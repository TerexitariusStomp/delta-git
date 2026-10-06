import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@/worker/db/d1/client";
import { namespaces } from "@/worker/db/d1/schema/namespaces";
import { repositories, type RepositoryRow } from "@/worker/db/d1/schema/repositories";
import { follows, repoTopics, stars } from "@/worker/db/d1/schema/social";

// Stars, topics, follows — the cross-repo social graph. All reads scope to
// public repositories for anonymous viewers; membership-scoped private
// reads happen at the route layer (same split as listRepositoriesForNamespace).

export async function starRepository(
  db: Db,
  userId: string,
  repositoryId: string
): Promise<"starred" | "exists"> {
  const existing = await db
    .select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.userId, userId), eq(stars.repositoryId, repositoryId)))
    .limit(1);
  if (existing.length > 0) return "exists";
  await db
    .insert(stars)
    .values({ id: crypto.randomUUID(), userId, repositoryId, createdAt: Date.now() });
  return "starred";
}

export async function unstarRepository(
  db: Db,
  userId: string,
  repositoryId: string
): Promise<"unstarred" | "not-starred"> {
  const deleted = await db
    .delete(stars)
    .where(and(eq(stars.userId, userId), eq(stars.repositoryId, repositoryId)))
    .returning({ id: stars.id });
  return deleted.length > 0 ? "unstarred" : "not-starred";
}

export async function isStarred(db: Db, userId: string, repositoryId: string): Promise<boolean> {
  const rows = await db
    .select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.userId, userId), eq(stars.repositoryId, repositoryId)))
    .limit(1);
  return rows.length > 0;
}

export async function starCount(db: Db, repositoryId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(stars)
    .where(eq(stars.repositoryId, repositoryId));
  return rows[0]?.count ?? 0;
}

export async function listStargazers(
  db: Db,
  repositoryId: string
): Promise<{ userId: string; createdAt: number }[]> {
  return await db
    .select({ userId: stars.userId, createdAt: stars.createdAt })
    .from(stars)
    .where(eq(stars.repositoryId, repositoryId))
    .orderBy(desc(stars.createdAt));
}

export type StarredRepo = {
  repository: RepositoryRow;
  namespaceSlug: string;
  starredAt: number;
};

export async function listStarredRepos(db: Db, userId: string): Promise<StarredRepo[]> {
  const rows = await db
    .select({
      repository: repositories,
      namespaceSlug: namespaces.slug,
      starredAt: stars.createdAt,
    })
    .from(stars)
    .innerJoin(repositories, eq(stars.repositoryId, repositories.id))
    .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
    .where(eq(stars.userId, userId))
    .orderBy(desc(stars.createdAt));
  return rows;
}

// Star counts batched by repo — the repo listing and explore pages need one
// query, not N lookups.
export async function starCountsForRepos(
  db: Db,
  repositoryIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (repositoryIds.length === 0) return out;
  const rows = await db
    .select({ repositoryId: stars.repositoryId, count: sql<number>`count(*)` })
    .from(stars)
    .where(
      sql`${stars.repositoryId} IN (${sql.join(
        repositoryIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
    .groupBy(stars.repositoryId);
  for (const row of rows) out.set(row.repositoryId, row.count);
  return out;
}

// --- topics ----------------------------------------------------------------

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** GitHub-shaped topic validation: lowercase slug, ≤50 chars, ≤20 per repo. */
export function normalizeTopics(input: string[]): string[] | null {
  const out = [...new Set(input.map((t) => t.trim().toLowerCase()))].filter(Boolean);
  if (out.length > 20 || out.some((t) => !TOPIC_RE.test(t))) return null;
  return out;
}

export async function setRepoTopics(db: Db, repositoryId: string, topics: string[]): Promise<void> {
  await db.delete(repoTopics).where(eq(repoTopics.repositoryId, repositoryId));
  if (topics.length === 0) return;
  await db.insert(repoTopics).values(topics.map((topic) => ({ repositoryId, topic })));
}

export async function listRepoTopics(db: Db, repositoryId: string): Promise<string[]> {
  const rows = await db
    .select({ topic: repoTopics.topic })
    .from(repoTopics)
    .where(eq(repoTopics.repositoryId, repositoryId))
    .orderBy(repoTopics.topic);
  return rows.map((r) => r.topic);
}

// --- explore / trending ----------------------------------------------------

export type ExploreRepo = {
  repository: RepositoryRow;
  namespaceSlug: string;
  stars: number;
};

/** Most-starred public repos — the explore page's trending lane. */
export async function listTopStarredPublicRepos(db: Db, limit: number): Promise<ExploreRepo[]> {
  const rows = await db
    .select({
      repository: repositories,
      namespaceSlug: namespaces.slug,
      starCount: sql<number>`count(${stars.id})`,
    })
    .from(repositories)
    .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
    .leftJoin(stars, eq(stars.repositoryId, repositories.id))
    .where(eq(repositories.visibility, "public"))
    .groupBy(repositories.id)
    .orderBy(desc(sql`count(${stars.id})`), desc(repositories.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    repository: r.repository,
    namespaceSlug: r.namespaceSlug,
    stars: r.starCount,
  }));
}

/** Repos carrying a given topic, public only, freshest first. */
export async function listPublicReposByTopic(
  db: Db,
  topic: string,
  limit: number
): Promise<ExploreRepo[]> {
  const rows = await db
    .select({
      repository: repositories,
      namespaceSlug: namespaces.slug,
      starCount: sql<number>`(select count(*) from ${stars} where ${stars.repositoryId} = ${repositories.id})`,
    })
    .from(repoTopics)
    .innerJoin(repositories, eq(repoTopics.repositoryId, repositories.id))
    .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
    .where(and(eq(repoTopics.topic, topic), eq(repositories.visibility, "public")))
    .orderBy(desc(repositories.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    repository: r.repository,
    namespaceSlug: r.namespaceSlug,
    stars: r.starCount,
  }));
}

/** Most-used topics across public repos — explore page chips. */
export async function listTopTopics(
  db: Db,
  limit: number
): Promise<{ topic: string; repos: number }[]> {
  const rows = await db
    .select({ topic: repoTopics.topic, count: sql<number>`count(*)` })
    .from(repoTopics)
    .innerJoin(repositories, eq(repoTopics.repositoryId, repositories.id))
    .where(eq(repositories.visibility, "public"))
    .groupBy(repoTopics.topic)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.map((r) => ({ topic: r.topic, repos: r.count }));
}

// --- follows ---------------------------------------------------------------

export async function followNamespace(
  db: Db,
  userId: string,
  namespaceId: string
): Promise<"followed" | "exists"> {
  const existing = await db
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.userId, userId), eq(follows.namespaceId, namespaceId)))
    .limit(1);
  if (existing.length > 0) return "exists";
  await db
    .insert(follows)
    .values({ id: crypto.randomUUID(), userId, namespaceId, createdAt: Date.now() });
  return "followed";
}

export async function unfollowNamespace(
  db: Db,
  userId: string,
  namespaceId: string
): Promise<"unfollowed" | "not-following"> {
  const deleted = await db
    .delete(follows)
    .where(and(eq(follows.userId, userId), eq(follows.namespaceId, namespaceId)))
    .returning({ id: follows.id });
  return deleted.length > 0 ? "unfollowed" : "not-following";
}

export async function isFollowing(db: Db, userId: string, namespaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.userId, userId), eq(follows.namespaceId, namespaceId)))
    .limit(1);
  return rows.length > 0;
}
