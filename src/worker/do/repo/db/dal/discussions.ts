import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { DiscussionCommentRow, DiscussionRow } from "../schema";

import { desc, eq, sql } from "drizzle-orm";
import { discussionComments, discussions } from "../schema";

// Discussions — numbered threaded topics. No state column: GitHub
// discussions aren't opened/closed, they're answered (Q&A) or not.

export async function insertDiscussion(
  db: DrizzleSqliteDODatabase,
  row: DiscussionRow
): Promise<void> {
  await db.insert(discussions).values(row);
}

export async function getDiscussionById(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<DiscussionRow | undefined> {
  const rows = await db.select().from(discussions).where(eq(discussions.id, id)).limit(1);
  return rows[0];
}

export async function getDiscussionByNumber(
  db: DrizzleSqliteDODatabase,
  number: number
): Promise<DiscussionRow | undefined> {
  const rows = await db.select().from(discussions).where(eq(discussions.number, number)).limit(1);
  return rows[0];
}

export async function nextDiscussionNumber(db: DrizzleSqliteDODatabase): Promise<number> {
  const rows = await db.select({ n: sql<number>`max(${discussions.number})` }).from(discussions);
  return (rows[0]?.n ?? 0) + 1;
}

export async function listDiscussions(
  db: DrizzleSqliteDODatabase,
  args: { category?: string; limit?: number }
): Promise<DiscussionRow[]> {
  const limit = args.limit ?? 100;
  if (args.category) {
    return await db
      .select()
      .from(discussions)
      .where(eq(discussions.category, args.category))
      .orderBy(desc(discussions.number))
      .limit(limit);
  }
  return await db.select().from(discussions).orderBy(desc(discussions.number)).limit(limit);
}

export async function updateDiscussion(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<DiscussionRow>
): Promise<void> {
  await db.update(discussions).set(patch).where(eq(discussions.id, id));
}

export async function deleteDiscussion(db: DrizzleSqliteDODatabase, id: string): Promise<boolean> {
  const rows = await db
    .delete(discussions)
    .where(eq(discussions.id, id))
    .returning({ id: discussions.id });
  return rows.length > 0;
}

export async function insertDiscussionComment(
  db: DrizzleSqliteDODatabase,
  row: DiscussionCommentRow
): Promise<void> {
  await db.insert(discussionComments).values(row);
}

export async function listDiscussionComments(
  db: DrizzleSqliteDODatabase,
  discussionId: string
): Promise<DiscussionCommentRow[]> {
  return await db
    .select()
    .from(discussionComments)
    .where(eq(discussionComments.discussionId, discussionId))
    .orderBy(discussionComments.createdAt);
}

export async function getDiscussionComment(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<DiscussionCommentRow | undefined> {
  const rows = await db
    .select()
    .from(discussionComments)
    .where(eq(discussionComments.id, id))
    .limit(1);
  return rows[0];
}

export async function updateDiscussionComment(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<DiscussionCommentRow>
): Promise<void> {
  await db.update(discussionComments).set(patch).where(eq(discussionComments.id, id));
}

export async function deleteDiscussionComment(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<boolean> {
  const rows = await db
    .delete(discussionComments)
    .where(eq(discussionComments.id, id))
    .returning({ id: discussionComments.id });
  return rows.length > 0;
}

export async function countDiscussionComments(
  db: DrizzleSqliteDODatabase,
  discussionId: string
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(discussionComments)
    .where(eq(discussionComments.discussionId, discussionId));
  return rows[0]?.count ?? 0;
}
