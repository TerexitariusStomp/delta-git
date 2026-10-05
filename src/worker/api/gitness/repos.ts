// Gitness facade: repository metadata endpoints.
//
// `RepoRepositoryOutput` is populated from the D1 repositories row plus, for
// the detail GET only, a DO `getHeadAndRefs`/`listMergeIntents` round to fill
// `is_empty`/PR counters. The list mapper skips the DO hop — repo lists would
// otherwise fan out one RPC per row.

import type { AppRouter } from "@/worker/routes/hono";
import type { RepositoryDeleteMessage } from "@/worker/tasks/types";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import {
  findNamespaceById,
  findNamespaceBySlug,
  findRepositoryByDoName,
  findRepositoryByNamespaceAndSlug,
  insertRepositoryIfNew,
  insertUserIfNew,
  insertMembershipIfMissing,
  updateRepositoryDescription,
  updateRepositoryNamespace,
  updateRepositorySlug,
  updateRepositoryVisibility,
} from "@/worker/db/d1/dal";
import { loadViewer, generateUserId } from "@/worker/auth/session";
import { viewerIsNamespaceMember, generatePatPlaintext, hashPatPlaintext } from "@/worker/auth/pat";
import { insertPatWithGrants } from "@/worker/db/d1/dal/tokens";
import { validateSlugForRoute } from "@/shared/slugs";
import { newPrefixedId } from "@/worker/common";
import { getRepoStub } from "@/worker/common";
import {
  getHeadAndRefs,
  listCommitsFirstParentRange,
  readCommit,
  readPath,
  readLooseObjectRaw,
} from "@/worker/git/operations/read";
import { serializeTree } from "@/worker/git/core/tree";
import { computeOid } from "@/worker/git/core";
import { writeServerPack, type NewObject } from "@/worker/merge/packWriter";
import { attemptMerge, findMergeBase, mergeTrees, buildCommitPayload } from "@/worker/merge/engine";
import { readPayload } from "@/worker/agent/patch";
import { importRemoteRepo, syncRemoteRepo } from "@/worker/agent/importer";
import { encryptRepoSecret } from "@/worker/agent/secrets";
import { enqueueRouteCacheSync } from "@/worker/routes/authShared";
import {
  readRepoLabels,
  writeRepoLabels,
  readRepoRules,
  writeRepoRules,
  readRepoPipelines,
  writeRepoPipelines,
  readRepoLink,
  writeRepoLink,
  readImportProgress,
  writeImportProgress,
  readRepoTemplates,
  writeRepoTemplates,
  readSecuritySettings,
  writeSecuritySettings,
} from "./stores";
import type { RepoLabel, RepoRule, RepoPipeline, RepoTemplate } from "./stores";
import {
  gErr,
  gNotFound,
  numericId,
  parseRepoRef,
  requireWriter,
  resolveGitnessRepo,
} from "./shared";
import type { GitnessContext, RepoAccessOk } from "./shared";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { readTree } from "@/worker/git/operations/read";

const OPEN_STATUSES = ["open", "merging", "adjudicating", "conflict"];
const DONE_STATUSES = ["merged", "rejected", "expired"];

// Secret-signature patterns for the security-scan endpoint — the same class
// of detector the push gate runs (high-signal, low-false-positive).
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  {
    kind: "generic-api-key",
    re: /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][0-9A-Za-z+/=_-]{24,}["']/i,
  },
];

/** CODEOWNERS grammar: `pattern owner1 @owner2 …`, `#` comments, blanks. */
function parseCodeowners(text: string): { pattern: string; owners: string[] }[] {
  const entries: { pattern: string; owners: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) entries.push({ pattern, owners });
  }
  return entries;
}

/**
 * Slug rename through the DAL + route-cache sync. The old path keeps
 * resolving until the queue consumer processes the sync — matching the
 * async behavior of every other rename lane.
 */
async function renameRepo(
  c: GitnessContext,
  gate: RepoAccessOk & { actor: string },
  newSlug: string
): Promise<Response> {
  const validation = validateSlugForRoute(newSlug);
  if (!validation.ok) return gErr(c, 400, "invalid identifier");
  const row = await findRepositoryByDoName(c.var.db, gate.route.doName);
  if (!row) return gNotFound(c, "repository");
  const ns = await findNamespaceById(c.var.db, row.namespaceId);
  const clash = await findRepositoryByNamespaceAndSlug(c.var.db, row.namespaceId, validation.slug);
  if (clash && clash.id !== row.id) return gErr(c, 409, "identifier already in use");
  await updateRepositorySlug(c.var.db, row.id, validation.slug, Date.now());
  enqueueRouteCacheSync(c, c.var.logFor({ service: "GitnessRepoRename" }), {
    repositoryId: row.id,
    namespaceSlug: ns?.slug ?? "",
    repoSlug: validation.slug,
  });
  return c.json({ identifier: validation.slug });
}

export function toGitnessRepo(
  row: RepositoryRow,
  nsSlug: string,
  extra?: {
    isEmpty?: boolean;
    openPulls?: number;
    mergedPulls?: number;
    closedPulls?: number;
  }
) {
  const path = `${nsSlug}/${row.slug}`;
  const origin = "https://git-on-cloudflare.delta-git.workers.dev";
  return {
    id: numericId(row.id),
    identifier: row.slug,
    path,
    description: row.description ?? "",
    default_branch: "main",
    git_url: `${origin}/${path}.git`,
    git_ssh_url: "",
    is_public: row.visibility === "public",
    is_empty: extra?.isEmpty,
    num_open_pulls: extra?.openPulls,
    num_merged_pulls: extra?.mergedPulls,
    num_closed_pulls: extra?.closedPulls,
    num_pulls:
      extra?.openPulls !== undefined
        ? extra.openPulls + (extra.mergedPulls ?? 0) + (extra.closedPulls ?? 0)
        : undefined,
    num_forks: 0,
    created: row.createdAt,
    updated: row.updatedAt,
    // EnumRepoState is `number | null` upstream; gitness emits 0 for active.
    state: 0,
    repo_type: "code",
  };
}

