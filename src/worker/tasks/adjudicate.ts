import type { RepoQueueMessageHandle, AdjudicateQueueMessage } from "./types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode } from "@/worker/git/core/tree";
import { parseCommitText } from "@/worker/git/core";
import { registerAgent } from "@/worker/agent/auth";
import { doPrefix } from "@/worker/keys";
import { createDb } from "@/worker/db/d1/client";
import { findRepositoryById } from "@/worker/db/d1/dal/repositories";
import { findNamespaceById } from "@/worker/db/d1/dal/namespaces";
import { insertEvalSample } from "@/worker/db/d1/dal/evalCorpus";
import { poolInfer, repoPoolProject } from "@/worker/compute/pool";

// Workers-AI adjudicator seat.
//
// When a merge intent enters adjudication, this queue consumer occupies one
// quorum seat: it reads both sides of each conflicted path, asks the model
// for a merged result, stores the resolution payload in R2, and casts a
// signed vote like any other adjudicator. An LLM is one vote in the quorum —
// never the whole decision — which is what makes this byzantine-tolerant
// rather than "LLM resolves conflicts" (a demo every other entrant will have).

const td = new TextDecoder();
const WORKERS_AI_DID_PUBKEY = "00".repeat(32); // deterministic platform did
const DEFAULT_QUORUM_K = 3;
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function blobTextAtPath(
  env: Env,
  doId: string,
  commitOid: string,
  path: string
): Promise<string | undefined> {
  const commit = await readObject(env, doId, commitOid, undefined);
  if (!commit || commit.type !== "commit") return undefined;
  const treeOid = parseCommitText(td.decode(commit.payload)).tree;
  if (!treeOid) return undefined;
  const entry = await resolvePathEntry(env, doId, treeOid, path, undefined);
  if (!entry || isTreeMode(entry.mode)) return undefined;
  const blob = await readObject(env, doId, entry.oid, undefined);
  if (!blob || blob.type !== "blob") return undefined;
  try {
    return td.decode(blob.payload);
  } catch {
    return undefined;
  }
}

export interface AdjudicationOutcome {
  /** Whether a vote was cast (false when the intent wasn't adjudicating). */
  voted: boolean;
  /** Whether the vote resolved the intent. */
  resolved: boolean;
  status?: string;
  unresolved?: number;
}

/**
 * Single adjudication pass: reads the intent, merges conflicts, stores the
 * resolution payload in R2, and casts a quorum vote. Shared by the queue
 * handler and the AdjudicatorAgent runtime DO.
 *
 * Merge engine: the compute pool runs first for PUBLIC repositories (repo
 * row looked up by `repoId` — private/E2E repos never emit content to
 * volunteer nodes) and Workers AI is the fallback floor.
 */
