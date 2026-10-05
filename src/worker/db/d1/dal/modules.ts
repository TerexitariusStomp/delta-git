// Modules DAL — notifications inbox, space environments, repo artifacts.

import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "../client";
import {
  artifacts,
  environments,
  notifications,
  repositories,
  type ArtifactRow,
  type EnvironmentRow,
  type NewArtifactRow,
  type NewEnvironmentRow,
  type NewNotificationRow,
  type NotificationRow,
} from "../schema";

// --- notifications -----------------------------------------------------------

export async function insertNotification(db: Db, row: NewNotificationRow): Promise<void> {
  await db.insert(notifications).values(row).run();
}

export async function listNotificationsForUser(
  db: Db,
  userId: string,
  limit = 50
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

export async function countUnreadNotifications(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .all();
  return rows.length;
}

export async function markNotificationRead(
  db: Db,
  id: string,
  userId: string,
  readAt: number | null
): Promise<boolean> {
  const row = await db
    .update(notifications)
    .set({ readAt })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning({ id: notifications.id })
    .get();
  return row !== undefined;
}

export async function markAllNotificationsRead(
  db: Db,
  userId: string,
  readAt: number
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .run();
}

// --- environments --------------------------------------------------------------

export async function listEnvironments(db: Db, namespaceId: string): Promise<EnvironmentRow[]> {
  return db.select().from(environments).where(eq(environments.namespaceId, namespaceId)).all();
}

export async function findEnvironment(
  db: Db,
  namespaceId: string,
  identifier: string
): Promise<EnvironmentRow | undefined> {
  return db
    .select()
    .from(environments)
    .where(and(eq(environments.namespaceId, namespaceId), eq(environments.identifier, identifier)))
    .get();
}

export async function insertEnvironment(db: Db, row: NewEnvironmentRow): Promise<EnvironmentRow> {
  await db.insert(environments).values(row).run();
  return (await db.select().from(environments).where(eq(environments.id, row.id)).get())!;
}

export async function updateEnvironment(
  db: Db,
  id: string,
  patch: Partial<Pick<EnvironmentRow, "description" | "type" | "identifier">>,
  updatedAt: number
): Promise<EnvironmentRow | undefined> {
  await db
    .update(environments)
    .set({ ...patch, updatedAt })
    .where(eq(environments.id, id))
    .run();
  return db.select().from(environments).where(eq(environments.id, id)).get();
}

export async function deleteEnvironment(db: Db, id: string): Promise<void> {
  await db.delete(environments).where(eq(environments.id, id)).run();
}

// --- artifacts -----------------------------------------------------------------

export async function upsertArtifact(db: Db, row: NewArtifactRow): Promise<ArtifactRow> {
  await db
    .insert(artifacts)
    .values(row)
    .onConflictDoUpdate({
      target: [artifacts.repositoryId, artifacts.name, artifacts.version, artifacts.path],
      set: {
        r2Key: row.r2Key,
        size: row.size,
        sha256: row.sha256,
        contentType: row.contentType,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      },
    })
    .run();
  return (await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.repositoryId, row.repositoryId),
        eq(artifacts.name, row.name),
        eq(artifacts.version, row.version),
        eq(artifacts.path, row.path)
      )
    )
    .get())!;
}

export async function listArtifactsForRepo(db: Db, repositoryId: string): Promise<ArtifactRow[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.repositoryId, repositoryId))
    .orderBy(desc(artifacts.createdAt))
    .all();
}

export async function findArtifact(
  db: Db,
  repositoryId: string,
  name: string,
  version: string,
  path: string
): Promise<ArtifactRow | undefined> {
  return db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.repositoryId, repositoryId),
        eq(artifacts.name, name),
        eq(artifacts.version, version),
        eq(artifacts.path, path)
      )
    )
    .get();
}

export async function deleteArtifactRow(db: Db, id: string): Promise<ArtifactRow | undefined> {
  const row = await db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  if (row) await db.delete(artifacts).where(eq(artifacts.id, id)).run();
  return row;
}

// Space-level listing for the Artifacts nav page — joins repositories so the
// UI can show which repo produced each artifact.
export async function listArtifactsForNamespace(
  db: Db,
  namespaceId: string
): Promise<(ArtifactRow & { repoSlug: string })[]> {
  const rows = await db
    .select({ artifact: artifacts, repoSlug: repositories.slug })
    .from(artifacts)
    .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
    .where(eq(repositories.namespaceId, namespaceId))
    .orderBy(desc(artifacts.createdAt))
    .all();
  return rows.map((r) => ({ ...r.artifact, repoSlug: r.repoSlug }));
}
