// Gists — GitHub-shaped gist surface on top of ordinary repositories.
//
// A gist IS a repo: `repositories.is_gist = 1`, slug `g-<rand>`, one `main`
// branch, full clone/push/history for free. The row is hidden from space
// repo lists and surfaced here instead. Secret gists are private repos —
// stricter than GitHub's link-readable "secret" but consistent with our
// non-enumerable private-repo model.
//
// Write path reuses the web-commit machinery: commitFileActions builds the
// tree diff → writeServerPack → R2 → acceptPatchCommit opens a merge intent
// → commitMerge fast-forwards `main` (attemptMerge on base_moved). Root
// commits pass expectedBaseOid "" — commitMergeState's missing-ref CAS value.

import type { AppRouter } from "@/worker/routes/hono";
import type { CacheContext } from "@/worker/cache";
import type { Viewer } from "@/client/server/viewer";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import {
  findGistBySlug,
  insertRepositoryIfNew,
  listGistsForUser,
  updateRepositoryDescription,
} from "@/worker/db/d1/dal/repositories";
import {
  findNamespaceById as findNsById,
  findNamespaceBySlug,
} from "@/worker/db/d1/dal/namespaces";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { isStarred, starRepository, unstarRepository } from "@/worker/db/d1/dal/social";
import type { RepositoryDeleteMessage } from "@/worker/tasks/types";
import {
  getHeadAndRefs,
  listCommitsFirstParentRange,
  readPath,
} from "@/worker/git/operations/read";
import { attemptMerge } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { getRepoStub, newPrefixedId } from "@/worker/common";
import { enqueueRouteCacheSync } from "@/worker/routes/authShared";
import { loadViewer } from "@/worker/auth/session";
import { validateSlugForRoute } from "@/shared/slugs";
import { enforceInNamespace, principalForUser } from "@/worker/rbac";
import { readNamespaceBlocks } from "./stores";
import { commitFileActions, type CommitFilesRequest } from "./commitFiles";
import {
  gErr,
  gNotFound,
  normalizeIdentifier,
  toGitnessCommit,
  type GitnessContext,
} from "./shared";

const GIST_BRANCH = "refs/heads/main";

