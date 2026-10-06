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

// --- reliability-plane registries (monitors, slos, downtime, incidents,
//     certificates, costs, chaos) -------------------------------------------

import {
  certificates,
  chaosExperiments,
  costSnapshots,
  downtimes,
  incidentUpdates,
  incidents,
  monitorChecks,
  monitors,
  slos,
  type CertificateRow,
  type ChaosExperimentRow,
  type CostSnapshotRow,
  type DowntimeRow,
  type IncidentRow,
  type IncidentUpdateRow,
  type MonitorCheckRow,
  type MonitorRow,
  type NewCertificateRow,
  type NewChaosExperimentRow,
  type NewCostSnapshotRow,
  type NewDowntimeRow,
  type NewIncidentRow,
  type NewIncidentUpdateRow,
  type NewMonitorCheckRow,
  type NewMonitorRow,
  type NewSloRow,
  type SloRow,
} from "../schema";

export async function listMonitors(db: Db, namespaceId: string): Promise<MonitorRow[]> {
  return db.select().from(monitors).where(eq(monitors.namespaceId, namespaceId)).all();
}
export async function findMonitor(db: Db, namespaceId: string, identifier: string) {
  return db
    .select()
    .from(monitors)
    .where(and(eq(monitors.namespaceId, namespaceId), eq(monitors.identifier, identifier)))
    .get();
}
export async function insertMonitor(db: Db, row: NewMonitorRow): Promise<void> {
  await db.insert(monitors).values(row).run();
}
export async function updateMonitor(db: Db, id: string, patch: Partial<MonitorRow>): Promise<void> {
  await db.update(monitors).set(patch).where(eq(monitors.id, id)).run();
}
export async function deleteMonitor(db: Db, id: string): Promise<void> {
  await db.delete(monitors).where(eq(monitors.id, id)).run();
}
export async function insertMonitorCheck(db: Db, row: NewMonitorCheckRow): Promise<void> {
  await db.insert(monitorChecks).values(row).run();
}
export async function listMonitorChecks(
  db: Db,
  monitorId: string,
  limit: number
): Promise<MonitorCheckRow[]> {
  return db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId))
    .orderBy(desc(monitorChecks.checkedAt))
    .limit(limit)
    .all();
}

export async function listSlos(db: Db, namespaceId: string): Promise<SloRow[]> {
  return db.select().from(slos).where(eq(slos.namespaceId, namespaceId)).all();
}
export async function insertSlo(db: Db, row: NewSloRow): Promise<void> {
  await db.insert(slos).values(row).run();
}
export async function deleteSlo(db: Db, id: string): Promise<void> {
  await db.delete(slos).where(eq(slos.id, id)).run();
}

export async function listDowntimes(db: Db, namespaceId: string): Promise<DowntimeRow[]> {
  return db.select().from(downtimes).where(eq(downtimes.namespaceId, namespaceId)).all();
}
export async function insertDowntime(db: Db, row: NewDowntimeRow): Promise<void> {
  await db.insert(downtimes).values(row).run();
}
export async function endDowntime(db: Db, id: string, endedAt: number): Promise<void> {
  await db.update(downtimes).set({ endedAt }).where(eq(downtimes.id, id)).run();
}

export async function listIncidents(db: Db, namespaceId: string): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(eq(incidents.namespaceId, namespaceId))
    .orderBy(desc(incidents.createdAt))
    .all();
}
export async function findIncident(db: Db, id: string) {
  return db.select().from(incidents).where(eq(incidents.id, id)).get();
}
export async function insertIncident(db: Db, row: NewIncidentRow): Promise<void> {
  await db.insert(incidents).values(row).run();
}
export async function updateIncident(
  db: Db,
  id: string,
  patch: Partial<IncidentRow>
): Promise<void> {
  await db.update(incidents).set(patch).where(eq(incidents.id, id)).run();
}
export async function insertIncidentUpdate(db: Db, row: NewIncidentUpdateRow): Promise<void> {
  await db.insert(incidentUpdates).values(row).run();
}
export async function listIncidentUpdates(
  db: Db,
  incidentId: string
): Promise<IncidentUpdateRow[]> {
  return db
    .select()
    .from(incidentUpdates)
    .where(eq(incidentUpdates.incidentId, incidentId))
    .orderBy(incidentUpdates.createdAt)
    .all();
}

export async function listCertificates(db: Db, namespaceId: string): Promise<CertificateRow[]> {
  return db.select().from(certificates).where(eq(certificates.namespaceId, namespaceId)).all();
}
export async function insertCertificate(db: Db, row: NewCertificateRow): Promise<void> {
  await db.insert(certificates).values(row).run();
}
export async function deleteCertificate(db: Db, id: string): Promise<void> {
  await db.delete(certificates).where(eq(certificates.id, id)).run();
}

