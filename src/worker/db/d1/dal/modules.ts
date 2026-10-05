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

// --- delivery-plane registries (connectors, delegates, files, freeze,
//     tickets, gitops, policies, iac) — uniform space-scoped CRUD -----------

import {
  connectors,
  delegateAgents,
  externalTickets,
  fileStore,
  freezeWindows,
  gitopsTargets,
  iacStates,
  policies,
  type ConnectorRow,
  type DelegateAgentRow,
  type ExternalTicketRow,
  type FileStoreRow,
  type FreezeWindowRow,
  type GitopsTargetRow,
  type IacStateRow,
  type NewConnectorRow,
  type NewDelegateAgentRow,
  type NewExternalTicketRow,
  type NewFileStoreRow,
  type NewFreezeWindowRow,
  type NewGitopsTargetRow,
  type NewIacStateRow,
  type NewPolicyRow,
  type PolicyRow,
} from "../schema";

export async function listConnectors(db: Db, namespaceId: string): Promise<ConnectorRow[]> {
  return db.select().from(connectors).where(eq(connectors.namespaceId, namespaceId)).all();
}
export async function insertConnector(db: Db, row: NewConnectorRow): Promise<void> {
  await db.insert(connectors).values(row).run();
}
export async function updateConnector(
  db: Db,
  id: string,
  patch: Partial<ConnectorRow>
): Promise<void> {
  await db.update(connectors).set(patch).where(eq(connectors.id, id)).run();
}
export async function deleteConnector(db: Db, id: string): Promise<void> {
  await db.delete(connectors).where(eq(connectors.id, id)).run();
}

export async function listDelegates(db: Db, namespaceId: string): Promise<DelegateAgentRow[]> {
  return db.select().from(delegateAgents).where(eq(delegateAgents.namespaceId, namespaceId)).all();
}
export async function insertDelegate(db: Db, row: NewDelegateAgentRow): Promise<void> {
  await db.insert(delegateAgents).values(row).run();
}
export async function updateDelegate(
  db: Db,
  id: string,
  patch: Partial<DelegateAgentRow>
): Promise<void> {
  await db.update(delegateAgents).set(patch).where(eq(delegateAgents.id, id)).run();
}
export async function deleteDelegate(db: Db, id: string): Promise<void> {
  await db.delete(delegateAgents).where(eq(delegateAgents.id, id)).run();
}

export async function listFiles(db: Db, namespaceId: string): Promise<FileStoreRow[]> {
  return db.select().from(fileStore).where(eq(fileStore.namespaceId, namespaceId)).all();
}
export async function insertFile(db: Db, row: NewFileStoreRow): Promise<void> {
  await db.insert(fileStore).values(row).run();
}
export async function deleteFileRow(db: Db, id: string): Promise<void> {
  await db.delete(fileStore).where(eq(fileStore.id, id)).run();
}
export async function findFile(db: Db, namespaceId: string, name: string) {
  return db
    .select()
    .from(fileStore)
    .where(and(eq(fileStore.namespaceId, namespaceId), eq(fileStore.name, name)))
    .get();
}

export async function listFreezeWindows(db: Db, namespaceId: string): Promise<FreezeWindowRow[]> {
  return db.select().from(freezeWindows).where(eq(freezeWindows.namespaceId, namespaceId)).all();
}
export async function insertFreezeWindow(db: Db, row: NewFreezeWindowRow): Promise<void> {
  await db.insert(freezeWindows).values(row).run();
}
export async function updateFreezeWindow(
  db: Db,
  id: string,
  patch: Partial<FreezeWindowRow>
): Promise<void> {
  await db.update(freezeWindows).set(patch).where(eq(freezeWindows.id, id)).run();
}
export async function deleteFreezeWindow(db: Db, id: string): Promise<void> {
  await db.delete(freezeWindows).where(eq(freezeWindows.id, id)).run();
}

export async function listTickets(db: Db, namespaceId: string): Promise<ExternalTicketRow[]> {
  return db
    .select()
    .from(externalTickets)
    .where(eq(externalTickets.namespaceId, namespaceId))
    .all();
}
export async function insertTicket(db: Db, row: NewExternalTicketRow): Promise<void> {
  await db.insert(externalTickets).values(row).run();
}
export async function updateTicket(
  db: Db,
  id: string,
  patch: Partial<ExternalTicketRow>
): Promise<void> {
  await db.update(externalTickets).set(patch).where(eq(externalTickets.id, id)).run();
}
export async function deleteTicket(db: Db, id: string): Promise<void> {
  await db.delete(externalTickets).where(eq(externalTickets.id, id)).run();
}

export async function listGitopsTargets(db: Db, namespaceId: string): Promise<GitopsTargetRow[]> {
  return db.select().from(gitopsTargets).where(eq(gitopsTargets.namespaceId, namespaceId)).all();
}
export async function insertGitopsTarget(db: Db, row: NewGitopsTargetRow): Promise<void> {
  await db.insert(gitopsTargets).values(row).run();
}
export async function updateGitopsTarget(
  db: Db,
  id: string,
  patch: Partial<GitopsTargetRow>
): Promise<void> {
  await db.update(gitopsTargets).set(patch).where(eq(gitopsTargets.id, id)).run();
}
export async function deleteGitopsTarget(db: Db, id: string): Promise<void> {
  await db.delete(gitopsTargets).where(eq(gitopsTargets.id, id)).run();
}

export async function listPolicies(db: Db, namespaceId: string): Promise<PolicyRow[]> {
  return db.select().from(policies).where(eq(policies.namespaceId, namespaceId)).all();
}
export async function insertPolicy(db: Db, row: NewPolicyRow): Promise<void> {
  await db.insert(policies).values(row).run();
}
export async function updatePolicy(db: Db, id: string, patch: Partial<PolicyRow>): Promise<void> {
  await db.update(policies).set(patch).where(eq(policies.id, id)).run();
}
export async function deletePolicy(db: Db, id: string): Promise<void> {
  await db.delete(policies).where(eq(policies.id, id)).run();
}
export async function listEnabledPolicies(
  db: Db,
  namespaceId: string,
  appliesTo: string
): Promise<PolicyRow[]> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(eq(policies.namespaceId, namespaceId), eq(policies.enabled, 1)))
    .all();
  return rows.filter((r) => r.appliesTo === "all" || r.appliesTo === appliesTo);
}

export async function findIacState(db: Db, namespaceId: string, name: string) {
  return db
    .select()
    .from(iacStates)
    .where(and(eq(iacStates.namespaceId, namespaceId), eq(iacStates.name, name)))
    .get();
}
export async function insertIacState(db: Db, row: NewIacStateRow): Promise<void> {
  await db.insert(iacStates).values(row).run();
}
export async function updateIacState(
  db: Db,
  id: string,
  patch: Partial<IacStateRow>
): Promise<void> {
  await db.update(iacStates).set(patch).where(eq(iacStates.id, id)).run();
}