// Gist slugs are globally unique ids (GitHub parity) — 12 hex chars keeps
// collision odds negligible; the create path re-rolls on a findGistBySlug hit.
function newGistSlug() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return `g-${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type ResolvedGist =
  | { kind: "ok"; row: RepositoryRow; namespaceSlug: string }
  | { kind: "response"; response: Response };

/** Resolve a gist id → repo row, enforcing private-visibility gates. */
async function resolveGist(c: GitnessContext, gistId: string): Promise<ResolvedGist> {
  const found = await findGistBySlug(c.var.db, gistId);
  if (!found) return { kind: "response", response: gNotFound(c, "gist") };
  const { repository: row, namespaceSlug } = found;
  if (row.visibility !== "public") {
    // Non-enumerable: non-public gists look exactly like missing ones.
    const viewer = await loadViewer(c);
    if (!viewer || !(await viewerIsNamespaceMember(c.var.db, viewer.userId, row.namespaceId))) {
      return { kind: "response", response: gNotFound(c, "gist") };
    }
  }
  return { kind: "ok", row, namespaceSlug };
}

type GistWriteGate =
  | { kind: "ok"; viewer: Viewer; row: RepositoryRow; namespaceSlug: string; actor: string }
  | { kind: "response"; response: Response };

/**
 * `requireWriter` for gists — same checks (membership + namespace block +
 * RBAC write) but resolved through the gist id rather than `repo_ref`.
 */
async function requireGistWriter(c: GitnessContext): Promise<GistWriteGate> {
  const viewer = await loadViewer(c);
  if (!viewer) return { kind: "response", response: gErr(c, 401, "unauthorized") };
  const g = await resolveGist(c, c.req.param("id") ?? "");
  if (g.kind !== "ok") return g;
  const db = c.var.db;
  if (!(await viewerIsNamespaceMember(db, viewer.userId, g.row.namespaceId))) {
    return { kind: "response", response: gErr(c, 403, "not a member of this space") };
  }
  if ((await readNamespaceBlocks(c.env, g.row.namespaceId)).includes(viewer.userId)) {
    return { kind: "response", response: gErr(c, 403, "blocked by this space") };
  }
  const allowed = await enforceInNamespace(
    db,
    g.row.namespaceId,
    principalForUser(viewer.userId),
    `repo:${g.row.doName}`,
    "write"
  );
  if (!allowed) {
    return { kind: "response", response: gErr(c, 403, "insufficient role for writes") };
  }
  return {
    kind: "ok",
    viewer,
    row: g.row,
    namespaceSlug: g.namespaceSlug,
    actor: viewer.primaryNamespaceSlug ?? viewer.userId,
  };
}

/** GitHub gist file map — reads each top-level blob under `main`. */
async function gistFiles(env: Env, doName: string, slug: string, cacheCtx?: CacheContext) {
  const result = await readPath(env, doName, GIST_BRANCH, "", cacheCtx).catch(() => null);
  const files: Record<
    string,
    { filename: string; size: number; content: string; raw_url: string }
  > = {};
  if (result?.type !== "tree") return files;
  for (const entry of result.entries ?? []) {
    if (entry.mode.startsWith("40000")) continue;
    const blob = await readPath(env, doName, GIST_BRANCH, entry.name, cacheCtx).catch(() => null);
    if (blob?.type !== "blob") continue;
    const content = new TextDecoder().decode(blob.content);
    files[entry.name] = {
      filename: entry.name,
      size: content.length,
      content,
      raw_url: `/api/v1/gists/${slug}/raw/${encodeURIComponent(entry.name)}`,
    };
  }
  return files;
}

function gistJson(
  row: RepositoryRow,
  namespaceSlug: string,
  files: Awaited<ReturnType<typeof gistFiles>>,
  extras: { viewer_starred?: boolean } = {}
) {
  const path = `${namespaceSlug}/${row.slug}`;
  return {
    id: row.slug,
    node_id: row.id,
    description: row.description ?? "",
    public: row.visibility === "public",
    html_url: `/${path}`,
    git_pull_url: `/${path}.git`,
    git_push_url: `/${path}.git`,
    files,
    owner: { login: namespaceSlug },
    viewer_starred: extras.viewer_starred ?? false,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * Commit a file-action set to `main`. The acceptPatchCommit + commitMerge
 * pair is the same intent/merge machinery web commits ride — a missing
 * `main` fast-forwards via expectedBaseOid "". base_moved falls back to
 * attemptMerge, which computes a real merge against the moved head.
 */
async function commitGistActions(
  c: GitnessContext,
  args: {
    doName: string;
    baseOid: string | undefined;
    req: CommitFilesRequest;
    actor: string;
    cacheCtx?: CacheContext;
  }
): Promise<{ kind: "ok"; commitOid: string } | { kind: "failed"; reason: string }> {
  const built = await commitFileActions({
    env: c.env,
    repoId: args.doName,
    baseCommitOid: args.baseOid,
    req: args.req,
    author: `${args.actor} <web@delta-git.invalid>`,
    cacheCtx: args.cacheCtx,
  });
  if (built.kind === "failed") return { kind: "failed", reason: built.reason };

  const stub = getRepoStub(c.env, args.doName);
  const pack = await writeServerPack(built.objects);
  const packKey = r2PackKey(
    doPrefix(stub.id.toString()),
    `pack-gist-${built.commitOid.slice(0, 12)}.pack`
  );
  await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
  await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

  const stagedPack = {
    packKey,
    packBytes: pack.packBytes.length,
    idxBytes: pack.idxBytes.length,
    objectCount: pack.objectCount,
  };
  const accepted = await stub.acceptPatchCommit({
    targetRef: GIST_BRANCH,
    newOid: built.commitOid,
    actor: args.actor,
    kind: "push.gist",
    stagedPack,
  });

  const committed = await stub.commitMerge({
    intentId: accepted.intent.id,
    expectedBaseOid: args.baseOid ?? "",
    mergeOid: built.commitOid,
    stagedPack,
    actor: args.actor,
    method: "auto",
  });
  if (committed.status === "committed") return { kind: "ok", commitOid: built.commitOid };

  // Concurrent write moved main — let the merge engine compute a real merge.
  const merge = await attemptMerge({
    env: c.env,
    repoId: args.doName,
    stub,
    intentId: accepted.intent.id,
    actor: args.actor,
    cacheCtx: args.cacheCtx,
  });
  if (merge.kind === "merged") return { kind: "ok", commitOid: merge.mergeOid };
  if (merge.kind === "conflict") {
    return { kind: "failed", reason: `conflicts: ${merge.conflicts.join(", ")}` };
  }
  return { kind: "failed", reason: "commit could not land" };
}

/** Normalize GitHub/gitness file payloads into CommitFilesRequest actions. */
function fileActionsFrom(
  files: Record<string, { content?: string; filename?: string } | string | null> | undefined
): NonNullable<CommitFilesRequest["actions"]> {
  const actions: NonNullable<CommitFilesRequest["actions"]> = [];
  for (const [name, spec] of Object.entries(files ?? {})) {
    if (spec === null) {
      // GitHub PATCH {files: {name: null}} deletes the file.
      actions.push({ action: "DELETE", path: name });
      continue;
    }
    const s = typeof spec === "string" ? { content: spec } : spec;
    // A differing `filename` field is GitHub's rename: delete old, write new.
    if (s.filename && s.filename !== name) {
      actions.push({ action: "DELETE", path: name });
    }
    actions.push({ action: "UPDATE", path: s.filename ?? name, payload: s.content ?? "" });
  }
  return actions;
}

export function registerGitnessGists(router: AppRouter) {
  // --- create -------------------------------------------------------------
  router.post("/api/v1/gists", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      description?: string;
      public?: boolean;
      files?: Record<string, { content?: string } | string>;
    } | null;
    const files = body?.files ?? {};
    if (Object.keys(files).length === 0) return gErr(c, 422, "a gist needs at least one file");

    const nsSlug = viewer.primaryNamespaceSlug;
    if (!nsSlug) return gErr(c, 400, "no personal space");
    const nsValidation = validateSlugForRoute(normalizeIdentifier(nsSlug));
    if (!nsValidation.ok) return gErr(c, 400, "invalid space identifier");
    const namespace = await findNamespaceBySlug(c.var.db, nsValidation.slug);
    if (!namespace) return gNotFound(c, "space");

    let slug = newGistSlug();
    for (let i = 0; i < 8 && (await findGistBySlug(c.var.db, slug)); i++) slug = newGistSlug();

    const now = Date.now();
    const repositoryId = newPrefixedId("repo");
    const row = await insertRepositoryIfNew(c.var.db, {
      id: repositoryId,
      namespaceId: namespace.id,
      createdBy: viewer.userId,
      slug,
      doName: `repo:${repositoryId.slice("repo_".length)}`,
      // GitHub's default is secret; `public` opt-in mirrors that.
      visibility: body?.public === false ? "private" : "public",
      encrypted: 0,
      description: body?.description || null,
      forkedFromId: null,
      isGist: 1,
      backend: "do",
      artifactsName: null,
      artifactsRemote: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!row) return gErr(c, 409, "gist id collision; retry");
    enqueueRouteCacheSync(c, c.var.logFor({ service: "GistCreate" }), {
      repositoryId: row.id,
      namespaceSlug: nsValidation.slug,
      repoSlug: slug,
    });

    const committed = await commitGistActions(c, {
      doName: row.doName,
      baseOid: undefined,
      req: { branch: "main", actions: fileActionsFrom(files), message: "gist" },
      actor: viewer.primaryNamespaceSlug ?? viewer.userId,
    });
    if (committed.kind === "failed") return gErr(c, 422, committed.reason);

    return c.json(gistJson(row, nsValidation.slug, await gistFiles(c.env, row.doName, slug)), 201);
  });

  // --- list mine ----------------------------------------------------------
  router.get("/api/v1/gists", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const rows = await listGistsForUser(c.var.db, viewer.userId);
    // Gists can span namespaces; resolve each distinct id once.
    const nsById = new Map<string, string>();
    for (const row of rows) {
      if (nsById.has(row.namespaceId)) continue;
      const ns = await findNsById(c.var.db, row.namespaceId);
      if (ns) nsById.set(row.namespaceId, ns.slug);
    }
    return c.json(
      rows.slice(0, 100).map((row) => gistJson(row, nsById.get(row.namespaceId) ?? "", {}))
    );
  });

  // --- detail -------------------------------------------------------------
  router.get("/api/v1/gists/:id", async (c) => {
    const g = await resolveGist(c, c.req.param("id"));
    if (g.kind !== "ok") return g.response;
    const viewer = await loadViewer(c);
    const files = await gistFiles(c.env, g.row.doName, g.row.slug);
    return c.json(
      gistJson(g.row, g.namespaceSlug, files, {
        viewer_starred: viewer ? await isStarred(c.var.db, viewer.userId, g.row.id) : false,
      })
    );
  });

  // --- file content -------------------------------------------------------
  router.get("/api/v1/gists/:id/raw/:filename", async (c) => {
    const g = await resolveGist(c, c.req.param("id"));
    if (g.kind !== "ok") return g.response;
    const blob = await readPath(
      c.env,
      g.row.doName,
      GIST_BRANCH,
      decodeURIComponent(c.req.param("filename"))
    ).catch(() => null);
    if (blob?.type !== "blob") return gNotFound(c, "file");
    return new Response(new Blob([blob.content.slice().buffer]), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // --- commits ------------------------------------------------------------
  router.get("/api/v1/gists/:id/commits", async (c) => {
    const g = await resolveGist(c, c.req.param("id"));
    if (g.kind !== "ok") return g.response;
    const commits = await listCommitsFirstParentRange(
      c.env,
      g.row.doName,
      GIST_BRANCH,
      0,
      50
    ).catch(() => []);
    return c.json(commits.map((info) => toGitnessCommit(info)));
  });

  // --- update -------------------------------------------------------------
  router.patch("/api/v1/gists/:id", async (c) => {
    const gate = await requireGistWriter(c);
    if (gate.kind !== "ok") return gate.response;
    const body = (await c.req.json().catch(() => null)) as {
      description?: string;
      files?: Record<string, { content?: string; filename?: string } | string | null>;
    } | null;

    const actions = fileActionsFrom(body?.files);
    if (actions.length > 0) {
      const { refs } = await getHeadAndRefs(c.env, gate.row.doName);
      const baseOid = refs.find((r) => r.name === GIST_BRANCH)?.oid;
      const committed = await commitGistActions(c, {
        doName: gate.row.doName,
        baseOid,
        req: { branch: "main", actions, message: "update gist" },
        actor: gate.actor,
      });
      if (committed.kind === "failed") return gErr(c, 422, committed.reason);
    }
    if (body?.description !== undefined) {
      await updateRepositoryDescription(c.var.db, gate.row.id, body.description, Date.now());
      // The response re-renders from `gate.row` — keep it in sync with the
      // write so callers see the new description without a refetch.
      gate.row.description = body.description.trim() ? body.description.trim() : null;
      gate.row.updatedAt = Date.now();
    }
    return c.json(
      gistJson(gate.row, gate.namespaceSlug, await gistFiles(c.env, gate.row.doName, gate.row.slug))
    );
  });

  // --- delete -------------------------------------------------------------
  router.delete("/api/v1/gists/:id", async (c) => {
    const gate = await requireGistWriter(c);
    if (gate.kind !== "ok") return gate.response;
    const message: RepositoryDeleteMessage = {
      kind: "repository-delete",
      repositoryId: gate.row.id,
      namespaceId: gate.row.namespaceId,
      namespaceSlug: gate.namespaceSlug,
      repoSlug: gate.row.slug,
      doName: gate.row.doName,
      actor: gate.viewer.userId,
      requestedAt: Date.now(),
    };
    await c.env.REPO_TASKS_QUEUE.send(message);
    return c.body(null, 204);
  });

  // --- star / unstar ------------------------------------------------------
  // Any authenticated reader can star — GitHub parity; write-gate is for
  // file edits only.
  router.put("/api/v1/gists/:id/star", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const g = await resolveGist(c, c.req.param("id"));
    if (g.kind !== "ok") return g.response;
    await starRepository(c.var.db, viewer.userId, g.row.id);
    return c.json({});
  });

  router.delete("/api/v1/gists/:id/star", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const g = await resolveGist(c, c.req.param("id"));
    if (g.kind !== "ok") return g.response;
    await unstarRepository(c.var.db, viewer.userId, g.row.id);
    return c.body(null, 204);
  });
}
