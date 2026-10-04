import type { CacheContext } from "@/worker/cache";
import type { RepoDurableObject } from "@/worker/do";
import type { GitObjectType } from "@/worker/git/core";

import { computeOid, parseCommitText } from "@/worker/git/core";
import { readObject } from "@/worker/git/object-store/store";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { mergeFileContents } from "./file";
import { writeServerPack, type NewObject } from "./packWriter";
import { isTreeMode, parseTree, serializeTree, type Tree, type TreeEntry } from "./tree";
import { writeMergeAttestation } from "@/worker/agent/attest";
import { createLogger } from "@/worker/common/logger";

// Worker-side merge engine.
//
// The DO owns ref/intent state; this module does the object work: merge-base
// discovery, recursive 3-way tree merge, file-level structured merge, and
// packing the resulting objects. Outcomes commit back through DO RPCs so the
// CAS check against a moved base stays atomic.

type RepoStub = DurableObjectStub<RepoDurableObject>;

const MERGE_AUTHOR = "delta-git <merge@delta-git.invalid>";
/** Cap on ancestors walked per side when finding a merge base. */
const MERGE_BASE_WALK_LIMIT = 512;
/** Cap on objects written into one merge pack (abuse guard). */
const MAX_MERGE_OBJECTS = 20_000;
/** Cap on blob sizes merged in memory. */
const MAX_MERGE_BLOB_BYTES = 4 * 1024 * 1024;

export type MergeAttemptResult =
  | { kind: "merged"; intentId: string; mergeOid: string }
  | { kind: "conflict"; intentId: string; conflicts: string[] }
  | { kind: "base_moved"; intentId: string; currentOid: string }
  | { kind: "up_to_date"; intentId: string }
  | { kind: "not_found" }
  | { kind: "skipped"; reason: string };

const td = new TextDecoder();

// ---------------------------------------------------------------------------
// Object reads
// ---------------------------------------------------------------------------

async function readPayload(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx: CacheContext | undefined,
  expect?: GitObjectType
): Promise<Uint8Array | undefined> {
  const obj = await readObject(env, repoId, oid, cacheCtx);
  if (!obj) return undefined;
  if (expect && obj.type !== expect) return undefined;
  return obj.payload;
}

export async function readCommit(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx: CacheContext | undefined
): Promise<{ tree: string; parents: string[] } | undefined> {
  const payload = await readPayload(env, repoId, oid, cacheCtx, "commit");
  if (!payload) return undefined;
  const parsed = parseCommitText(td.decode(payload));
  if (!parsed.tree) return undefined;
  return { tree: parsed.tree, parents: parsed.parents };
}

// ---------------------------------------------------------------------------
// Merge base discovery (BFS on parent links)
// ---------------------------------------------------------------------------

async function ancestorsOf(
  env: Env,
  repoId: string,
  oid: string,
  cacheCtx: CacheContext | undefined
): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0 && seen.size < MERGE_BASE_WALK_LIMIT) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = await readCommit(env, repoId, cur, cacheCtx);
    if (!commit) break;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return seen;
}

export async function findMergeBase(
  env: Env,
  repoId: string,
  oursOid: string,
  theirsOid: string,
  cacheCtx: CacheContext | undefined
): Promise<string | undefined> {
  if (oursOid === theirsOid) return oursOid;
  const oursAncestors = await ancestorsOf(env, repoId, oursOid, cacheCtx);
  if (oursAncestors.has(theirsOid)) return theirsOid;
  const queue = [theirsOid];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MERGE_BASE_WALK_LIMIT) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (oursAncestors.has(cur)) return cur;
    const commit = await readCommit(env, repoId, cur, cacheCtx);
    if (!commit) break;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Recursive tree merge
// ---------------------------------------------------------------------------

type TreeMergeOutcome = {
  entries: Tree;
  newObjects: NewObject[];
  conflicts: string[];
};

