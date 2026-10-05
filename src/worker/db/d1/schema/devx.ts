import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { repositories } from "./repositories";

// Wave-4 developer-experience plane — catalog entities, dev environments,
// database records, security tests, supply-chain documents, dashboards.

// Developer-portal catalog — the software catalog's entity records.
export const catalogEntities = sqliteTable(
  "catalog_entities",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    kind: text("kind").notNull().default("service"), // service | website | library | api
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    owner: text("owner"),
    description: text("description"),
    metadata: text("metadata").notNull().default("{}"), // JSON annotations/links
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_catalog_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_catalog_ns").on(table.namespaceId),
  ]
);
export type CatalogEntityRow = typeof catalogEntities.$inferSelect;
export type NewCatalogEntityRow = typeof catalogEntities.$inferInsert;

// Dev environments — remote workspace records backed by delegate runners.
export const devEnvironments = sqliteTable(
  "dev_environments",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("stopped"), // stopped | running | provisioning
    machineType: text("machine_type").notNull().default("standard"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("uq_devenv_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_devenv_ns").on(table.namespaceId),
  ]
);
export type DevEnvironmentRow = typeof devEnvironments.$inferSelect;
export type NewDevEnvironmentRow = typeof devEnvironments.$inferInsert;

// Database records — tracked databases + applied migration ledger.
export const databaseRecords = sqliteTable(
  "database_records",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    engine: text("engine").notNull().default("postgres"), // postgres | mysql | sqlite | d1
    host: text("host"), // connection handle, not credentials
    status: text("status").notNull().default("provisioned"),
    // JSON ledger: [{version,appliedAt,actor}]
    migrations: text("migrations").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_dbrec_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_dbrec_ns").on(table.namespaceId),
  ]
);
export type DatabaseRecordRow = typeof databaseRecords.$inferSelect;
export type NewDatabaseRecordRow = typeof databaseRecords.$inferInsert;

// Security tests — SAST/DAST/secret/dependency scan job records. Client-side
// runners (delegates or the dgit CLI) execute and POST results here; the
// shape mirrors scan_runs but at space scope across arbitrary targets.
export const securityTests = sqliteTable(
  "security_tests",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(), // sast | dast | secrets | deps
    target: text("target").notNull(), // repo ref, URL, or image ref
    status: text("status").notNull().default("queued"), // queued | running | pass | fail
    findings: integer("findings").notNull().default(0),
    report: text("report"), // JSON summary, never raw secret values
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("idx_sectests_ns").on(table.namespaceId, table.createdAt),
    index("idx_sectests_repo").on(table.repositoryId),
  ]
);
export type SecurityTestRow = typeof securityTests.$inferSelect;
export type NewSecurityTestRow = typeof securityTests.$inferInsert;

// Supply-chain documents — SBOMs, provenance statements, attestations bound
// to a repo+commit. `document` holds the JSON payload directly (these are
// public-by-design artifacts; encrypted repos store digests only).
export const supplyChainDocs = sqliteTable(
  "supply_chain_docs",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // sbom | provenance | attestation
    commitOid: text("commit_oid"),
    document: text("document").notNull(), // JSON payload
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_supply_ns").on(table.namespaceId),
    index("idx_supply_repo").on(table.repositoryId),
  ]
);
export type SupplyChainDocRow = typeof supplyChainDocs.$inferSelect;
export type NewSupplyChainDocRow = typeof supplyChainDocs.$inferInsert;

// Dashboards — user-defined layouts (JSON widget grids) over the platform's
// metrics surfaces.
export const dashboards = sqliteTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    layout: text("layout").notNull().default("[]"), // JSON widget list
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_dash_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_dash_ns").on(table.namespaceId),
  ]
);
export type DashboardRow = typeof dashboards.$inferSelect;
export type NewDashboardRow = typeof dashboards.$inferInsert;
