import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type {
  CommitStatusRow,
  MergeIntentRow,
  MergeVoteRow,
  OpLogRow,
  RepoSecretRow,
  WebhookSubRow,
  WorkIntentRow,
} from "../schema";

import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  commitStatus,
  mergeIntents,
  mergeVotes,
  opLog,
  repoSecrets,
  webhookSubs,
  workIntents,
} from "../schema";

// ---------------------------------------------------------------------------
// Merge intents
// ---------------------------------------------------------------------------

export async function insertMergeIntent(
  db: DrizzleSqliteDODatabase,
  row: MergeIntentRow
): Promise<void> {
  await db.insert(mergeIntents).values(row);
}

export async function getMergeIntent(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<MergeIntentRow | undefined> {
  const rows = await db.select().from(mergeIntents).where(eq(mergeIntents.id, id)).limit(1);
  return rows[0];
}

export async function listMergeIntentsByStatus(
  db: DrizzleSqliteDODatabase,
  statuses: string[],
  limit = 100
): Promise<MergeIntentRow[]> {
  return await db
    .select()
    .from(mergeIntents)
    .where(inArray(mergeIntents.status, statuses))
    .orderBy(asc(mergeIntents.createdAt))
    .limit(limit);
}

export async function updateMergeIntent(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<MergeIntentRow>
): Promise<void> {
  await db.update(mergeIntents).set(patch).where(eq(mergeIntents.id, id));
}

/** Claim an open intent for adjudication/merging; returns false if already taken. */
export async function claimMergeIntent(
  db: DrizzleSqliteDODatabase,
  id: string,
  status: string
): Promise<boolean> {
  const rows = await db
    .update(mergeIntents)
    .set({ status })
    .where(and(eq(mergeIntents.id, id), eq(mergeIntents.status, "open")))
    .returning({ id: mergeIntents.id });
  return rows.length > 0;
}

/** Expire open intents whose deadline passed. Returns affected ids. */
export async function expireMergeIntents(
  db: DrizzleSqliteDODatabase,
  now: number
): Promise<string[]> {
  const rows = await db
    .update(mergeIntents)
    .set({ status: "expired" })
    .where(and(eq(mergeIntents.status, "open"), lt(mergeIntents.expiresAt, now)))
    .returning({ id: mergeIntents.id });
  return rows.map((r) => r.id);
}

/** Count intents that are not yet resolved toward a target ref (flood control). */
export async function countOpenIntentsForRef(
  db: DrizzleSqliteDODatabase,
  targetRef: string
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(mergeIntents)
    .where(
      and(
        eq(mergeIntents.targetRef, targetRef),
        inArray(mergeIntents.status, ["open", "merging", "adjudicating"])
      )
    );
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Merge votes
// ---------------------------------------------------------------------------

export async function insertMergeVote(
  db: DrizzleSqliteDODatabase,
  row: MergeVoteRow
): Promise<void> {
  await db.insert(mergeVotes).values(row).onConflictDoNothing();
}

export async function listMergeVotes(
  db: DrizzleSqliteDODatabase,
  intentId: string
): Promise<MergeVoteRow[]> {
  return await db
    .select()
    .from(mergeVotes)
    .where(eq(mergeVotes.intentId, intentId))
    .orderBy(asc(mergeVotes.seat));
}

/** Tally votes by resolution digest for quorum decisions. */
export async function tallyMergeVotes(
  db: DrizzleSqliteDODatabase,
  intentId: string
): Promise<{ resolutionDigest: string; votes: number }[]> {
  return await db
    .select({
      resolutionDigest: mergeVotes.resolutionDigest,
      votes: sql<number>`count(*)`,
    })
    .from(mergeVotes)
    .where(eq(mergeVotes.intentId, intentId))
    .groupBy(mergeVotes.resolutionDigest)
    .orderBy(desc(sql`count(*)`));
}

// ---------------------------------------------------------------------------
// Op log (append-only, hash-chained)
// ---------------------------------------------------------------------------

export async function getLatestOpLogRow(
  db: DrizzleSqliteDODatabase
): Promise<OpLogRow | undefined> {
  const rows = await db.select().from(opLog).orderBy(desc(opLog.seq)).limit(1);
  return rows[0];
}

export async function appendOpLog(
  db: DrizzleSqliteDODatabase,
  row: OpLogRow
): Promise<void> {
  await db.insert(opLog).values(row);
}

export async function listOpLogSince(
  db: DrizzleSqliteDODatabase,
  seq: number,
  limit = 200
): Promise<OpLogRow[]> {
  return await db
    .select()
    .from(opLog)
    .where(gt(opLog.seq, seq))
    .orderBy(asc(opLog.seq))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Work intents
// ---------------------------------------------------------------------------

export async function insertWorkIntent(
  db: DrizzleSqliteDODatabase,
  row: WorkIntentRow
): Promise<void> {
  await db.insert(workIntents).values(row);
}

export async function getWorkIntent(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<WorkIntentRow | undefined> {
  const rows = await db.select().from(workIntents).where(eq(workIntents.id, id)).limit(1);
  return rows[0];
}

export async function listOpenWorkIntents(
  db: DrizzleSqliteDODatabase,
  limit = 100
): Promise<WorkIntentRow[]> {
  return await db
    .select()
    .from(workIntents)
    .where(eq(workIntents.status, "open"))
    .orderBy(asc(workIntents.createdAt))
    .limit(limit);
}

export async function updateWorkIntent(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<WorkIntentRow>
): Promise<void> {
  await db.update(workIntents).set(patch).where(eq(workIntents.id, id));
}

// ---------------------------------------------------------------------------
// Commit statuses
// ---------------------------------------------------------------------------

export async function upsertCommitStatus(
  db: DrizzleSqliteDODatabase,
  row: CommitStatusRow
): Promise<void> {
  await db.insert(commitStatus).values(row).onConflictDoUpdate({
    target: [commitStatus.sha, commitStatus.context],
    set: {
      state: row.state,
      description: row.description,
      targetUrl: row.targetUrl,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    },
  });
}

export async function listCommitStatuses(
  db: DrizzleSqliteDODatabase,
  sha: string
): Promise<CommitStatusRow[]> {
  return await db
    .select()
    .from(commitStatus)
    .where(eq(commitStatus.sha, sha))
    .orderBy(desc(commitStatus.createdAt));
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------

export async function insertWebhookSub(
  db: DrizzleSqliteDODatabase,
  row: WebhookSubRow
): Promise<void> {
  await db.insert(webhookSubs).values(row);
}

export async function listActiveWebhookSubs(
  db: DrizzleSqliteDODatabase
): Promise<WebhookSubRow[]> {
  return await db.select().from(webhookSubs).where(eq(webhookSubs.active, 1));
}

export async function setWebhookSubActive(
  db: DrizzleSqliteDODatabase,
  id: string,
  active: boolean
): Promise<void> {
  await db
    .update(webhookSubs)
    .set({ active: active ? 1 : 0 })
    .where(eq(webhookSubs.id, id));
}

// ---------------------------------------------------------------------------
// Repo secrets (write-only contract; ciphertext only)
// ---------------------------------------------------------------------------

export async function upsertRepoSecret(
  db: DrizzleSqliteDODatabase,
  row: RepoSecretRow
): Promise<void> {
  await db.insert(repoSecrets).values(row).onConflictDoUpdate({
    target: [repoSecrets.name],
    set: {
      ciphertext: row.ciphertext,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
    },
  });
}

export async function listRepoSecretMeta(
  db: DrizzleSqliteDODatabase
): Promise<{ name: string; createdAt: number; updatedAt: number }[]> {
  return await db
    .select({
      name: repoSecrets.name,
      createdAt: repoSecrets.createdAt,
      updatedAt: repoSecrets.updatedAt,
    })
    .from(repoSecrets)
    .orderBy(asc(repoSecrets.name));
}

/** Internal-only: fetch ciphertexts for deploy-time injection. Never expose over HTTP. */
export async function listRepoSecretCiphertexts(
  db: DrizzleSqliteDODatabase
): Promise<{ name: string; ciphertext: string }[]> {
  return await db
    .select({ name: repoSecrets.name, ciphertext: repoSecrets.ciphertext })
    .from(repoSecrets);
}