export async function listCostSnapshots(db: Db, namespaceId: string): Promise<CostSnapshotRow[]> {
  return db
    .select()
    .from(costSnapshots)
    .where(eq(costSnapshots.namespaceId, namespaceId))
    .orderBy(desc(costSnapshots.periodStart))
    .all();
}
export async function insertCostSnapshot(db: Db, row: NewCostSnapshotRow): Promise<void> {
  await db.insert(costSnapshots).values(row).run();
}

export async function listChaosExperiments(
  db: Db,
  namespaceId: string
): Promise<ChaosExperimentRow[]> {
  return db
    .select()
    .from(chaosExperiments)
    .where(eq(chaosExperiments.namespaceId, namespaceId))
    .all();
}
export async function insertChaosExperiment(db: Db, row: NewChaosExperimentRow): Promise<void> {
  await db.insert(chaosExperiments).values(row).run();
}
export async function updateChaosExperiment(
  db: Db,
  id: string,
  patch: Partial<ChaosExperimentRow>
): Promise<void> {
  await db.update(chaosExperiments).set(patch).where(eq(chaosExperiments.id, id)).run();
}
export async function deleteChaosExperiment(db: Db, id: string): Promise<void> {
  await db.delete(chaosExperiments).where(eq(chaosExperiments.id, id)).run();
}

// --- devx-plane registries (catalog, dev envs, databases, security tests,
//     supply chain, dashboards) ----------------------------------------------

import {
  catalogEntities,
  dashboards,
  databaseRecords,
  devEnvironments,
  securityTests,
  supplyChainDocs,
  type CatalogEntityRow,
  type DashboardRow,
  type DatabaseRecordRow,
  type DevEnvironmentRow,
  type NewCatalogEntityRow,
  type NewDashboardRow,
  type NewDatabaseRecordRow,
  type NewDevEnvironmentRow,
  type NewSecurityTestRow,
  type NewSupplyChainDocRow,
  type SecurityTestRow,
  type SupplyChainDocRow,
} from "../schema";

export async function listCatalogEntities(
  db: Db,
  namespaceId: string
): Promise<CatalogEntityRow[]> {
  return db
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.namespaceId, namespaceId))
    .all();
}
export async function insertCatalogEntity(db: Db, row: NewCatalogEntityRow): Promise<void> {
  await db.insert(catalogEntities).values(row).run();
}
export async function deleteCatalogEntity(db: Db, id: string): Promise<void> {
  await db.delete(catalogEntities).where(eq(catalogEntities.id, id)).run();
}

export async function listDevEnvironments(
  db: Db,
  namespaceId: string
): Promise<DevEnvironmentRow[]> {
  return db
    .select()
    .from(devEnvironments)
    .where(eq(devEnvironments.namespaceId, namespaceId))
    .all();
}
export async function insertDevEnvironment(db: Db, row: NewDevEnvironmentRow): Promise<void> {
  await db.insert(devEnvironments).values(row).run();
}
export async function updateDevEnvironment(
  db: Db,
  id: string,
  patch: Partial<DevEnvironmentRow>
): Promise<void> {
  await db.update(devEnvironments).set(patch).where(eq(devEnvironments.id, id)).run();
}
export async function deleteDevEnvironment(db: Db, id: string): Promise<void> {
  await db.delete(devEnvironments).where(eq(devEnvironments.id, id)).run();
}

export async function listDatabaseRecords(
  db: Db,
  namespaceId: string
): Promise<DatabaseRecordRow[]> {
  return db
    .select()
    .from(databaseRecords)
    .where(eq(databaseRecords.namespaceId, namespaceId))
    .all();
}
export async function insertDatabaseRecord(db: Db, row: NewDatabaseRecordRow): Promise<void> {
  await db.insert(databaseRecords).values(row).run();
}
export async function updateDatabaseRecord(
  db: Db,
  id: string,
  patch: Partial<DatabaseRecordRow>
): Promise<void> {
  await db.update(databaseRecords).set(patch).where(eq(databaseRecords.id, id)).run();
}
export async function deleteDatabaseRecord(db: Db, id: string): Promise<void> {
  await db.delete(databaseRecords).where(eq(databaseRecords.id, id)).run();
}
export async function findDatabaseRecord(db: Db, namespaceId: string, identifier: string) {
  return db
    .select()
    .from(databaseRecords)
    .where(
      and(eq(databaseRecords.namespaceId, namespaceId), eq(databaseRecords.identifier, identifier))
    )
    .get();
}

