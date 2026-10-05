import type { MatchEntryRow, MatchRow, MatchVoteRow, WorkspaceRow } from "../db/schema";

import { getDb } from "../db";
import {
  findMatchEntryByWorkspace,
  getMatch,
  getMatchEntry,
  getWorkspace,
  insertMatch,
  insertMatchEntry,
  insertMatchVote,
  insertMergeIntent,
  insertProcessedEvent,
  insertWorkspace,
  listMatchEntries,
  listMatchesByStatus,
  listMatchVotes,
  listOverdueMatches,
  listWorkspacesByStatus,
  recordWorkspacePush,
  transitionMatch,
  updateMatchEntry,
  updateWorkspace,
  upsertPackCatalogRow,
  voterAlreadyVoted,
} from "../db";
import { appendOpLogEntry } from "./oplog";
import { asTypedStorage, type RepoStateSchema, type Ref } from "../repoState";
import { bumpPacksetVersion, ensureRepoMetadataDefaults } from "./shared";
import { deltaRefFor, mergeIntentIdFor, MERGE_INTENT_TTL_MS } from "./diverge";
import type { StagedImportPack } from "./agentApi";

// Arena + workspace coordination state. Rows live in the canonical repo's
// DO SQLite so they share a transaction with refs and merge intents; the
// Worker-facing RPC wrappers live on RepoDurableObject.
//
// Workspace fork names encode the canonical Artifacts repo name
// (`ws-<dg-name>-<rand>`), letting a `cf.artifacts.repo.pushed` event that
// only carries a repo name find its home DO without a global index.

const ZERO_OID = "0".repeat(40);
/** When a resolve task fails, the match re-surfaces after this window. */
const RESOLVE_RETRY_MS = 5 * 60 * 1000;
/** Task workspaces older than this are reaped (namespace quota is finite). */
const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type AttachWorkspaceResult =
  | { status: "attached"; workspace: WorkspaceRow }
  | { status: "exists"; workspace: WorkspaceRow };

export async function attachWorkspaceState(args: {
  ctx: DurableObjectState;
  row: WorkspaceRow;
  actor: string;
}): Promise<AttachWorkspaceResult> {
  const db = getDb(args.ctx.storage);
  const existing = await getWorkspace(db, args.row.artifactsName);
  if (existing) return { status: "exists", workspace: existing };
  await insertWorkspace(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "workspace.attach",
      actor: args.actor,
      payload: {
        artifactsName: args.row.artifactsName,
        ownerDid: args.row.ownerDid,
        workIntentId: args.row.workIntentId,
        matchId: args.row.matchId,
      },
    },
    Date.now()
  );
  return { status: "attached", workspace: args.row };
}

export async function getWorkspaceState(
  ctx: DurableObjectState,
  artifactsName: string
): Promise<WorkspaceRow | undefined> {
  return await getWorkspace(getDb(ctx.storage), artifactsName);
}

/**
 * Record a push observed on a workspace fork (via artifacts event). For
 * task workspaces this also mints a merge intent against the canonical
 * default branch — same divergent-push contract as the receive pipeline.
 * Arena entries only accumulate stats; their winner merges at resolve.
 */
export type RecordWorkspacePushResult =
  | { status: "recorded"; intentId?: string }
  | { status: "unknown-workspace" };

export async function recordWorkspacePushState(args: {
  ctx: DurableObjectState;
  artifactsName: string;
  headOid: string;
  actor: string;
  stagedPack?: StagedImportPack;
}): Promise<RecordWorkspacePushResult> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const workspace = await getWorkspace(db, args.artifactsName);
  if (!workspace) return { status: "unknown-workspace" };

  await recordWorkspacePush(db, args.artifactsName, args.headOid, now);

  const entry = await findMatchEntryByWorkspace(db, args.artifactsName);
  if (entry) {
    await updateMatchEntry(db, entry.id, {
      headOid: args.headOid,
      lastPushAt: now,
      pushCount: entry.pushCount + 1,
      firstPushAt: entry.firstPushAt ?? now,
    });
  }

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
  }

  let intentId: string | undefined;
  if (workspace.kind === "task") {
    // Mirror the divergent-push contract: park the workspace head on a
    // delta ref and mint a merge intent the adjudication layer can claim.
    const head = await store.get("head");
    const targetRef = head?.target ?? "refs/heads/main";
    const deltaRef = deltaRefFor(targetRef, args.headOid);
    intentId = mergeIntentIdFor(targetRef, args.headOid);
    const currentRefs: Ref[] = (await store.get("refs")) || [];
    if (!currentRefs.some((ref) => ref.name === deltaRef)) {
      await store.put("refs", [...currentRefs, { name: deltaRef, oid: args.headOid }]);
      await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
    }
    const baseOid = currentRefs.find((ref) => ref.name === targetRef)?.oid ?? ZERO_OID;
    await insertMergeIntent(db, {
      id: intentId,
      targetRef,
      baseOid,
      deltaRef,
      deltaOid: args.headOid,
      actor: args.actor,
      status: "open",
      conflicts: null,
      resultOid: null,
      createdAt: now,
      expiresAt: now + MERGE_INTENT_TTL_MS,
      resolvedAt: null,
    }).catch(() => {});
  }

  await appendOpLogEntry(
    db,
    {
      kind: "workspace.push",
      actor: args.actor,
      payload: {
        artifactsName: args.artifactsName,
        headOid: args.headOid,
        intentId: intentId ?? null,
        matchId: entry?.matchId ?? null,
      },
    },
    now
  );
  return { status: "recorded", intentId };
}

