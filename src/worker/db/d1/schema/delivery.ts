import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { repositories } from "./repositories";

// Wave-2 delivery-plane registries — space-scoped D1 records. Credentials
// never live here: connectors hold only an opaque custody-broker handle
// (the secret material stays client-side per the sovereignty model).

export const connectors = sqliteTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    // github | gitlab | generic-http | k8s
    type: text("type").notNull(),
    // Opaque broker handle — usable only by the client's custody worker.
    sealedHandle: text("sealed_handle"),
    endpoint: text("endpoint"),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_connectors_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_connectors_ns").on(table.namespaceId),
  ]
);
export type ConnectorRow = typeof connectors.$inferSelect;
export type NewConnectorRow = typeof connectors.$inferInsert;

// Registered delegate runners — CI runners on client infra. The runner
// protocol itself is ephemeral (claim/report/heartbeat on executions);
// this table is the registry: who has declared a runner, its labels, and
// its last heartbeat.
export const delegateAgents = sqliteTable(
  "delegate_agents",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    // Labels advertised for pipeline step targeting (os/arch/gpu…).
    tags: text("tags").notNull().default("[]"),
    status: text("status").notNull().default("offline"), // online | offline | disabled
    lastSeenAt: integer("last_seen_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_delegates_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_delegates_ns").on(table.namespaceId),
  ]
);
export type DelegateAgentRow = typeof delegateAgents.$inferSelect;
export type NewDelegateAgentRow = typeof delegateAgents.$inferInsert;

// File store — PR/wiki/release attachments and arbitrary blobs, R2-backed.
export const fileStore = sqliteTable(
  "file_store",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_files_ns_name").on(table.namespaceId, table.name),
    index("idx_files_ns").on(table.namespaceId),
  ]
);
export type FileStoreRow = typeof fileStore.$inferSelect;
export type NewFileStoreRow = typeof fileStore.$inferInsert;

// Freeze windows — time gates on mutating operations. `schedule` is a compact
// expression: comma-separated day letters + optional hour range in UTC,
// e.g. "sa,su" (weekends) or "mo-fr 17-09" (overnights). Evaluated server-side.
export const freezeWindows = sqliteTable(
  "freeze_windows",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    schedule: text("schedule").notNull(),
    appliesTo: text("applies_to").notNull().default("all"), // push | merge | deploy | all
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_freeze_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_freeze_ns").on(table.namespaceId),
  ]
);
export type FreezeWindowRow = typeof freezeWindows.$inferSelect;
export type NewFreezeWindowRow = typeof freezeWindows.$inferInsert;

// External ticket links — records correlating repos/PRs with tickets in
// external trackers; connector-driven sync is a follow-on.
export const externalTickets = sqliteTable(
  "external_tickets",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    status: text("status").notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_tickets_ns").on(table.namespaceId),
    index("idx_tickets_repo").on(table.repositoryId),
  ]
);
export type ExternalTicketRow = typeof externalTickets.$inferSelect;
export type NewExternalTicketRow = typeof externalTickets.$inferInsert;

// GitOps sync targets — a repo+branch reconciled into an environment.
export const gitopsTargets = sqliteTable(
  "gitops_targets",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    branch: text("branch").notNull().default("main"),
    targetEnvironment: text("target_environment").notNull(),
    enabled: integer("enabled").notNull().default(1),
    lastSyncAt: integer("last_sync_at"),
    // Head oid captured at the last reconcile — drift = repo head ≠ this.
    lastSyncOid: text("last_sync_oid"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_gitops_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_gitops_repo").on(table.repositoryId),
  ]
);
export type GitopsTargetRow = typeof gitopsTargets.$inferSelect;
export type NewGitopsTargetRow = typeof gitopsTargets.$inferInsert;

// Policies — JSON rule documents evaluated in-worker (OPA-wasm upgrade path
// noted in the plan). Rules gate push/merge/deploy; `enforcement` = "warn"
// (op-log only) or "enforce" (reject).
export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    // JSON rule list: [{when:{field,op,value},action:"deny",message}]
    document: text("document").notNull(),
    appliesTo: text("applies_to").notNull().default("all"), // push | merge | deploy | all
    enforcement: text("enforcement").notNull().default("warn"), // warn | enforce
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_policies_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_policies_ns").on(table.namespaceId),
  ]
);
export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicyRow = typeof policies.$inferInsert;

// IaC state backend — Terraform-style state JSON in R2 with a lock column
// implementing the HTTP state-locking protocol.
export const iacStates = sqliteTable(
  "iac_states",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    r2Key: text("r2_key"),
    version: integer("version").notNull().default(0),
    lockId: text("lock_id"),
    lockInfo: text("lock_info"), // JSON {id,operation,who,created}
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("uq_iac_ns_name").on(table.namespaceId, table.name)]
);
export type IacStateRow = typeof iacStates.$inferSelect;
export type NewIacStateRow = typeof iacStates.$inferInsert;

// Feature flags — space-scoped toggles with JSON targeting rules. Eval is
// OpenFeature-protocol-shaped: flag name + subject → boolean.
export const featureFlags = sqliteTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    state: integer("state").notNull().default(0), // 0 off | 1 on
    // JSON targeting: [{kind:"user"|"group"|"percentage", value}]
    targets: text("targets").notNull().default("[]"),
    description: text("description"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_flags_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_flags_ns").on(table.namespaceId),
  ]
);
export type FeatureFlagRow = typeof featureFlags.$inferSelect;
export type NewFeatureFlagRow = typeof featureFlags.$inferInsert;

// Overrides — env-scoped policy/SLO exemptions with expiry.
export const overrides = sqliteTable(
  "overrides",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    // What is overridden: "freeze:<id>" | "policy:<id>" | "slo:<id>"
    subject: text("subject").notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_overrides_ns").on(table.namespaceId)]
);
export type OverrideRow = typeof overrides.$inferSelect;
export type NewOverrideRow = typeof overrides.$inferInsert;
