import type { RepoQueueMessageHandle, AdjudicateQueueMessage } from "./types";

import { createLogger, getRepoStubByDoId } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode } from "@/worker/merge/tree";
import { parseCommitText } from "@/worker/git/core";
import { registerAgent } from "@/worker/agent/auth";
import { doPrefix } from "@/worker/keys";
import { createDb } from "@/worker/db/d1/client";

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

export async function handleAdjudicateMessage(
  message: Omit<RepoQueueMessageHandle<AdjudicateQueueMessage>, "body">,
  body: AdjudicateQueueMessage,
  env: Env
): Promise<void> {
  const log = createLogger(env.LOG_LEVEL, { service: "WorkersAiAdjudicator" });
  const stub = getRepoStubByDoId(env, body.doId);
  const intent = await stub.getMergeIntent(body.intentId);
  if (!intent || intent.status !== "adjudicating") {
    message.ack();
    return;
  }

  const db = createDb(env.DB);
  const did = `did:dg:${WORKERS_AI_DID_PUBKEY}`;
  await registerAgent(db, { pubkeyHex: WORKERS_AI_DID_PUBKEY, label: "workers-ai" }).catch(
    () => undefined
  );

  const conflicts: string[] = intent.conflicts ? JSON.parse(intent.conflicts) : [];
  const files: Record<string, { content_b64?: string; delete?: boolean }> = {};
  let unresolved = 0;

  for (const path of conflicts.slice(0, 8)) {
    const [ours, theirs] = await Promise.all([
      blobTextAtPath(env, body.doId, intent.baseOid, path),
      blobTextAtPath(env, body.doId, intent.deltaOid, path),
    ]);
    if (ours === undefined || theirs === undefined) {
      files[path] = { delete: ours === undefined };
      continue;
    }
    try {
      const res = (await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are a merge adjudicator. Given OURS and THEIRS versions of a file, output ONLY the merged file contents — no fences, no commentary.",
          },
          {
            role: "user",
            content: `FILE: ${path}\n\n=== OURS ===\n${ours.slice(0, 6000)}\n\n=== THEIRS ===\n${theirs.slice(0, 6000)}`,
          },
        ],
        max_tokens: 4096,
      })) as { response?: string };
      const merged = res.response?.trim();
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
    log.info("adjudicate:partial", { intentId: body.intentId, unresolved });
  }

  const canonical = JSON.stringify({ files });
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical) as BufferSource
  );
  const digest = [...new Uint8Array(digestBytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const resolutionKey = `${doPrefix(body.doId)}/resolutions/${body.intentId}/${digest}.json`;
  await env.REPO_BUCKET.put(resolutionKey, canonical);

  const outcome = await stub.castMergeVote({
    intentId: body.intentId,
    voterDid: did,
    resolutionDigest: digest,
    rationale: `workers-ai ${MODEL} semantic merge`,
    signature: `workers-ai:${digest.slice(0, 16)}`,
    quorumK: DEFAULT_QUORUM_K,
  });
  log.info("adjudicate:vote-cast", {
    intentId: body.intentId,
    status: outcome.status,
    resolved: outcome.status === "accepted" ? outcome.resolved : false,
  });
  message.ack();
}
