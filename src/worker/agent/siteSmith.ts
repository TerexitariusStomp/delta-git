import type { SiteBuildQueueMessage } from "@/worker/tasks/types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { applyManifest } from "@/worker/agent/patch";
import { attemptMerge } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { registerAgent } from "@/worker/agent/auth";
import { createDb } from "@/worker/db/d1/client";
import { bytesToHex } from "@/worker/common/hex";
import { readObject } from "@/worker/git/object-store/store";
import { parseCommitText } from "@/worker/git/core";
import { isTreeMode, parseTree } from "@/worker/merge/tree";
import { extractFileManifest, validateManifest, type SiteManifest } from "@/worker/agent/manifest";
import {
  SITE_SMITH_MODEL,
  SITE_SMITH_SYSTEM,
  buildSitePrompt,
} from "@/worker/agent/prompts/siteSmith";

// Site-smith: the built-in site-builder seat. A `site-build` queue message
// carries a work intent whose body is a natural-language site description;
// this pass turns it into a full WordPress site (Playground blueprint +
// block theme + static mirror) and lands it through the normal
// delta-ref → merge-intent → adjudication lanes. Nothing bypasses review:
// the site lands on a delta ref and the merge/quorum machinery decides.

const SITE_SMITH_PUBKEY_HEX = "22".repeat(32); // deterministic platform seat
const DEFAULT_QUORUM_K = 3;
const MAX_PROMPT_PATHS = 100;

const td = new TextDecoder();
const te = new TextEncoder();

