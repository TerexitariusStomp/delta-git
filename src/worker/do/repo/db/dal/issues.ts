import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type {
  IssueRow,
  IssueCommentRow,
  IssueAssigneeRow,
  LabelRow,
  MilestoneRow,
  ReactionRow,
} from "../schema";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  issues,
  issueComments,
  issueAssignees,
  issueLabels,
  labels,
  milestones,
  reactions,
} from "../schema";

// ---------------------------------------------------------------------------
// Issues — GitHub-shaped tracker rows. Every issue also materializes a
// work_intents row (kind='issue'); that link is written by the state layer
// in catalog/issues.ts, not here.
// ---------------------------------------------------------------------------

export async function insertIssue(db: DrizzleSqliteDODatabase, row: IssueRow): Promise<void> {
  await db.insert(issues).values(row);
}

export async function getIssueById(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<IssueRow | undefined> {
  const rows = await db.select().from(issues).where(eq(issues.id, id)).limit(1);
  return rows[0];
}

export async function getIssueByNumber(
  db: DrizzleSqliteDODatabase,
  number: number
): Promise<IssueRow | undefined> {
  const rows = await db.select().from(issues).where(eq(issues.number, number)).limit(1);
  return rows[0];
}

/** Next per-repo issue number — callers run inside the DO's serialized RPC. */
export async function nextIssueNumber(db: DrizzleSqliteDODatabase): Promise<number> {
  const rows = await db.select({ n: sql<number>`max(${issues.number})` }).from(issues);
  return (rows[0]?.n ?? 0) + 1;
}

export async function listIssues(
  db: DrizzleSqliteDODatabase,
  args: { state?: "open" | "closed"; limit?: number }
): Promise<IssueRow[]> {
  const limit = args.limit ?? 100;
  if (args.state) {
    return await db
      .select()
      .from(issues)
      .where(eq(issues.state, args.state))
      .orderBy(desc(issues.number))
      .limit(limit);
  }
  return await db.select().from(issues).orderBy(desc(issues.number)).limit(limit);
}

export async function updateIssue(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<IssueRow>
): Promise<void> {
  await db.update(issues).set(patch).where(eq(issues.id, id));
}

export async function countIssues(
  db: DrizzleSqliteDODatabase,
  state?: "open" | "closed"
): Promise<number> {
  const sel = db.select({ n: sql<number>`count(*)` }).from(issues);
  const rows = state ? await sel.where(eq(issues.state, state)) : await sel;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Issue comments
// ---------------------------------------------------------------------------

export async function insertIssueComment(
  db: DrizzleSqliteDODatabase,
  row: IssueCommentRow
): Promise<void> {
  await db.insert(issueComments).values(row);
}

export async function getIssueComment(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<IssueCommentRow | undefined> {
  const rows = await db.select().from(issueComments).where(eq(issueComments.id, id)).limit(1);
  return rows[0];
}

export async function listIssueComments(
  db: DrizzleSqliteDODatabase,
  issueId: string,
  limit = 200
): Promise<IssueCommentRow[]> {
  return await db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(asc(issueComments.createdAt))
    .limit(limit);
}

export async function updateIssueComment(
  db: DrizzleSqliteDODatabase,
  id: string,
  body: string,
  updatedAt: number
): Promise<void> {
  await db.update(issueComments).set({ body, updatedAt }).where(eq(issueComments.id, id));
}

export async function deleteIssueComment(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(issueComments).where(eq(issueComments.id, id));
}

export async function countIssueComments(
  db: DrizzleSqliteDODatabase,
  issueId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId));
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

export async function replaceIssueAssignees(
  db: DrizzleSqliteDODatabase,
  issueId: string,
  assignees: string[],
  createdAt: number
): Promise<void> {
  await db.delete(issueAssignees).where(eq(issueAssignees.issueId, issueId));
  for (const assignee of assignees) {
    await db.insert(issueAssignees).values({ issueId, assignee, createdAt });
  }
}

export async function listIssueAssignees(
  db: DrizzleSqliteDODatabase,
  issueId: string
): Promise<IssueAssigneeRow[]> {
  return await db
    .select()
    .from(issueAssignees)
    .where(eq(issueAssignees.issueId, issueId))
    .orderBy(asc(issueAssignees.createdAt));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function insertLabel(db: DrizzleSqliteDODatabase, row: LabelRow): Promise<void> {
  await db.insert(labels).values(row);
}

export async function getLabelByName(
  db: DrizzleSqliteDODatabase,
  name: string
): Promise<LabelRow | undefined> {
  const rows = await db.select().from(labels).where(eq(labels.name, name)).limit(1);
  return rows[0];
}

export async function listLabels(db: DrizzleSqliteDODatabase, limit = 200): Promise<LabelRow[]> {
  return await db.select().from(labels).orderBy(asc(labels.name)).limit(limit);
}

export async function deleteLabel(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(labels).where(eq(labels.id, id));
}

/** Resolve display labels for a set of issues in one query per side. */
export async function listIssueLabels(
  db: DrizzleSqliteDODatabase,
  issueId: string
): Promise<LabelRow[]> {
  const links = await db
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, issueId));
  if (links.length === 0) return [];
  return await db
    .select()
    .from(labels)
    .where(
      inArray(
        labels.id,
        links.map((l) => l.labelId)
      )
    );
}

export async function replaceIssueLabels(
  db: DrizzleSqliteDODatabase,
  issueId: string,
  labelIds: string[]
): Promise<void> {
  await db.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
  for (const labelId of labelIds) {
    await db.insert(issueLabels).values({ issueId, labelId });
  }
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function insertMilestone(
  db: DrizzleSqliteDODatabase,
  row: MilestoneRow
): Promise<void> {
  await db.insert(milestones).values(row);
}

export async function getMilestoneById(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<MilestoneRow | undefined> {
  const rows = await db.select().from(milestones).where(eq(milestones.id, id)).limit(1);
  return rows[0];
}

export async function getMilestoneByNumber(
  db: DrizzleSqliteDODatabase,
  number: number
): Promise<MilestoneRow | undefined> {
  const rows = await db.select().from(milestones).where(eq(milestones.number, number)).limit(1);
  return rows[0];
}

export async function nextMilestoneNumber(db: DrizzleSqliteDODatabase): Promise<number> {
  const rows = await db.select({ n: sql<number>`max(${milestones.number})` }).from(milestones);
  return (rows[0]?.n ?? 0) + 1;
}

export async function listMilestones(
  db: DrizzleSqliteDODatabase,
  args: { state?: "open" | "closed"; limit?: number }
): Promise<MilestoneRow[]> {
  const limit = args.limit ?? 100;
  if (args.state) {
    return await db
      .select()
      .from(milestones)
      .where(eq(milestones.state, args.state))
      .orderBy(desc(milestones.number))
      .limit(limit);
  }
  return await db.select().from(milestones).orderBy(desc(milestones.number)).limit(limit);
}

export async function updateMilestone(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<MilestoneRow>
): Promise<void> {
  await db.update(milestones).set(patch).where(eq(milestones.id, id));
}

// ---------------------------------------------------------------------------
// Reactions — one row per (target, reaction, actor) so toggles are
// insert/delete and aggregation is a grouped count.
// ---------------------------------------------------------------------------

export async function insertReaction(db: DrizzleSqliteDODatabase, row: ReactionRow): Promise<void> {
  await db.insert(reactions).values(row).onConflictDoNothing();
}

export async function deleteReaction(
  db: DrizzleSqliteDODatabase,
  args: { targetType: string; targetId: string; reaction: string; actor: string }
): Promise<void> {
  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.targetType, args.targetType),
        eq(reactions.targetId, args.targetId),
        eq(reactions.reaction, args.reaction),
        eq(reactions.actor, args.actor)
      )
    );
}

export async function listReactions(
  db: DrizzleSqliteDODatabase,
  args: { targetType: string; targetId: string }
): Promise<ReactionRow[]> {
  return await db
    .select()
    .from(reactions)
    .where(and(eq(reactions.targetType, args.targetType), eq(reactions.targetId, args.targetId)))
    .orderBy(asc(reactions.createdAt));
}