export async function listSecurityTests(db: Db, namespaceId: string): Promise<SecurityTestRow[]> {
  return db
    .select()
    .from(securityTests)
    .where(eq(securityTests.namespaceId, namespaceId))
    .orderBy(desc(securityTests.createdAt))
    .all();
}
export async function insertSecurityTest(db: Db, row: NewSecurityTestRow): Promise<void> {
  await db.insert(securityTests).values(row).run();
}
export async function findSecurityTest(db: Db, id: string) {
  return db.select().from(securityTests).where(eq(securityTests.id, id)).get();
}
export async function updateSecurityTest(
  db: Db,
  id: string,
  patch: Partial<SecurityTestRow>
): Promise<void> {
  await db.update(securityTests).set(patch).where(eq(securityTests.id, id)).run();
}

export async function listSupplyChainDocs(
  db: Db,
  namespaceId: string
): Promise<SupplyChainDocRow[]> {
  return db
    .select()
    .from(supplyChainDocs)
    .where(eq(supplyChainDocs.namespaceId, namespaceId))
    .orderBy(desc(supplyChainDocs.createdAt))
    .all();
}
export async function insertSupplyChainDoc(db: Db, row: NewSupplyChainDocRow): Promise<void> {
  await db.insert(supplyChainDocs).values(row).run();
}
export async function findSupplyChainDoc(db: Db, id: string) {
  return db.select().from(supplyChainDocs).where(eq(supplyChainDocs.id, id)).get();
}

export async function listDashboards(db: Db, namespaceId: string): Promise<DashboardRow[]> {
  return db.select().from(dashboards).where(eq(dashboards.namespaceId, namespaceId)).all();
}
export async function insertDashboard(db: Db, row: NewDashboardRow): Promise<void> {
  await db.insert(dashboards).values(row).run();
}
export async function updateDashboard(
  db: Db,
  id: string,
  patch: Partial<DashboardRow>
): Promise<void> {
  await db.update(dashboards).set(patch).where(eq(dashboards.id, id)).run();
}
export async function deleteDashboard(db: Db, id: string): Promise<void> {
  await db.delete(dashboards).where(eq(dashboards.id, id)).run();
}

// --- feature flags + overrides ---------------------------------------------------

import {
  featureFlags,
  overrides,
  type FeatureFlagRow,
  type NewFeatureFlagRow,
  type NewOverrideRow,
  type OverrideRow,
} from "../schema";

export async function listFeatureFlags(db: Db, namespaceId: string): Promise<FeatureFlagRow[]> {
  return db.select().from(featureFlags).where(eq(featureFlags.namespaceId, namespaceId)).all();
}
export async function findFeatureFlag(db: Db, namespaceId: string, identifier: string) {
  return db
    .select()
    .from(featureFlags)
    .where(and(eq(featureFlags.namespaceId, namespaceId), eq(featureFlags.identifier, identifier)))
    .get();
}
export async function insertFeatureFlag(db: Db, row: NewFeatureFlagRow): Promise<void> {
  await db.insert(featureFlags).values(row).run();
}
export async function updateFeatureFlag(
  db: Db,
  id: string,
  patch: Partial<FeatureFlagRow>
): Promise<void> {
  await db.update(featureFlags).set(patch).where(eq(featureFlags.id, id)).run();
}
export async function deleteFeatureFlag(db: Db, id: string): Promise<void> {
  await db.delete(featureFlags).where(eq(featureFlags.id, id)).run();
}

export async function listOverrides(db: Db, namespaceId: string): Promise<OverrideRow[]> {
  return db.select().from(overrides).where(eq(overrides.namespaceId, namespaceId)).all();
}
export async function insertOverride(db: Db, row: NewOverrideRow): Promise<void> {
  await db.insert(overrides).values(row).run();
}
export async function deleteOverride(db: Db, id: string): Promise<void> {
  await db.delete(overrides).where(eq(overrides.id, id)).run();
}

// --- cron-scope readers (fleet-wide, no namespace filter) -------------------------------

/** All enabled monitors across namespaces — the scheduled probe iterates these. */
export async function listAllEnabledMonitors(db: Db): Promise<MonitorRow[]> {
  return db.select().from(monitors).where(eq(monitors.enabled, 1)).all();
}

/** Online delegates for the staleness reaper — cron flips them offline. */
export async function listOnlineDelegates(db: Db): Promise<DelegateAgentRow[]> {
  return db.select().from(delegateAgents).where(eq(delegateAgents.status, "online")).all();
}

/** Certificates still within their expiry horizon — cron expiry scanner. */
export async function listAllCertificates(db: Db): Promise<CertificateRow[]> {
  return db.select().from(certificates).all();
}

/** Delegate lookup by identifier — the runner protocol touches rows it matches. */
export async function findDelegate(
  db: Db,
  namespaceId: string,
  identifier: string
): Promise<DelegateAgentRow | undefined> {
  return db
    .select()
    .from(delegateAgents)
    .where(
      and(eq(delegateAgents.namespaceId, namespaceId), eq(delegateAgents.identifier, identifier))
    )
    .get();
}
