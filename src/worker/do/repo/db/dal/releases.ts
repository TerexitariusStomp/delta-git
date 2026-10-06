import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { releaseAssets, releases, type ReleaseAssetRow, type ReleaseRow } from "../schema";

export async function insertRelease(db: DrizzleSqliteDODatabase, row: ReleaseRow): Promise<void> {
  await db.insert(releases).values(row);
}

export async function getReleaseById(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<ReleaseRow | undefined> {
  const rows = await db.select().from(releases).where(eq(releases.id, id)).limit(1);
  return rows[0];
}

export async function getReleaseByTag(
  db: DrizzleSqliteDODatabase,
  tagName: string
): Promise<ReleaseRow | undefined> {
  const rows = await db.select().from(releases).where(eq(releases.tagName, tagName)).limit(1);
  return rows[0];
}

export async function listReleases(
  db: DrizzleSqliteDODatabase,
  args: { includeDrafts?: boolean; limit?: number } = {}
): Promise<ReleaseRow[]> {
  const limit = Math.min(100, Math.max(1, args.limit ?? 30));
  const query = db.select().from(releases).orderBy(desc(releases.createdAt)).limit(limit);
  if (args.includeDrafts) return await query;
  return await db
    .select()
    .from(releases)
    .where(eq(releases.draft, 0))
    .orderBy(desc(releases.createdAt))
    .limit(limit);
}

export async function latestRelease(db: DrizzleSqliteDODatabase): Promise<ReleaseRow | undefined> {
  // "Latest" = newest non-draft, non-prerelease — GitHub's definition.
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.draft, 0), eq(releases.prerelease, 0)))
    .orderBy(desc(releases.createdAt))
    .limit(1);
  return rows[0];
}

export async function updateRelease(
  db: DrizzleSqliteDODatabase,
  id: string,
  patch: Partial<ReleaseRow>
): Promise<void> {
  await db.update(releases).set(patch).where(eq(releases.id, id));
}

export async function deleteRelease(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(releases).where(eq(releases.id, id));
}

// --- assets -----------------------------------------------------------------

export async function insertReleaseAsset(
  db: DrizzleSqliteDODatabase,
  row: ReleaseAssetRow
): Promise<void> {
  await db.insert(releaseAssets).values(row);
}

export async function getReleaseAsset(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<ReleaseAssetRow | undefined> {
  const rows = await db.select().from(releaseAssets).where(eq(releaseAssets.id, id)).limit(1);
  return rows[0];
}

export async function listReleaseAssets(
  db: DrizzleSqliteDODatabase,
  releaseId: string
): Promise<ReleaseAssetRow[]> {
  return await db
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.releaseId, releaseId))
    .orderBy(asc(releaseAssets.name));
}

export async function bumpAssetDownloadCount(
  db: DrizzleSqliteDODatabase,
  id: string
): Promise<void> {
  await db
    .update(releaseAssets)
    .set({ downloadCount: sql`"download_count" + 1` })
    .where(eq(releaseAssets.id, id));
}

export async function deleteReleaseAsset(db: DrizzleSqliteDODatabase, id: string): Promise<void> {
  await db.delete(releaseAssets).where(eq(releaseAssets.id, id));
}
