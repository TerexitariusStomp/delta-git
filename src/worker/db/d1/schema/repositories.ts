import { sql, desc } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { namespaces } from "./namespaces";
import { users } from "./users";

export type RepositoryVisibility = "public" | "private";

// Storage backend discriminator. "do" is the native DO+R2 engine; "artifacts"
// means the canonical object store is a Cloudflare Artifacts repo while the
// DO remains the coordination authority (refs index, merge intents, quorum).
export type RepositoryBackend = "do" | "artifacts";

// A repository row identifies a repo by `(namespace_id, slug)` and binds
// it to a Durable Object via `do_name`. `do_name` is the value passed to
// `env.REPO_DO.idFromName()`. Legacy/imported rows use the historical
// `<namespace>/<repo>` form so that existing storage stays addressable;
// new repos created post-migration use a `repo:<uuid>` form.
export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    namespaceId: text("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    doName: text("do_name").notNull(),
    // Federation-addressable repo DID (`did:dg:repo:<hash>`), minted at
    // creation. Stable across renames; NULL for repos predating the column
    // (minted lazily on first federation touch).
    did: text("did"),
    // JSON array of mirror targets [{name,url}] — `https://` remotes get a
    // real smart-HTTP push; ssh/rad/tangled targets go through the signed
    // federation relay. See docs/federation.md.
    mirrorTargets: text("mirror_targets"),
    visibility: text("visibility").notNull().$type<RepositoryVisibility>(),
    // Strict-E2E flag: when 1 the server stores only ciphertext — opaque
    // encrypted chunks under R2 `enc/` and a wrapped repo key per member.
    // Smart-HTTP object endpoints are refused; browsing/merge run in the
    // client custody worker which holds the unwrapped key. Only meaningful
    // alongside visibility='private'.
    encrypted: integer("encrypted").notNull().default(0),
    // One-line GitHub-style repository description shown in the repo header
    // and About sidebar. NULL until the owner sets one on the admin page.
    description: text("description"),
    // Project homepage/URL shown in the About sidebar (GitHub "website").
    website: text("website"),
    // "do" (default) = native DO+R2 engine. "artifacts" = canonical objects
    // live in a Cloudflare Artifacts repository; `artifacts_name` holds the
    // repo name inside the bound namespace (`dg-<uuid>`).
    backend: text("backend").notNull().default("do").$type<RepositoryBackend>(),
    artifactsName: text("artifacts_name"),
    // HTTPS git remote returned by `env.ARTIFACTS.create()` — stored because
    // the URL embeds the account id, which is not available to the Worker at
    // runtime, and re-fetching via `ARTIFACTS.get()` costs an RPC per render.
    artifactsRemote: text("artifacts_remote"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_repositories_namespace_slug").on(table.namespaceId, table.slug),
    uniqueIndex("uq_repositories_do_name").on(table.doName),
    // Owner page / namespace listing without scanning the namespace.
    index("idx_repositories_namespace_updated").on(
      table.namespaceId,
      desc(table.updatedAt),
      table.slug
    ),
    check("chk_repositories_visibility", sql`"visibility" IN ('public','private')`),
  ]
);

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
