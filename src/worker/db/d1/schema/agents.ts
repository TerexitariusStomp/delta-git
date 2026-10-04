import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// delta-git agent registry — global, cross-repo identity.
//
// Agents authenticate with ed25519 signatures over request envelopes and are
// identified by `did:dg:<base58-pubkey>`. Reputation is earned by correct
// adjudication votes and slashed on minority/malicious votes; it gates the
// `merge`/`verify` lanes and rep-protected ref updates.
export const agents = sqliteTable(
  "agents",
  {
    did: text("did").primaryKey(),
    // base58-encoded ed25519 public key (32 bytes decoded).
    pubkey: text("pubkey").notNull(),
    // Optional human-readable label for the leaderboard/UI.
    label: text("label"),
    rep: integer("rep").notNull().default(0),
    banned: integer("banned").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
  },
  (table) => [
    uniqueIndex("uq_agents_pubkey").on(table.pubkey),
    index("idx_agents_rep").on(table.rep),
    check("chk_agents_banned", sql`"banned" IN (0,1)`),
  ]
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
