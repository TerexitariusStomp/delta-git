import type { Logger } from "@/worker/common/logger";
import type { MergeIntentRow, MergeVoteRow, OpLogRow } from "../db/schema";
import type { RepoStateSchema } from "../repoState";

import {
  claimMergeIntent,
  countOpenIntentsForRef,
  expireMergeIntents,
  getMergeIntent,
  insertMergeVote,
  listMergeIntentsByStatus,
  listMergeVotes,
  listOpLogSince,
  releaseMergeIntent,
  tallyMergeVotes,
  updateMergeIntent,
} from "../db";
import { getDb, listActivePackCatalog, upsertPackCatalogRow } from "../db";
import { appendOpLogEntry } from "./oplog";
import { deltaRefFor } from "./diverge";
import { asTypedStorage } from "../repoState";
import { bumpPacksetVersion, DEFAULT_HEAD, ensureRepoMetadataDefaults } from "./shared";
import { catalogNeedsCompaction, scheduleCompactionWake } from "./compaction/plan";

// Merge + adjudication state transitions (DO side).
//
// All mutations happen inside the repo DO so ref CAS, pack catalog, intent
// status, votes, and the op log commit atomically. Workers orchestrate the
// object work (3-way merge, resolution construction) and call back in here
// to commit outcomes.

export type StagedMergePack = {
  packKey: string;
  packBytes: number;
  idxBytes: number;
  objectCount: number;
};

export type CommitMergeResult =
  | { status: "committed"; mergeOid: string; intent: MergeIntentRow }
  | { status: "base_moved"; currentOid: string; intent: MergeIntentRow }
  | { status: "intent_state"; state: string; message: string }
  | { status: "not_found" };

const ADJUDICATABLE_STATES = new Set(["open", "merging", "adjudicating", "conflict"]);

/**
 * Commit a merge result to the intent's target ref. The CAS on
 * `expectedBaseOid` keeps concurrent merges honest: if the target ref moved
 * since the merge attempt started, the caller retries against the new base
 * rather than clobbering it.
 */
export async function commitMergeState(args: {
  ctx: DurableObjectState;
  env: Env;
  intentId: string;
  expectedBaseOid: string;
  mergeOid: string;
  stagedPack: StagedMergePack;
  actor: string;
  method: "auto" | "adjudicated";
  logger?: Logger;
}): Promise<CommitMergeResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);

  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "not_found" };
  if (!ADJUDICATABLE_STATES.has(intent.status)) {
    return {
      status: "intent_state",
      state: intent.status,
      message: `Merge intent is ${intent.status}, not committable.`,
    };
  }

  const currentRefs = (await store.get("refs")) || [];
  const target = currentRefs.find((ref) => ref.name === intent.targetRef);
  const currentOid = target?.oid ?? "";
  if (currentOid.toLowerCase() !== args.expectedBaseOid.toLowerCase()) {
    return { status: "base_moved", currentOid, intent };
  }

  const nextPackSeq = (await store.get("nextPackSeq")) || 1;
  await upsertPackCatalogRow(db, {
    packKey: args.stagedPack.packKey,
    kind: "receive",
    state: "active",
    tier: 0,
    seqLo: nextPackSeq,
    seqHi: nextPackSeq,
    objectCount: args.stagedPack.objectCount,
    packBytes: args.stagedPack.packBytes,
    idxBytes: args.stagedPack.idxBytes,
    createdAt: Date.now(),
    supersededBy: null,
  });
  await store.put("nextPackSeq", nextPackSeq + 1);
  await bumpPacksetVersion(store);
  const activeCatalog = await listActivePackCatalog(db);
  if (catalogNeedsCompaction(activeCatalog)) {
    await store.put("compactionWantedAt", Date.now());
    await scheduleCompactionWake(args.ctx, args.env);
  }

  const nextRefs = target
    ? currentRefs.map((ref) =>
        ref.name === intent.targetRef ? { name: ref.name, oid: args.mergeOid } : ref
      )
    : [...currentRefs, { name: intent.targetRef, oid: args.mergeOid }];
  await store.put("refs", nextRefs);
  await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);

  const storedHead = await store.get("head");
  const headTarget = storedHead?.target || DEFAULT_HEAD.target;
  if (headTarget === intent.targetRef) {
    await store.put("head", { target: headTarget, oid: args.mergeOid });
  }

  const now = Date.now();
  await updateMergeIntent(db, intent.id, {
    status: "merged",
    resultOid: args.mergeOid,
    resolvedAt: now,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "merge.commit",
      actor: args.actor,
      payload: {
        intentId: intent.id,
        targetRef: intent.targetRef,
        baseOid: args.expectedBaseOid,
        deltaOid: intent.deltaOid,
        mergeOid: args.mergeOid,
        method: args.method,
      },
    },
    now
  );

  args.logger?.info("merge:committed", {
    intentId: intent.id,
    targetRef: intent.targetRef,
    mergeOid: args.mergeOid,
    method: args.method,
  });
  return { status: "committed", mergeOid: args.mergeOid, intent };
}

