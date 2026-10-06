import { and, desc, eq, exists, or, sql } from "drizzle-orm";

import type { Db } from "@/worker/db/d1/client";
import { namespaceMemberships } from "@/worker/db/d1/schema/namespaceMemberships";
import { namespaces } from "@/worker/db/d1/schema/namespaces";
import {
  type NewRepositoryRow,
  type RepositoryRow,
  type RepositoryVisibility,
  repositories,
} from "@/worker/db/d1/schema/repositories";

export async function findRepositoryById(
  db: Db,
  repositoryId: string
): Promise<RepositoryRow | undefined> {
  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  return rows[0];
}

export async function findRepositoryByDoName(
  db: Db,
  doName: string
): Promise<RepositoryRow | undefined> {
  const rows = await db.select().from(repositories).where(eq(repositories.doName, doName)).limit(1);
  return rows[0];
}

export async function findRepositoryByNamespaceAndSlug(
  db: Db,
  namespaceId: string,
  slug: string
): Promise<RepositoryRow | undefined> {
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.namespaceId, namespaceId), eq(repositories.slug, slug)))
    .limit(1);
  return rows[0];
}

// Used by repository creation and operator/test seeding. The conflict path
// keeps existing rows untouched, so safe replays and re-runs are idempotent.
export async function insertRepositoryIfNew(
  db: Db,
  row: NewRepositoryRow
): Promise<RepositoryRow | undefined> {
  const inserted = await db.insert(repositories).values(row).onConflictDoNothing().returning();
  return inserted[0];
}

export type RepositoryListing = {
  repository: RepositoryRow;
  namespace: { id: string; slug: string };
};

// All repositories owned by a user via namespace memberships, ordered by the
// user-facing full repository name (`namespace/repo`). This keeps account
// listings stable even when pushes update repository activity timestamps.
export async function listRepositoriesForUser(
  db: Db,
  userId: string
): Promise<RepositoryListing[]> {
  const rows = await db
    .select({ repository: repositories, namespaceSlug: namespaces.slug })
    .from(repositories)
    .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
    .innerJoin(namespaceMemberships, eq(repositories.namespaceId, namespaceMemberships.namespaceId))
    .where(eq(namespaceMemberships.userId, userId))
    .orderBy(namespaces.slug, repositories.slug);
  return rows.map((row) => ({
    repository: row.repository,
    namespace: { id: row.repository.namespaceId, slug: row.namespaceSlug },
  }));
}

// Membership is owner-equivalent in this migration; an `EXISTS` subquery
// lets the same owner page query include private rows only for members.
export async function listRepositoriesForNamespace(
  db: Db,
  namespaceId: string,
  viewerUserId: string | null
): Promise<RepositoryRow[]> {
  if (viewerUserId === null) {
    return await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.namespaceId, namespaceId), eq(repositories.visibility, "public")))
      .orderBy(repositories.slug);
  }
  const memberClause = exists(
    db
      .select({ one: sql`1` })
      .from(namespaceMemberships)
      .where(
        and(
          eq(namespaceMemberships.namespaceId, namespaceId),
          eq(namespaceMemberships.userId, viewerUserId)
        )
      )
  );
  return await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.namespaceId, namespaceId),
        or(eq(repositories.visibility, "public"), memberClause)
      )
    )
    .orderBy(repositories.slug);
}

export async function touchRepositoryUpdatedAt(
  db: Db,
  repositoryId: string,
  now: number
): Promise<void> {
  await db.update(repositories).set({ updatedAt: now }).where(eq(repositories.id, repositoryId));
}

// Deletes a repository row by id. Schema FK cascades remove `pat_repo_grants`
// for that repo. Namespace-scoped grants in `pat_namespace_grants` are
// intentionally untouched: they still cover any other or future repo in the
// same namespace.
//
// Returns true on first run, false on replay (row already absent). Callers
// must enforce membership before invoking; this DAL has no auth opinion so
// the queue consumer can use it after the request-path gate has already
// run.
export async function deleteRepositoryById(db: Db, repositoryId: string): Promise<boolean> {
  const result = await db
    .delete(repositories)
    .where(eq(repositories.id, repositoryId))
    .returning({ id: repositories.id });
  return result.length === 1;
}

// Caller must verify membership before calling. Empty/whitespace input
// normalizes to NULL so clearing the field removes the description.
export async function updateRepositoryDescription(
  db: Db,
  repositoryId: string,
  description: string | null,
  now: number
): Promise<void> {
  const normalized = description?.trim() ? description.trim() : null;
  await db
    .update(repositories)
    .set({ description: normalized, updatedAt: now })
    .where(eq(repositories.id, repositoryId));
}

