import type { Db } from "@/worker/db/d1/client";

import { desc, eq, sql } from "drizzle-orm";
import { arenaMatches, type ArenaMatchIndexRow } from "../schema";

// DAL for the arena_matches feed index. Writes mirror DO-side match
// lifecycle transitions (create / enter / resolve) so `/arena` renders
// without fanning out DO RPCs.

export async function insertArenaMatchIndex(db: Db, row: ArenaMatchIndexRow): Promise<void> {
  await db.insert(arenaMatches).values(row);
}

export async function bumpArenaMatchEntryCount(db: Db, matchId: string): Promise<void> {
  await db
    .update(arenaMatches)
    .set({ entryCount: sql`${arenaMatches.entryCount} + 1` })
    .where(eq(arenaMatches.id, matchId));
}

export async function markArenaMatchResolved(
  db: Db,
  matchId: string,
  winnerEntryId: string | null
): Promise<void> {
  await db
    .update(arenaMatches)
    .set({ status: "resolved", winnerEntryId })
    .where(eq(arenaMatches.id, matchId));
}

export async function listArenaMatchIndex(db: Db, limit = 50): Promise<ArenaMatchIndexRow[]> {
  return await db.select().from(arenaMatches).orderBy(desc(arenaMatches.createdAt)).limit(limit);
}
