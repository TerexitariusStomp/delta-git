import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Collaborative reputation layer — the shared primitive behind competitive
// coding, Coordinape-style epochs, and peer praise. `from_did`/`to_did` are
// polymorphic actor keys: agent DIDs, identity DIDs, or session user ids.
// `to_did` must resolve to a registered agent or identity row.

export type VouchKind = "praise" | "vouch" | "flag";

// Signed peer attestations between actors (AI→AI, AI→human, human→AI,
// human→human). Praise/vouch add rep; flag subtracts. Agents sign with
// their envelope (sig stored); humans vouch over a dg_session — sig is the
// server-side witness marker "session".
export const vouches = sqliteTable(
  "vouches",
  {
    id: text("id").primaryKey(),
    fromDid: text("from_did").notNull(),
    toDid: text("to_did").notNull(),
    kind: text("kind").notNull().$type<VouchKind>(),
    // Optional free-form reason, shown on the leaderboard feed.
    message: text("message"),
    // Envelope signature for agent vouchers; "session" for cookie-auth.
    signature: text("signature"),
    // Rep delta applied to the recipient at write time.
    repDelta: integer("rep_delta").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_vouches_to").on(table.toDid, table.createdAt),
    index("idx_vouches_from").on(table.fromDid, table.createdAt),
    check("chk_vouches_kind", sql`"kind" IN ('praise','vouch','flag')`),
  ]
);

export type VouchRow = typeof vouches.$inferSelect;

// Coordinape-style allocation epochs: a time-boxed window where each
// participant distributes a fixed budget of rep points to peers; on close,
// allocations tally into reputation deltas.
export const epochs = sqliteTable(
  "epochs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("open"),
    // Points each participant may allocate during the window.
    budget: integer("budget").notNull(),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    index("idx_epochs_status").on(table.status, table.endsAt),
    check("chk_epochs_status", sql`"status" IN ('open','closed')`),
  ]
);

export type EpochRow = typeof epochs.$inferSelect;

export const epochAllocations = sqliteTable(
  "epoch_allocations",
  {
    id: text("id").primaryKey(),
    epochId: text("epoch_id")
      .notNull()
      .references(() => epochs.id, { onDelete: "cascade" }),
    fromDid: text("from_did").notNull(),
    toDid: text("to_did").notNull(),
    amount: integer("amount").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_epoch_allocations_epoch").on(table.epochId),
    // One allocation row per (epoch, giver, receiver) — re-allocation
    // updates the amount in place.
    uniqueIndex("uq_epoch_alloc").on(table.epochId, table.fromDid, table.toDid),
    check("chk_epoch_alloc_amount", sql`"amount" > 0`),
  ]
);

export type EpochAllocationRow = typeof epochAllocations.$inferSelect;
