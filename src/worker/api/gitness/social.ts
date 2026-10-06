import type { AppRouter } from "@/worker/routes/hono";

import {
  findRepositoryByDoName,
  followNamespace,
  isFollowing,
  isStarred,
  listPublicReposByTopic,
  listRepoTopics,
  listStarredRepos,
  listTopStarredPublicRepos,
  listTopTopics,
  isWatching,
  listWatchedRepos,
  listWatchers,
  starCount,
  starRepository,
  unfollowNamespace,
  unstarRepository,
  unwatchRepository,
  watchRepository,
} from "@/worker/db/d1/dal";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { loadViewer } from "@/worker/auth/session";
import { gErr, gNotFound, resolveGitnessRepo } from "./shared";

// Cross-repo social graph — stars, topics, follows, explore. Session-authed
// for writes (same viewer convention as every /api/v1 route); reads are
// public for public repos. The /api/v3 surface mirrors the GitHub-shaped
// subset (user/starred, repos/:o/:r/topics) for gh/agent clients.

function repoJson(row: {
  repository: { slug: string; description: string | null; updatedAt: number };
  namespaceSlug: string;
  stars: number;
}) {
  return {
    owner: row.namespaceSlug,
    name: row.repository.slug,
    full_name: `${row.namespaceSlug}/${row.repository.slug}`,
    description: row.repository.description ?? null,
    stargazers_count: row.stars,
    updated_at: new Date(row.repository.updatedAt).toISOString(),
  };
}

export function registerGitnessSocial(router: AppRouter) {
  // --- stars ---------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/star", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    const [count, starred] = await Promise.all([
      starCount(c.var.db, row.id),
      access.viewer ? isStarred(c.var.db, access.viewer.userId, row.id) : false,
    ]);
    return c.json({ starred, stargazers_count: count });
  });

  router.put("/api/v1/repos/:repo_ref{.+}/star", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    await starRepository(c.var.db, access.viewer.userId, row.id);
    return c.json({ starred: true, stargazers_count: await starCount(c.var.db, row.id) });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/star", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    await unstarRepository(c.var.db, access.viewer.userId, row.id);
    return c.json({ starred: false, stargazers_count: await starCount(c.var.db, row.id) });
  });

  // Viewer's starred repos — powers the "Starred" profile lane.
  router.get("/api/v1/starred", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const rows = await listStarredRepos(c.var.db, viewer.userId);
    return c.json(
      rows.map((r) => ({
        owner: r.namespaceSlug,
        name: r.repository.slug,
        full_name: `${r.namespaceSlug}/${r.repository.slug}`,
        description: r.repository.description ?? null,
        starred_at: new Date(r.starredAt).toISOString(),
      }))
    );
  });

  // --- watchers (GitHub "watch" → notification subscription) ----------------

  router.get("/api/v1/repos/:repo_ref{.+}/watch", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    const [watchers, watching] = await Promise.all([
      listWatchers(c.var.db, row.id),
      access.viewer ? isWatching(c.var.db, access.viewer.userId, row.id) : false,
    ]);
    return c.json({ watching, watchers_count: watchers.length });
  });

  router.put("/api/v1/repos/:repo_ref{.+}/watch", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    await watchRepository(c.var.db, access.viewer.userId, row.id);
    const watchers = await listWatchers(c.var.db, row.id);
    return c.json({ watching: true, watchers_count: watchers.length });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/watch", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    await unwatchRepository(c.var.db, access.viewer.userId, row.id);
    const watchers = await listWatchers(c.var.db, row.id);
    return c.json({ watching: false, watchers_count: watchers.length });
  });

  // Viewer's watched repos — powers the "Watching" profile lane.
  router.get("/api/v1/watching", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const rows = await listWatchedRepos(c.var.db, viewer.userId);
    return c.json(
      rows.map((r) => ({
        owner: r.namespaceSlug,
        name: r.repository.slug,
        full_name: `${r.namespaceSlug}/${r.repository.slug}`,
        description: r.repository.description ?? null,
        watched_at: new Date(r.watchedAt).toISOString(),
      }))
    );
  });

  // --- topics --------------------------------------------------------------

  router.get("/api/v1/repos/:repo_ref{.+}/topics", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const row = await findRepositoryByDoName(c.var.db, access.route.doName);
    if (!row) return gNotFound(c, "repository");
    return c.json({ topics: await listRepoTopics(c.var.db, row.id) });
  });

  // --- follows -------------------------------------------------------------

  router.get("/api/v1/spaces/:space/+/follow", async (c) => {
    const viewer = await loadViewer(c);
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("space"));
    if (!ns) return gNotFound(c, "space");
    return c.json({
      following: viewer ? await isFollowing(c.var.db, viewer.userId, ns.id) : false,
    });
  });

  router.put("/api/v1/spaces/:space/+/follow", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("space"));
    if (!ns) return gNotFound(c, "space");
    await followNamespace(c.var.db, viewer.userId, ns.id);
    return c.json({ following: true });
  });

  router.delete("/api/v1/spaces/:space/+/follow", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const ns = await findNamespaceBySlug(c.var.db, c.req.param("space"));
    if (!ns) return gNotFound(c, "space");
    await unfollowNamespace(c.var.db, viewer.userId, ns.id);
    return c.json({ following: false });
  });

  // --- explore -------------------------------------------------------------

  // Public trending + topic browse — anonymous-safe by construction (the
  // DAL filters to public repos).
  router.get("/api/v1/explore", async (c) => {
    const topic = c.req.query("topic");
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20));
    if (topic) {
      const repos = await listPublicReposByTopic(c.var.db, topic, limit);
      return c.json({ topic, repos: repos.map(repoJson), topics: [] });
    }
    const [repos, topics] = await Promise.all([
      listTopStarredPublicRepos(c.var.db, limit),
      listTopTopics(c.var.db, 12),
    ]);
    return c.json({ repos: repos.map(repoJson), topics });
  });
}
