import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { repositories } from "./repositories";
import { users } from "./users";

// Notifications inbox — written by server events (push fan-out, merge-intent
// resolution, execution status) for each affected user. Read-state lives on
// the row; listing/reading is user-scoped.
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Event discriminator: push | intent_resolved | execution | mention | incident.
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // SPA-relative deep link (e.g. repo commits page) — nullable for
    // notifications that have no natural target.
    link: text("link"),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (table) => [
    index("idx_notifications_user_created").on(table.userId, table.createdAt),
    index("idx_notifications_user_unread").on(table.userId, table.readAt),
  ]
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

// Deployment targets inside a space — pipeline stages and environment
// promotions reference these records.
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    description: text("description"),
    // dev | staging | prod — free-form but the UI groups on these buckets.
    type: text("type").notNull().default("pre_production"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_environments_ns_ident").on(table.namespaceId, table.identifier),
    index("idx_environments_ns").on(table.namespaceId),
  ]
);

export type EnvironmentRow = typeof environments.$inferSelect;
export type NewEnvironmentRow = typeof environments.$inferInsert;

// Pipeline outputs / published packages — metadata index over R2 objects
// stored under `artifacts/<doName>/<name>/<version>/<path>` in the objects
// bucket. Repo-scoped because upload auth rides the repo's push PAT.
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: text("version").notNull(),
    path: text("path").notNull(),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_artifacts_repo_nvp").on(
      table.repositoryId,
      table.name,
      table.version,
      table.path
    ),
    index("idx_artifacts_repo_name").on(table.repositoryId, table.name),
  ]
);

export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifactRow = typeof artifacts.$inferInsert;
