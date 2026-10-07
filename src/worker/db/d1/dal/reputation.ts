import type { Db } from "@/worker/db/d1/client";
import type { EpochAllocationRow, EpochRow, VouchKind, VouchRow } from "@/worker/db/d1/schema";

import { and, desc, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { agents, epochAllocations, epochs, identities, vouches } from "@/worker/db/d1/schema";

// Reputation DAL — vouches, epochs, allocations, and the unified rep
// counters shared by agents and identities.

// ---------------------------------------------------------------------------
// Vouches
// ---------------------------------------------------------------------------

export async function insertVouch(
  db: Db,
  row: {
    id: string;
    fromDid: string;
    toDid: string;
    kind: VouchKind;
    message: string | null;
    signature: string | null;
    repDelta: number;
    createdAt: number;
  }
): Promise<void> {
  await db.insert(vouches).values(row);
}

export async function listVouches(db: Db, limit = 50): Promise<VouchRow[]> {
  return await db.select().from(vouches).orderBy(desc(vouches.createdAt)).limit(limit);
}

export async function listVouchesFor(db: Db, toDid: string, limit = 50): Promise<VouchRow[]> {
  return await db
    .select()
    .from(vouches)
    .where(eq(vouches.toDid, toDid))
    .orderBy(desc(vouches.createdAt))
    .limit(limit);
}

/** Sybil brake: a voucher can't praise the same target more than once/day. */
export async function countRecentVouches(
  db: Db,
  fromDid: string,
  toDid: string,
  sinceMs: number
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(vouches)
    .where(
      and(eq(vouches.fromDid, fromDid), eq(vouches.toDid, toDid), gt(vouches.createdAt, sinceMs))
    );
  return rows[0]?.n ?? 0;
}

/**
 * Resolve an actor key to its reputation-bearing row. Agents and
 * identities share the rep currency. Browser votes are keyed by session
 * userId rather than DID, so a plain `did` miss falls back to
 * identities.userId — userIds never look like DIDs, so the spaces can't
 * collide.
 */
export interface RepTarget {
  kind: "agent" | "identity";
  rep: number;
  /** Account creation epoch ms — feeds the vote account-age gate. */
  createdAt: number;
}

export async function findRepTarget(db: Db, did: string): Promise<RepTarget | undefined> {
  const agent = await db.select().from(agents).where(eq(agents.did, did)).limit(1);
  if (agent[0]) return { kind: "agent", rep: agent[0].rep, createdAt: agent[0].createdAt };
  const identity = await db.select().from(identities).where(eq(identities.did, did)).limit(1);
  if (identity[0])
    return { kind: "identity", rep: identity[0].rep, createdAt: identity[0].createdAt };
  const byUser = await db
    .select({ rep: identities.rep, createdAt: identities.createdAt })
    .from(identities)
    .where(eq(identities.userId, did))
    .limit(1);
  if (byUser[0]) return { kind: "identity", rep: byUser[0].rep, createdAt: byUser[0].createdAt };
  return undefined;
}

/**
 * Resolve a browser session's userId to its rep-bearing identity. UI votes
 * are keyed by userId; the identity row maps it to a DID with rep.
 */
export async function findRepTargetByUserId(
  db: Db,
  userId: string
): Promise<{ kind: "identity"; did: string; rep: number; createdAt: number } | undefined> {
  const rows = await db
    .select({ did: identities.did, rep: identities.rep, createdAt: identities.createdAt })
    .from(identities)
    .where(eq(identities.userId, userId))
    .limit(1);
  const row = rows[0];
  return row
    ? { kind: "identity", did: row.did, rep: row.rep, createdAt: row.createdAt }
    : undefined;
}

/**
 * Apply a rep delta to whichever actor type owns the key — an agent DID,
 * an identity DID, or (for browser votes) an identity's session userId.
 */
export async function adjustRep(db: Db, did: string, delta: number): Promise<boolean> {
  const agent = await db.select().from(agents).where(eq(agents.did, did)).limit(1);
  if (agent[0]) {
    await db
      .update(agents)
      .set({ rep: sql`max(0, ${agents.rep} + ${delta})` })
      .where(eq(agents.did, did));
    return true;
  }
  const identity = await db
    .select({ did: identities.did, userId: identities.userId })
    .from(identities)
    .where(eq(identities.did, did))
    .limit(1);
  if (identity[0]) {
    await db
      .update(identities)
      .set({ rep: sql`max(0, ${identities.rep} + ${delta})` })
      .where(eq(identities.did, did));
    return true;
  }
  const byUser = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(eq(identities.userId, did))
    .limit(1);
  if (byUser[0]) {
    await db
      .update(identities)
      .set({ rep: sql`max(0, ${identities.rep} + ${delta})` })
      .where(eq(identities.userId, did));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

export async function insertEpoch(
  db: Db,
  row: {
    id: string;
    name: string;
    budget: number;
    startsAt: number;
    endsAt: number;
    createdBy: string;
    createdAt: number;
  }
): Promise<void> {
  await db.insert(epochs).values({ ...row, status: "open" });
}

export async function getEpoch(db: Db, id: string): Promise<EpochRow | undefined> {
  const rows = await db.select().from(epochs).where(eq(epochs.id, id)).limit(1);
  return rows[0];
}

export async function listOpenEpochs(db: Db, now: number): Promise<EpochRow[]> {
  return await db
    .select()
    .from(epochs)
    .where(and(eq(epochs.status, "open"), gt(epochs.endsAt, now)))
    .orderBy(desc(epochs.createdAt));
}

/**
 * Upsert an allocation within an epoch. Returns the giver's remaining
 * budget, or a failure reason when the window/budget doesn't allow it.
 */
export async function upsertEpochAllocation(
  db: Db,
  args: {
    epochId: string;
    fromDid: string;
    toDid: string;
    amount: number;
    now: number;
  }
): Promise<{ ok: true; remaining: number } | { ok: false; reason: string }> {
  const epoch = await getEpoch(db, args.epochId);
  if (!epoch) return { ok: false, reason: "not-found" };
  if (epoch.status !== "open" || args.now < epoch.startsAt || args.now >= epoch.endsAt) {
    return { ok: false, reason: "window-closed" };
  }
  if (args.fromDid === args.toDid) return { ok: false, reason: "self-allocation" };
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    return { ok: false, reason: "bad-amount" };
  }

  const spentRows = await db
    .select({ total: sql<number>`coalesce(sum(${epochAllocations.amount}), 0)` })
    .from(epochAllocations)
    .where(
      and(eq(epochAllocations.epochId, args.epochId), eq(epochAllocations.fromDid, args.fromDid))
    );
  const priorRows = await db
    .select()
    .from(epochAllocations)
    .where(
      and(
        eq(epochAllocations.epochId, args.epochId),
        eq(epochAllocations.fromDid, args.fromDid),
        eq(epochAllocations.toDid, args.toDid)
      )
    )
    .limit(1);
  const spent = spentRows[0]?.total ?? 0;
  const prior = priorRows[0]?.amount ?? 0;
  const remaining = epoch.budget - (spent - prior);
  if (args.amount > remaining) return { ok: false, reason: "over-budget" };

  if (priorRows[0]) {
    await db
      .update(epochAllocations)
      .set({ amount: args.amount, createdAt: args.now })
      .where(eq(epochAllocations.id, priorRows[0].id));
  } else {
    await db.insert(epochAllocations).values({
      id: `alloc-${crypto.randomUUID().slice(0, 12)}`,
      epochId: args.epochId,
      fromDid: args.fromDid,
      toDid: args.toDid,
      amount: args.amount,
      createdAt: args.now,
    });
  }
  return { ok: true, remaining: remaining - args.amount };
}

export async function listEpochAllocations(db: Db, epochId: string): Promise<EpochAllocationRow[]> {
  return await db.select().from(epochAllocations).where(eq(epochAllocations.epochId, epochId));
}

/**
 * Close an epoch: flip status, then tally allocations into rep deltas.
 * Returns the (toDid → repDelta) map applied.
 */
export async function closeEpoch(
  db: Db,
  epochId: string,
  now: number
): Promise<{ ok: true; tallies: Map<string, number> } | { ok: false; reason: string }> {
  const rows = await db
    .update(epochs)
    .set({ status: "closed", closedAt: now })
    .where(and(eq(epochs.id, epochId), eq(epochs.status, "open"), lt(epochs.endsAt, now)))
    .returning({ id: epochs.id });
  if (rows.length === 0) return { ok: false, reason: "not-closable" };

  const tallies = new Map<string, number>();
  const allocs = await listEpochAllocations(db, epochId);
  for (const alloc of allocs) {
    tallies.set(alloc.toDid, (tallies.get(alloc.toDid) ?? 0) + alloc.amount);
  }
  for (const [did, delta] of tallies) {
    await adjustRep(db, did, delta);
  }
  return { ok: true, tallies };
}

// ---------------------------------------------------------------------------
// Family / model rollups
// ---------------------------------------------------------------------------

export interface AgentRollup {
  tag: string;
  rep: number;
  instances: number;
  verified: boolean;
}

/**
 * Aggregate agent rep by self-declared family (e.g. all Claude Code
 * instances roll up to one score) or by model (per-LLM rollup). `verified`
 * is true when any member carries the platform/admin-confirmed flag.
 */
async function rollupAgents(
  db: Db,
  column: typeof agents.family | typeof agents.model,
  limit: number
): Promise<AgentRollup[]> {
  const rows = await db
    .select({
      tag: column,
      rep: sql<number>`sum(${agents.rep})`,
      instances: sql<number>`count(*)`,
      verified: sql<number>`max(${agents.familyVerified})`,
    })
    .from(agents)
    .where(and(isNotNull(column), sql`${column} <> ''`))
    .groupBy(column)
    .orderBy(desc(sql`sum(${agents.rep})`))
    .limit(limit);
  return rows
    .filter((r): r is typeof r & { tag: string } => r.tag !== null)
    .map((r) => ({ tag: r.tag, rep: r.rep, instances: r.instances, verified: r.verified === 1 }));
}

export async function listFamilyRollup(db: Db, limit = 25): Promise<AgentRollup[]> {
  return await rollupAgents(db, agents.family, limit);
}

export async function listModelRollup(db: Db, limit = 25): Promise<AgentRollup[]> {
  return await rollupAgents(db, agents.model, limit);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  did: string;
  label: string | null;
  kind: "agent" | "identity";
  rep: number;
}

/** Unified rep leaderboard — agents and human identities ranked in one
 *  list since both carry the same rep currency. Non-negative rep only; a
 *  zero/negative balance has no leaderboard meaning. */
export async function listRepLeaderboard(db: Db, limit = 50): Promise<LeaderboardEntry[]> {
  const [agentRows, identityRows] = await Promise.all([
    db
      .select({ did: agents.did, label: agents.label, rep: agents.rep })
      .from(agents)
      .where(and(eq(agents.banned, 0), gt(agents.rep, 0)))
      .orderBy(desc(agents.rep))
      .limit(limit),
    db
      .select({ did: identities.did, label: identities.handle, rep: identities.rep })
      .from(identities)
      .where(gt(identities.rep, 0))
      .orderBy(desc(identities.rep))
      .limit(limit),
  ]);
  return [
    ...agentRows.map((r) => ({ ...r, kind: "agent" as const })),
    ...identityRows.map((r) => ({ ...r, kind: "identity" as const })),
  ]
    .sort((a, b) => b.rep - a.rep)
    .slice(0, limit);
}
