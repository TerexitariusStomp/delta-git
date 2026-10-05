// Scan-run DAL — push-scan attestations recorded by client tooling (dgit
// push, the installed pre-push hook). One row per (repo, head oid).

import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { scanRuns, type NewScanRunRow, type ScanRunRow, type ScanStatus } from "../schema";

export async function upsertScanRun(db: Db, row: NewScanRunRow): Promise<void> {
  await db
    .insert(scanRuns)
    .values(row)
    .onConflictDoUpdate({
      target: [scanRuns.repositoryId, scanRuns.headOid],
      set: {
        actor: row.actor,
        status: row.status,
        tools: row.tools,
        durationMs: row.durationMs,
        ranAt: row.ranAt,
      },
    })
    .run();
}

export async function listScanRunsForRepo(db: Db, repositoryId: string, limit = 50) {
  return db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.repositoryId, repositoryId))
    .orderBy(desc(scanRuns.ranAt))
    .limit(limit)
    .all();
}

export async function findScanRunForHead(
  db: Db,
  repositoryId: string,
  headOid: string
): Promise<ScanRunRow | undefined> {
  return db
    .select()
    .from(scanRuns)
    .where(and(eq(scanRuns.repositoryId, repositoryId), eq(scanRuns.headOid, headOid)))
    .get();
}

/** Statuses that satisfy a `block` push policy — the head was scanned and the
 * outcome was clean or below the blocking threshold. `fail`/`skipped`/missing
 * rows do not satisfy it. */
export function scanStatusSatisfiesPolicy(status: ScanStatus): boolean {
  return status === "pass" || status === "warn";
}
