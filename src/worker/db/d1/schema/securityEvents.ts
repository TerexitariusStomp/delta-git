import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// Per-user security history — GitHub's "security log" surface. Auth-affecting
// events (sign-ins, PAT lifecycle, key binds) append rows here; the user
// reads their own trail at /api/v1/user/security-log.
export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Frozen vocabulary: session.sign_in, session.end, pat.create, pat.revoke. */
    kind: text("kind").notNull(),
    /** Short free-text context (token name, auth method). */
    detail: text("detail"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_security_events_user").on(table.userId, desc(table.createdAt))]
);

export type SecurityEventRow = typeof securityEvents.$inferSelect;
export type NewSecurityEventRow = typeof securityEvents.$inferInsert;