/** Adjudication hook: resolve a conflicted path to blob content or a delete. */
export type ConflictResolver = (
  path: string
) => { kind: "content"; content: Uint8Array } | { kind: "delete" } | undefined;

export async function mergeTrees(
  env: Env,
  repoId: string,
  prefix: string,
  baseTreeOid: string | undefined,
  oursTreeOid: string | undefined,
  theirsTreeOid: string | undefined,
  cacheCtx: CacheContext | undefined,
  resolve?: ConflictResolver
): Promise<TreeMergeOutcome | "too_big"> {
  const [baseTree, oursTree, theirsTree] = await Promise.all([
    baseTreeOid ? readPayload(env, repoId, baseTreeOid, cacheCtx, "tree") : undefined,
    oursTreeOid ? readPayload(env, repoId, oursTreeOid, cacheCtx, "tree") : undefined,
    theirsTreeOid ? readPayload(env, repoId, theirsTreeOid, cacheCtx, "tree") : undefined,
  ]);
  const base = baseTree ? parseTree(baseTree) : (new Map() as Tree);
  const ours = oursTree ? parseTree(oursTree) : (new Map() as Tree);
  const theirs = theirsTree ? parseTree(theirsTree) : (new Map() as Tree);

  const out: Tree = new Map();
  const newObjects: NewObject[] = [];
  const conflicts: string[] = [];
  const names = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);

  for (const name of names) {
    if (newObjects.length > MAX_MERGE_OBJECTS) return "too_big";
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    const path = prefix ? `${prefix}/${name}` : name;

    const sameOT = sameEntry(o, t);
    const sameBO = sameEntry(b, o);
    const sameBT = sameEntry(b, t);

    if (sameOT) {
      if (o) out.set(name, o);
      continue;
    }
    if (sameBO) {
      if (t) out.set(name, t);
      continue;
    }
    if (sameBT) {
      if (o) out.set(name, o);
      continue;
    }

    // Adjudicated resolution wins over any merge logic for the path.
    const ruling = resolve?.(path);
    if (ruling !== undefined) {
      if (ruling.kind === "delete") {
        out.delete(name);
      } else {
        const oid = await computeOid("blob", ruling.content);
        newObjects.push({ type: "blob", payload: ruling.content, oid });
        out.set(name, { mode: o?.mode ?? t?.mode ?? "100644", name, oid });
      }
      continue;
    }

    // Both sides changed the entry differently.
    if (o && t && isTreeMode(o.mode) && isTreeMode(t.mode)) {
      const merged = await mergeTrees(
        env,
        repoId,
        path,
        b && isTreeMode(b.mode) ? b.oid : undefined,
        o.oid,
        t.oid,
        cacheCtx,
        resolve
      );
      if (merged === "too_big") return "too_big";
      conflicts.push(...merged.conflicts);
      if (merged.entries.size > 0 || merged.newObjects.length > 0) {
        const payload = serializeTree(merged.entries);
        const oid = await computeOid("tree", payload);
        newObjects.push(...merged.newObjects, { type: "tree", payload, oid });
        out.set(name, { mode: "40000", name, oid });
      }
      continue;
    }

    if (o && t && !isTreeMode(o.mode) && !isTreeMode(t.mode)) {
      const [baseBlob, oursBlob, theirsBlob] = await Promise.all([
        b && !isTreeMode(b.mode) ? readPayload(env, repoId, b.oid, cacheCtx, "blob") : undefined,
        readPayload(env, repoId, o.oid, cacheCtx, "blob"),
        readPayload(env, repoId, t.oid, cacheCtx, "blob"),
      ]);
      if (
        (oursBlob && oursBlob.length > MAX_MERGE_BLOB_BYTES) ||
        (theirsBlob && theirsBlob.length > MAX_MERGE_BLOB_BYTES)
      ) {
        conflicts.push(path);
        continue;
      }
      const merged = mergeFileContents({
        path,
        base: baseBlob,
        ours: oursBlob,
        theirs: theirsBlob,
      });
      if (merged.kind === "merged") {
        const oid = await computeOid("blob", merged.content);
        newObjects.push({ type: "blob", payload: merged.content, oid });
        out.set(name, { mode: o.mode, name, oid });
      } else {
        conflicts.push(path);
      }
      continue;
    }

    // Tree-vs-blob or add/add with diverging kinds.
    conflicts.push(path);
  }

  return { entries: out, newObjects, conflicts };
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

