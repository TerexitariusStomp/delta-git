import { desc, eq } from "drizzle-orm";

import type { Db } from "@/worker/db/d1/client";
import { securityEvents } from "@/worker/db/d1/schema/securityEvents";

/** Append a security-history row; callers fire-and-forget via waitUntil or await. */
export async function insertSecurityEvent(
  db: Db,
  row: { id: string; userId: string; kind: string; detail?: string | null; createdAt: number }
): Promise<void> {
  await db.insert(securityEvents).values({ ...row, detail: row.detail ?? null });
}

export async function listSecurityEventsForUser(db: Db, userId: string, limit = 100) {
  return await db
    .select()
    .from(securityEvents)
    .where(eq(securityEvents.userId, userId))
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
}
