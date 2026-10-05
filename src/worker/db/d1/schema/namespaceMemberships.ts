import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { users } from "./users";

// Membership now carries a real role — "owner" (full space admin),
// "developer" (write/push, no admin), "viewer" (read only). Pre-RBAC rows
// migrate in as owners, matching the old every-member-is-an-owner semantic.
export const namespaceMemberships = sqliteTable(
  "namespace_memberships",
  {
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespaceId, table.userId] }),
    // Reverse-direction index for "my namespaces" / "my repositories" pages.
    // The PK already covers (namespace_id, user_id) lookups.
    index("idx_namespace_memberships_user_ns").on(table.userId, table.namespaceId),
  ]
);

export type NamespaceMembershipRow = typeof namespaceMemberships.$inferSelect;
export type NewNamespaceMembershipRow = typeof namespaceMemberships.$inferInsert;