export async function runWorkersAiAdjudication(
  env: Env,
  doId: string,
  intentId: string,
  repoId?: string
): Promise<AdjudicationOutcome> {
  const log = createLogger(env.LOG_LEVEL, { service: "WorkersAiAdjudicator" });
  const stub = getRepoStubByDoId(env, doId);
  const intent = await stub.getMergeIntent(intentId);
  if (!intent || intent.status !== "adjudicating") {
    return { voted: false, resolved: false, status: intent?.status };
  }

  const db = createDb(env.DB);

  // Pool routing context — resolved once per intent. Missing repoId or a
  // private repo leaves `poolProject` undefined, which gates every
  // poolInfer call off before it reaches the network. Internal repos ride
  // the INTERNAL lane — durable+DID-bound nodes only, coordinator-enforced.
  let poolProject: string | undefined;
  let poolVisibility = "private";
  if (repoId) {
    const repo = await findRepositoryById(db, repoId).catch(() => undefined);
    if (repo) {
      poolVisibility = repo.visibility;
      const ns = await findNamespaceById(db, repo.namespaceId).catch(() => undefined);
      if ((repo.visibility === "public" || repo.visibility === "internal") && ns) {
        poolProject = repoPoolProject(ns.slug, repo.slug);
      }
    }
  }
  const registered = await registerAgent(db, {
    pubkeyHex: WORKERS_AI_DID_PUBKEY,
    label: "workers-ai",
    kind: "workers-ai",
  }).catch(() => undefined);
  const did =
    registered && "did" in registered ? registered.did : `did:dg:${WORKERS_AI_DID_PUBKEY}`;

  const conflicts: string[] = intent.conflicts ? JSON.parse(intent.conflicts) : [];
  const files: Record<string, { content_b64?: string; delete?: boolean }> = {};
  // Eval-corpus sample — inputs collected alongside the merge loop so the
  // offline harness can replay real conflicts. Public repos only.
  const corpusInputs: { path: string; ours: string; theirs: string }[] = [];
  let unresolved = 0;
  let poolMerged = 0;

  for (const path of conflicts.slice(0, 8)) {
    const [ours, theirs] = await Promise.all([
      blobTextAtPath(env, doId, intent.baseOid, path),
      blobTextAtPath(env, doId, intent.deltaOid, path),
    ]);
    if (ours === undefined || theirs === undefined) {
      files[path] = { delete: ours === undefined };
      continue;
    }
    if (poolVisibility === "public") {
      corpusInputs.push({ path, ours: ours.slice(0, 6000), theirs: theirs.slice(0, 6000) });
    }
    const messages = [
      {
        role: "system",
        content:
          "You are a merge adjudicator. Given OURS and THEIRS versions of a file, output ONLY the merged file contents — no fences, no commentary.",
      },
      {
        role: "user",
        content: `FILE: ${path}\n\n=== OURS ===\n${ours.slice(0, 6000)}\n\n=== THEIRS ===\n${theirs.slice(0, 6000)}`,
      },
    ];
    try {
      let merged: string | undefined;
      if (poolProject) {
        // Volunteer pool first — public content only, enforced both here
        // (visibility arg) and coordinator-side (PUBLIC classification gate).
        const pooled = await poolInfer(env, {
          project: poolProject,
          messages,
          maxTokens: 4096,
          visibility: poolVisibility,
        });
        if (pooled) {
          merged = pooled;
          poolMerged++;
        }
      }
      if (!merged) {
        const res = (await env.AI.run(MODEL, {
          messages,
          max_tokens: 4096,
        })) as { response?: string };
        merged = res.response?.trim();
      }
      if (!merged) {
        unresolved++;
        continue;
      }
      files[path] = { content_b64: b64(new TextEncoder().encode(merged + "\n")) };
    } catch (error) {
      log.warn("adjudicate:ai-failed", { path, error: String(error) });
      unresolved++;
    }
  }
  if (unresolved > 0) {
    log.info("adjudicate:partial", { intentId, unresolved });
  }

  const canonical = JSON.stringify({ files });
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical) as BufferSource
  );
  const digest = [...new Uint8Array(digestBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const resolutionKey = `${doPrefix(doId)}/resolutions/${intentId}/${digest}.json`;
  await env.REPO_BUCKET.put(resolutionKey, canonical);

  const outcome = await stub.castMergeVote({
    intentId,
    voterDid: did,
    resolutionDigest: digest,
    rationale:
      poolMerged > 0
        ? `compute-pool(${poolMerged})+workers-ai ${MODEL} semantic merge`
        : `workers-ai ${MODEL} semantic merge`,
    signature: `workers-ai:${digest.slice(0, 16)}`,
    quorumK: DEFAULT_QUORUM_K,
  });
  log.info("adjudicate:vote-cast", {
    intentId,
    status: outcome.status,
    resolved: outcome.status === "accepted" ? outcome.resolved : false,
  });
  // Eval-corpus write — only when the repo is public (same visibility gate
  // as pool dispatch; private/E2E content never leaves the DO). The row is
  // the offline harness's replay material: conflict inputs + merged output
  // + engine mix. `outcome` backfills on resolution via markEvalOutcome.
  if (repoId && corpusInputs.length > 0) {
    const engine =
      poolMerged === 0
        ? "workers-ai"
        : poolMerged === corpusInputs.length
          ? "compute-pool"
          : "mixed";
    insertEvalSample(db, {
      id: crypto.randomUUID(),
      repositoryId: repoId,
      intentId,
      engine,
      input: JSON.stringify(corpusInputs),
      output: JSON.stringify(
        Object.fromEntries(
          Object.entries(files).map(([p, f]) => [p, f.content_b64 ? "b64" : "delete"])
        )
      ),
      outcome:
        outcome.status === "accepted"
          ? "merged"
          : outcome.status === "rejected"
            ? "rejected"
            : null,
      createdAt: Date.now(),
    }).catch((error) =>
      log.warn("adjudicate:corpus-write-failed", { intentId, error: String(error) })
    );
  }
  return {
    voted: true,
    resolved: outcome.status === "accepted" ? outcome.resolved : false,
    status: outcome.status,
    unresolved,
  };
}

export async function handleAdjudicateMessage(
  message: Omit<RepoQueueMessageHandle<AdjudicateQueueMessage>, "body">,
  body: AdjudicateQueueMessage,
  env: Env
): Promise<void> {
  const stub = env.ADJUDICATOR_DO.get(env.ADJUDICATOR_DO.idFromName("adjudicator"));
  const result = await stub.runQueueTask(body);
  if (result.action === "retry") message.retry();
  else message.ack();
}
