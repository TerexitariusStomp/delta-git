import type { CacheContext } from "@/worker/cache";
import type { RepoDurableObject } from "@/worker/do";

import { computeOid } from "@/worker/git/core";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import {
  buildCommitPayload,
  findMergeBase,
  mergeTrees,
  readCommit,
  type ConflictResolver,
} from "./engine";
import { serializeTree } from "./tree";
import { writeServerPack, type NewObject } from "./packWriter";

// Adjudicated-resolution application.
//
// After quorum selects a winning resolution digest, the resolution payload
// (stored in R2 at vote time) is replayed here: the same 3-way merge runs
// again, but conflicted paths take the adjudicated contents. The result
// commits through the DO with method "adjudicated" so the op log records
// that a quorum, not the auto-merger, produced it.

export type ResolutionDoc = {
  files: Record<string, { content_b64?: string; delete?: boolean }>;
};

export type ApplyResolutionResult =
  | { kind: "merged"; mergeOid: string }
  | { kind: "base_moved"; currentOid: string }
  | { kind: "failed"; reason: string };

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function applyResolution(args: {
  env: Env;
  repoId: string;
  stub: DurableObjectStub<RepoDurableObject>;
  intentId: string;
  resolutionJson: string;
  expectedBaseOid: string;
  actor: string;
  cacheCtx?: CacheContext;
}): Promise<ApplyResolutionResult> {
  const { env, repoId, stub, intentId, actor, cacheCtx } = args;
  const intent = await stub.getMergeIntent(intentId);
  if (!intent) return { kind: "failed", reason: "intent-not-found" };
  if (intent.status !== "conflict") {
    return { kind: "failed", reason: `intent-${intent.status}` };
  }

  let doc: ResolutionDoc;
  try {
    doc = JSON.parse(args.resolutionJson) as ResolutionDoc;
  } catch {
    return { kind: "failed", reason: "resolution-parse-error" };
  }

  const resolutions = new Map<string, { kind: "content"; content: Uint8Array } | { kind: "delete" }>();
  for (const [path, file] of Object.entries(doc.files ?? {})) {
    if (file.delete) resolutions.set(path, { kind: "delete" });
    else if (typeof file.content_b64 === "string") {
      resolutions.set(path, { kind: "content", content: b64decode(file.content_b64) });
    }
  }
  const resolve: ConflictResolver = (path) => resolutions.get(path);

  const { refs } = await stub.getHeadAndRefs();
  const baseOid = refs.find((ref) => ref.name === intent.targetRef)?.oid ?? intent.baseOid;
  const [oursCommit, theirsCommit] = await Promise.all([
    readCommit(env, repoId, baseOid, cacheCtx),
    readCommit(env, repoId, intent.deltaOid, cacheCtx),
  ]);
  if (!oursCommit || !theirsCommit) return { kind: "failed", reason: "missing-commit-objects" };

  const mergeBaseOid = await findMergeBase(env, repoId, baseOid, intent.deltaOid, cacheCtx);
  const mergeBaseCommit = mergeBaseOid
    ? await readCommit(env, repoId, mergeBaseOid, cacheCtx)
    : undefined;

  const treeMerge = await mergeTrees(
    env,
    repoId,
    "",
    mergeBaseCommit?.tree,
    oursCommit.tree,
    theirsCommit.tree,
    cacheCtx,
    resolve
  );
  if (treeMerge === "too_big") return { kind: "failed", reason: "merge-too-large" };
  if (treeMerge.conflicts.length > 0) {
    return { kind: "failed", reason: `unresolved-paths:${treeMerge.conflicts.join(",")}` };
  }

  const treePayload = serializeTree(treeMerge.entries);
  const treeOid = await computeOid("tree", treePayload);
  const commitPayload = buildCommitPayload({
    treeOid,
    parents: [baseOid, intent.deltaOid],
    timestampSec: Math.floor(Date.now() / 1000),
    message: `delta-git adjudicated merge ${intent.id}\n\nbase:  ${baseOid}\ndelta: ${intent.deltaOid}\nresolution: quorum\n`,
  });
  const mergeOid = await computeOid("commit", commitPayload);

  const objects: NewObject[] = [
    ...treeMerge.newObjects,
    { type: "tree", payload: treePayload, oid: treeOid },
    { type: "commit", payload: commitPayload, oid: mergeOid },
  ];
  const pack = await writeServerPack(objects);
  const packKey = r2PackKey(doPrefix(stub.id.toString()), `pack-merge-${mergeOid.slice(0, 12)}.pack`);
  await env.REPO_BUCKET.put(packKey, pack.packBytes);
  await env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

  const committed = await stub.commitMerge({
    intentId,
    expectedBaseOid: baseOid,
    mergeOid,
    stagedPack: {
      packKey,
      packBytes: pack.packBytes.length,
      idxBytes: pack.idxBytes.length,
      objectCount: pack.objectCount,
    },
    actor,
    method: "adjudicated",
  });
  if (committed.status === "base_moved") {
    return { kind: "base_moved", currentOid: committed.currentOid };
  }
  if (committed.status !== "committed") {
    return { kind: "failed", reason: committed.status };
  }
  return { kind: "merged", mergeOid };
}
