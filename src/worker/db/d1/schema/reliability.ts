import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { repositories } from "./repositories";

// Wave-3 reliability plane — space-scoped registries for uptime monitoring,
// SLOs/downtime, incidents, certificate tracking, cloud cost snapshots, and
// chaos experiments.

// HTTP/uptime monitors. `lastStatus`/`lastCheckedAt` are updated by the
// monitor-run endpoint (or external probes POSTing results); checks do not
// run in-band on Workers cron yet — the record model is probe-agnostic.
export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    expectedStatus: integer("expected_status").notNull().default(200),
    intervalSec: integer("interval_sec").notNull().default(300),
    enabled: integer("enabled").notNull().default(1),
    lastStatus: text("last_status"), // up | down | unknown
    lastLatencyMs: integer("last_latency_ms"),
    lastCheckedAt: integer("last_checked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_monitors_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_monitors_ns").on(table.namespaceId),
  ]
);
export type MonitorRow = typeof monitors.$inferSelect;
export type NewMonitorRow = typeof monitors.$inferInsert;

// Monitor probe history — one row per check result.
export const monitorChecks = sqliteTable(
  "monitor_checks",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // up | down
    latencyMs: integer("latency_ms"),
    statusCode: integer("status_code"),
    checkedAt: integer("checked_at").notNull(),
  },
  (table) => [index("idx_mchecks_monitor").on(table.monitorId, table.checkedAt)]
);
export type MonitorCheckRow = typeof monitorChecks.$inferSelect;
export type NewMonitorCheckRow = typeof monitorChecks.$inferInsert;

// SLO targets — percentage-based budgets over a rolling window.
export const slos = sqliteTable(
  "slos",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    monitorId: text("monitor_id").references(() => monitors.id, { onDelete: "set null" }),
    targetPct: integer("target_pct").notNull(), // e.g. 9990 = 99.90%
    windowDays: integer("window_days").notNull().default(30),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_slos_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_slos_ns").on(table.namespaceId),
  ]
);
export type SloRow = typeof slos.$inferSelect;
export type NewSloRow = typeof slos.$inferInsert;

// Downtime windows — scheduled maintenance or recorded outages applied to
// SLO budget math.
export const downtimes = sqliteTable(
  "downtimes",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id").references(() => monitors.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"), // null = ongoing
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_downtimes_ns").on(table.namespaceId)]
);
export type DowntimeRow = typeof downtimes.$inferSelect;
export type NewDowntimeRow = typeof downtimes.$inferInsert;

// Incidents — records with an update timeline.
export const incidents = sqliteTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    severity: text("severity").notNull().default("sev3"), // sev1..sev4
    status: text("status").notNull().default("open"), // open | mitigated | resolved
    summary: text("summary"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [index("idx_incidents_ns").on(table.namespaceId, table.createdAt)]
);
export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;

export const incidentUpdates = sqliteTable(
  "incident_updates",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    status: text("status"), // optional status transition
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_iupdates_incident").on(table.incidentId, table.createdAt)]
);
export type IncidentUpdateRow = typeof incidentUpdates.$inferSelect;
export type NewIncidentUpdateRow = typeof incidentUpdates.$inferInsert;

// Certificate records — expiry tracking; the renew-by date is computed.
export const certificates = sqliteTable(
  "certificates",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    issuer: text("issuer"),
    expiresAt: integer("expires_at").notNull(),
    autoRenew: integer("auto_renew").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_certs_ns_domain").on(table.namespaceId, table.domain),
    index("idx_certs_expiry").on(table.expiresAt),
  ]
);
export type CertificateRow = typeof certificates.$inferSelect;
export type NewCertificateRow = typeof certificates.$inferInsert;

// Cloud cost snapshots — periodic aggregates pushed by an external collector
// or recorded manually.
export const costSnapshots = sqliteTable(
  "cost_snapshots",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // aws | gcp | cloudflare | other
    service: text("service").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_costs_ns").on(table.namespaceId, table.periodStart)]
);
export type CostSnapshotRow = typeof costSnapshots.$inferSelect;
export type NewCostSnapshotRow = typeof costSnapshots.$inferInsert;

// Chaos experiments — scheduled fault-injection definitions and run records.
export const chaosExperiments = sqliteTable(
  "chaos_experiments",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(), // latency | failure | resource
    spec: text("spec").notNull().default("{}"), // JSON experiment definition
    lastRunAt: integer("last_run_at"),
    lastOutcome: text("last_outcome"), // pass | fail | aborted
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_chaos_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_chaos_ns").on(table.namespaceId),
  ]
);
export type ChaosExperimentRow = typeof chaosExperiments.$inferSelect;
export type NewChaosExperimentRow = typeof chaosExperiments.$inferInsert;