// About-sidebar website link; only http(s) URLs are stored — anything else
// is dropped to null rather than persisted for the renderer to trip over.
export async function updateRepositoryWebsite(
  db: Db,
  repositoryId: string,
  website: string | null,
  now: number
): Promise<void> {
  const trimmed = website?.trim() ?? "";
  const normalized = /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
  await db
    .update(repositories)
    .set({ website: normalized, updatedAt: now })
    .where(eq(repositories.id, repositoryId));
}

export type UpdateRepositoryVisibilityResult =
  | { ok: true; previous: RepositoryVisibility; current: RepositoryVisibility }
  | { ok: false; reason: "not-found" };

// Caller must verify membership before calling. Returns previous visibility
// so the caller can decide whether to clear the route KV (privacy hygiene).
export async function updateRepositoryVisibility(
  db: Db,
  repositoryId: string,
  visibility: RepositoryVisibility,
  now: number
): Promise<UpdateRepositoryVisibilityResult> {
  const rows = await db
    .select({ visibility: repositories.visibility })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: "not-found" };
  await db
    .update(repositories)
    .set({ visibility, updatedAt: now })
    .where(eq(repositories.id, repositoryId));
  return {
    ok: true,
    previous: existing.visibility,
    current: visibility,
  };
}

/**
 * Rename a repository's slug within its namespace. The (namespaceId, slug)
 * unique constraint means a collision resolves to a no-op — callers detect
 * it by re-reading the row. Route-cache sync must run afterwards so the old
 * slug stops resolving.
 */
export async function updateRepositorySlug(
  db: Db,
  repositoryId: string,
  slug: string,
  now: number
): Promise<boolean> {
  const rows = await db
    .update(repositories)
    .set({ slug, updatedAt: now })
    .where(eq(repositories.id, repositoryId))
    .returning({ id: repositories.id });
  return rows.length === 1;
}

/**
 * Move a repository to a different namespace ("transfer" in forge terms).
 * The caller verifies membership in both namespaces; the route-cache sync
 * afterwards re-registers the path under the new owner slug.
 */
export async function updateRepositoryNamespace(
  db: Db,
  repositoryId: string,
  namespaceId: string,
  now: number
): Promise<boolean> {
  const rows = await db
    .update(repositories)
    .set({ namespaceId, updatedAt: now })
    .where(eq(repositories.id, repositoryId))
    .returning({ id: repositories.id });
  return rows.length === 1;
}

// --- fork lineage ------------------------------------------------------------

/** Direct fork count for the repo JSON `num_forks` field. */
export async function countForks(db: Db, repositoryId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.forkedFromId, repositoryId));
  return rows[0]?.count ?? 0;
}

export type ForkNode = {
  repository: RepositoryRow;
  namespaceSlug: string;
};

/** Total repos owned by a namespace (gists included) — quota accounting. */
export async function countRepositoriesForNamespace(db: Db, namespaceId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.namespaceId, namespaceId));
  return rows[0]?.count ?? 0;
}

/**
 * Fork network for a repo: walk up to the root, then BFS down collecting
 * every descendant with its owning namespace slug. Public-only filtering
 * happens at the route layer (private forks are simply absent from the
 * response for unauthorized viewers).
 */
export async function listForkNetwork(db: Db, repositoryId: string): Promise<ForkNode[]> {
  // Root = oldest ancestor (bounded — pathological chains stop at 32 hops).
  let rootId = repositoryId;
  for (let hops = 0; hops < 32; hops++) {
    const row = await db
      .select({ parent: repositories.forkedFromId })
      .from(repositories)
      .where(eq(repositories.id, rootId))
      .limit(1);
    if (!row[0]?.parent) break;
    rootId = row[0].parent;
  }
  const out: ForkNode[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < 512) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const children = await db
      .select({ repository: repositories, namespaceSlug: namespaces.slug })
      .from(repositories)
      .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
      .where(eq(repositories.forkedFromId, id));
    for (const child of children) {
      out.push(child);
      queue.push(child.repository.id);
    }
  }
  return out;
}

/** Gist-backed repos hide from space lists but resolve publicly by slug. */
export async function findGistBySlug(
  db: Db,
  slug: string
): Promise<{ repository: RepositoryRow; namespaceSlug: string } | undefined> {
  const rows = await db
    .select({ repository: repositories, namespaceSlug: namespaces.slug })
    .from(repositories)
    .innerJoin(namespaces, eq(repositories.namespaceId, namespaces.id))
    .where(and(eq(repositories.slug, slug), eq(repositories.isGist, 1)))
    .limit(1);
  return rows[0];
}

/** All gist repos a user created (any namespace), newest first. */
export async function listGistsForUser(db: Db, userId: string): Promise<RepositoryRow[]> {
  return await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.createdBy, userId), eq(repositories.isGist, 1)))
    .orderBy(desc(repositories.createdAt));
}
