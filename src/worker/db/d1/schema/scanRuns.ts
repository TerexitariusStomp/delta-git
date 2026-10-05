import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { repositories } from "./repositories";

// Push-scan attestations — a client (dgit CLI, pre-push hook, IDE plugin)
// reports the outcome of running its local scanner suite against the OIDs it
// is about to push. Attestations are an audit trail, not proof of compute:
// they record *who claimed to have scanned what* so a repo policy can refuse
// pushes whose new heads were never attested, and so the op log can correlate
// a ref advance with the scan that preceded it.
//
// One row per (repository, head_oid): re-attesting the same head replaces the
// row (upsert) since a newer scan of identical content supersedes the old.
export type ScanStatus = "pass" | "warn" | "fail" | "skipped";

export const scanRuns = sqliteTable(
  "scan_runs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // The pushed head OID this attestation covers. `block` policy checks for
    // a pass/warn row keyed on the exact new head.
    headOid: text("head_oid").notNull(),
    // Pusher identity — PAT uid, agent DID, or session user slug — recorded
    // for the audit trail and op-log correlation.
    actor: text("actor").notNull(),
    // Aggregate outcome across all tools that ran.
    status: text("status").notNull().$type<ScanStatus>(),
    // JSON array of per-tool summaries:
    // [{tool, version, status, findings, durationMs}] — compact, no findings
    // payloads (those stay in the client's local report file).
    tools: text("tools").notNull(),
    durationMs: integer("duration_ms"),
    ranAt: integer("ran_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_scan_runs_repo_head").on(table.repositoryId, table.headOid),
    index("idx_scan_runs_repo_ran").on(table.repositoryId, table.ranAt),
  ]
);

export type ScanRunRow = typeof scanRuns.$inferSelect;
export type NewScanRunRow = typeof scanRuns.$inferInsert;
