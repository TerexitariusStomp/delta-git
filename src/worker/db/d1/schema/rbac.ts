import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { users } from "./users";

// RBAC plane — casbin rules plus the domain objects they describe.
//
// `casbinRules` is the standard adapter shape: every `p` (policy) and `g`
// (grouping/role-assignment) row casbin persists. The D1 adapter loads rows
// into an enforcer; domain writes (add user to group, assign role) translate
// to g-rows, permission changes to p-rows.
export const casbinRules = sqliteTable(
  "casbin_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ptype: text("ptype").notNull(), // "p" | "g"
    v0: text("v0"),
    v1: text("v1"),
    v2: text("v2"),
    v3: text("v3"),
    v4: text("v4"),
    v5: text("v5"),
  },
  (table) => [
    index("idx_casbin_rules_ptype").on(table.ptype),
    index("idx_casbin_rules_v1").on(table.v1),
  ]
);

export type CasbinRuleRow = typeof casbinRules.$inferSelect;
export type NewCasbinRuleRow = typeof casbinRules.$inferInsert;

// Named groups inside a namespace — members confer the group's space role.
export const userGroups = sqliteTable(
  "user_groups",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    // Group-wide role conferred on its members in this namespace.
    role: text("role").notNull().default("viewer"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_user_groups_ns").on(table.namespaceId, table.identifier)]
);

export type UserGroupRow = typeof userGroups.$inferSelect;
export type NewUserGroupRow = typeof userGroups.$inferInsert;

export const userGroupMembers = sqliteTable(
  "user_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => userGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("idx_user_group_members_user").on(table.userId),
  ]
);

export type UserGroupMemberRow = typeof userGroupMembers.$inferSelect;

// Non-user principals — named agent/automation identities. They carry
// namespace-scoped PATs; the principal id is what those PATs authenticate as.
export const serviceAccounts = sqliteTable(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    // Role its PATs act under in this namespace.
    role: text("role").notNull().default("developer"),
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_service_accounts_ns").on(table.namespaceId, table.identifier)]
);

export type ServiceAccountRow = typeof serviceAccounts.$inferSelect;

// Named bundles of resources (repos/spaces) policies can target as a unit.
export const resourceGroups = sqliteTable(
  "resource_groups",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_resource_groups_ns").on(table.namespaceId, table.identifier)]
);

export type ResourceGroupRow = typeof resourceGroups.$inferSelect;

export const resourceGroupItems = sqliteTable(
  "resource_group_items",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => resourceGroups.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(), // "repo" | "space"
    resourceRef: text("resource_ref").notNull(), // doName or namespace id
  },
  (table) => [primaryKey({ columns: [table.groupId, table.resourceType, table.resourceRef] })]
);

export type ResourceGroupItemRow = typeof resourceGroupItems.$inferSelect;
