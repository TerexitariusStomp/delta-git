import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// WebAuthn credentials — GitHub's passkeys surface. `credentialId` and
// `publicKey` are base64url; `counter` is the authenticator sign-count used
// for clone detection on every assertion.
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports"),
    /** User-facing label ("work laptop"). */
    name: text("name"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    index("idx_passkeys_user").on(table.userId, desc(table.createdAt)),
    uniqueIndex("idx_passkeys_credential").on(table.credentialId),
  ]
);

export type PasskeyRow = typeof passkeys.$inferSelect;
export type NewPasskeyRow = typeof passkeys.$inferInsert;
