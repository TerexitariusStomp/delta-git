import type { OvernightQueueMessage } from "@/worker/tasks/types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { applyUnifiedPatch } from "@/worker/agent/patch";
import { attemptMerge } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { registerAgent } from "@/worker/agent/auth";
import { createDb } from "@/worker/db/d1/client";
import { bytesToHex } from "@/worker/common/hex";

// Overnight self-improvement agent (Symbient-shaped, delta-git-native).
//
// The RepoAgent runtime consumes `overnight` queue messages and calls this
// pass. Each pass sweeps open `kind="idea"` work intents and drives them
// through the *normal* lanes — nothing bypasses adjudication:
//
//   idea (claimed) → spec (Workers AI) → patch (Workers AI) →
//   delta ref + merge intent → merge/adjudication → verify vote → close
//
// Checkpoints land in the op-log via work-intent result updates and the
// merge machinery's own entries, so the whole run is auditable and
// resumable: claims expire in 30 min, results carry the last stage.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const OVERNIGHT_PUBKEY_HEX = "11".repeat(32); // deterministic platform agent
const MAX_IDEAS_PER_PASS = 3;
const DEFAULT_QUORUM_K = 3;

const te = new TextEncoder();

export interface OvernightOutcome {
  detail: string;
}

async function ai(env: Env, system: string, prompt: string, maxTokens = 2048): Promise<string> {
  try {
    const res = (await env.AI.run(MODEL, {
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

/** Extract a fenced/inline unified diff from model output, if any. */
function extractPatch(text: string): string | undefined {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  if (!body.includes("---") || !body.includes("+++")) return undefined;
  // Keep only the diff-shaped tail starting at the first `diff --git` or `---`.
  const start = body.search(/^(diff --git|---\s)/m);
  if (start < 0) return undefined;
  const patch = body.slice(start);
  return patch.length > 128 * 1024 ? undefined : patch;
}

export async function runOvernightPass(
  env: Env,
  msg: OvernightQueueMessage
): Promise<OvernightOutcome> {
  const log = createLogger(env.LOG_LEVEL, { service: "Overnight", repoId: msg.repoId });
  const stub = getRepoStubByDoId(env, msg.doId);
  const db = createDb(env.DB);

  // Register the deterministic platform agent (idempotent) so votes/statuses
  // attribute to a real did:key row.
  const registered = await registerAgent(db, {
    pubkeyHex: OVERNIGHT_PUBKEY_HEX,
    label: "overnight",
    kind: "workers-ai",
  }).catch(() => undefined);
  const actor =
    registered && "did" in registered ? registered.did : `did:dg:${OVERNIGHT_PUBKEY_HEX}`;

  const ideas = msg.workIntentId
    ? [await stub.getWorkIntent(msg.workIntentId)].filter((r) => r !== undefined)
    : (await stub.listWorkIntentsByKind("idea")).filter((r) => r.status === "open");
  if (ideas.length === 0) return { detail: "no-open-ideas" };

  const results: string[] = [];
  for (const idea of ideas.slice(0, MAX_IDEAS_PER_PASS)) {
    const claimed = await stub.claimWorkIntent({ id: idea.id, actor });
    if (claimed.status !== "claimed") {
      results.push(`${idea.id}:unclaimed`);
      continue;
    }

    // --- spec ---------------------------------------------------------
    const spec = await ai(
      env,
      "You write terse engineering specs for small repo improvements. Output a numbered checklist — no prose around it.",
      `Idea: ${idea.title}\n\n${idea.body ?? ""}`
    );
    if (!spec) {
      results.push(`${idea.id}:spec-failed`);
      continue;
    }
    await stub.updateWorkIntentResult({
      id: idea.id,
      result: `spec:${await sha256Hex(spec)}\n${spec}`.slice(0, 4000),
      actor,
    });

    // --- patch --------------------------------------------------------
    const { refs } = await stub.getHeadAndRefs();
    const main = refs.find((r) => r.name === "refs/heads/main") ?? refs[0];
    if (!main) {
      results.push(`${idea.id}:no-refs`);
      continue;
    }
    const patchText = await ai(
      env,
      "You are a code-writing agent. Output ONLY a unified diff (diff --git / --- / +++ / @@ hunks). For new files use `--- /dev/null` and `+++ b/<path>`. Small, safe changes only.",
      `Spec:\n${spec}\n\nProduce the unified diff implementing it.`,
      4096
    );
    const patch = extractPatch(patchText);
    if (!patch) {
      await stub.updateWorkIntentResult({
        id: idea.id,
        result: `stage:patch-failed spec:${await sha256Hex(spec)}`,
        actor,
      });
      results.push(`${idea.id}:no-patch`);
      continue;
    }

    const applied = await applyUnifiedPatch({
      env,
      repoId: msg.doId,
      baseCommitOid: main.oid,
      patchText: patch,
      message: `overnight: ${idea.title}`,
      author: `overnight <agent@delta-git.invalid>`,
      cacheCtx: undefined,
    });
    if (applied.kind === "failed") {
      await stub.updateWorkIntentResult({
        id: idea.id,
        result: `stage:apply-failed reason:${applied.reason}`,
        actor,
      });
      results.push(`${idea.id}:apply-${applied.reason.slice(0, 40)}`);
      continue;
    }

    // --- land as delta ref + merge intent --------------------------------
    const pack = await writeServerPack(applied.objects);
    const packKey = r2PackKey(
      doPrefix(msg.doId),
      `pack-overnight-${applied.commitOid.slice(0, 12)}.pack`
    );
    await env.REPO_BUCKET.put(packKey, pack.packBytes);
    await env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

    const accepted = await stub.acceptPatchCommit({
      targetRef: main.name,
      newOid: applied.commitOid,
      actor,
      kind: "overnight.patch",
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });

    // --- verify (merge through normal adjudication) ----------------------
    const merge = await attemptMerge({
      env,
      repoId: msg.doId,
      stub,
      intentId: accepted.intent.id,
      actor,
      cacheCtx: undefined,
    });

    if (merge.kind === "merged" || merge.kind === "up_to_date") {
      const landedOid = merge.kind === "merged" ? merge.mergeOid : applied.commitOid;
      const digest = await sha256Hex(`${spec}\n${applied.commitOid}`);
      await stub.setCommitStatus({
        row: {
          sha: landedOid,
          context: "overnight/verify",
          state: "success",
          description: `idea ${idea.id} landed`,
          targetUrl: null,
          createdBy: actor,
          createdAt: Date.now(),
        },
        actor,
      });
      // Overnight casts one verify seat; human agents close the quorum via
      // POST /dg/ideas/:id/verify — no self-certification.
      await stub.castWorkVote({
        workIntentId: idea.id,
        voterDid: actor,
        resolutionDigest: `verified:${digest}`,
        rationale: "overnight patch merged clean",
        signature: `overnight:${digest.slice(0, 16)}`,
        quorumK: DEFAULT_QUORUM_K,
      });
      await stub.updateWorkIntentResult({
        id: idea.id,
        result: `stage:merged sha:${landedOid} attest:/dg/attest/${landedOid} verify:quorum-pending`,
        actor,
      });
      results.push(`${idea.id}:merged`);
    } else {
      const stage = merge.kind === "conflict" ? "adjudicating" : merge.kind;
      await stub.updateWorkIntentResult({
        id: idea.id,
        result: `stage:${stage} intent:${accepted.intent.id}${merge.kind === "skipped" ? ` reason:${merge.reason}` : ""}`,
        actor,
      });
      results.push(`${idea.id}:${stage}`);
    }
  }

  const detail = results.join(", ").slice(0, 480);
  log.info("overnight:pass-done", { detail });
  return { detail };
}