// ---------------------------------------------------------------------------
// Commit construction
// ---------------------------------------------------------------------------

export function buildCommitPayload(args: {
  treeOid: string;
  parents: string[];
  message: string;
  timestampSec: number;
}): Uint8Array {
  const sig = `${MERGE_AUTHOR} ${args.timestampSec} +0000`;
  const lines = [
    `tree ${args.treeOid}`,
    ...args.parents.map((parent) => `parent ${parent}`),
    `author ${sig}`,
    `committer ${sig}`,
    "",
    args.message,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Merge attempt
// ---------------------------------------------------------------------------

/**
 * Attempt an automatic merge for an intent: claim it, merge the delta tip
 * into the current target head, then either commit through the DO or hand
 * off to adjudication. Returns a tagged outcome; callers map it to HTTP.
 */
export async function attemptMerge(args: {
  env: Env;
  repoId: string;
  stub: RepoStub;
  intentId: string;
  actor: string;
  cacheCtx?: CacheContext;
}): Promise<MergeAttemptResult> {
  const { env, repoId, stub, intentId, actor, cacheCtx } = args;
  const log = createLogger(env.LOG_LEVEL, { service: "MergeEngine", repoId });
  const intent = await stub.claimMergeIntent(intentId);
  if (!intent) {
    const existing = await stub.getMergeIntent(intentId);
    return existing
      ? { kind: "skipped", reason: `intent-${existing.status}` }
      : { kind: "not_found" };
  }

  // Every early return below this point must settle the lease we just took:
  // either release it back to `open` so the intent can be retried, or close
  // it as merged. Leaving `merging` behind would wedge the intent until its
  // TTL expires.
  const release = (reason: string) =>
    stub.releaseMergeIntent({ id: intentId, reason, actor }).catch(() => {});

  const { refs } = await stub.getHeadAndRefs();
  const target = refs.find((ref) => ref.name === intent.targetRef);
  const baseOid = target?.oid ?? intent.baseOid;
  if (baseOid === intent.deltaOid) {
    await stub.markMergeUpToDate({ intentId, actor });
    return { kind: "up_to_date", intentId };
  }

  const [oursCommit, theirsCommit] = await Promise.all([
    readCommit(env, repoId, baseOid, cacheCtx),
    readCommit(env, repoId, intent.deltaOid, cacheCtx),
  ]);
  if (!oursCommit || !theirsCommit) {
    await release("missing-commit-objects");
    return { kind: "skipped", reason: "missing-commit-objects" };
  }

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
    cacheCtx
  );
  if (treeMerge === "too_big") {
    await release("merge-too-large");
    return { kind: "skipped", reason: "merge-too-large" };
  }

  if (treeMerge.conflicts.length > 0) {
    const marked = await stub.markMergeAdjudicating({
      intentId,
      conflicts: treeMerge.conflicts,
      actor,
    });
    if (marked.status !== "ok") {
      // The intent moved under us before it could be adjudicated; make sure
      // we did not leave our `merging` lease behind (release is a no-op if
      // the status already changed).
      await release(`adjudicate-mark-failed:${marked.status}`);
    }
    // The Workers-AI seat votes on every adjudication via the queue.
    await env.REPO_TASKS_QUEUE.send({
      kind: "adjudicate",
      doId: stub.id.toString(),
      repoId,
      intentId,
      seatDid: "did:dg:workers-ai",
    }).catch(() => {});
    return { kind: "conflict", intentId, conflicts: treeMerge.conflicts };
  }

  const treePayload = serializeTree(treeMerge.entries);
  const treeOid = await computeOid("tree", treePayload);
  const commitPayload = buildCommitPayload({
    treeOid,
    parents: [baseOid, intent.deltaOid],
    timestampSec: Math.floor(Date.now() / 1000),
    message: `delta-git merge ${intent.id}\n\nbase:  ${baseOid}\ndelta: ${intent.deltaOid}\n`,
  });
  const mergeOid = await computeOid("commit", commitPayload);

  const objects: NewObject[] = [
    ...treeMerge.newObjects,
    { type: "tree", payload: treePayload, oid: treeOid },
    { type: "commit", payload: commitPayload, oid: mergeOid },
  ];
  const pack = await writeServerPack(objects);
  const packKey = r2PackKey(
    doPrefix(stub.id.toString()),
    `pack-merge-${mergeOid.slice(0, 12)}.pack`
  );
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
    method: "auto",
  });

  if (committed.status === "base_moved") {
    // The intent is still `merging` (commitMergeState returns without a
    // status change on CAS failure); reopen it so a retry merges against
    // the new head.
    await release("base-moved");
    return { kind: "base_moved", intentId, currentOid: committed.currentOid };
  }
  if (committed.status !== "committed") {
    // `intent_state`/`not_found` mean the intent left `merging` under us —
    // another actor owns it now, so there is no lease to release.
    return { kind: "skipped", reason: committed.status };
  }
  // in-toto/DSSE attestation for the committed merge — provenance forever.
  await writeMergeAttestation({
    env,
    doId: stub.id.toString(),
    intentId,
    mergeOid,
    targetRef: intent.targetRef,
    baseOid,
    deltaOid: intent.deltaOid,
    method: "auto",
    voters: [`actor:${actor}`],
  }).catch((error) => log.warn("attest:write-failed", { error: String(error) }));
  // Deploy-on-commit for merge landings on heads refs.
  if (intent.targetRef.startsWith("refs/heads/")) {
    await env.REPO_TASKS_QUEUE.send({
      kind: "deploy",
      doId: stub.id.toString(),
      repoId,
      ref: intent.targetRef,
      sha: mergeOid,
      actor,
    }).catch(() => {});
  }
  return { kind: "merged", intentId, mergeOid };
}