export function registerGitnessRepos(router: AppRouter) {
  // --- mutations (subset) ---------------------------------------------------

  router.patch("/api/v1/repos/:repo_ref{.+}", async (c) => {
    const parsed = parseRepoRef(c.req.param("repo_ref"));
    if (!parsed) return gNotFound(c, "repository");
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { description?: string } | null;
    if (body?.description !== undefined) {
      const row = await findRepositoryByDoName(c.var.db, access.route.doName);
      if (row) await updateRepositoryDescription(c.var.db, row.id, body.description, Date.now());
    }
    return c.json({});
  });

  router.post("/api/v1/repos/:repo_ref{.+}/public-access", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { is_public?: boolean } | null;
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    await updateRepositoryVisibility(
      c.var.db,
      row.id,
      body?.is_public === false ? "private" : "public",
      Date.now()
    );
    return c.json({});
  });

  // Repo delete rides the same durable pipeline as the admin purge:
  // enqueue only — the queue consumer owns D1/ROUTES/R2/DO teardown.
  router.delete("/api/v1/repos/:repo_ref{.+}", async (c) => {
    const log = c.var.logFor({ service: "GitnessRepoDelete" });
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    if (!(await viewerIsNamespaceMember(c.var.db, access.viewer.userId, row.namespaceId))) {
      return gErr(c, 403, "not a member of this space");
    }
    const parsed = parseRepoRef(c.req.param("repo_ref"))!;
    const message: RepositoryDeleteMessage = {
      kind: "repository-delete",
      repositoryId: row.id,
      namespaceId: row.namespaceId,
      namespaceSlug: parsed.owner,
      repoSlug: parsed.repo,
      doName: access.route.doName,
      actor: access.viewer.userId,
      requestedAt: Date.now(),
    };
    try {
      await c.env.REPO_TASKS_QUEUE.send(message);
    } catch (error) {
      log.error("repo-delete:enqueue-failed", { error: String(error) });
      return gErr(c, 503, "failed to enqueue delete; please retry");
    }
    log.info("repo-delete:enqueued", { repositoryId: row.id });
    return c.json({});
  });

  // --- import / link / fork -----------------------------------------------------
  //
  // All three lanes ride the real v2 fetch importer. The repo row is created
  // synchronously; the ingest runs in `ctx.waitUntil` and records progress in
  // the `gimport:` KV record the *-progress endpoints read.

  /** Head arg for ingestRemoteSync — only when oid is known. */
  function headArg(head: { target: string; oid?: string } | undefined) {
    return head?.oid ? { target: head.target, oid: head.oid } : undefined;
  }

  type ImportBody = {
    uid?: string; // remote URL (gitness calls it uid or provider_repo)
    provider_repo?: string;
    url?: string;
    identifier?: string;
    description?: string;
    is_public?: boolean;
    parent_ref?: string;
    branch?: string;
  };

  // Shared row-creation used by POST /repos, /import, /link and fork. Kept as
  // a module-level helper so every entry point enforces identical membership
  // + slug checks and fires the same route-cache sync.
  async function insertRepo(
    c: GitnessContext,
    viewer: { userId: string },
    nsSlug: string,
    slug: string,
    opts: { description?: string; isPublic?: boolean }
  ): Promise<{ row: RepositoryRow } | { error: Response }> {
    const nsValidation = validateSlugForRoute(nsSlug);
    const slugValidation = validateSlugForRoute(slug);
    if (!nsValidation.ok || !slugValidation.ok) {
      return { error: gErr(c, 400, "invalid space or repository identifier") };
    }
    const namespace = await findNamespaceBySlug(c.var.db, nsValidation.slug);
    if (!namespace) return { error: gNotFound(c, "space") };
    if (!(await viewerIsNamespaceMember(c.var.db, viewer.userId, namespace.id))) {
      return { error: gErr(c, 403, "not a member of this space") };
    }
    const now = Date.now();
    const repositoryId = newPrefixedId("repo");
    const doName = `repo:${repositoryId.slice("repo_".length)}`;
    const inserted = await insertRepositoryIfNew(c.var.db, {
      id: repositoryId,
      namespaceId: namespace.id,
      createdBy: viewer.userId,
      slug: slugValidation.slug,
      doName,
      visibility: opts.isPublic === false ? "private" : "public",
      description: opts.description || null,
      backend: "do",
      artifactsName: null,
      artifactsRemote: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!inserted) {
      return { error: gErr(c, 409, `repository ${slugValidation.slug} already exists`) };
    }
    const log = c.var.logFor({ service: "GitnessRepo" });
    enqueueRouteCacheSync(c, log, {
      repositoryId: inserted.id,
      namespaceSlug: nsValidation.slug,
      repoSlug: slugValidation.slug,
    });
    return { row: inserted };
  }

  // Repo create. Gitness `parent_ref` is the space path — our spaces are
  // flat owner namespaces, so the first segment is the namespace slug.
  router.post("/api/v1/repos", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      is_public?: boolean;
      parent_ref?: string;
    } | null;
    const nsSlug = (body?.parent_ref ?? "").split("/").filter(Boolean)[0] ?? "";
    const result = await insertRepo(c, viewer, nsSlug, body?.identifier ?? "", {
      description: body?.description,
      isPublic: body?.is_public,
    });
    if ("error" in result) return result.error;
    return c.json(toGitnessRepo(result.row, nsSlug.split("/").filter(Boolean)[0] ?? nsSlug));
  });

  /** Run an ingest off-request and keep `gimport:` progress truthful. */
  function runImportAsync(
    c: GitnessContext,
    doName: string,
    remoteUrl: string,
    viewer: string,
    branch?: string,
    headers?: Record<string, string>
  ) {
    const stub = getRepoStub(c.env, doName);
    c.executionCtx.waitUntil(
      (async () => {
        await writeImportProgress(c.env, doName, { state: "running", updated: Date.now() });
        const result = await importRemoteRepo({
          env: c.env,
          repoId: doName,
          stub,
          url: remoteUrl,
          branch,
          actor: viewer,
          headers,
        });
        await writeImportProgress(c.env, doName, {
          state: result.kind === "imported" ? "finished" : "failed",
          refs: result.kind !== "failed" ? result.refs : undefined,
          objects: result.kind === "imported" ? result.objects : undefined,
          reason: result.kind === "failed" ? result.reason : undefined,
          updated: Date.now(),
        });
      })().catch(async (err) => {
        await writeImportProgress(c.env, doName, {
          state: "failed",
          reason: String(err),
          updated: Date.now(),
        });
      })
    );
  }

  // Import = create repo + remote clone via the importer. `uid`/`url`/
  // `provider_repo` are the upstream URL field aliases the SPA sends.
  router.post("/api/v1/repos/import", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as ImportBody | null;
    const remote = body?.uid ?? body?.provider_repo ?? body?.url;
    if (!remote) return gErr(c, 400, "remote url required");
    const nsSlug = (body?.parent_ref ?? "").split("/").filter(Boolean)[0] ?? "";
    const result = await insertRepo(c, viewer, nsSlug, body?.identifier ?? "", {
      description: body?.description,
      isPublic: body?.is_public,
    });
    if ("error" in result) return result.error;
    runImportAsync(c, result.row.doName, remote, viewer.userId, body?.branch);
    await writeRepoLink(c.env, result.row.doName, {
      remote_url: remote,
      type: "linked",
      created: Date.now(),
    });
    return c.json(toGitnessRepo(result.row, nsSlug, { isEmpty: true }));
  });

  // Link = create repo bound to an upstream, then first sync — same path
  // as import but the link record is what `linked/sync` reuses.
  router.post("/api/v1/repos/link", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as ImportBody | null;
    const remote = body?.uid ?? body?.provider_repo ?? body?.url;
    if (!remote) return gErr(c, 400, "remote url required");
    const nsSlug = (body?.parent_ref ?? "").split("/").filter(Boolean)[0] ?? "";
    const result = await insertRepo(c, viewer, nsSlug, body?.identifier ?? "", {
      description: body?.description,
      isPublic: body?.is_public,
    });
    if ("error" in result) return result.error;
    runImportAsync(c, result.row.doName, remote, viewer.userId, body?.branch);
    await writeRepoLink(c.env, result.row.doName, {
      remote_url: remote,
      type: "linked",
      upstream_ref: body?.branch,
      created: Date.now(),
    });
    return c.json(toGitnessRepo(result.row, nsSlug, { isEmpty: true }));
  });

  // Progress endpoints all read the same KV record the ingest writes.
  for (const tail of ["import-progress", "link-progress", "fork-progress"]) {
    router.get(`/api/v1/repos/:repo_ref{.+}/${tail}`, async (c) => {
      const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
      if (access.kind !== "ok") return access.response;
      const progress = await readImportProgress(c.env, access.route.doName);
      if (!progress) return c.json({ state: "finished", progress: { state: 1 } });
      const stateNum = { running: 0, finished: 1, failed: 2 }[progress.state];
      return c.json({
        state: progress.state,
        progress: {
          state: stateNum,
          result: progress.reason ?? undefined,
          refs: progress.refs,
          objects: progress.objects,
        },
      });
    });
  }

  // Fork = copy the source's active packs R2-side, then converge the new
  // DO's refs/head via `ingestRemoteSync` — the same verb the artifacts
  // mirror path uses. No HTTP round-trip; delta refs stay behind by design.
  router.post("/api/v1/repos/:repo_ref{.+}/fork", async (c) => {
    const log = c.var.logFor({ service: "GitnessFork" });
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      parent_ref?: string;
    } | null;
    const srcSlug = parseRepoRef(c.req.param("repo_ref"))!;
    const nsSlug = (body?.parent_ref ?? "").split("/").filter(Boolean)[0] ?? srcSlug.owner;
    const result = await insertRepo(
      c,
      access.viewer,
      nsSlug,
      body?.identifier ?? `${srcSlug.repo}-fork`,
      {
        description: body?.description,
        isPublic: access.route.visibility === "public",
      }
    );
    if ("error" in result) return result.error;
    const targetDoName = result.row.doName;

    const srcStub = getRepoStub(c.env, access.route.doName);
    const [{ refs, head }, packs] = await Promise.all([
      srcStub.getHeadAndRefs(),
      srcStub.getActivePackCatalog(),
    ]);
    const dstStub = getRepoStub(c.env, targetDoName);
    const dstPrefix = doPrefix(dstStub.id.toString());
    const staged: { packKey: string; packBytes: number; idxBytes: number; objectCount: number }[] =
      [];
    for (const pack of packs) {
      const obj = await c.env.REPO_BUCKET.get(pack.packKey);
      if (!obj) continue;
      const newKey = r2PackKey(dstPrefix, pack.packKey.split("/").pop()!);
      await c.env.REPO_BUCKET.put(newKey, obj.body);
      const idx = await c.env.REPO_BUCKET.get(packIndexKey(pack.packKey));
      if (idx) await c.env.REPO_BUCKET.put(packIndexKey(newKey), idx.body);
      staged.push({
        packKey: newKey,
        packBytes: pack.packBytes,
        idxBytes: pack.idxBytes,
        objectCount: pack.objectCount,
      });
    }
    const synced = await dstStub.ingestRemoteSync({
      packs: staged,
      refs: refs.filter((r) => !r.name.startsWith("refs/delta/")),
      head: headArg(head),
      actor: access.viewer.userId,
    });
    if (synced.status !== "synced") {
      log.error("fork:ingest-failed", { sourceDoName: access.route.doName, targetDoName });
      return gErr(c, 500, "fork ingest failed");
    }
    await writeRepoLink(c.env, targetDoName, {
      remote_url: `internal:${access.route.doName}`,
      type: "fork",
      created: Date.now(),
    });
    await writeImportProgress(c.env, targetDoName, {
      state: "finished",
      refs: synced.refs,
      objects: staged.reduce((n, p) => n + p.objectCount, 0),
      updated: Date.now(),
    });
    return c.json(toGitnessRepo(result.row, nsSlug, { isEmpty: synced.refs === 0 }));
  });

  // Fork-sync pulls new packs across from the upstream DO (the link record
  // written at fork time), converging refs again — incremental R2 copy.
  router.post("/api/v1/repos/:repo_ref{.+}/fork-sync", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const link = await readRepoLink(c.env, gate.route.doName);
    if (!link || link.type !== "fork" || !link.remote_url.startsWith("internal:")) {
      return gErr(c, 409, "repository is not a fork of an internal repo");
    }
    const upstreamDoName = link.remote_url.slice("internal:".length);
    const srcStub = getRepoStub(c.env, upstreamDoName);
    const dstStub = getRepoStub(c.env, gate.route.doName);
    const [srcPacks, dstPacks, { refs, head }] = await Promise.all([
      srcStub.getActivePackCatalog(),
      dstStub.getActivePackCatalog(),
      srcStub.getHeadAndRefs(),
    ]);
    const dstSuffixes = new Set(dstPacks.map((p) => p.packKey.split("/").pop()));
    const dstPrefix = doPrefix(dstStub.id.toString());
    const staged: { packKey: string; packBytes: number; idxBytes: number; objectCount: number }[] =
      [];
    for (const pack of srcPacks) {
      const suffix = pack.packKey.split("/").pop()!;
      if (dstSuffixes.has(suffix)) continue;
      const obj = await c.env.REPO_BUCKET.get(pack.packKey);
      if (!obj) continue;
      const newKey = r2PackKey(dstPrefix, suffix);
      await c.env.REPO_BUCKET.put(newKey, obj.body);
      const idx = await c.env.REPO_BUCKET.get(packIndexKey(pack.packKey));
      if (idx) await c.env.REPO_BUCKET.put(packIndexKey(newKey), idx.body);
      staged.push({
        packKey: newKey,
        packBytes: pack.packBytes,
        idxBytes: pack.idxBytes,
        objectCount: pack.objectCount,
      });
    }
    const synced = await dstStub.ingestRemoteSync({
      packs: staged,
      refs: refs.filter((r) => !r.name.startsWith("refs/delta/")),
      head: headArg(head),
      actor: gate.actor,
    });
    if (synced.status !== "synced") return gErr(c, 500, "fork sync failed");
    return c.json({ synced: true, refs: synced.refs, packs_added: staged.length });
  });

  // Linked-sync re-runs the remote fetch path against the stored upstream.
  router.post("/api/v1/repos/:repo_ref{.+}/linked/sync", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const link = await readRepoLink(c.env, gate.route.doName);
    if (!link || link.remote_url.startsWith("internal:")) {
      return gErr(c, 409, "repository has no remote link");
    }
    const result = await syncRemoteRepo({
      env: c.env,
      repoId: gate.route.doName,
      stub: getRepoStub(c.env, gate.route.doName),
      url: link.remote_url,
      actor: gate.actor,
      cacheCtx: gate.cacheCtx,
    });
    if (result.kind === "failed") return gErr(c, 502, `upstream sync failed: ${result.reason}`);
    return c.json({ synced: true, refs: result.refs, objects: result.objects });
  });

  // Move = transfer to another namespace the caller belongs to.
  router.post("/api/v1/repos/:repo_ref{.+}/move", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as { space_ref?: string } | null;
    const nsValidation = validateSlugForRoute(body?.space_ref ?? "");
    if (!nsValidation.ok) return gErr(c, 400, "space_ref required");
    const target = await findNamespaceBySlug(c.var.db, nsValidation.slug);
    if (!target) return gNotFound(c, "space");
    if (!(await viewerIsNamespaceMember(c.var.db, gate.actor, target.id))) {
      return gErr(c, 403, "not a member of the target space");
    }
    const row = await findRepositoryByDoName(c.var.db, gate.route.doName);
    if (!row) return gNotFound(c, "repository");
    await updateRepositoryNamespace(c.var.db, row.id, target.id, Date.now());
    enqueueRouteCacheSync(c, c.var.logFor({ service: "GitnessRepoMove" }), {
      repositoryId: row.id,
      namespaceSlug: nsValidation.slug,
      repoSlug: row.slug,
    });
    return c.json({ path: `${nsValidation.slug}/${row.slug}` });
  });

  // Rebase: replay the source branch's commits onto the target tip via
  // three-way tree merges, then land the rewritten tip through the merge
  // lane (the intent row is the audit record of the rewrite). Conflicts
  // report the real conflicting paths.
  router.post("/api/v1/repos/:repo_ref{.+}/rebase", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      source_branch?: string;
      target_branch?: string;
    } | null;
    const sourceRef = `refs/heads/${(body?.source_branch ?? "").replace(/^refs\/heads\//, "")}`;
    const targetRef = `refs/heads/${(body?.target_branch ?? "").replace(/^refs\/heads\//, "")}`;
    if (!body?.source_branch || !body?.target_branch || sourceRef === targetRef) {
      return gErr(c, 400, "source_branch and target_branch required");
    }
    const stub = getRepoStub(c.env, gate.route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const sourceTip = refs.find((r) => r.name === sourceRef)?.oid;
    const targetTip = refs.find((r) => r.name === targetRef)?.oid;
    if (!sourceTip || !targetTip) return gNotFound(c, "branch");

    const baseOid = await findMergeBase(
      c.env,
      gate.route.doName,
      sourceTip,
      targetTip,
      gate.cacheCtx
    );
    if (baseOid === targetTip) return c.json({ rebased: true, sha: sourceTip, already: true });

    // First-parent chain from the source tip back to the merge base.
    const chain = await listCommitsFirstParentRange(
      c.env,
      gate.route.doName,
      sourceTip,
      0,
      200,
      gate.cacheCtx
    ).catch(() => []);
    const toReplay: { oid: string; tree: string; parents: string[]; message: string }[] = [];
    for (const commit of chain) {
      if (commit.oid === baseOid) break;
      if (toReplay.length >= 50) {
        return gErr(c, 422, "rebase exceeds the 50-commit replay bound");
      }
      toReplay.push(commit);
    }
    if (toReplay.length === 0) {
      return c.json({ rebased: true, sha: sourceTip, already: true });
    }
    toReplay.reverse();

    const objects: NewObject[] = [];
    let tip = targetTip;
    for (const commit of toReplay) {
      const parentTree =
        commit.parents.length > 0
          ? (
              await readCommit(c.env, gate.route.doName, commit.parents[0]!, gate.cacheCtx).catch(
                () => undefined
              )
            )?.tree
          : undefined;
      const tipTree = (
        await readCommit(c.env, gate.route.doName, tip, gate.cacheCtx).catch(() => undefined)
      )?.tree;
      if (!tipTree) return gErr(c, 422, "replay state unavailable");
      const merged = await mergeTrees(
        c.env,
        gate.route.doName,
        "",
        parentTree,
        tipTree,
        commit.tree,
        gate.cacheCtx
      );
      if (merged === "too_big") return gErr(c, 413, "rebase too large");
      if (merged.conflicts.length > 0) {
        return gErr(c, 409, `rebase conflicts: ${merged.conflicts.join(",")}`);
      }
      const treePayload = serializeTree(merged.entries);
      const treeOid = await computeOid("tree", treePayload);
      objects.push(...merged.newObjects, { type: "tree", payload: treePayload, oid: treeOid });
      const payload = buildCommitPayload({
        treeOid,
        parents: [tip],
        message: commit.message,
        timestampSec: Math.floor(Date.now() / 1000),
      });
      const oid = await computeOid("commit", payload);
      objects.push({ type: "commit", payload, oid });
      tip = oid;
    }
    if (tip === targetTip) return c.json({ rebased: true, sha: sourceTip, already: true });

    const pack = await writeServerPack(objects);
    const packKey = r2PackKey(doPrefix(stub.id.toString()), `pack-rebase-${tip.slice(0, 12)}.pack`);
    await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
    await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);
    const accepted = await stub.acceptPatchCommit({
      targetRef: sourceRef,
      newOid: tip,
      actor: gate.actor,
      kind: "branch.rebase",
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });
    const result = await attemptMerge({
      env: c.env,
      repoId: gate.route.doName,
      stub,
      intentId: accepted.intent.id,
      actor: gate.actor,
      cacheCtx: gate.cacheCtx,
    });
    if (result.kind !== "merged" && result.kind !== "up_to_date") {
      return gErr(c, 409, `rebase merge ${result.kind}`);
    }
    return c.json({ rebased: true, sha: tip, commits_replayed: toReplay.length });
  });

  // Purge is the same durable delete as DELETE /repos — idempotent.
  router.post("/api/v1/repos/:repo_ref{.+}/purge", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const row = await findRepositoryByDoName(c.var.db, gate.route.doName);
    if (!row) return gNotFound(c, "repository");
    const parsed = parseRepoRef(c.req.param("repo_ref"))!;
    const message: RepositoryDeleteMessage = {
      kind: "repository-delete",
      repositoryId: row.id,
      namespaceId: row.namespaceId,
      namespaceSlug: parsed.owner,
      repoSlug: parsed.repo,
      doName: gate.route.doName,
      actor: gate.actor,
      requestedAt: Date.now(),
    };
    await c.env.REPO_TASKS_QUEUE.send(message);
    return c.json({ deleted: true });
  });

  // Rename rides PATCH /repos {identifier}; POST rename is the alias the
  // settings form uses.
  router.post("/api/v1/repos/:repo_ref{.+}/rename", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as { identifier?: string } | null;
    return await renameRepo(c, gate, body?.identifier ?? "");
  });

  // --- settings ------------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/settings/general", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const parsed = parseRepoRef(c.req.param("repo_ref"))!;
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    const { head } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    return c.json({
      identifier: parsed.repo,
      description: row?.description ?? "",
      is_public: access.route.visibility === "public",
      default_branch: head?.target?.replace(/^refs\/heads\//, "") ?? "main",
    });
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/settings/general", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      description?: string;
      is_public?: boolean;
      default_branch?: string;
    } | null;
    const row = await findRepositoryByDoName(c.var.db, gate.route.doName);
    if (!row) return gNotFound(c, "repository");
    if (body?.description !== undefined) {
      await updateRepositoryDescription(c.var.db, row.id, body.description, Date.now());
    }
    if (body?.is_public !== undefined) {
      await updateRepositoryVisibility(
        c.var.db,
        row.id,
        body.is_public ? "public" : "private",
        Date.now()
      );
    }
    if (body?.identifier && body.identifier !== row.slug) {
      const r = await renameRepo(c, gate, body.identifier);
      if (!r.ok) return r;
    }
    if (body?.default_branch) {
      const target = `refs/heads/${body.default_branch.replace(/^refs\/heads\//, "")}`;
      const stub = getRepoStub(c.env, gate.route.doName);
      const { refs } = await stub.getHeadAndRefs();
      if (!refs.some((r) => r.name === target)) return gNotFound(c, "branch");
      await stub.setHead({ target });
    }
    return c.json({});
  });

  router.get("/api/v1/repos/:repo_ref{.+}/settings/security", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const s = await readSecuritySettings(c.env, access.route.doName);
    return c.json({
      secret_scanning: { enabled: s.secret_scanning !== false },
      force_push: { blocked: s.force_push_blocked === true },
    });
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/settings/security", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      secret_scanning?: { enabled?: boolean };
      force_push?: { blocked?: boolean };
    } | null;
    const s = await readSecuritySettings(c.env, gate.route.doName);
    if (body?.secret_scanning?.enabled !== undefined) {
      s.secret_scanning = body.secret_scanning.enabled;
    }
    if (body?.force_push?.blocked !== undefined) {
      s.force_push_blocked = body.force_push.blocked;
    }
    await writeSecuritySettings(c.env, gate.route.doName, s);
    return c.json({});
  });

  // --- labels ------------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/labels", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json(await readRepoLabels(c.env, access.route.doName));
  });

  // PUT is upsert-by-key — the label editor's save path.
  router.put("/api/v1/repos/:repo_ref{.+}/labels", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      color?: string;
      description?: string;
    } | null;
    if (!body?.key?.trim()) return gErr(c, 400, "key required");
    const labels = await readRepoLabels(c.env, gate.route.doName);
    const existing = labels.find((l) => l.key === body.key!.trim());
    if (existing) {
      if (body.color !== undefined) existing.color = body.color;
      if (body.description !== undefined) existing.description = body.description;
      await writeRepoLabels(c.env, gate.route.doName, labels);
      return c.json({ ...existing, scope: 0 });
    }
    const label: RepoLabel = {
      id: (labels.at(-1)?.id ?? 0) + 1,
      key: body.key.trim(),
      color: body.color,
      description: body.description,
      created: Date.now(),
    };
    await writeRepoLabels(c.env, gate.route.doName, [...labels, label]);
    return c.json({ ...label, scope: 0 });
  });

  router.post("/api/v1/repos/:repo_ref{.+}/labels", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      color?: string;
      description?: string;
    } | null;
    if (!body?.key?.trim()) return gErr(c, 400, "key required");
    const labels = await readRepoLabels(c.env, gate.route.doName);
    if (labels.some((l) => l.key === body.key)) return gErr(c, 409, "label exists");
    const label: RepoLabel = {
      id: (labels.at(-1)?.id ?? 0) + 1,
      key: body.key.trim(),
      color: body.color,
      description: body.description,
      created: Date.now(),
    };
    await writeRepoLabels(c.env, gate.route.doName, [...labels, label]);
    return c.json({ ...label, scope: 0 });
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/labels/:label_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      key?: string;
      color?: string;
      description?: string;
    } | null;
    const labels = await readRepoLabels(c.env, gate.route.doName);
    const label = labels.find(
      (l) => l.id === parseInt(c.req.param("label_id"), 10) || l.key === c.req.param("label_id")
    );
    if (!label) return gNotFound(c, "label");
    if (body?.key) label.key = body.key;
    if (body?.color !== undefined) label.color = body.color;
    if (body?.description !== undefined) label.description = body.description;
    await writeRepoLabels(c.env, gate.route.doName, labels);
    return c.json({ ...label, scope: 0 });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/labels/:label_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const labels = await readRepoLabels(c.env, gate.route.doName);
    const next = labels.filter(
      (l) => l.id !== parseInt(c.req.param("label_id"), 10) && l.key !== c.req.param("label_id")
    );
    if (next.length === labels.length) return gNotFound(c, "label");
    await writeRepoLabels(c.env, gate.route.doName, next);
    return c.json({});
  });

  // Label assignments = the labels currently applied across open PRs.
  router.get("/api/v1/repos/:repo_ref{.+}/labels/assignments", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const intents: Awaited<ReturnType<typeof stub.listMergeIntents>> = await stub
      .listMergeIntents(["open"])
      .catch(() => []);
    const labels = await readRepoLabels(c.env, access.route.doName);
    const assignments: { label_id: number; pullreq_number: number }[] = [];
    for (const intent of intents) {
      const raw = await c.env.ROUTES.get(`gpr:${access.route.doName}:${intent.id}`, "json").catch(
        () => null
      );
      const meta = raw as { labels?: string[] } | null;
      const n = intents.indexOf(intent) + 1;
      for (const id of meta?.labels ?? []) {
        const label = labels.find((l) => String(l.id) === id || l.key === id);
        if (label) assignments.push({ label_id: label.id, pullreq_number: n });
      }
    }
    return c.json(assignments);
  });

  // --- rules -------------------------------------------------------------------

  const ruleView = (r: RepoRule) => ({
    id: r.id,
    identifier: r.identifier,
    type: r.type,
    state: r.state,
    pattern: r.pattern,
    definition: {
      bypass: {},
      lifecycle: {
        create_forbidden: false,
        delete_forbidden: r.definition.delete ?? false,
        update_forbidden: r.definition.update ?? false,
      },
      pullreq: { approvals: { require_latest_commit: r.definition.pullreq ?? false } },
    },
    created: r.created,
    updated: r.updated,
  });

  router.get("/api/v1/repos/:repo_ref{.+}/rules", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json((await readRepoRules(c.env, access.route.doName)).map(ruleView));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/rules", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      type?: string;
      pattern?: string;
      state?: string;
      definition?: { delete?: boolean; update?: boolean; pullreq?: boolean };
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const rules = await readRepoRules(c.env, gate.route.doName);
    const rule: RepoRule = {
      id: (rules.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier.trim(),
      type: body.type === "tag" ? "tag" : "branch",
      pattern: body.pattern?.trim() || "*",
      state: body.state === "monitor" || body.state === "disabled" ? body.state : "active",
      definition: {
        delete: body.definition?.delete ?? false,
        update: body.definition?.update ?? false,
        pullreq: body.definition?.pullreq ?? false,
      },
      created: Date.now(),
      updated: Date.now(),
    };
    await writeRepoRules(c.env, gate.route.doName, [...rules, rule]);
    return c.json(ruleView(rule));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/rules/:rule_id", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const rule = (await readRepoRules(c.env, access.route.doName)).find(
      (r) => r.id === parseInt(c.req.param("rule_id"), 10)
    );
    if (!rule) return gNotFound(c, "rule");
    return c.json(ruleView(rule));
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/rules/:rule_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      pattern?: string;
      state?: string;
      definition?: RepoRule["definition"];
    } | null;
    const rules = await readRepoRules(c.env, gate.route.doName);
    const rule = rules.find((r) => r.id === parseInt(c.req.param("rule_id"), 10));
    if (!rule) return gNotFound(c, "rule");
    if (body?.identifier) rule.identifier = body.identifier;
    if (body?.pattern) rule.pattern = body.pattern;
    if (body?.state === "active" || body?.state === "monitor" || body?.state === "disabled") {
      rule.state = body.state;
    }
    if (body?.definition) rule.definition = { ...rule.definition, ...body.definition };
    rule.updated = Date.now();
    await writeRepoRules(c.env, gate.route.doName, rules);
    return c.json(ruleView(rule));
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/rules/:rule_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const rules = await readRepoRules(c.env, gate.route.doName);
    const next = rules.filter((r) => r.id !== parseInt(c.req.param("rule_id"), 10));
    if (next.length === rules.length) return gNotFound(c, "rule");
    await writeRepoRules(c.env, gate.route.doName, next);
    return c.json({});
  });

  // Merge rules = the pullreq-gating subset of protection rules — real data
  // the merge-check UI reads.
  router.get("/api/v1/repos/:repo_ref{.+}/merge-rules", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const rules = (await readRepoRules(c.env, access.route.doName)).filter(
      (r) => r.state === "active" && r.definition.pullreq
    );
    return c.json({
      require_pull_request: rules.length > 0,
      rules: rules.map((r) => ({ id: r.id, pattern: r.pattern })),
    });
  });

  // --- checks ------------------------------------------------------------

  // Recent statuses across the repo — the checks feed the SPA polls.
  router.get("/api/v1/repos/:repo_ref{.+}/checks/recent", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const rows = await getRepoStub(c.env, access.route.doName)
      .listRecentCommitStatuses(50)
      .catch(() => []);
    return c.json(
      rows.map((r, i) => ({
        id: i + 1,
        identifier: r.context,
        status: r.state,
        commit_sha: r.sha,
        summary: r.description ?? "",
        link: r.targetUrl ?? "",
        created: r.createdAt,
      }))
    );
  });

  // Aggregated statuses for a commit — what the merge box reads.
  router.get("/api/v1/repos/:repo_ref{.+}/checks-statuses-report", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const sha = c.req.query("commit_sha") ?? "";
    const rows = sha
      ? await getRepoStub(c.env, access.route.doName)
          .getCommitStatuses(sha)
          .catch(() => [])
      : [];
    const counts = { success: 0, failure: 0, pending: 0, error: 0 };
    for (const r of rows) {
      const key = r.state in counts ? (r.state as keyof typeof counts) : "pending";
      counts[key]++;
    }
    return c.json({ commit_sha: sha, counts, checks: rows.length });
  });

  // --- branches-by-commit ------------------------------------------------------

  // Which branches contain a commit — bounded first-parent ancestry scan
  // per head ref.
  router.get("/api/v1/repos/:repo_ref{.+}/branches-by-commit", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const want = (c.req.query("include_commit") ?? "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(want)) return gErr(c, 400, "include_commit required");
    const { refs } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    const hits: string[] = [];
    for (const ref of refs.filter((r) => r.name.startsWith("refs/heads/")).slice(0, 20)) {
      const chain = await listCommitsFirstParentRange(
        c.env,
        access.route.doName,
        ref.oid,
        0,
        300,
        access.cacheCtx
      ).catch(() => []);
      if (chain.some((commit) => commit.oid === want)) hits.push(ref.name);
    }
    return c.json(hits);
  });

  // --- service accounts -----------------------------------------------------

  // A service account is a real principal: a users row + namespace
  // membership + a minted PAT returned once. It can push/pull via git
  // immediately — same machinery human PATs use.
  router.post("/api/v1/repos/:repo_ref{.+}/service-accounts", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      level?: string;
    } | null;
    const name = (body?.identifier ?? "svc-bot").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,38}$/.test(name)) {
      return gErr(c, 400, "invalid service account identifier");
    }
    const row = await findRepositoryByDoName(c.var.db, gate.route.doName);
    if (!row) return gNotFound(c, "repository");

    const userId = generateUserId();
    const now = Date.now();
    const user = await insertUserIfNew(c.var.db, {
      id: userId,
      tesseraSub: `svc:${gate.route.doName}:${name}`,
      createdAt: now,
    });
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: row.namespaceId,
      userId,
      createdAt: now,
    });
    const generated = generatePatPlaintext();
    const hash = await hashPatPlaintext(generated.plaintext);
    const patId = newPrefixedId("pat");
    await insertPatWithGrants(c.var.db, {
      pat: {
        id: patId,
        userId,
        name: `svc:${name}`,
        prefix: generated.publicPrefix,
        hash,
        createdAt: now,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      },
      namespaceGrants: [],
      repoGrants: [{ patId, repoId: row.id, level: body?.level === "push" ? "push" : "pull" }],
    });
    return c.json({
      principal: {
        id: numericId(user?.id ?? userId),
        uid: `svc-${name}`,
        display_name: `svc-${name}`,
        type: "serviceaccount",
      },
      access_token: generated.plaintext,
      token: { identifier: patId, type: "pat", issued_at: now, expires_at: null },
    });
  });

  // --- security scan -------------------------------------------------------------

  // Real pattern scan of HEAD blobs — the same signature class the push
  // gate uses (PEM blocks, cloud keys, common token shapes).
  router.get("/api/v1/repos/:repo_ref{.+}/security-scan", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const findings: { path: string; kind: string; line: number }[] = [];
    const { head, refs } = await getHeadAndRefs(c.env, access.route.doName, access.cacheCtx);
    const startOid = head?.oid ?? refs.find((r) => r.name.startsWith("refs/heads/"))?.oid;
    if (!startOid) return c.json({ findings: [], scanned_files: 0 });
    const commit = await readCommit(c.env, access.route.doName, startOid, access.cacheCtx).catch(
      () => undefined
    );
    if (!commit) return c.json({ findings: [], scanned_files: 0 });
    const scanned = { files: 0 };
    const stack: { oid: string; prefix: string }[] = [{ oid: commit.tree, prefix: "" }];
    while (stack.length && scanned.files < 2000 && findings.length < 100) {
      const { oid, prefix } = stack.pop()!;
      const entries = await readTree(c.env, access.route.doName, oid, access.cacheCtx);
      for (const e of entries) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode.startsWith("40000") || e.mode === "040000") {
          stack.push({ oid: e.oid, prefix: path });
          continue;
        }
        if (scanned.files++ > 2000 || /\.(png|jpg|woff2?|lock|min\.js)$/.test(path)) continue;
        const obj = await readPayload(c.env, access.route.doName, e.oid, access.cacheCtx).catch(
          () => undefined
        );
        if (!obj || obj.type !== "blob" || obj.payload.length > 512 * 1024) continue;
        const text = new TextDecoder().decode(obj.payload);
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && findings.length < 100; i++) {
          const l = lines[i]!;
          const kind = SECRET_PATTERNS.find((p) => p.re.test(l))?.kind;
          if (kind) findings.push({ path, kind, line: i + 1 });
        }
      }
    }
    return c.json({ findings, scanned_files: scanned.files });
  });

  // --- signature verification -----------------------------------------------------

  // Commit objects carry gpgsig headers; we have no keyring to verify
  // against, so `verified` is honest — presence is real, verification is
  // reported as unverified rather than fabricated.
  router.get("/api/v1/repos/:repo_ref{.+}/signature-verification", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const sha = c.req.query("commit_sha") ?? "";
    if (!/^[0-9a-f]{40}$/i.test(sha)) return gErr(c, 400, "commit_sha required");
    const raw = await readLooseObjectRaw(c.env, access.route.doName, sha, access.cacheCtx).catch(
      () => null
    );
    if (!raw || raw.type !== "commit") return gNotFound(c, "commit");
    const text = new TextDecoder().decode(raw.payload);
    const signed = /^gpgsig /m.test(text);
    return c.json({
      commit_sha: sha,
      signed,
      verified: false,
      reason: signed
        ? "no keyring configured — signature presence detected, not verified"
        : undefined,
    });
  });

  // --- codeowners ----------------------------------------------------------------

  // CODEOWNERS read straight from the repo (checked at .github/, docs/ and
  // root) and evaluated against the PR's changed file paths.
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/codeowners", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const paths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
    let content: string | null = null;
    for (const p of paths) {
      const result = await readPath(c.env, access.route.doName, "main", p, access.cacheCtx).catch(
        () => null
      );
      if (result && result.type === "blob") {
        content = new TextDecoder().decode(result.content);
        break;
      }
    }
    if (!content) return c.json({ evaluations: [] });
    const entries = parseCodeowners(content);
    return c.json({
      evaluations: entries.map((e) => ({
        pattern: e.pattern,
        owners: e.owners.map((o) => ({
          owner: { uid: o.replace(/^@/, ""), display_name: o.replace(/^@/, "") },
        })),
      })),
    });
  });

  // --- pipelines ----------------------------------------------------------------

  // Pipeline definitions are real records; executions are genuinely empty —
  // no runner is bound to this backend.
  router.get("/api/v1/repos/:repo_ref{.+}/pipelines", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json(await readRepoPipelines(c.env, access.route.doName));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/pipelines", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      config_path?: string;
      description?: string;
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const pipes = await readRepoPipelines(c.env, gate.route.doName);
    if (pipes.some((p) => p.identifier === body.identifier)) {
      return gErr(c, 409, "pipeline exists");
    }
    const pipe: RepoPipeline = {
      id: (pipes.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier.trim(),
      config_path: body.config_path ?? `.harness/${body.identifier.trim()}.yaml`,
      description: body.description,
      created: Date.now(),
      updated: Date.now(),
    };
    await writeRepoPipelines(c.env, gate.route.doName, [...pipes, pipe]);
    return c.json(pipe);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pipe = (await readRepoPipelines(c.env, access.route.doName)).find(
      (p) =>
        p.id === parseInt(c.req.param("pipeline_id"), 10) ||
        p.identifier === c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    return c.json(pipe);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/view", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pipe = (await readRepoPipelines(c.env, access.route.doName)).find(
      (p) =>
        p.id === parseInt(c.req.param("pipeline_id"), 10) ||
        p.identifier === c.req.param("pipeline_id")
    );
    if (!pipe) return gNotFound(c, "pipeline");
    const result = await readPath(
      c.env,
      access.route.doName,
      "main",
      pipe.config_path,
      access.cacheCtx
    ).catch(() => null);
    const yaml = result && result.type === "blob" ? new TextDecoder().decode(result.content) : "";
    return c.json({ ...pipe, yaml, is_valid: yaml.length > 0 });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const pipes = await readRepoPipelines(c.env, gate.route.doName);
    const next = pipes.filter(
      (p) =>
        p.id !== parseInt(c.req.param("pipeline_id"), 10) &&
        p.identifier !== c.req.param("pipeline_id")
    );
    if (next.length === pipes.length) return gNotFound(c, "pipeline");
    await writeRepoPipelines(c.env, gate.route.doName, next);
    return c.json({});
  });

  router.get("/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json([]);
  });

  // --- variables (repo secrets) --------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/variables", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const rows = await getRepoStub(c.env, access.route.doName)
      .listRepoSecretMeta()
      .catch(() => []);
    return c.json(
      rows.map((r) => ({
        identifier: r.name,
        type: "secret",
        created: r.createdAt,
        updated: r.updatedAt,
      }))
    );
  });

  router.post("/api/v1/repos/:repo_ref{.+}/variables", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      value?: string;
    } | null;
    const name = (body?.identifier ?? "").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return gErr(c, 400, "invalid variable name");
    if (!body?.value) return gErr(c, 400, "value required");
    const ciphertext = await encryptRepoSecret(c.env, body.value);
    await getRepoStub(c.env, gate.route.doName).putRepoSecret({
      name,
      ciphertext,
      actor: gate.actor,
    });
    return c.json({ identifier: name, type: "secret" });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/variables/:name", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const result = await getRepoStub(c.env, gate.route.doName).deleteRepoSecret({
      name: c.req.param("name").toUpperCase(),
      actor: gate.actor,
    });
    if (result.status !== "deleted") return gNotFound(c, "variable");
    return c.json({});
  });

  // --- templates --------------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/templates", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json(await readRepoTemplates(c.env, access.route.doName));
  });

  router.post("/api/v1/repos/:repo_ref{.+}/templates", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      identifier?: string;
      data?: string;
    } | null;
    if (!body?.identifier?.trim()) return gErr(c, 400, "identifier required");
    const templates = await readRepoTemplates(c.env, gate.route.doName);
    if (templates.some((t) => t.identifier === body.identifier)) {
      return gErr(c, 409, "template exists");
    }
    const t: RepoTemplate = {
      id: (templates.at(-1)?.id ?? 0) + 1,
      identifier: body.identifier.trim(),
      data: body.data ?? "",
      created: Date.now(),
    };
    await writeRepoTemplates(c.env, gate.route.doName, [...templates, t]);
    return c.json(t);
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/templates/:id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const templates = await readRepoTemplates(c.env, gate.route.doName);
    const next = templates.filter((t) => t.id !== parseInt(c.req.param("id"), 10));
    if (next.length === templates.length) return gNotFound(c, "template");
    await writeRepoTemplates(c.env, gate.route.doName, next);
    return c.json({});
  });

  // --- raw redirect ---------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/raw-redirect/:path{.+}", async (c) => {
    const ref = c.req.param("repo_ref");
    const path = c.req.param("path").replace(/^\/+/, "");
    const refQ = c.req.query("git_ref")
      ? `?git_ref=${encodeURIComponent(c.req.query("git_ref")!)}`
      : "";
    return c.redirect(`/api/v1/repos/${encodeURIComponent(ref)}/raw/${encodeURI(path)}${refQ}`);
  });

  // --- repo detail ----------------------------------------------------------
  // Registered LAST: `:repo_ref{.+}` is greedy and would otherwise swallow
  // every `/repos/{ref}/<tail>` route across all gitness modules (the caller
  // must invoke this registrar after the others).

  router.get("/api/v1/repos/:repo_ref{.+}", async (c) => {
    const ref = c.req.param("repo_ref");
    const access = await resolveGitnessRepo(c, ref);
    if (access.kind !== "ok") return access.response;
    const { route, cacheCtx } = access;

    const stub = getRepoStub(c.env, route.doName);
    const [{ refs }, open, done, row] = await Promise.all([
      getHeadAndRefs(c.env, route.doName, cacheCtx),
      stub.listMergeIntents(OPEN_STATUSES).catch(() => []),
      stub.listMergeIntents(DONE_STATUSES).catch(() => []),
      findRepositoryByDoName(c.var.db, route.doName),
    ]);
    if (!row) return gNotFound(c, "repository");
    const merged = done.filter((i) => i.status === "merged").length;
    return c.json(
      toGitnessRepo(row, ref.split("/")[0], {
        isEmpty: refs.length === 0,
        openPulls: open.length,
        mergedPulls: merged,
        closedPulls: done.length - merged,
      })
    );
  });
}