async function ai(env: Env, system: string, prompt: string, maxTokens = 8192): Promise<string> {
  try {
    const res = (await env.AI.run(SITE_SMITH_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
    })) as { response?: string };
    return res.response?.trim() ?? "";
  } catch {
    return "";
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Top-level paths of the base tree, so the prompt can tell the model what
 * already exists (and avoid clobbering unrelated content). Capped — this
 * is orientation, not a full listing.
 */
async function listRootPaths(
  env: Env,
  repoId: string,
  baseCommitOid: string | undefined
): Promise<string[]> {
  if (!baseCommitOid) return [];
  const commitObj = await readObject(env, repoId, baseCommitOid, undefined);
  if (!commitObj || commitObj.type !== "commit") return [];
  const commit = parseCommitText(td.decode(commitObj.payload));
  if (!commit.tree) return [];
  const treeObj = await readObject(env, repoId, commit.tree, undefined);
  if (!treeObj || treeObj.type !== "tree") return [];
  const paths: string[] = [];
  for (const [name, entry] of parseTree(treeObj.payload)) {
    paths.push(isTreeMode(entry.mode) ? `${name}/` : name);
    if (paths.length >= MAX_PROMPT_PATHS) break;
  }
  return paths.sort();
}

/** One generation + one bounded repair pass if the manifest is invalid. */
async function generateManifest(
  env: Env,
  description: string,
  existing: string[]
): Promise<{ manifest: SiteManifest; raw: string } | { error: string }> {
  const prompt = buildSitePrompt(description, existing);
  const first = await ai(env, SITE_SMITH_SYSTEM, prompt);
  const manifest = first ? extractFileManifest(first) : undefined;
  if (manifest) {
    const check = validateManifest(manifest);
    if (check.ok) return { manifest, raw: first };
    // Repair pass: tell the model exactly which constraint it violated.
    const repair = await ai(
      env,
      SITE_SMITH_SYSTEM,
      `${prompt}\n\nYour previous output was rejected: ${check.reasons.join(", ")}. ` +
        `Fix ONLY those problems and output the corrected JSON manifest.`,
      8192
    );
    const repaired = repair ? extractFileManifest(repair) : undefined;
    if (repaired) {
      const recheck = validateManifest(repaired);
      if (recheck.ok) return { manifest: repaired, raw: repair };
      return { error: `manifest-invalid:${recheck.reasons.join(",").slice(0, 200)}` };
    }
    return { error: "repair-empty" };
  }
  return { error: first ? "manifest-unparseable" : "model-empty" };
}

export async function runSiteSmithPass(
  env: Env,
  msg: SiteBuildQueueMessage
): Promise<{ detail: string }> {
  const log = createLogger(env.LOG_LEVEL, { service: "SiteSmith", repoId: msg.repoId });
  const stub = getRepoStubByDoId(env, msg.doId);
  const db = createDb(env.DB);

  // Deterministic platform seat — family/model are verified because the
  // platform controls this key, so contributions roll up under the
  // site-smith family on the leaderboard.
  const registered = await registerAgent(db, {
    pubkeyHex: SITE_SMITH_PUBKEY_HEX,
    label: "site-smith",
    kind: "workers-ai",
    family: "site-smith",
    model: SITE_SMITH_MODEL,
  }).catch(() => undefined);
  const actor =
    registered && "did" in registered ? registered.did : `did:dg:${SITE_SMITH_PUBKEY_HEX}`;

  const intent = await stub.getWorkIntent(msg.workIntentId);
  if (!intent) return { detail: "intent-missing" };
  if (intent.status !== "open") return { detail: `intent-${intent.status}` };
  const claimed = await stub.claimWorkIntent({ id: intent.id, actor });
  if (claimed.status !== "claimed") return { detail: "unclaimed" };

  const description = [intent.title.replace(/^site:\s*/i, ""), intent.body ?? ""]
    .join("\n")
    .trim()
    .slice(0, 8000);
  if (!description) return { detail: "empty-description" };

  const { refs } = await stub.getHeadAndRefs();
  const main = refs.find((r) => r.name === "refs/heads/main") ?? refs[0];
  const existing = await listRootPaths(env, msg.repoId ?? msg.doId, main?.oid);

  // --- manifest ---------------------------------------------------------
  const generated = await generateManifest(env, description, existing);
  if ("error" in generated) {
    await stub.updateWorkIntentResult({
      id: intent.id,
      result: `stage:manifest-failed ${generated.error}`,
      actor,
    });
    log.warn("sitesmith:manifest-failed", { error: generated.error });
    return { detail: generated.error };
  }
  const { manifest, raw } = generated;
  await stub.updateWorkIntentResult({
    id: intent.id,
    result:
      `stage:manifest files:${manifest.files.length} sha:${await sha256Hex(raw)}\n${manifest.summary}`.slice(
        0,
        4000
      ),
    actor,
  });

  // --- commit the file set ----------------------------------------------
  const applied = await applyManifest({
    env,
    repoId: msg.repoId ?? msg.doId,
    baseCommitOid: main?.oid,
    files: manifest.files,
    message: `site-smith: ${intent.title}`.slice(0, 200),
    author: `site-smith <agent@delta-git.invalid>`,
    cacheCtx: undefined,
  });
  if (applied.kind === "failed") {
    await stub.updateWorkIntentResult({
      id: intent.id,
      result: `stage:apply-failed reason:${applied.reason}`,
      actor,
    });
    return { detail: `apply-${applied.reason.slice(0, 40)}` };
  }

  // --- land as delta ref + merge intent ----------------------------------
  const pack = await writeServerPack(applied.objects);
  const packKey = r2PackKey(
    doPrefix(msg.doId),
    `pack-sitesmith-${applied.commitOid.slice(0, 12)}.pack`
  );
  await env.REPO_BUCKET.put(packKey, pack.packBytes);
  await env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

  // Empty repos have no target ref — land on refs/heads/main directly.
  const accepted = await stub.acceptPatchCommit({
    targetRef: main?.name ?? "refs/heads/main",
    newOid: applied.commitOid,
    actor,
    kind: "sitesmith.build",
    stagedPack: {
      packKey,
      packBytes: pack.packBytes.length,
      idxBytes: pack.idxBytes.length,
      objectCount: pack.objectCount,
    },
  });

  // --- merge through the normal adjudication lane -------------------------
  const merge = await attemptMerge({
    env,
    repoId: msg.repoId ?? msg.doId,
    stub,
    intentId: accepted.intent.id,
    actor,
    cacheCtx: undefined,
  });

  if (merge.kind === "merged" || merge.kind === "up_to_date") {
    const landedOid = merge.kind === "merged" ? merge.mergeOid : applied.commitOid;
    const digest = await sha256Hex(`${manifest.summary}\n${applied.commitOid}`);
    await stub.setCommitStatus({
      row: {
        sha: landedOid,
        context: "sitesmith/build",
        state: "success",
        description: `site build landed (${manifest.files.length} files)`,
        targetUrl: null,
        createdBy: actor,
        createdAt: Date.now(),
      },
      actor,
    });
    // One verify seat — quorum still requires other voters.
    await stub.castWorkVote({
      workIntentId: intent.id,
      voterDid: actor,
      resolutionDigest: `verified:${digest}`,
      rationale: "site build merged clean",
      signature: `sitesmith:${digest.slice(0, 16)}`,
      quorumK: DEFAULT_QUORUM_K,
    });
    await stub.updateWorkIntentResult({
      id: intent.id,
      result:
        `stage:merged sha:${landedOid} files:${manifest.files.length} ` +
        `attest:/dg/attest/${landedOid} preview:deploy-git prefix=site`,
      actor,
    });
    log.info("sitesmith:merged", { oid: landedOid, files: manifest.files.length });
    return { detail: `merged:${landedOid.slice(0, 12)}` };
  }

  const stage = merge.kind === "conflict" ? "adjudicating" : merge.kind;
  await stub.updateWorkIntentResult({
    id: intent.id,
    result: `stage:${stage} intent:${accepted.intent.id}${merge.kind === "skipped" ? ` reason:${merge.reason}` : ""}`,
    actor,
  });
  log.info("sitesmith:pending", { stage, intentId: accepted.intent.id });
  return { detail: stage };
}
