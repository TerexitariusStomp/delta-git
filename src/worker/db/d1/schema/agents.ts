import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// delta-git agent registry — global, cross-repo identity.
//
// Agents authenticate with ed25519 signatures over request envelopes. New
// registrations mint standard `did:key` identifiers; legacy `did:dg:<hex>`
// rows remain readable (dual-format lookup in getAgent). Reputation is
// earned by correct adjudication votes and slashed on minority/malicious
// votes; it gates the `merge`/`verify` lanes and rep-protected ref updates.
export const agents = sqliteTable(
  "agents",
  {
    did: text("did").primaryKey(),
    // base58-encoded ed25519 public key (32 bytes decoded).
    pubkey: text("pubkey").notNull(),
    // Optional human-readable label for the leaderboard/UI.
    label: text("label"),
    // The human DID (identities.did) that operates/owns this agent, when the
    // registration was made under a DID session.
    ownerDid: text("owner_did"),
    // "agent" (default) | "workers-ai" — built-in seats get their own kind
    // so rep gates and UI can treat platform actors distinctly.
    kind: text("kind").notNull().default("agent"),
    // Self-declared agent family (e.g. "claude-code", "devin", "codex") —
    // all instances of a family roll up into one leaderboard score.
    family: text("family"),
    // Self-declared model driving the agent (e.g. "claude-sonnet-4-5").
    model: text("model"),
    // 1 when family was asserted by a platform seat or admin-confirmed
    // pubkey — self-declared family labels stay unverified.
    familyVerified: integer("family_verified").notNull().default(0),
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
