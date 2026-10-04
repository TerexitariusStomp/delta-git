import type {
  CommitStatusRow,
  MergeIntentRow,
  MergeVoteRow,
  WebhookSubRow,
  WorkIntentRow,
} from "../db/schema";
import type { RepoStateSchema } from "../repoState";

import { deltaRefFor, mergeIntentIdFor, MERGE_INTENT_TTL_MS } from "./diverge";
import {
  getDb,
  getWorkIntent,
  insertMergeIntent,
  insertMergeVote,
  insertWebhookSub,
  insertWorkIntent,
  listActiveWebhookSubs,
  listCommitStatuses,
  listMergeVotes,
  listOpenWorkIntents,
  listRepoSecretMeta,
  listWorkIntentsByKind,
  tallyMergeVotes,
  updateWorkIntent,
  upsertCommitStatus,
  upsertPackCatalogRow,
  upsertRepoSecret,
  listRepoSecretCiphertexts,
} from "../db";
import { appendOpLogEntry } from "./oplog";
import { asTypedStorage } from "../repoState";
import { bumpPacksetVersion, ensureRepoMetadataDefaults } from "./shared";
import { catalogNeedsCompaction, scheduleCompactionWake } from "./compaction/plan";
import { listActivePackCatalog } from "../db";
import type { StagedMergePack } from "./merge";

// Remaining agent-layer DO state: commit statuses, webhook subscriptions,
// repo secrets (ciphertext only), work intents, and server-side patch
// acceptance (delta ref + merge intent minting without a client push).

const ZERO_OID = "0".repeat(40);

export type AcceptPatchResult =
  | { status: "accepted"; intent: MergeIntentRow }
  | { status: "exists"; intent: MergeIntentRow };

/**
 * Land a server-constructed commit as a delta ref + merge intent. Used by
 * the /patch endpoint and importer flows where the commit was built in the
 * worker rather than pushed by a git client.
 *
 * `stagedPack` registers the caller-uploaded pack holding the new objects
 * in the pack catalog — without it the delta ref would point at objects the
 * object store cannot see, and every merge attempt would fail with
 * missing-commit-objects while holding a lease.
 */
export async function acceptPatchCommitState(args: {
  ctx: DurableObjectState;
  env: Env;
  targetRef: string;
  newOid: string;
  actor: string;
  kind: string;
  stagedPack?: StagedMergePack;
}): Promise<AcceptPatchResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);
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

  const currentRefs = (await store.get("refs")) || [];
  const deltaRef = deltaRefFor(args.targetRef, args.newOid);
  const intentId = mergeIntentIdFor(args.targetRef, args.newOid);
  const baseOid = currentRefs.find((ref) => ref.name === args.targetRef)?.oid ?? ZERO_OID;

  if (!currentRefs.some((ref) => ref.name === deltaRef)) {
    await store.put("refs", [...currentRefs, { name: deltaRef, oid: args.newOid }]);
    await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  }

  const intent: MergeIntentRow = {
    id: intentId,
    targetRef: args.targetRef,
    baseOid,
    deltaRef,
    deltaOid: args.newOid,
    actor: args.actor,
    status: "open",
    conflicts: null,
    resultOid: null,
    createdAt: now,
    expiresAt: now + MERGE_INTENT_TTL_MS,
    resolvedAt: null,
  };
  await insertMergeIntent(db, intent).catch(() => {});
  await appendOpLogEntry(
    db,
    {
      kind: args.kind,
      actor: args.actor,
      payload: {
        intentId,
        targetRef: args.targetRef,
        deltaRef,
        baseOid,
        deltaOid: args.newOid,
      },
    },
    now
  );
  return { status: "accepted", intent };
}

export async function setCommitStatusState(args: {
  ctx: DurableObjectState;
  row: CommitStatusRow;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  await upsertCommitStatus(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "status.set",
      actor: args.actor,
      payload: { sha: args.row.sha, context: args.row.context, state: args.row.state },
    },
    Date.now()
  );
}

export async function getCommitStatusesState(
  ctx: DurableObjectState,
  sha: string
): Promise<CommitStatusRow[]> {
  return await listCommitStatuses(getDb(ctx.storage), sha);
}

export async function addWebhookSubState(args: {
  ctx: DurableObjectState;
  row: WebhookSubRow;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  await insertWebhookSub(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "webhook.add",
      actor: args.actor,
      payload: { id: args.row.id, url: args.row.url, events: args.row.events },
    },
    Date.now()
  );
}

export async function listWebhookSubsState(ctx: DurableObjectState): Promise<WebhookSubRow[]> {
  return await listActiveWebhookSubs(getDb(ctx.storage));
}