export type MarkAdjudicatingResult =
  | { status: "ok"; intent: MergeIntentRow }
  | { status: "not_found" }
  | { status: "intent_state"; state: string };

/** Move an intent into adjudication with its conflict path list. */
export async function markMergeAdjudicatingState(args: {
  ctx: DurableObjectState;
  intentId: string;
  conflicts: string[];
  actor: string;
}): Promise<MarkAdjudicatingResult> {
  const db = getDb(args.ctx.storage);
  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "not_found" };
  if (!ADJUDICATABLE_STATES.has(intent.status)) {
    return { status: "intent_state", state: intent.status };
  }
  await updateMergeIntent(db, args.intentId, {
    status: "adjudicating",
    conflicts: JSON.stringify(args.conflicts),
  });
  await appendOpLogEntry(
    db,
    {
      kind: "merge.adjudicating",
      actor: args.actor,
      payload: { intentId: args.intentId, conflicts: args.conflicts },
    },
    Date.now()
  );
  return { status: "ok", intent };
}

export type CastVoteResult =
  | {
      status: "accepted";
      seat: number;
      tallies: { resolutionDigest: string; votes: number }[];
      resolved: boolean;
      winningDigest?: string;
    }
  | { status: "rejected"; reason: string };

/**
 * Record a signed adjudication vote. Seats are server-assigned (next open
 * seat) so a voter can't stuff multiple slots; one vote per (intent, did).
 * When a resolution digest reaches majority the caller is told to resolve.
 */
export async function castMergeVoteState(args: {
  ctx: DurableObjectState;
  intentId: string;
  voterDid: string;
  resolutionDigest: string;
  rationale?: string;
  signature: string;
  quorumK: number;
  winningActor?: string;
}): Promise<CastVoteResult> {
  const db = getDb(args.ctx.storage);
  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "rejected", reason: "intent-not-found" };
  if (intent.status !== "adjudicating") {
    return { status: "rejected", reason: `intent-${intent.status}` };
  }

  const existing = await listMergeVotes(db, args.intentId);
  if (existing.some((vote) => vote.voterDid === args.voterDid)) {
    return { status: "rejected", reason: "duplicate-voter" };
  }
  if (existing.length >= args.quorumK) {
    return { status: "rejected", reason: "quorum-full" };
  }

  const vote: MergeVoteRow = {
    intentId: args.intentId,
    seat: existing.length + 1,
    voterDid: args.voterDid,
    resolutionDigest: args.resolutionDigest,
    rationale: args.rationale ?? null,
    signature: args.signature,
    createdAt: Date.now(),
  };
  await insertMergeVote(db, vote);
  await appendOpLogEntry(
    db,
    {
      kind: "merge.vote",
      actor: args.voterDid,
      payload: {
        intentId: args.intentId,
        seat: vote.seat,
        resolutionDigest: args.resolutionDigest,
      },
    },
    Date.now()
  );

  const tallies = await tallyMergeVotes(db, args.intentId);
  const majority = Math.floor(args.quorumK / 2) + 1;
  const winner = tallies.find((t) => t.votes >= majority);
  if (winner) {
    await updateMergeIntent(db, args.intentId, { status: "conflict" });
    await appendOpLogEntry(
      db,
      {
        kind: "merge.quorum",
        actor: args.winningActor ?? args.voterDid,
        payload: {
          intentId: args.intentId,
          winningDigest: winner.resolutionDigest,
          votes: winner.votes,
          quorumK: args.quorumK,
        },
      },
      Date.now()
    );
    return {
      status: "accepted",
      seat: vote.seat,
      tallies,
      resolved: true,
      winningDigest: winner.resolutionDigest,
    };
  }
  return { status: "accepted", seat: vote.seat, tallies, resolved: false };
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function listMergeIntentsState(
  ctx: DurableObjectState,
  statuses: string[]
): Promise<MergeIntentRow[]> {
  await expireMergeIntents(getDb(ctx.storage), Date.now());
  return await listMergeIntentsByStatus(getDb(ctx.storage), statuses);
}

