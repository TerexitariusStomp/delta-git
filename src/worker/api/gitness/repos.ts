// Gitness facade: repository metadata endpoints.
//
// `RepoRepositoryOutput` is populated from the D1 repositories row plus, for
// the detail GET only, a DO `getHeadAndRefs`/`listMergeIntents` round to fill
// `is_empty`/PR counters. The list mapper skips the DO hop — repo lists would
// otherwise fan out one RPC per row.

import type { AppRouter } from "@/worker/routes/hono";
import type { RepositoryRow } from "@/worker/db/d1/schema/repositories";
import {
  findRepositoryByDoName,
  updateRepositoryDescription,
  updateRepositoryVisibility,
} from "@/worker/db/d1/dal/repositories";
import { getRepoStub } from "@/worker/common";
import { getHeadAndRefs } from "@/worker/git/operations/read";
import { gErr, gNotFound, gStub, numericId, parseRepoRef, resolveGitnessRepo } from "./shared";

const OPEN_STATUSES = ["open", "merging", "adjudicating", "conflict"];
const DONE_STATUSES = ["merged", "rejected", "expired"];

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

  // Repo creation forks through the existing authenticated lane later; the
  // SPA's create/import dialogs get honest 501s until then.
  for (const route of [
    ["post", "/api/v1/repos"],
    ["post", "/api/v1/repos/import"],
    ["post", "/api/v1/repos/link"],
    ["delete", "/api/v1/repos/:repo_ref{.+}"],
    ["post", "/api/v1/repos/:repo_ref{.+}/fork"],
    ["post", "/api/v1/repos/:repo_ref{.+}/fork-sync"],
    ["post", "/api/v1/repos/:repo_ref{.+}/linked/sync"],
    ["post", "/api/v1/repos/:repo_ref{.+}/rebase"],
    ["post", "/api/v1/repos/:repo_ref{.+}/default-branch"],
  ] as const) {
    router[route[0]](route[1], async (c) => gStub(c, "this repository operation"));
  }

  // Settings: the SPA settings page reads general + security blocks.
  router.get("/api/v1/repos/:repo_ref{.+}/settings/general", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const parsed = parseRepoRef(c.req.param("repo_ref"))!;
    return c.json({
      identifier: parsed.repo,
      description: "",
      is_public: access.route.visibility === "public",
      default_branch: "main",
    });
  });
  router.get("/api/v1/repos/:repo_ref{.+}/settings/security", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    return c.json({});
  });
  for (const tail of ["settings/general", "settings/security"]) {
    router.patch(`/api/v1/repos/:repo_ref{.+}/${tail}`, async (c) => gStub(c, "repo settings"));
  }

  // Empty-list surfaces the SPA expects (labels, rules, webhooks, checks,
  // pipeline executions, pullreq sub-resources we cannot back).
  const emptyLists = [
    "/api/v1/repos/:repo_ref{.+}/labels",
    "/api/v1/repos/:repo_ref{.+}/rules",
    "/api/v1/repos/:repo_ref{.+}/webhooks",
    "/api/v1/repos/:repo_ref{.+}/checks/recent",
    "/api/v1/repos/:repo_ref{.+}/pipelines/:pipeline_id/executions",
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/file-views",
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/labels",
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers",
    "/api/v1/repos/:repo_ref{.+}/pullreq/:n/codeowners",
  ];
  for (const p of emptyLists) {
    router.get(p, async (c) => c.json([]));
  }
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/reviewers/combined", async (c) =>
    c.json({ reviewers: [], evaluation_result: null })
  );
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/checks", async (c) =>
    c.json({ checks: [], commit_sha: "" })
  );
  router.get("/api/v1/repos/:repo_ref{.+}/pullreq/:n/automerge", async (c) =>
    c.json({ mergeable: false })
  );
  router.get("/api/v1/repos/:repo_ref{.+}/rules/:rule_id", async (c) => c.json({}));
  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id", async (c) => c.json({}));
  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id/executions", async (c) => c.json([]));
  router.get("/api/v1/repos/:repo_ref{.+}/webhooks/:id/executions/:exec", async (c) => c.json({}));

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