export async function putRepoSecretState(args: {
  ctx: DurableObjectState;
  name: string;
  ciphertext: string;
  actor: string;
}): Promise<void> {
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  await upsertRepoSecret(db, {
    name: args.name,
    ciphertext: args.ciphertext,
    createdBy: args.actor,
    createdAt: now,
    updatedAt: now,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "secret.set",
      actor: args.actor,
      payload: { name: args.name },
    },
    now
  );
}

export async function listRepoSecretsMetaState(
  ctx: DurableObjectState
): Promise<{ name: string; createdAt: number; updatedAt: number }[]> {
  return await listRepoSecretMeta(getDb(ctx.storage));
}

/** Deploy-time only: returns ciphertexts for binding injection. Never HTTP. */
export async function listRepoSecretCiphertextsState(
  ctx: DurableObjectState
): Promise<{ name: string; ciphertext: string }[]> {
  return await listRepoSecretCiphertexts(getDb(ctx.storage));
}

export async function listWorkIntentsState(ctx: DurableObjectState): Promise<WorkIntentRow[]> {
  return await listOpenWorkIntents(getDb(ctx.storage));
}

export type ImportPackResult = { status: "imported" } | { status: "not_empty"; refs: number };

/**
 * Register a pack fetched from an external remote and set the repo's refs.
 * Only permitted on an empty repo (no refs) so imports can't clobber
 * existing history — the agent equivalent of `git clone` into a fresh repo.
 * The pack bytes and idx must already be staged in R2 at packKey.
 */
export type StagedImportPack = {
  packKey: string;
  packBytes: number;
  idxBytes: number;
  objectCount: number;
};

export async function importPackState(args: {
  ctx: DurableObjectState;
  packs: StagedImportPack[];
  refs: { name: string; oid: string }[];
  head: { target: string; oid: string };
  actor: string;
}): Promise<ImportPackResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);

  const existing = ((await store.get("refs")) || []).filter((ref) => ref.name.startsWith("refs/"));
  if (existing.length > 0) return { status: "not_empty", refs: existing.length };

  let seq = (await store.get("nextPackSeq")) || 1;
  let totalObjects = 0;
  for (const pack of args.packs) {
    await upsertPackCatalogRow(db, {
      packKey: pack.packKey,
      kind: "receive",
      state: "active",
      tier: 0,
      seqLo: seq,
      seqHi: seq,
      objectCount: pack.objectCount,
      packBytes: pack.packBytes,
      idxBytes: pack.idxBytes,
      createdAt: Date.now(),
      supersededBy: null,
    });
    totalObjects += pack.objectCount;
    seq++;
  }
  await store.put("nextPackSeq", seq);
  await bumpPacksetVersion(store);
  await store.put("refs", args.refs);
  await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  await store.put("head", args.head);
  await appendOpLogEntry(
    db,
    {
      kind: "repo.import",
      actor: args.actor,
      payload: {
        packs: args.packs.length,
        refs: args.refs.length,
        head: args.head.target,
        objects: totalObjects,
      },
    },
    Date.now()
  );
  return { status: "imported" };
}

/** Post a claimable work item (PostEarn-style bounty lane, minus payout). */
export async function createWorkIntentState(args: {
  ctx: DurableObjectState;
  row: WorkIntentRow;
  actor: string;
}): Promise<WorkIntentRow> {
  const db = getDb(args.ctx.storage);
  await insertWorkIntent(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "work.post",
      actor: args.actor,
      payload: { id: args.row.id, title: args.row.title },
    },
    Date.now()
  );
  return args.row;
}

const WORK_CLAIM_MS = 30 * 60 * 1000;

/**
 * Claim an open work intent under a short lease. Expired claims reopen so
 * abandoned work returns to the pool — same lease discipline as receives.
 */
export async function claimWorkIntentState(args: {
  ctx: DurableObjectState;
  id: string;
  actor: string;
}): Promise<{ status: "claimed"; row: WorkIntentRow } | { status: "unavailable" }> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.id);
  if (!row) return { status: "unavailable" };
  const now = Date.now();
  const claimLive = row.claimExpiresAt != null && row.claimExpiresAt > now;
  if (row.status !== "open" && claimLive) return { status: "unavailable" };
  const next: WorkIntentRow = {
    ...row,
    status: "claimed",
    claimedBy: args.actor,
    claimExpiresAt: now + WORK_CLAIM_MS,
  };
  await updateWorkIntent(db, args.id, {
    status: "claimed",
    claimedBy: args.actor,
    claimExpiresAt: next.claimExpiresAt,
  });
  await appendOpLogEntry(
    db,
    {
      kind: "work.claim",
      actor: args.actor,
      payload: { id: args.id },
    },
    now
  );
  return { status: "claimed", row: next };
}