export async function getMergeIntentState(
  ctx: DurableObjectState,
  id: string
): Promise<MergeIntentRow | undefined> {
  return await getMergeIntent(getDb(ctx.storage), id);
}

export async function listMergeVotesState(
  ctx: DurableObjectState,
  intentId: string
): Promise<MergeVoteRow[]> {
  return await listMergeVotes(getDb(ctx.storage), intentId);
}

export async function listOpLogState(
  ctx: DurableObjectState,
  sinceSeq: number
): Promise<OpLogRow[]> {
  return await listOpLogSince(getDb(ctx.storage), sinceSeq);
}

/** Take a merge lease for a worker-driven merge attempt. */
export async function claimMergeIntentState(
  ctx: DurableObjectState,
  id: string
): Promise<MergeIntentRow | undefined> {
  const db = getDb(ctx.storage);
  await expireMergeIntents(db, Date.now());
  const claimed = await claimMergeIntent(db, id, "merging");
  return claimed ? await getMergeIntent(db, id) : undefined;
}

export type ReleaseMergeIntentResult =
  | { status: "released"; intent: MergeIntentRow }
  | { status: "not_releasable"; state: string }
  | { status: "not_found" };

/**
 * Return a merge lease to `open` after a failed attempt so the intent can be
 * retried (or expire on its own TTL). Safe to call unconditionally: the CAS
 * only flips rows still in `merging`.
 */
export async function releaseMergeIntentState(args: {
  ctx: DurableObjectState;
  intentId: string;
  reason: string;
  actor: string;
}): Promise<ReleaseMergeIntentResult> {
  const db = getDb(args.ctx.storage);
  const released = await releaseMergeIntent(db, args.intentId);
  if (!released) {
    const intent = await getMergeIntent(db, args.intentId);
    return intent ? { status: "not_releasable", state: intent.status } : { status: "not_found" };
  }
  await appendOpLogEntry(
    db,
    {
      kind: "merge.release",
      actor: args.actor,
      payload: { intentId: args.intentId, reason: args.reason },
    },
    Date.now()
  );
  const intent = (await getMergeIntent(db, args.intentId))!;
  return { status: "released", intent };
}

/**
 * Settle an intent whose delta oid is already the target head — the work is
 * landed by definition, so the intent closes as `merged` with no merge
 * commit of its own.
 */
export async function markMergeUpToDateState(args: {
  ctx: DurableObjectState;
  intentId: string;
  actor: string;
}): Promise<MarkAdjudicatingResult> {
  const db = getDb(args.ctx.storage);
  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "not_found" };
  if (!ADJUDICATABLE_STATES.has(intent.status)) {
    return { status: "intent_state", state: intent.status };
  }
  const now = Date.now();
  await updateMergeIntent(db, intent.id, {
    status: "merged",
    resultOid: intent.deltaOid,
    resolvedAt: now,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "merge.up_to_date",
      actor: args.actor,
      payload: {
        intentId: intent.id,
        targetRef: intent.targetRef,
        deltaOid: intent.deltaOid,
      },
    },
    now
  );
  return {
    status: "ok",
    intent: { ...intent, status: "merged", resultOid: intent.deltaOid, resolvedAt: now },
  };
}

export type RejectMergeIntentResult =
  | { status: "rejected"; intent: MergeIntentRow }
  | { status: "not_rejectable"; state: string }
  | { status: "not_found" };

