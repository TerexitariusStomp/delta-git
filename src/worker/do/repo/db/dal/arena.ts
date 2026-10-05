import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { MatchEntryRow, MatchRow, MatchVoteRow, WorkspaceRow } from "../schema";

import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { matchEntries, matches, matchVotes, processedEvents, workspaces } from "../schema";

// ---------------------------------------------------------------------------
// Workspaces (Artifacts forks used as agent sandboxes)
// ---------------------------------------------------------------------------

export async function insertWorkspace(
  db: DrizzleSqliteDODatabase,
  row: WorkspaceRow
): Promise<void> {
  await db.insert(workspaces).values(row);
}

export async function getWorkspace(
  db: DrizzleSqliteDODatabase,
  artifactsName: string
): Promise<WorkspaceRow | undefined> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.artifactsName, artifactsName))
    .limit(1);
  return rows[0];
}

export async function updateWorkspace(
  db: DrizzleSqliteDODatabase,
  artifactsName: string,
  patch: Partial<WorkspaceRow>
): Promise<void> {
  await db.update(workspaces).set(patch).where(eq(workspaces.artifactsName, artifactsName));
}

export async function listWorkspacesByStatus(
  db: DrizzleSqliteDODatabase,
  statuses: string[],
  limit = 100
): Promise<WorkspaceRow[]> {
  return await db
    .select()
    .from(workspaces)
    .where(inArray(workspaces.status, statuses))
    .orderBy(asc(workspaces.createdAt))
    .limit(limit);
}

/**
 * Record a push observed on a workspace fork. Bumps stats and tracks the
 * first/last push timestamps used by arena wall-clock scoring.
 */
export async function recordWorkspacePush(
  db: DrizzleSqliteDODatabase,
  artifactsName: string,
  headOid: string,
  now: number
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      headOid,
      lastPushAt: now,
      pushCount: sql`${workspaces.pushCount} + 1`,
      firstPushAt: sql`coalesce(${workspaces.firstPushAt}, ${now})`,
    })
    .where(eq(workspaces.artifactsName, artifactsName));
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export async function insertMatch(db: DrizzleSqliteDODatabase, row: MatchRow): Promise<void> {
  await db.insert(matches).values(row);
}

export async function getMatch(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<MatchRow | undefined> {
  const rows = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  return rows[0];
}

export async function updateMatch(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<MatchRow>
): Promise<void> {
  await db.update(matches).set(patch).where(eq(matches.id, id));
}

/** Conditional status transition — returns false if the row moved already. */
export async function transitionMatch(
  db: DrizzleSqliteDODatabase,
  id: string,
  from: string | string[],
  patch: Partial<MatchRow>
): Promise<boolean> {
  const rows = await db
    .update(matches)
    .set(patch)
    .where(and(eq(matches.id, id), inArray(matches.status, Array.isArray(from) ? from : [from])))
    .returning({ id: matches.id });
  return rows.length > 0;
}

export async function listMatchesByStatus(
  db: DrizzleSqliteDODatabase,
  statuses: string[],
  limit = 100
): Promise<MatchRow[]> {
  return await db
    .select()
    .from(matches)
    .where(inArray(matches.status, statuses))
    .orderBy(asc(matches.createdAt))
    .limit(limit);
}

/**
 * Earliest pending deadline across live matches — the next alarm-worthy
 * timestamp for the match lifecycle. Null when nothing is scheduled.
 */
export async function nextMatchDeadline(db: DrizzleSqliteDODatabase): Promise<number | null> {
  const rows = await db
    .select({
      deadline: sql<number | null>`min(coalesce(
        case when ${matches.status} = 'building' then ${matches.endsAt} end,
        case when ${matches.status} = 'judging' then ${matches.judgeEndsAt} end
      ))`,
    })
    .from(matches)
    .where(inArray(matches.status, ["building", "judging"]));
  return rows[0]?.deadline ?? null;
}

/** Matches whose current-phase deadline has passed. */
export async function listOverdueMatches(
  db: DrizzleSqliteDODatabase,
  now: number
): Promise<MatchRow[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        inArray(matches.status, ["building", "judging"]),
        lt(
          sql`coalesce(
          case when ${matches.status} = 'building' then ${matches.endsAt} end,
          case when ${matches.status} = 'judging' then ${matches.judgeEndsAt} end
        )`,
          now
        )
      )
    );
  return rows;
}

// ---------------------------------------------------------------------------
// Match entries
// ---------------------------------------------------------------------------

export async function insertMatchEntry(
  db: DrizzleSqliteDODatabase,
  row: MatchEntryRow
): Promise<boolean> {
  const rows = await db.insert(matchEntries).values(row).onConflictDoNothing().returning();
  return rows.length > 0;
}

export async function getMatchEntry(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<MatchEntryRow | undefined> {
  const rows = await db.select().from(matchEntries).where(eq(matchEntries.id, id)).limit(1);
  return rows[0];
}

export async function listMatchEntries(
  db: DrizzleSqliteDODatabase,
  matchId: string
): Promise<MatchEntryRow[]> {
  return await db
    .select()
    .from(matchEntries)
    .where(eq(matchEntries.matchId, matchId))
    .orderBy(asc(matchEntries.createdAt));
}

export async function updateMatchEntry(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<MatchEntryRow>
): Promise<void> {
  await db.update(matchEntries).set(patch).where(eq(matchEntries.id, id));
}

export async function findMatchEntryByWorkspace(
  db: DrizzleSqliteDODatabase,
  workspaceName: string
): Promise<MatchEntryRow | undefined> {
  const rows = await db
    .select()
    .from(matchEntries)
    .where(eq(matchEntries.workspaceName, workspaceName))
    .limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Match votes
// ---------------------------------------------------------------------------

/** One vote per voter per match; returns false when the voter already voted. */
export async function insertMatchVote(
  db: DrizzleSqliteDODatabase,
  row: MatchVoteRow
): Promise<boolean> {
  const rows = await db.insert(matchVotes).values(row).onConflictDoNothing().returning();
  return rows.length > 0;
}

export async function listMatchVotes(
  db: DrizzleSqliteDODatabase,
  matchId: string
): Promise<MatchVoteRow[]> {
  return await db.select().from(matchVotes).where(eq(matchVotes.matchId, matchId));
}

export async function voterAlreadyVoted(
  db: DrizzleSqliteDODatabase,
  matchId: string,
  voterDid: string
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(matchVotes)
    .where(and(eq(matchVotes.matchId, matchId), eq(matchVotes.voterDid, voterDid)))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Processed queue events (idempotency)
// ---------------------------------------------------------------------------

/** Returns true the first time `eventId` is recorded; false on replays. */
export async function insertProcessedEvent(
  db: DrizzleSqliteDODatabase,
  eventId: string,
  now: number
): Promise<boolean> {
  const rows = await db
    .insert(processedEvents)
    .values({ eventId, createdAt: now })
    .onConflictDoNothing()
    .returning({ eventId: processedEvents.eventId });
  return rows.length > 0;
}