// ---------------------------------------------------------------------------
// Remote sync (canonical artifacts repo → DO mirror)
// ---------------------------------------------------------------------------

/**
 * Register a fetched pack and reconcile mirror refs/head to the remote's
 * state. Used when a `cf.artifacts.repo.pushed` event lands on the
 * canonical Artifacts repo: the remote is the object authority, so mirror
 * refs converge to exactly what it advertises.
 */
export async function ingestRemoteSyncState(args: {
  ctx: DurableObjectState;
  packs: StagedImportPack[];
  refs: { name: string; oid: string }[];
  head?: { target: string; oid: string };
  actor: string;
}): Promise<{ status: "synced"; refs: number }> {
  const store = asTypedStorage<RepoStateSchema>(args.ctx.storage);
  await ensureRepoMetadataDefaults(store);
  const db = getDb(args.ctx.storage);
  const now = Date.now();

  let seq = (await store.get("nextPackSeq")) || 1;
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
      createdAt: now,
      supersededBy: null,
    });
    seq++;
  }
  if (args.packs.length > 0) {
    await store.put("nextPackSeq", seq);
    await bumpPacksetVersion(store);
  }
  // The remote is authoritative for real refs, but `refs/delta/*` entries
  // are coordination-local (in-flight merge/adjudication work) and must
  // survive a mirror refresh — they only disappear when the merge-out push
  // lands them on the remote or the intent expires.
  const currentRefs: Ref[] = (await store.get("refs")) || [];
  const remoteNames = new Set(args.refs.map((ref: Ref) => ref.name));
  const keptDeltas = currentRefs.filter(
    (ref: Ref) => ref.name.startsWith("refs/delta/") && !remoteNames.has(ref.name)
  );
  await store.put("refs", [...args.refs, ...keptDeltas]);
  await store.put("refsVersion", ((await store.get("refsVersion")) || 0) + 1);
  if (args.head) {
    await store.put("head", args.head);
  }
  await appendOpLogEntry(
    db,
    {
      kind: "artifacts.sync",
      actor: args.actor,
      payload: {
        packs: args.packs.length,
        refs: args.refs.length,
        head: args.head?.target ?? null,
      },
    },
    now
  );
  return { status: "synced", refs: args.refs.length };
}

