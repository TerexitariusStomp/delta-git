import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { namespaces } from "./namespaces";
import { repositories } from "./repositories";
import { users } from "./users";

// Cross-repo social graph — unlike issues (repo-local, DO SQLite), stars,
// topics, and follows join across repositories, so they live in D1.
// Federation note: the atproto projection (sh.delta.* records) is derived
// from these rows; D1 remains the authoritative count store.

export const stars = sqliteTable(
  "stars",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_stars_user_repo").on(table.userId, table.repositoryId),
    // Stargazer lists + repo star counts.
    index("idx_stars_repo").on(table.repositoryId, table.createdAt),
  ]
);

// Normalized topic tags — one row per (repo, topic); the topic page and
// explore filters key off the topic index. Topics are lowercase slug-shaped.
export const repoTopics = sqliteTable(
  "repo_topics",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
  },
  (table) => [
    uniqueIndex("uq_repo_topics_repo_topic").on(table.repositoryId, table.topic),
    index("idx_repo_topics_topic").on(table.topic, table.repositoryId),
    check("chk_repo_topics_topic", sql`"topic" GLOB '[a-z0-9][a-z0-9-]*'`),
  ]
);

// Following a namespace (GitHub "watch" is per-repo; following the space
// covers GitHub's follow-user and watch-org in one row shape).
export const follows = sqliteTable(
  "follows",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_follows_user_namespace").on(table.userId, table.namespaceId),
    index("idx_follows_namespace").on(table.namespaceId, table.createdAt),
  ]
);

// Per-repo watch subscriptions (GitHub "watch"). Namespace membership already
// implies notifications; watchers extend the fan-out to non-members watching
// public repos. Level is reserved for a future ignore/releases-only mode —
// today every row means "all activity".
export const repoWatchers = sqliteTable(
  "repo_watchers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_watchers_user_repo").on(table.userId, table.repositoryId),
    index("idx_watchers_repo").on(table.repositoryId, table.createdAt),
  ]
);

export type StarRow = typeof stars.$inferSelect;
export type RepoTopicRow = typeof repoTopics.$inferSelect;
export type FollowRow = typeof follows.$inferSelect;
export type RepoWatcherRow = typeof repoWatchers.$inferSelect;