/**
 * User-driven close of a merge intent (the gitness facade's PR close). Only
 * unclaimed intents are rejectable: `merging`/`adjudicating` rows hold a
 * lease owned by the engine/quorum, and terminal rows are already settled.
 * `conflict` stays closeable — a conflicted intent is still open work the
 * author may abandon.
 */
export async function rejectMergeIntentState(args: {
  ctx: DurableObjectState;
  intentId: string;
  actor: string;
}): Promise<RejectMergeIntentResult> {
  const db = getDb(args.ctx.storage);
  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "not_found" };
  if (intent.status !== "open" && intent.status !== "conflict") {
    return { status: "not_rejectable", state: intent.status };
  }
  const now = Date.now();
  await updateMergeIntent(db, intent.id, { status: "rejected", resolvedAt: now });
  await appendOpLogEntry(
    db,
    {
      kind: "merge.reject",
      actor: args.actor,
      payload: { intentId: intent.id, targetRef: intent.targetRef, deltaOid: intent.deltaOid },
    },
    now
  );
  return {
    status: "rejected",
    intent: { ...intent, status: "rejected", resolvedAt: now },
  };
}

export type AdvanceIntentDeltaResult =
  | { status: "advanced"; intent: MergeIntentRow }
  | { status: "not_advancable"; state: string }
  | { status: "not_found" };

/**
 * Move an open intent's delta tip forward — the "push to PR source" write.
 * The caller stages the new tip's objects first (stagedPack registers them
 * in the catalog here), then the delta ref and intent point at the new tip
 * in one transaction. Only unclaimed intents advance; a leased intent is
 * owned by the engine/quorum and must resolve first.
 */
export async function advanceMergeIntentDeltaState(args: {
  ctx: DurableObjectState;
  env: Env;
  intentId: string;
  newOid: string;
  actor: string;
  stagedPack?: StagedMergePack;
}): Promise<AdvanceIntentDeltaResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);
  const intent = await getMergeIntent(db, args.intentId);
  if (!intent) return { status: "not_found" };
  if (intent.status !== "open" && intent.status !== "conflict") {
    return { status: "not_advancable", state: intent.status };
  }

  const now = Date.now();
  if (args.stagedPack) {
    const nextPackSeq = (await store.get("nextPackSeq")) || 1;
    await upsertPackCatalogRow(db, {
      packKey: args.stagedPack.packKey,
      kind: "receive",
      state: "active",
      tier: 0,
      seqLo: nextPackSeq,
      seqHi: nextPackSeq,
      objectCount: args.stagedPack.objectCount,
      packBytes: args.stagedPack.packBytes,
      idxBytes: args.stagedPack.idxBytes,
      createdAt: now,
      supersededBy: null,
    });
    await store.put("nextPackSeq", nextPackSeq + 1);
    await bumpPacksetVersion(store);
    const activeCatalog = await listActivePackCatalog(db);
    if (catalogNeedsCompaction(activeCatalog)) {
      await store.put("compactionWantedAt", Date.now());
      await scheduleCompactionWake(args.ctx, args.env);
    }
  }

  const deltaRef = deltaRefFor(intent.targetRef, args.newOid);
  const currentRefs = (await store.get("refs")) || [];
  if (!currentRefs.some((ref) => ref.name === deltaRef)) {
    await store.put("refs", [...currentRefs, { name: deltaRef, oid: args.newOid }]);
    await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  }
  await updateMergeIntent(db, intent.id, {
    deltaRef,
    deltaOid: args.newOid,
    // An advanced tip re-opens a conflicted intent — the push may carry the
    // resolution.
    status: "open",
    conflicts: null,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "merge.delta_advance",
      actor: args.actor,
      payload: {
        intentId: intent.id,
        targetRef: intent.targetRef,
        deltaRef,
        previousOid: intent.deltaOid,
        deltaOid: args.newOid,
      },
    },
    now
  );
  return {
    status: "advanced",
    intent: { ...intent, deltaRef, deltaOid: args.newOid, status: "open", conflicts: null },
  };
}

export { countOpenIntentsForRef };