/** Idempotency check for at-least-once queue deliveries. */
export async function recordProcessedEventState(
  ctx: DurableObjectState,
  eventId: string
): Promise<boolean> {
  return await insertProcessedEvent(getDb(ctx.storage), eventId, Date.now());
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function createMatchState(args: {
  ctx: DurableObjectState;
  row: MatchRow;
  actor: string;
}): Promise<MatchRow> {
  const db = getDb(args.ctx.storage);
  await insertMatch(db, args.row);
  await appendOpLogEntry(
    db,
    {
      kind: "arena.create",
      actor: args.actor,
      payload: {
        id: args.row.id,
        title: args.row.title,
        endsAt: args.row.endsAt,
        prizeRep: args.row.prizeRep,
      },
    },
    Date.now()
  );
  return args.row;
}

export async function getMatchState(
  ctx: DurableObjectState,
  id: string
): Promise<{ match: MatchRow; entries: MatchEntryRow[]; votes: MatchVoteRow[] } | undefined> {
  const db = getDb(ctx.storage);
  const match = await getMatch(db, id);
  if (!match) return undefined;
  const entries = await listMatchEntries(db, id);
  const votes = await listMatchVotes(db, id);
  return { match, entries, votes };
}

export async function listMatchesState(
  ctx: DurableObjectState,
  statuses: string[]
): Promise<MatchRow[]> {
  return await listMatchesByStatus(getDb(ctx.storage), statuses);
}

/**
 * Join a building match. The caller creates the Artifacts fork first and
 * passes its name + a fresh entry id; this call performs the capacity and
 * duplicate checks transactionally and records both rows.
 */
export type EnterMatchResult =
  | { status: "entered" }
  | { status: "not-found" | "closed" | "full" | "duplicate" };

export async function enterMatchState(args: {
  ctx: DurableObjectState;
  matchId: string;
  entryId: string;
  entrantDid: string;
  workspaceName: string;
  actor: string;
}): Promise<EnterMatchResult> {
  const db = getDb(args.ctx.storage);
  const now = Date.now();
  const match = await getMatch(db, args.matchId);
  if (!match) return { status: "not-found" };
  if (match.status !== "building" || (match.endsAt ?? 0) <= now) {
    return { status: "closed" };
  }
  const entries = await listMatchEntries(db, args.matchId);
  if (entries.length >= match.maxEntrants) return { status: "full" };
  if (entries.some((entry) => entry.entrantDid === args.entrantDid)) {
    return { status: "duplicate" };
  }

  const workspaceRow: WorkspaceRow = {
    artifactsName: args.workspaceName,
    kind: "arena",
    ownerDid: args.entrantDid,
    workIntentId: null,
    matchId: args.matchId,
    headOid: null,
    pushCount: 0,
    firstPushAt: null,
    lastPushAt: null,
    status: "open",
    createdAt: now,
  };
  await insertWorkspace(db, workspaceRow);

  const entry: MatchEntryRow = {
    id: args.entryId,
    matchId: args.matchId,
    entrantDid: args.entrantDid,
    workspaceName: args.workspaceName,
    headOid: null,
    pushCount: 0,
    firstPushAt: null,
    lastPushAt: null,
    autoScore: 0,
    voteCount: 0,
    won: 0,
    createdAt: now,
  };
  const inserted = await insertMatchEntry(db, entry);
  if (!inserted) return { status: "duplicate" };

  await appendOpLogEntry(
    db,
    {
      kind: "arena.enter",
      actor: args.actor,
      payload: {
        matchId: args.matchId,
        entryId: args.entryId,
        workspace: args.workspaceName,
      },
    },
    now
  );
  return { status: "entered" };
}

/**
 * Cast a blind vote. The row insert is idempotent per voter; re-votes
 * report duplicate so the client can reveal results without double counts.
 */
export type CastMatchVoteResult =
  | { status: "voted" }
  | { status: "duplicate" | "not-judging" | "bad-entry" | "not-found" };

export async function castMatchVoteState(args: {
  ctx: DurableObjectState;
  matchId: string;
  voterDid: string;
  entryId: string;
  /** Rep escrowed with the vote — recorded here, moved in D1 by the caller. */
  stake?: number;
}): Promise<CastMatchVoteResult> {
  const db = getDb(args.ctx.storage);
  const match = await getMatch(db, args.matchId);
  if (!match) return { status: "not-found" };
  const entry = await getMatchEntry(db, args.entryId);
  if (!entry || entry.matchId !== args.matchId) return { status: "bad-entry" };
  if (await voterAlreadyVoted(db, args.matchId, args.voterDid)) {
    return { status: "duplicate" };
  }
  // Votes count during judging; late votes on resolved matches are ignored.
  if (match.status !== "judging") return { status: "not-judging" };
  const now = Date.now();
  await insertMatchVote(db, {
    matchId: args.matchId,
    voterDid: args.voterDid,
    entryId: args.entryId,
    stake: Math.max(0, Math.floor(args.stake ?? 0)),
    createdAt: now,
  });
  await updateMatchEntry(db, entry.id, { voteCount: entry.voteCount + 1 });
  await appendOpLogEntry(
    db,
    {
      kind: "arena.vote",
      actor: args.voterDid,
      payload: { matchId: args.matchId, entryId: args.entryId },
    },
    now
  );
  return { status: "voted" };
}

/**
 * Resolve a match after the queue-side scoring pass: record per-entry auto
 * scores, mark the winner, flip status → resolved, log it. Called by the
 * `arena-resolve` queue task after it computes composite scores (the task
 * needs Worker-side fetches like preview probes, so scoring lives there;
 * the write lands here transactionally).
 */
/** Stake-settlement summary recorded in the resolve op-log entry so the
 * payout math is part of the auditable record, not just a side effect. */
export interface MatchSettlement {
  pool: number;
  forfeits: number;
  winnerPrize: number;
  voterPoolSeed: number;
  /** voter key → rep returned after resolution (stake back + share). */
  payouts: Record<string, number>;
}

export async function resolveMatchState(args: {
  ctx: DurableObjectState;
  matchId: string;
  winnerEntryId: string | null;
  scores: { entryId: string; autoScore: number; voteCount: number; voteWeight?: number }[];
  settlement?: MatchSettlement;
  actor: string;
}): Promise<{ status: "resolved" | "not-found" | "already-resolved" }> {
  const db = getDb(args.ctx.storage);
  const match = await getMatch(db, args.matchId);
  if (!match) return { status: "not-found" };
  const transitioned = await transitionMatch(db, args.matchId, ["judging", "building"], {
    status: "resolved",
    winnerEntryId: args.winnerEntryId,
  });
  if (!transitioned) return { status: "already-resolved" };
  for (const score of args.scores) {
    const won = score.entryId === args.winnerEntryId ? 1 : 0;
    await updateMatchEntry(db, score.entryId, {
      autoScore: score.autoScore,
      voteCount: score.voteCount,
      won,
    });
  }
  await appendOpLogEntry(
    db,
    {
      kind: "arena.resolve",
      actor: args.actor,
      payload: {
        matchId: args.matchId,
        winnerEntryId: args.winnerEntryId,
        scores: args.scores,
        settlement: args.settlement ?? null,
      },
    },
    Date.now()
  );
  return { status: "resolved" };
}

/**
 * Alarm-driven phase advancement. `building` matches past `ends_at` move to
 * `judging`; `judging` matches past `judge_ends_at` get a `resolve-needed`
 * flag the caller turns into an `arena-resolve` queue message (re-armed
 * every RESOLVE_RETRY_MS until the task lands the transition).
 */
export async function advanceMatchPhasesState(
  ctx: DurableObjectState,
  now: number
): Promise<{ judged: string[]; resolveNeeded: { matchId: string; doName: string }[] }> {
  const db = getDb(ctx.storage);
  const overdue = await listOverdueMatches(db, now);
  const judged: string[] = [];
  const resolveNeeded: { matchId: string; doName: string }[] = [];

  for (const match of overdue) {
    if (match.status === "building" && (match.endsAt ?? 0) <= now) {
      const judgeEndsAt = (match.endsAt ?? now) + match.judgeMinutes * 60 * 1000;
      const ok = await transitionMatch(db, match.id, "building", {
        status: "judging",
        judgeEndsAt,
      });
      if (ok) {
        judged.push(match.id);
        await appendOpLogEntry(
          db,
          {
            kind: "arena.judging",
            actor: "system",
            payload: { matchId: match.id, judgeEndsAt },
          },
          now
        );
      }
    } else if (match.status === "judging" && (match.judgeEndsAt ?? 0) <= now) {
      // Push the deadline forward so the sweep doesn't resend every alarm;
      // the resolve task owns the actual transition.
      const ok = await transitionMatch(db, match.id, "judging", {
        judgeEndsAt: now + RESOLVE_RETRY_MS,
      });
      if (ok) resolveNeeded.push({ matchId: match.id, doName: match.doName });
    }
  }
  return { judged, resolveNeeded };
}

/**
 * Alarm-driven workspace reaper. Two cases end a workspace's life:
 *   - arena workspace whose match resolved/expired, or
 *   - task workspace past WORKSPACE_TTL_MS.
 * The Artifacts fork is deleted (namespace quota is finite) and the row is
 * marked so the sweep doesn't retry. Best-effort: delete failures leave the
 * row open for the next alarm.
 */
export async function sweepWorkspacesState(args: {
  ctx: DurableObjectState;
  env: Env;
  now: number;
}): Promise<number> {
  const artifacts = args.env.ARTIFACTS;
  if (!artifacts) return 0;
  const db = getDb(args.ctx.storage);
  const open = await listWorkspacesByStatus(db, ["open"]);
  let reaped = 0;
  for (const ws of open) {
    let done = false;
    if (ws.matchId) {
      const match = await getMatch(db, ws.matchId);
      done = match?.status === "resolved" || match?.status === "expired";
    } else if (args.now - ws.createdAt > WORKSPACE_TTL_MS) {
      done = true;
    }
    if (!done) continue;
    try {
      await artifacts.delete(ws.artifactsName);
      await updateWorkspace(db, ws.artifactsName, { status: "deleted" });
      await appendOpLogEntry(
        db,
        {
          kind: "workspace.delete",
          actor: "system",
          payload: { artifactsName: ws.artifactsName, matchId: ws.matchId },
        },
        args.now
      );
      reaped++;
    } catch {
      // Best-effort — the next alarm retries.
    }
  }
  return reaped;
}
