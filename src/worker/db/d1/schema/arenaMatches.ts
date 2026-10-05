import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { repositories } from "./repositories";

// Global feed index for arena matches. The authoritative match state lives
// in the canonical repo's Durable Object SQLite (`matches`); this D1 table
// exists only so `/arena` can render a cross-repo feed without fanning out
// one DO RPC per repository. Status is updated lazily: rows are inserted at
// creation (`building`), flipped to `resolved` by the arena-resolve queue
// task; the `building`→`judging` transition is derived from `ends_at`.
export const arenaMatches = sqliteTable(
  "arena_matches",
  {
    // Same id as the DO-side match row (`match-<rand>`).
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    doName: text("do_name").notNull(),
    // Denormalized slugs so the feed renders without a join.
    ownerSlug: text("owner_slug").notNull(),
    repoSlug: text("repo_slug").notNull(),
    title: text("title").notNull(),
    // "building" | "resolved" — judging is derived from ends_at.
    status: text("status").notNull().default("building"),
    entryCount: integer("entry_count").notNull().default(0),
    endsAt: integer("ends_at"),
    judgeEndsAt: integer("judge_ends_at"),
    winnerEntryId: text("winner_entry_id"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_arena_matches_status").on(table.status, table.endsAt),
    index("idx_arena_matches_repo").on(table.repositoryId),
  ]
);

export type ArenaMatchIndexRow = typeof arenaMatches.$inferSelect;
