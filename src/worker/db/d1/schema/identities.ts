import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// atproto identity layer.
//
// `identities` is the human-facing account: a resolvable DID (did:plc /
// did:web / did:key) plus the handle that resolved to it last and the set
// of device keys bound to the identity. `userId` bridges into the existing
// users/namespace_memberships ACL — a DID sign-in owns a `users` row whose
// tessera_sub is the DID itself, so repo ACL needs no DID-specific fork.
export const identities = sqliteTable(
  "identities",
  {
    did: text("did").primaryKey(),
    // The bridged users.id for ACL (tessera_sub = this DID).
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Last verified atproto handle (e.g. alice.bsky.social). Nullable for
    // did:key registrations which carry no handle.
    handle: text("handle"),
    // JSON array of bound device public keys:
    //   [{ "multibase": "z...", "curve": "k256|p256|ed25519", "revokedAt": n|null, "addedAt": n }]
    deviceKeys: text("device_keys").notNull().default("[]"),
    // Unified reputation — same currency as agents.rep. Arena wins,
    // adjudication, vouches, and epoch allocations all feed it.
    rep: integer("rep").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_identities_handle").on(t.handle)]
);

export type IdentityRow = typeof identities.$inferSelect;
export type NewIdentityRow = typeof identities.$inferInsert;

// Short-lived DID sessions. The cookie carries the JWT; this table is the
// revocation authority — a row with revokedAt set (or past expiresAt)
// fails verification even when the JWT signature is valid.
export const didSessions = sqliteTable(
  "did_sessions",
  {
    jti: text("jti").primaryKey(),
    did: text("did")
      .notNull()
      .references(() => identities.did, { onDelete: "cascade" }),
    // Optional DPoP binding (RFC 9449 jwk thumbprint).
    dpopJkt: text("dpop_jkt"),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_did_sessions_did").on(t.did)]
);

export type DidSessionRow = typeof didSessions.$inferSelect;
export type NewDidSessionRow = typeof didSessions.$inferInsert;