/** Close a work intent (its claimant or its poster may close it). */
export async function closeWorkIntentState(args: {
  ctx: DurableObjectState;
  id: string;
  actor: string;
}): Promise<{ status: "closed" } | { status: "unavailable" }> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.id);
  if (!row) return { status: "unavailable" };
  if (row.status === "claimed" && row.claimedBy !== args.actor && row.createdBy !== args.actor) {
    return { status: "unavailable" };
  }
  await updateWorkIntent(db, args.id, { status: "closed", closedAt: Date.now() });
  await appendOpLogEntry(
    db,
    {
      kind: "work.close",
      actor: args.actor,
      payload: { id: args.id },
    },
    Date.now()
  );
  return { status: "closed" };
}

/** List work intents of a kind across all statuses (ideas/verify boards). */
export async function listWorkIntentsByKindState(
  ctx: DurableObjectState,
  kind: string
): Promise<WorkIntentRow[]> {
  return await listWorkIntentsByKind(getDb(ctx.storage), kind);
}

export async function getWorkIntentState(
  ctx: DurableObjectState,
  id: string
): Promise<WorkIntentRow | undefined> {
  return await getWorkIntent(getDb(ctx.storage), id);
}

/** Record an outcome against a work intent without closing it (specs,
 *  progress notes, landed-shares). */
export async function updateWorkIntentResultState(args: {
  ctx: DurableObjectState;
  id: string;
  result: string;
  actor: string;
}): Promise<{ status: "ok" } | { status: "unavailable" }> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.id);
  if (!row) return { status: "unavailable" };
  await updateWorkIntent(db, args.id, { result: args.result });
  await appendOpLogEntry(
    db,
    {
      kind: "work.result",
      actor: args.actor,
      payload: { id: args.id },
    },
    Date.now()
  );
  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// Work-intent verification votes ("verify by quorum")
// ---------------------------------------------------------------------------
// Verification reuses the merge_votes quorum machinery with intent ids of
// the form `work:<id>` — same seat/dedup/tally semantics as merge
// adjudication, no merge_intents row required. A work intent flips to
// `verified` once a digest reaches majority.

export type CastWorkVoteResult =
  | { status: "accepted"; seat: number; resolved: boolean }
  | { status: "rejected"; reason: string };

export async function castWorkVoteState(args: {
  ctx: DurableObjectState;
  workIntentId: string;
  voterDid: string;
  resolutionDigest: string;
  rationale?: string;
  signature: string;
  quorumK: number;
}): Promise<CastWorkVoteResult> {
  const db = getDb(args.ctx.storage);
  const row = await getWorkIntent(db, args.workIntentId);
  if (!row) return { status: "rejected", reason: "intent-not-found" };
  if (row.status === "closed" || row.status === "verified") {
    return { status: "rejected", reason: `intent-${row.status}` };
  }

  const voteKey = `work:${args.workIntentId}`;
  const existing = await listMergeVotes(db, voteKey);
  if (existing.some((vote) => vote.voterDid === args.voterDid)) {
    return { status: "rejected", reason: "duplicate-voter" };
  }
  if (existing.length >= args.quorumK) {
    return { status: "rejected", reason: "quorum-full" };
  }

  const vote: MergeVoteRow = {
    intentId: voteKey,
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
      kind: "work.vote",
      actor: args.voterDid,
      payload: { id: args.workIntentId, seat: vote.seat, resolutionDigest: args.resolutionDigest },
    },
    Date.now()
  );

  const tallies = await tallyMergeVotes(db, voteKey);
  const majority = Math.floor(args.quorumK / 2) + 1;
  const winner = tallies.find((t) => t.votes >= majority);
  if (winner) {
    await updateWorkIntent(db, args.workIntentId, {
      status: "verified",
      closedAt: Date.now(),
      result: row.result ?? `verified:${winner.resolutionDigest}`,
    });
    await appendOpLogEntry(
      db,
      {
        kind: "work.verified",
        actor: args.voterDid,
        payload: {
          id: args.workIntentId,
          winningDigest: winner.resolutionDigest,
          votes: winner.votes,
          quorumK: args.quorumK,
        },
      },
      Date.now()
    );
    return { status: "accepted", seat: vote.seat, resolved: true };
  }
  return { status: "accepted", seat: vote.seat, resolved: false };
}

export async function listWorkVotesState(
  ctx: DurableObjectState,
  workIntentId: string
): Promise<MergeVoteRow[]> {
  return await listMergeVotes(getDb(ctx.storage), `work:${workIntentId}`);
}