export type MergeDryRunResult = {
  mergeable: boolean;
  conflicts: string[];
  base_oid: string;
  delta_oid: string;
  merge_base_oid?: string;
};

/**
 * Predict whether a delta oid would merge cleanly into a target ref without
 * mutating any state. Agents call this before pushing to decide whether to
 * rebase early.
 */
export async function mergeDryRun(args: {
  env: Env;
  repoId: string;
  targetRef: string;
  baseOid: string;
  deltaOid: string;
  cacheCtx?: CacheContext;
}): Promise<MergeDryRunResult | { error: string }> {
  const { env, repoId, cacheCtx } = args;
  const [oursCommit, theirsCommit] = await Promise.all([
    readCommit(env, repoId, args.baseOid, cacheCtx),
    readCommit(env, repoId, args.deltaOid, cacheCtx),
  ]);
  if (!oursCommit || !theirsCommit) return { error: "missing-commit-objects" };

  const mergeBaseOid = await findMergeBase(env, repoId, args.baseOid, args.deltaOid, cacheCtx);
  const mergeBaseCommit = mergeBaseOid
    ? await readCommit(env, repoId, mergeBaseOid, cacheCtx)
    : undefined;
  const merged = await mergeTrees(
    env,
    repoId,
    "",
    mergeBaseCommit?.tree,
    oursCommit.tree,
    theirsCommit.tree,
    cacheCtx
  );
  if (merged === "too_big") return { error: "merge-too-large" };
  return {
    mergeable: merged.conflicts.length === 0,
    conflicts: merged.conflicts,
    base_oid: args.baseOid,
    delta_oid: args.deltaOid,
    merge_base_oid: mergeBaseOid,
  };
}
