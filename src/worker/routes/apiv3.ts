import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";

import { getRepoStub } from "@/worker/common";
import { deliverWebhookEvent } from "@/worker/agent/webhooks";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { authenticateGitRequest, authenticateIdentity } from "@/worker/auth/gitAuth";
import { hasOAuthScope, OAUTH_SCOPES } from "@/worker/auth/oauth";
import { loadViewer } from "@/worker/auth/session";
import { isValidOwnerRepo } from "@/shared/web";
import { readPayload, resolvePathEntry } from "@/worker/agent/patch";
import { listCommitsFirstParentRange, resolveRef } from "@/worker/git/operations/read";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import type { ReleaseAssetRow, ReleaseRow } from "@/worker/do/repo/db/schema";
import { isTreeMode, parseTree } from "@/worker/git/core/tree";
import { parseCommitText } from "@/worker/git/core";
import { listNamespacesForUser } from "@/worker/db/d1/dal/namespaces";
import { markEvalOutcome } from "@/worker/db/d1/dal/evalCorpus";
import {
  findRepositoryById,
  isStarred,
  listRepoTopics,
  listStargazers,
  normalizeTopics,
  setRepoTopics,
  starCount,
  starRepository,
  unstarRepository,
} from "@/worker/db/d1/dal";
import { attemptMerge } from "@/worker/merge/engine";
import { closeIssuesLinkedFromText, readPrMeta, writePrMeta } from "@/worker/api/gitness/prmeta";
import { readCommitMeta, writeCommitMeta } from "@/worker/api/gitness/commitmeta";
import {
  findCheckRunSha,
  MAX_CHECK_RUNS_PER_SHA,
  readCheckRuns,
  writeCheckRunIndex,
  writeCheckRuns,
  type CheckRun,
  type CheckRunConclusion,
  type CheckRunStatus,
} from "@/worker/api/gitness/stores";
import type { DiscussionView } from "@/worker/do/repo/catalog/discussions";
import type { IssueView } from "@/worker/do/repo/catalog/issues";
import { parseIssueQuery, type IssueQuery } from "@/worker/do/repo/catalog/issueQuery";

// GitHub REST v3 compatibility shim — the high-traffic subset that lets
// `GH_HOST=<this host> gh repo view`, IDE git integrations, status bots, and
// deploy hooks interoperate without modification. Not full parity; the
// coverage list lives in ARCHITECTURE.md.

const td = new TextDecoder();

// Frozen machine error codes (DGS-02): `message` stays GitHub-compatible
// prose for `gh`; `error` is the stable code agents branch on.
export const ERROR_CODES = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  422: "validation-failed",
  429: "rate-limited",
  500: "internal-error",
  503: "unavailable",
} as const;

type ErrorStatus = keyof typeof ERROR_CODES;

export function v3Err(c: AppContext, status: ErrorStatus, message: string): Response {
  return c.json({ message, error: ERROR_CODES[status] }, status as never);
}

async function resolveRoute(c: AppContext): Promise<RepositoryRoute | null> {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  return await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "ApiV3" }),
  });
}

async function authenticated(c: AppContext, route: RepositoryRoute): Promise<string | Response> {
  const auth = await authenticateGitRequest(c.env, c.req.raw, route, { db: c.var.db });
  if (auth.kind === "pat") return auth.verified.userId;
  if (auth.kind === "oauth") {
    // Scope by verb: reads need repo:read, mutations need repo:write; the
    // token's user must also be a namespace member.
    const needed =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? OAUTH_SCOPES.REPO_READ
        : OAUTH_SCOPES.REPO_WRITE;
    if (auth.verified.member && hasOAuthScope(auth.verified.scopes, needed)) {
      return auth.verified.userId;
    }
    return v3Err(c, 401, "Requires authentication");
  }
  if (route.visibility === "public" && c.req.method === "GET") return "anonymous";
  return v3Err(c, 401, "Requires authentication");
}

function commitOidForRef(refs: { name: string; oid: string }[], ref?: string): string | undefined {
  const target = ref?.startsWith("refs/") ? ref : `refs/heads/${ref ?? "main"}`;
  return refs.find((r) => r.name === target)?.oid;
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function registerApiV3Routes(router: AppRouter): void {
  // GET /api/v3/user — the authenticated user (gh auth status, gh api user).
  // Session cookie, OAuth Bearer, and PAT (Basic/token/Bearer) lanes all map
  // to a userId; `login` is the user's primary namespace slug.
  router.get("/api/v3/user", async (c) => {
    const identity = await authenticateIdentity(c.env, c.req.raw, { db: c.var.db });
    if (identity instanceof Response) return identity;
    let userId = identity?.userId;
    if (!userId) {
      const viewer = await loadViewer(c);
      userId = viewer?.userId;
    }
    if (!userId) return v3Err(c, 401, "Requires authentication");
    const namespaces = await listNamespacesForUser(c.var.db, userId);
    const login = namespaces[0]?.slug;
    if (!login) return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json({
      login,
      id: userId,
      type: "User",
      html_url: `${origin}/${login}`,
    });
  });

  // GET /api/v3/user/emails — the authenticated user's notification
  // address. Contact fields live in the `gprofile:{userId}` KV record (the
  // same store `/api/v1/user` writes); delta-git has no verification flow,
  // so a set email reports `verified: false`.
  router.get("/api/v3/user/emails", async (c) => {
    const identity = await authenticateIdentity(c.env, c.req.raw, { db: c.var.db });
    let userId = identity instanceof Response ? undefined : identity?.userId;
    if (!userId) {
      const viewer = await loadViewer(c);
      userId = viewer?.userId;
    }
    if (!userId) return v3Err(c, 401, "Requires authentication");
    const profile = (await c.env.ROUTES.get(`gprofile:${userId}`, "json").catch(() => null)) as {
      email?: string;
    } | null;
    const email = profile?.email?.trim();
    return c.json(email ? [{ email, primary: true, verified: false, visibility: "private" }] : []);
  });

  // GET /api/v3/rate_limit — gh checks this for pacing hints. We enforce
  // quotas per-repo rather than per-token; report GitHub-shaped ceilings.
  router.get("/api/v3/rate_limit", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      resources: {
        core: { limit: 5000, used: 0, remaining: 5000, reset: now + 3600 },
        search: { limit: 30, used: 0, remaining: 30, reset: now + 60 },
        graphql: { limit: 5000, used: 0, remaining: 5000, reset: now + 3600 },
      },
    });
  });

  // GET /api/v3/repos/:owner/:repo — gh repo view
  router.get("/api/v3/repos/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const { head, refs } = await stub.getHeadAndRefs();
    const defaultBranch = head.target.replace(/^refs\/heads\//, "");
    const [repoRow, stars, topics] = await Promise.all([
      findRepositoryById(c.var.db, route.repositoryId),
      starCount(c.var.db, route.repositoryId),
      listRepoTopics(c.var.db, route.repositoryId),
    ]);
    const body = {
      id: route.repositoryId,
      name: c.req.param("repo"),
      full_name: `${c.req.param("owner")}/${c.req.param("repo")}`,
      private: route.visibility !== "public",
      owner: { login: c.req.param("owner"), type: "User" },
      html_url: `${new URL(c.req.url).origin}/${c.req.param("owner")}/${c.req.param("repo")}`,
      clone_url: `${new URL(c.req.url).origin}/${c.req.param("owner")}/${c.req.param("repo")}.git`,
      default_branch: defaultBranch,
      visibility: route.visibility,
      refs_count: refs.length,
      description: repoRow?.description ?? null,
      homepage: repoRow?.website ?? null,
      stargazers_count: stars,
      topics,
    };
    return c.json(body);
  });

  // GET /api/v3/repos/:owner/:repo/git/ref(s)
  router.get("/api/v3/repos/:owner/:repo/git/refs", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    return c.json(
      refs.map((ref) => ({
        ref: ref.name,
        object: { sha: ref.oid, type: "commit" },
        url: `${new URL(c.req.url).origin}/api/v3/repos/${c.req.param("owner")}/${c.req.param("repo")}/git/refs/${ref.name}`,
      }))
    );
  });

  // GET /api/v3/repos/:owner/:repo/branches(+/:branch) — gh api branches,
  // branch pickers. Straight projection of refs/heads/* from the DO.
  const branchesHandler = async (c: AppContext) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const { head, refs } = await stub.getHeadAndRefs();
    const branches = refs.filter((r) => r.name.startsWith("refs/heads/"));
    const origin = new URL(c.req.url).origin;
    const shape = (name: string, oid: string) => ({
      name,
      commit: {
        sha: oid,
        url: `${origin}/api/v3/repos/${route.routeNamespaceSlug}/${route.routeRepoSlug}/commits/${oid}`,
      },
      protected: false,
    });
    const want = c.req.param("branch");
    if (want === undefined) {
      return c.json(branches.map((r) => shape(r.name.replace(/^refs\/heads\//, ""), r.oid)));
    }
    const match = branches.find((r) => r.name === `refs/heads/${want}`);
    if (!match) return v3Err(c, 404, "Branch not found");
    return c.json({
      ...shape(want, match.oid),
      // GitHub wraps single-branch responses differently: `commit.commit`
      // carries the message. Keep the common fields identical.
      default: head.target === match.name,
    });
  };
  // Plain :branch — a `{.+}` catch-all here corrupts sibling /repos/* routes
  // under Hono's RegExpRouter (same quirk family as the AGENTS.md warning).
  router.get("/api/v3/repos/:owner/:repo/branches", branchesHandler);
  router.get("/api/v3/repos/:owner/:repo/branches/:branch", branchesHandler);

  // GET /api/v3/repos/:owner/:repo/commits?sha=&per_page=&page= — commit
  // history (gh api repos/…/commits, log views). First-parent walk from the
  // resolved sha/branch; pagination is offset-based over the walk.
  router.get("/api/v3/repos/:owner/:repo/commits", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const perPage = Math.min(Math.max(Number(c.req.query("per_page")) || 30, 1), 100);
    const page = Math.max(Number(c.req.query("page")) || 1, 1);
    const sha = c.req.query("sha") ?? "HEAD";
    const commits = await listCommitsFirstParentRange(
      c.env,
      route.doName,
      sha,
      (page - 1) * perPage,
      perPage,
      c.var.cacheCtx
    ).catch(() => null);
    if (!commits) {
      // Empty repo (unborn HEAD, no refs): GitHub returns an empty list.
      // A bad explicit sha on a non-empty repo is a 422 upstream.
      const { refs } = await getRepoStub(c.env, route.doName).getHeadAndRefs();
      if (refs.length === 0) return c.json([]);
      return v3Err(c, 422, `No commit found for SHA: ${sha}`);
    }
    const origin = new URL(c.req.url).origin;
    const ns = route.routeNamespaceSlug;
    const rs = route.routeRepoSlug;
    const person = (p?: CommitInfo["author"]) =>
      p
        ? {
            name: p.name,
            email: p.email,
            date: new Date(p.when * 1000).toISOString(),
          }
        : null;
    return c.json(
      commits.map((ci) => ({
        sha: ci.oid,
        node_id: ci.oid,
        commit: {
          author: person(ci.author),
          committer: person(ci.committer),
          message: ci.message,
          tree: { sha: ci.tree },
          url: `${origin}/api/v3/repos/${ns}/${rs}/git/commits/${ci.oid}`,
          comment_count: 0,
        },
        url: `${origin}/api/v3/repos/${ns}/${rs}/commits/${ci.oid}`,
        html_url: `${origin}/${ns}/${rs}/commit/${ci.oid}`,
        author: null,
        committer: null,
        parents: ci.parents.map((p) => ({ sha: p })),
      }))
    );
  });

  // GET /api/v3/repos/:owner/:repo/readme — gh repo view's second call.
  // GitHub resolves the first matching README* at the repo root.
  // Registered BEFORE `contents/*` — a `*` wildcard earlier in the compiled
  // RegExpRouter table misroutes later same-prefix literal siblings.
  router.get("/api/v3/repos/:owner/:repo/readme", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const oid = commitOidForRef(refs, c.req.query("ref"));
    if (!oid) return v3Err(c, 404, "Not Found");
    const commit = await readPayload(c.env, route.doName, oid, c.var.cacheCtx);
    if (!commit) return v3Err(c, 404, "Not Found");
    const treeOid = parseCommitText(td.decode(commit.payload)).tree;
    if (!treeOid) return v3Err(c, 404, "Not Found");
    const treeObj = await readPayload(c.env, route.doName, treeOid, c.var.cacheCtx);
    if (!treeObj) return v3Err(c, 404, "Not Found");
    const entry = [...parseTree(treeObj.payload).values()].find(
      (e) => !isTreeMode(e.mode) && /^readme(\.(md|markdown|txt|rst|org|adoc))?$/i.test(e.name)
    );
    if (!entry) return v3Err(c, 404, "Not Found");
    const blob = await readObject(c.env, route.doName, entry.oid, c.var.cacheCtx);
    if (!blob || blob.type !== "blob") return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json({
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      type: "file",
      encoding: "base64",
      content: b64(blob.payload),
      html_url: `${origin}/${route.routeNamespaceSlug}/${route.routeRepoSlug}/blob/HEAD/${entry.name}`,
    });
  });

  // GET /api/v3/repos/:owner/:repo/contents/{path}?ref=
  router.get("/api/v3/repos/:owner/:repo/contents/*", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const ref = c.req.query("ref");
    const oid = commitOidForRef(refs, ref);
    if (!oid) return v3Err(c, 404, "Not Found");
    const commit = await readPayload(c.env, route.doName, oid, c.var.cacheCtx);
    if (!commit) return v3Err(c, 404, "Not Found");
    const treeOid = parseCommitText(td.decode(commit.payload)).tree;
    if (!treeOid) return v3Err(c, 404, "Not Found");

    const path = decodeURIComponent(
      new URL(c.req.url).pathname.split(
        `/api/v3/repos/${c.req.param("owner")}/${c.req.param("repo")}/contents/`
      )[1] ?? ""
    ).replace(/^\/+|\/+$/g, "");

    if (path === "") {
      const treeObj = await readPayload(c.env, route.doName, treeOid, c.var.cacheCtx);
      if (!treeObj) return v3Err(c, 404, "Not Found");
      const tree = parseTree(treeObj.payload);
      return c.json(
        [...tree.values()].map((entry) => ({
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          type: isTreeMode(entry.mode) ? "dir" : "file",
        }))
      );
    }

    const entry = await resolvePathEntry(c.env, route.doName, treeOid, path, c.var.cacheCtx);
    if (!entry) return v3Err(c, 404, "Not Found");
    if (isTreeMode(entry.mode)) {
      const treeObj = await readPayload(c.env, route.doName, entry.oid, c.var.cacheCtx);
      if (!treeObj) return v3Err(c, 404, "Not Found");
      const tree = parseTree(treeObj.payload);
      return c.json(
        [...tree.values()].map((child) => ({
          name: child.name,
          path: `${path}/${child.name}`,
          sha: child.oid,
          type: isTreeMode(child.mode) ? "dir" : "file",
        }))
      );
    }
    const blob = await readObject(c.env, route.doName, entry.oid, c.var.cacheCtx);
    if (!blob || blob.type !== "blob") return v3Err(c, 404, "Not Found");
    return c.json({
      name: path.split("/").pop(),
      path,
      sha: entry.oid,
      type: "file",
      encoding: "base64",
      content: b64(blob.payload),
    });
  });

  // POST /api/v3/repos/:owner/:repo/statuses/:sha — Checks/status writeback
  router.post("/api/v3/repos/:owner/:repo/statuses/:sha", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const parsed = await c.req
      .json<{ state?: string; context?: string; description?: string; target_url?: string }>()
      .catch(() => null);
    if (!parsed?.state || !parsed.context) {
      return v3Err(c, 422, "state + context required");
    }
    if (!["pending", "success", "failure", "error"].includes(parsed.state)) {
      return v3Err(c, 422, "invalid state");
    }
    const stub = getRepoStub(c.env, route.doName);
    await stub.setCommitStatus({
      row: {
        sha: c.req.param("sha"),
        context: parsed.context.slice(0, 128),
        state: parsed.state,
        description: parsed.description?.slice(0, 512) ?? null,
        targetUrl: parsed.target_url ?? null,
        createdBy: auth,
        createdAt: Date.now(),
      },
      actor: auth,
    });
    // GitHub's `status` webhook event — fanned out best-effort in waitUntil.
    c.executionCtx.waitUntil(
      deliverWebhookEvent(c.env, route.repositoryId, stub, {
        kind: "status",
        payload: {
          repo: `${route.routeNamespaceSlug}/${route.routeRepoSlug}`,
          sha: c.req.param("sha"),
          state: parsed.state,
          context: parsed.context,
          actor: auth,
        },
      }).catch(() => {})
    );
    return c.json({ state: parsed.state, context: parsed.context }, 201);
  });

  // GET /api/v3/repos/:owner/:repo/commits/:sha/status — combined status
  router.get("/api/v3/repos/:owner/:repo/commits/:sha/status", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.getCommitStatuses(c.req.param("sha"));
    const state =
      rows.length === 0
        ? "pending"
        : rows.some((r) => r.state === "failure" || r.state === "error")
          ? "failure"
          : rows.every((r) => r.state === "success")
            ? "success"
            : "pending";
    return c.json({
      state,
      sha: c.req.param("sha"),
      statuses: rows.map((r) => ({
        context: r.context,
        state: r.state,
        description: r.description,
        target_url: r.targetUrl,
      })),
    });
  });

  // --- check runs -----------------------------------------------------------
  // GitHub's modern status shape. The conclusion also lands in the commit
  // statuses (context = check name) so required-status-checks branch rules
  // and the combined-status endpoint see check-run results uniformly.

  type CheckStatusBody = {
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string;
    external_id?: string;
    details_url?: string;
    output?: { title?: string; summary?: string };
  };

  const VALID_CONCLUSIONS = new Set([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
  ]);

  /** Map a check-run onto the plain status vocabulary the merge gate reads. */
  function checkRunToStatusState(run: CheckRun): string {
    if (run.status !== "completed") return "pending";
    if (run.conclusion === "failure") return "failure";
    if (
      run.conclusion === "success" ||
      run.conclusion === "neutral" ||
      run.conclusion === "skipped"
    )
      return "success";
    return "error"; // cancelled / timed_out / action_required
  }

  function toV3CheckRun(run: CheckRun, owner: string, repo: string) {
    return {
      id: run.id,
      name: run.name,
      head_sha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      external_id: run.externalId ?? null,
      details_url: run.detailsUrl ?? null,
      output: { title: run.output?.title ?? null, summary: run.output?.summary ?? null },
      started_at: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      completed_at: run.completedAt ? new Date(run.completedAt).toISOString() : null,
      url: `/api/v3/repos/${owner}/${repo}/check-runs/${run.id}`,
    };
  }

  router.post("/api/v3/repos/:owner/:repo/check-runs", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const body = await c.req.json<CheckStatusBody>().catch(() => null);
    if (!body?.name?.trim() || !body?.head_sha) {
      return v3Err(c, 422, "name + head_sha required");
    }
    const status =
      body.status === "in_progress" || body.status === "completed" ? body.status : "queued";
    const conclusion =
      status === "completed" && body.conclusion && VALID_CONCLUSIONS.has(body.conclusion)
        ? (body.conclusion as CheckRunConclusion)
        : status === "completed"
          ? "success"
          : null;
    const now = Date.now();
    const run: CheckRun = {
      id: `cr-${crypto.randomUUID()}`,
      name: body.name.trim().slice(0, 128),
      headSha: body.head_sha.toLowerCase(),
      status: status as CheckRunStatus,
      conclusion,
      externalId: body.external_id,
      detailsUrl: body.details_url,
      output: body.output,
      startedAt: status === "queued" ? null : now,
      completedAt: status === "completed" ? now : null,
      createdAt: now,
    };
    const runs = await readCheckRuns(c.env, route.doName, run.headSha);
    if (runs.length >= MAX_CHECK_RUNS_PER_SHA) {
      return v3Err(c, 422, "check-run limit for this sha");
    }
    runs.push(run);
    await writeCheckRuns(c.env, route.doName, run.headSha, runs);
    await writeCheckRunIndex(c.env, route.doName, run.id, run.headSha);
    // Mirror into commit statuses so required-checks rules see it.
    await getRepoStub(c.env, route.doName).setCommitStatus({
      row: {
        sha: run.headSha,
        context: run.name,
        state: checkRunToStatusState(run),
        description: run.output?.title?.slice(0, 512) ?? null,
        targetUrl: run.detailsUrl ?? null,
        createdBy: auth,
        createdAt: now,
      },
      actor: auth,
    });
    return c.json(toV3CheckRun(run, c.req.param("owner"), c.req.param("repo")), 201);
  });

  router.get("/api/v3/repos/:owner/:repo/commits/:sha/check-runs", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const runs = await readCheckRuns(c.env, route.doName, c.req.param("sha"));
    return c.json({
      total_count: runs.length,
      check_runs: runs.map((r) => toV3CheckRun(r, c.req.param("owner"), c.req.param("repo"))),
    });
  });

  router.get("/api/v3/repos/:owner/:repo/check-runs/:id", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const sha = await findCheckRunSha(c.env, route.doName, c.req.param("id"));
    if (!sha) return v3Err(c, 404, "Not Found");
    const run = (await readCheckRuns(c.env, route.doName, sha)).find(
      (r) => r.id === c.req.param("id")
    );
    if (!run) return v3Err(c, 404, "Not Found");
    return c.json(toV3CheckRun(run, c.req.param("owner"), c.req.param("repo")));
  });

  router.patch("/api/v3/repos/:owner/:repo/check-runs/:id", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const sha = await findCheckRunSha(c.env, route.doName, c.req.param("id"));
    if (!sha) return v3Err(c, 404, "Not Found");
    const runs = await readCheckRuns(c.env, route.doName, sha);
    const run = runs.find((r) => r.id === c.req.param("id"));
    if (!run) return v3Err(c, 404, "Not Found");
    const body = await c.req.json<CheckStatusBody>().catch(() => null);
    if (
      body?.status === "queued" ||
      body?.status === "in_progress" ||
      body?.status === "completed"
    ) {
      run.status = body.status;
      if (run.status === "in_progress" && !run.startedAt) run.startedAt = Date.now();
      if (run.status === "completed" && !run.completedAt) run.completedAt = Date.now();
    }
    if (body?.conclusion && VALID_CONCLUSIONS.has(body.conclusion)) {
      run.conclusion = body.conclusion as CheckRunConclusion;
      run.status = "completed";
      if (!run.completedAt) run.completedAt = Date.now();
    }
    if (body?.output !== undefined) run.output = body.output;
    if (body?.details_url !== undefined) run.detailsUrl = body.details_url;
    await writeCheckRuns(c.env, route.doName, run.headSha, runs);
    await getRepoStub(c.env, route.doName).setCommitStatus({
      row: {
        sha: run.headSha,
        context: run.name,
        state: checkRunToStatusState(run),
        description: run.output?.title?.slice(0, 512) ?? null,
        targetUrl: run.detailsUrl ?? null,
        createdBy: auth,
        createdAt: Date.now(),
      },
      actor: auth,
    });
    return c.json(toV3CheckRun(run, c.req.param("owner"), c.req.param("repo")));
  });

  // Commit comments — shares the KV store with the /api/v1 surface so both
  // faces of the API see one conversation.
  router.get("/api/v3/repos/:owner/:repo/commits/:sha/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const meta = await readCommitMeta(c.env, route.doName, c.req.param("sha"));
    return c.json(
      meta.comments.map((cm) => ({
        id: cm.id,
        body: cm.text,
        user: { login: cm.author },
        created_at: new Date(cm.created).toISOString(),
        updated_at: new Date(cm.edited).toISOString(),
      }))
    );
  });

  router.post("/api/v3/repos/:owner/:repo/commits/:sha/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body?.trim();
    if (!text) return v3Err(c, 422, "body is required");
    const sha = c.req.param("sha");
    const meta = await readCommitMeta(c.env, route.doName, sha);
    const comment = {
      id: (meta.comments.at(-1)?.id ?? 0) + 1,
      author: auth,
      text,
      created: Date.now(),
      edited: Date.now(),
    };
    meta.comments.push(comment);
    await writeCommitMeta(c.env, route.doName, sha, meta);
    return c.json(
      {
        id: comment.id,
        body: comment.text,
        user: { login: comment.author },
        created_at: new Date(comment.created).toISOString(),
        updated_at: new Date(comment.edited).toISOString(),
      },
      201
    );
  });

  // --- pull requests: `gh pr` verbs over merge intents ---------------------
  // Numbering is positional in the createdAt-ordered intent list — the same
  // convention the /api/v1 pullreq facade uses, so PR #s agree across both
  // surfaces. Human title/body/comments live in the shared KV meta record.

  const OPEN_INTENT_STATUSES = ["open", "merging", "adjudicating", "conflict"];
  const ALL_INTENT_STATUSES = [...OPEN_INTENT_STATUSES, "merged", "rejected", "expired"];

  const intentsOrdered = async (env: Env, doName: string) => {
    const intents = await getRepoStub(env, doName).listMergeIntents(ALL_INTENT_STATUSES);
    return intents.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  };

  const pullJson = async (
    env: Env,
    route: RepositoryRoute,
    intent: Awaited<ReturnType<typeof intentsOrdered>>[number],
    number: number,
    origin: string,
    owner: string,
    repo: string
  ) => {
    const meta = await readPrMeta(env, route.doName, intent.id);
    const merged = intent.status === "merged";
    const closed = merged || intent.status === "rejected" || intent.status === "expired";
    return {
      number,
      id: intent.id,
      state: closed ? "closed" : "open",
      title: meta.title ?? `merge ${intent.deltaRef} → ${intent.targetRef}`,
      body: meta.description ?? null,
      user: { login: intent.actor },
      head: { ref: intent.deltaRef.replace(/^refs\/heads\//, ""), sha: intent.deltaOid },
      base: { ref: intent.targetRef.replace(/^refs\/heads\//, ""), sha: intent.baseOid },
      merged,
      merged_at: merged && intent.resolvedAt ? new Date(intent.resolvedAt).toISOString() : null,
      closed_at: closed && intent.resolvedAt ? new Date(intent.resolvedAt).toISOString() : null,
      html_url: `${origin}/${owner}/${repo}/intents/${intent.id}`,
      mergeable_state: intent.status === "adjudicating" ? "blocked" : "unstable",
      created_at: new Date(intent.createdAt).toISOString(),
      updated_at: new Date(intent.resolvedAt ?? intent.createdAt).toISOString(),
    };
  };

  // GET /api/v3/repos/:owner/:repo/pulls?state= — gh pr list
  router.get("/api/v3/repos/:owner/:repo/pulls", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const all = await intentsOrdered(c.env, route.doName);
    const state = c.req.query("state") ?? "open";
    const wantOpen = state !== "closed";
    const filtered = all
      .map((intent, idx) => ({ intent, number: idx + 1 }))
      .filter(({ intent }) =>
        state === "all"
          ? true
          : wantOpen
            ? OPEN_INTENT_STATUSES.includes(intent.status)
            : !OPEN_INTENT_STATUSES.includes(intent.status)
      );
    const origin = new URL(c.req.url).origin;
    return c.json(
      await Promise.all(
        filtered.map(({ intent, number }) =>
          pullJson(c.env, route, intent, number, origin, c.req.param("owner"), c.req.param("repo"))
        )
      )
    );
  });

  // POST /api/v3/repos/:owner/:repo/pulls — gh pr create
  router.post("/api/v3/repos/:owner/:repo/pulls", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{ title?: string; body?: string; head?: string; base?: string }>()
      .catch(() => null);
    if (!body?.head || !body?.base) {
      return v3Err(c, 422, "head and base required");
    }
    const targetRef = `refs/heads/${body.base.replace(/^refs\/heads\//, "")}`;
    const sourceRef = `refs/heads/${body.head.replace(/^refs\/heads\//, "")}`;
    if (targetRef === sourceRef) return v3Err(c, 422, "head and base match");
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const source = refs.find((r) => r.name === sourceRef);
    if (!source) return v3Err(c, 422, `head ref not found: ${body.head}`);
    if (!refs.some((r) => r.name === targetRef)) {
      return v3Err(c, 422, `base ref not found: ${body.base}`);
    }
    const actor = await actorSlug(c, auth);
    const accepted = await stub.acceptPatchCommit({
      targetRef,
      newOid: source.oid,
      actor,
      kind: "pullreq.create",
    });
    if (body.title || body.body) {
      await writePrMeta(c.env, route.doName, accepted.intent.id, {
        title: body.title,
        description: body.body,
        comments: [],
      });
    }
    const all = await intentsOrdered(c.env, route.doName);
    const number = all.findIndex((i) => i.id === accepted.intent.id) + 1;
    const origin = new URL(c.req.url).origin;
    return c.json(
      await pullJson(
        c.env,
        route,
        accepted.intent,
        number > 0 ? number : all.length,
        origin,
        c.req.param("owner"),
        c.req.param("repo")
      ),
      201
    );
  });

  // GET /api/v3/repos/:owner/:repo/pulls/:number — gh pr view
  router.get("/api/v3/repos/:owner/:repo/pulls/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json(
      await pullJson(
        c.env,
        route,
        intent,
        number,
        origin,
        c.req.param("owner"),
        c.req.param("repo")
      )
    );
  });

  // PATCH /api/v3/repos/:owner/:repo/pulls/:number — gh pr close/edit
  router.patch("/api/v3/repos/:owner/:repo/pulls/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return v3Err(c, 404, "Not Found");
    const actor = await actorSlug(c, auth);
    const body = await c.req
      .json<{ title?: string; body?: string; state?: string }>()
      .catch(() => null);
    const stub = getRepoStub(c.env, route.doName);
    if (body?.state === "closed") {
      const result = await stub.rejectMergeIntent({ id: intent.id, actor });
      if (result.status === "not_found") return v3Err(c, 404, "Not Found");
      if (result.status === "not_rejectable") {
        return v3Err(c, 409, `pull request is ${result.state}`);
      }
      // Corpus backfill — a user-closed intent records outcome "rejected".
      void markEvalOutcome(c.var.db, intent.id, "rejected").catch((error) =>
        c.var
          .logFor({ service: "ApiV3" })
          .warn("apiv3:eval-outcome-mark-failed", { intentId: intent.id, error: String(error) })
      );
    }
    if (body?.title !== undefined || body?.body !== undefined) {
      const meta = await readPrMeta(c.env, route.doName, intent.id);
      if (body.title !== undefined) meta.title = body.title;
      if (body.body !== undefined) meta.description = body.body;
      await writePrMeta(c.env, route.doName, intent.id, meta);
    }
    const refreshed = await stub.getMergeIntent(intent.id);
    const origin = new URL(c.req.url).origin;
    return c.json(
      await pullJson(
        c.env,
        route,
        refreshed ?? intent,
        number,
        origin,
        c.req.param("owner"),
        c.req.param("repo")
      )
    );
  });

  // PUT /api/v3/repos/:owner/:repo/pulls/:number/merge — gh pr merge
  router.put("/api/v3/repos/:owner/:repo/pulls/:number/merge", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return v3Err(c, 404, "Not Found");
    const actor = await actorSlug(c, auth);
    const stub = getRepoStub(c.env, route.doName);
    const result = await attemptMerge({
      env: c.env,
      repoId: route.doName,
      stub,
      intentId: intent.id,
      actor,
      cacheCtx: c.var.cacheCtx,
    });
    switch (result.kind) {
      case "merged": {
        const meta = await readPrMeta(c.env, route.doName, intent.id);
        const closedIssues = await closeIssuesLinkedFromText({
          stub,
          text: `${meta.title ?? ""}\n${meta.description ?? ""}`,
          actor,
        });
        return c.json({ merged: true, sha: result.mergeOid, closed_issues: closedIssues });
      }
      case "conflict":
        return c.json(
          { merged: false, message: "Merge conflict", conflicts: result.conflicts },
          409
        );
      case "up_to_date":
        return c.json({ merged: true, message: "already up to date" });
      case "base_moved":
        return c.json({ merged: false, message: `base moved to ${result.currentOid}` }, 409);
      default:
        return c.json({ merged: false, message: `merge failed: ${result.kind}` }, 422);
    }
  });

  // GET/POST /api/v3/repos/:owner/:repo/pulls/:number/comments — gh pr comment
  router.get("/api/v3/repos/:owner/:repo/pulls/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return v3Err(c, 404, "Not Found");
    const meta = await readPrMeta(c.env, route.doName, intent.id);
    return c.json(
      meta.comments.map((cm) => ({
        id: cm.id,
        body: cm.text,
        user: { login: cm.author },
        path: cm.codeComment?.path ?? null,
        line: cm.codeComment?.line_end ?? cm.codeComment?.line_start ?? null,
        created_at: new Date(cm.created).toISOString(),
        updated_at: new Date(cm.edited).toISOString(),
      }))
    );
  });

  router.post("/api/v3/repos/:owner/:repo/pulls/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return v3Err(c, 404, "Not Found");
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return v3Err(c, 422, "body required");
    const actor = await actorSlug(c, auth);
    const meta = await readPrMeta(c.env, route.doName, intent.id);
    const comment = {
      id: (meta.comments.at(-1)?.id ?? 0) + 1,
      author: actor,
      text: body.body,
      created: Date.now(),
      edited: Date.now(),
    };
    meta.comments.push(comment);
    await writePrMeta(c.env, route.doName, intent.id, meta);
    return c.json(
      {
        id: comment.id,
        body: comment.text,
        user: { login: actor },
        created_at: new Date(comment.created).toISOString(),
      },
      201
    );
  });

  // --- issues: GitHub REST shape over DO-backed tracker rows ---------------
  // The same IssueView model the /api/v1 facade serves — `gh issue` verbs
  // against GH_HOST work end-to-end on these routes.

  const issueJson = (issue: IssueView, origin: string, owner: string, repo: string) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    state_reason: issue.stateReason ?? null,
    user: { login: issue.author },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    assignees: issue.assignees.map((login) => ({ login })),
    milestone: issue.milestone
      ? {
          number: issue.milestone.number,
          title: issue.milestone.title,
          state: issue.milestone.state,
        }
      : null,
    comments: issue.comments,
    html_url: `${origin}/${owner}/${repo}/issues/${issue.number}`,
    created_at: new Date(issue.createdAt).toISOString(),
    updated_at: new Date(issue.updatedAt).toISOString(),
    closed_at: issue.closedAt ? new Date(issue.closedAt).toISOString() : null,
  });

  // Map GitHub REST issue-list params onto the shared IssueQuery filter.
  // `q` (qualifier grammar) merges with the discrete params when both are
  // present.
  function v3IssueQuery(c: AppContext): IssueQuery | undefined {
    const query: IssueQuery = c.req.query("q")?.trim()
      ? parseIssueQuery(c.req.query("q")!)
      : {
          assignees: [],
          labels: [],
          noLabels: false,
          noAssignee: false,
          noMilestone: false,
          terms: [],
          order: "desc",
        };
    let touched = query.terms.length > 0;

    const labels = c.req.query("labels");
    if (labels) {
      query.labels.push(...labels.split(",").filter(Boolean));
      touched = true;
    }
    const assignee = c.req.query("assignee");
    if (assignee === "none") {
      query.noAssignee = true;
      touched = true;
    } else if (assignee) {
      query.assignees.push(assignee);
      touched = true;
    }
    const creator = c.req.query("creator");
    if (creator) {
      query.author = creator;
      touched = true;
    }
    const milestone = c.req.query("milestone");
    if (milestone === "none") {
      query.noMilestone = true;
      touched = true;
    } else if (milestone) {
      query.milestone = milestone;
      touched = true;
    }
    const sort = c.req.query("sort");
    if (sort === "created" || sort === "updated" || sort === "comments") {
      query.sort = sort;
      query.order = c.req.query("direction") === "asc" ? "asc" : "desc";
      touched = true;
    }
    const since = c.req.query("since");
    if (since) {
      const at = Date.parse(since);
      if (!Number.isNaN(at)) {
        query.updatedAfter = at;
        touched = true;
      }
    }
    return touched ? query : undefined;
  }

  // Writes attribute the primary namespace slug (the actor convention the
  // rest of the forge uses) rather than the raw userId.
  async function actorSlug(c: AppContext, userId: string): Promise<string> {
    const namespaces = await listNamespacesForUser(c.var.db, userId).catch(() => []);
    return namespaces[0]?.slug ?? userId;
  }

  // GET /api/v3/repos/:owner/:repo/issues — gh issue list. Supports the
  // standard filter params (labels/assignee/creator/milestone/sort) plus
  // `q` for full qualifier syntax.
  router.get("/api/v3/repos/:owner/:repo/issues", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const state = c.req.query("state") ?? "open";
    const query = v3IssueQuery(c);
    const issues = await stub.listIssues({
      state: state === "open" || state === "closed" ? state : undefined,
      query,
    });
    const origin = new URL(c.req.url).origin;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    return c.json(issues.map((i) => issueJson(i, origin, owner, repo)));
  });

  // GET /api/v3/search/issues?q=repo:owner/name+is:open — gh search issues.
  // Requires a repo: qualifier; qualifiers beyond repo: are the standard
  // issue grammar, plus free-text terms matched against title and body.
  router.get("/api/v3/search/issues", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q) return v3Err(c, 422, "q required");
    const repoMatches = [...q.matchAll(/(?:^|\s)repo:([^\s]+)/g)].map((m) => m[1]!);
    if (repoMatches.length !== 1) {
      return v3Err(c, 422, "exactly one repo:owner/name qualifier required");
    }
    const [owner, repo] = repoMatches[0]!.split("/");
    if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) {
      return v3Err(c, 422, "invalid repo: qualifier");
    }
    const route = await resolveRepositoryRoute(c.env, owner, repo, {
      mode: "route-cache-only",
      db: c.var.db,
      log: c.var.logFor({ service: "ApiV3" }),
    });
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;

    const remaining = q.replace(/(?:^|\s)repo:[^\s]+/g, " ");
    const query = parseIssueQuery(remaining);
    const stub = getRepoStub(c.env, route.doName);
    const issues = await stub.listIssues({ query });
    const origin = new URL(c.req.url).origin;
    return c.json({
      total_count: issues.length,
      incomplete_results: false,
      items: issues.map((i) => issueJson(i, origin, owner, repo)),
    });
  });

  // POST /api/v3/repos/:owner/:repo/issues — gh issue create
  router.post("/api/v3/repos/:owner/:repo/issues", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{ title?: string; body?: string; labels?: string[]; assignees?: string[] }>()
      .catch(() => null);
    if (!body?.title?.trim()) return v3Err(c, 422, "title required");
    const actor = await actorSlug(c, auth);
    const stub = getRepoStub(c.env, route.doName);
    const labelIds: string[] = [];
    for (const name of body.labels ?? []) {
      const created = await stub.createLabel({
        name,
        color: "ededed",
        description: null,
        actor,
      });
      if (created.status !== "invalid") labelIds.push(created.label.id);
    }
    const result = await stub.createIssue({
      title: body.title,
      body: body.body ?? null,
      actor,
      assignees: body.assignees,
      labelIds,
    });
    if (result.status !== "created") return v3Err(c, 422, result.reason);
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")), 201);
  });

  // GET /api/v3/repos/:owner/:repo/issues/:number — gh issue view
  router.get("/api/v3/repos/:owner/:repo/issues/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getIssue(number);
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")));
  });

  // PATCH /api/v3/repos/:owner/:repo/issues/:number — gh issue edit/close
  router.patch("/api/v3/repos/:owner/:repo/issues/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const body = await c.req
      .json<{
        title?: string;
        body?: string | null;
        state?: string;
        labels?: string[];
        assignees?: string[];
      }>()
      .catch(() => null);
    const actor = await actorSlug(c, auth);
    const stub = getRepoStub(c.env, route.doName);
    const patch: Parameters<typeof stub.updateIssue>[0]["patch"] = {};
    if (body?.title !== undefined) patch.title = body.title;
    if (body?.body !== undefined) patch.body = body.body;
    if (body?.state === "open" || body?.state === "closed") patch.state = body.state;
    if (body?.assignees) patch.assignees = body.assignees;
    if (body?.labels) {
      const labelIds: string[] = [];
      for (const name of body.labels) {
        const created = await stub.createLabel({
          name,
          color: "ededed",
          description: null,
          actor,
        });
        if (created.status !== "invalid") labelIds.push(created.label.id);
      }
      patch.labelIds = labelIds;
    }
    const result = await stub.updateIssue({ number, patch, actor });
    if (result.status === "not-found") return v3Err(c, 404, "Not Found");
    if (result.status === "invalid") return v3Err(c, 422, result.reason);
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")));
  });

  // GET /api/v3/repos/:owner/:repo/issues/:number/comments — gh issue view --comments
  router.get("/api/v3/repos/:owner/:repo/issues/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.listIssueComments(number);
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    return c.json(
      result.comments.map((cm) => ({
        id: cm.id,
        body: cm.body,
        user: { login: cm.author },
        created_at: new Date(cm.createdAt).toISOString(),
        updated_at: new Date(cm.updatedAt).toISOString(),
      }))
    );
  });

  // POST /api/v3/repos/:owner/:repo/issues/:number/comments — gh issue comment
  router.post("/api/v3/repos/:owner/:repo/issues/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return v3Err(c, 422, "body required");
    const actor = await actorSlug(c, auth);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.addIssueComment({ number, body: body.body, actor });
    if (result.status === "not-found") return v3Err(c, 404, "Not Found");
    if (result.status === "invalid") return v3Err(c, 422, "body required");
    return c.json(
      {
        id: result.comment.id,
        body: result.comment.body,
        user: { login: result.comment.author },
        created_at: new Date(result.comment.createdAt).toISOString(),
      },
      201
    );
  });

  // GET/POST /api/v3/repos/:owner/:repo/labels — gh label list/create
  router.get("/api/v3/repos/:owner/:repo/labels", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.listLabels();
    return c.json(
      rows.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }))
    );
  });

  router.post("/api/v3/repos/:owner/:repo/labels", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{ name?: string; color?: string; description?: string }>()
      .catch(() => null);
    if (!body?.name?.trim() || !body.color) return v3Err(c, 422, "name + color required");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createLabel({
      name: body.name,
      color: body.color,
      description: body.description ?? null,
      actor: await actorSlug(c, auth),
    });
    if (result.status === "invalid") return v3Err(c, 422, "invalid name or color");
    return c.json(
      { name: result.label.name, color: result.label.color, description: result.label.description },
      result.status === "exists" ? 200 : 201
    );
  });

  // GET/POST /api/v3/repos/:owner/:repo/milestones
  router.get("/api/v3/repos/:owner/:repo/milestones", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const state = c.req.query("state");
    const rows = await stub.listMilestones({
      state: state === "open" || state === "closed" ? state : undefined,
    });
    return c.json(
      rows.map((m) => ({
        number: m.number,
        title: m.title,
        description: m.description ?? null,
        state: m.state,
        due_on: m.dueOn ? new Date(m.dueOn).toISOString() : null,
      }))
    );
  });

  router.post("/api/v3/repos/:owner/:repo/milestones", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{ title?: string; description?: string; due_on?: string }>()
      .catch(() => null);
    if (!body?.title?.trim()) return v3Err(c, 422, "title required");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createMilestone({
      title: body.title,
      description: body.description ?? null,
      dueOn: body.due_on ? Date.parse(body.due_on) : null,
      actor: await actorSlug(c, auth),
    });
    if (result.status !== "created") return v3Err(c, 422, "title required");
    return c.json(
      {
        number: result.milestone.number,
        title: result.milestone.title,
        description: result.milestone.description,
        state: result.milestone.state,
        due_on: result.milestone.dueOn ? new Date(result.milestone.dueOn).toISOString() : null,
      },
      201
    );
  });

  // --- discussions ----------------------------------------------------------
  // Upstream GitHub REST has no discussions surface (GraphQL-only); these
  // routes keep the same auth contract as issues so PAT-bearing agents can
  // read and join threads without a browser session.

  const discussionJson = (d: DiscussionView, origin: string, owner: string, repo: string) => ({
    number: d.number,
    title: d.title,
    body: d.body ?? null,
    category: d.category,
    user: { login: d.author },
    comments: d.comments,
    answer_comment_id: d.answerCommentId ?? null,
    html_url: `${origin}/${owner}/${repo}/discussions/${d.number}`,
    created_at: new Date(d.createdAt).toISOString(),
    updated_at: new Date(d.updatedAt).toISOString(),
  });

  // GET /api/v3/repos/:owner/:repo/discussions
  router.get("/api/v3/repos/:owner/:repo/discussions", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const category = c.req.query("category");
    const discussions = await stub.listDiscussions({ category: category ?? undefined });
    const origin = new URL(c.req.url).origin;
    return c.json(
      discussions.map((d) => discussionJson(d, origin, c.req.param("owner"), c.req.param("repo")))
    );
  });

  // POST /api/v3/repos/:owner/:repo/discussions
  router.post("/api/v3/repos/:owner/:repo/discussions", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{ title?: string; body?: string; category?: string }>()
      .catch(() => null);
    if (!body?.title?.trim()) return v3Err(c, 422, "title required");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createDiscussion({
      title: body.title,
      body: body.body ?? null,
      category: body.category,
      actor: await actorSlug(c, auth),
    });
    if (result.status !== "created") return v3Err(c, 422, result.reason);
    const origin = new URL(c.req.url).origin;
    return c.json(
      discussionJson(result.discussion, origin, c.req.param("owner"), c.req.param("repo")),
      201
    );
  });

  // GET /api/v3/repos/:owner/:repo/discussions/:number
  router.get("/api/v3/repos/:owner/:repo/discussions/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getDiscussion(number);
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json(
      discussionJson(result.discussion, origin, c.req.param("owner"), c.req.param("repo"))
    );
  });

  // GET /api/v3/repos/:owner/:repo/discussions/:number/comments
  router.get("/api/v3/repos/:owner/:repo/discussions/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.listDiscussionComments(number);
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    return c.json(
      result.comments.map((cm) => ({
        id: cm.id,
        body: cm.body,
        user: { login: cm.author },
        created_at: new Date(cm.createdAt).toISOString(),
        updated_at: new Date(cm.updatedAt).toISOString(),
      }))
    );
  });

  // POST /api/v3/repos/:owner/:repo/discussions/:number/comments
  router.post("/api/v3/repos/:owner/:repo/discussions/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return v3Err(c, 404, "Not Found");
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return v3Err(c, 422, "body required");
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.addDiscussionComment({
      number,
      body: body.body,
      actor: await actorSlug(c, auth),
    });
    if (result.status === "not-found") return v3Err(c, 404, "Not Found");
    if (result.status === "invalid") return v3Err(c, 422, "body required");
    return c.json(
      {
        id: result.comment.id,
        body: result.comment.body,
        user: { login: result.comment.author },
        created_at: new Date(result.comment.createdAt).toISOString(),
      },
      201
    );
  });

  // --- releases: gh release verbs ------------------------------------------

  const releaseJson = (
    r: ReleaseRow,
    assets: ReleaseAssetRow[],
    origin: string,
    owner: string,
    repo: string
  ) => ({
    id: r.id,
    tag_name: r.tagName,
    target_commitish: r.targetOid ?? null,
    name: r.name,
    body: r.body ?? null,
    draft: r.draft === 1,
    prerelease: r.prerelease === 1,
    author: { login: r.author },
    html_url: `${origin}/${owner}/${repo}/releases/${r.tagName}`,
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      content_type: a.contentType,
      size: a.size,
      download_count: a.downloadCount,
      browser_download_url: `${origin}/api/v3/repos/${owner}/${repo}/releases/${r.id}/assets/${a.id}`,
    })),
    created_at: new Date(r.createdAt).toISOString(),
    published_at: r.draft ? null : new Date(r.createdAt).toISOString(),
  });

  // GET /api/v3/repos/:owner/:repo/releases — gh release list
  router.get("/api/v3/repos/:owner/:repo/releases", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const releases = await stub.listReleases({ includeDrafts: auth !== "anonymous" });
    const origin = new URL(c.req.url).origin;
    return c.json(
      releases.map((r) => releaseJson(r, [], origin, c.req.param("owner"), c.req.param("repo")))
    );
  });

  // POST /api/v3/repos/:owner/:repo/releases — gh release create
  router.post("/api/v3/repos/:owner/:repo/releases", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req
      .json<{
        tag_name?: string;
        name?: string;
        body?: string;
        draft?: boolean;
        prerelease?: boolean;
      }>()
      .catch(() => null);
    if (!body?.tag_name?.trim()) return v3Err(c, 422, "tag_name required");
    const targetOid =
      (await resolveRef(c.env, route.doName, `refs/tags/${body.tag_name}`, c.var.cacheCtx).catch(
        () => undefined
      )) ?? null;
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createRelease({
      tagName: body.tag_name,
      name: body.name,
      body: body.body ?? null,
      draft: body.draft,
      prerelease: body.prerelease,
      targetOid,
      actor: await actorSlug(c, auth),
    });
    if (result.status === "invalid") return v3Err(c, 422, result.reason);
    const origin = new URL(c.req.url).origin;
    return c.json(
      releaseJson(result.release, [], origin, c.req.param("owner"), c.req.param("repo")),
      result.status === "exists" ? 200 : 201
    );
  });

  // GET /api/v3/repos/:owner/:repo/releases/latest — gh release view (latest)
  router.get("/api/v3/repos/:owner/:repo/releases/latest", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getLatestRelease();
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    const origin = new URL(c.req.url).origin;
    return c.json(
      releaseJson(result.release, result.assets, origin, c.req.param("owner"), c.req.param("repo"))
    );
  });

  // GET /api/v3/repos/:owner/:repo/releases/tags/:tag — gh release view <tag>
  router.get("/api/v3/repos/:owner/:repo/releases/tags/:tag", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getReleaseByTag(c.req.param("tag"));
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    if (result.release.draft === 1 && auth === "anonymous") {
      return v3Err(c, 404, "Not Found");
    }
    const origin = new URL(c.req.url).origin;
    return c.json(
      releaseJson(result.release, result.assets, origin, c.req.param("owner"), c.req.param("repo"))
    );
  });

  // GET /api/v3/repos/:owner/:repo/releases/:id/assets/:asset_id — download
  router.get("/api/v3/repos/:owner/:repo/releases/:id/assets/:asset_id", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.releaseAssetForDownload({
      releaseId: c.req.param("id"),
      assetId: c.req.param("asset_id"),
    });
    if (result.status !== "ok") return v3Err(c, 404, "Not Found");
    const obj = await c.env.REPO_BUCKET.get(result.asset.r2Key);
    if (!obj) return v3Err(c, 404, "Not Found");
    return new Response(obj.body, {
      headers: {
        "content-type": result.asset.contentType,
        "content-length": String(result.asset.size),
        "content-disposition": `attachment; filename="${result.asset.name.replace(/"/g, "")}"`,
      },
    });
  });

  // --- social: stars + topics (gh api / integrations) ----------------------

  // PUT/DELETE /api/v3/user/starred/:owner/:repo — gh api -X PUT user/starred/o/r
  router.put("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    await starRepository(c.var.db, auth, route.repositoryId);
    return c.body(null, 204);
  });

  router.delete("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    await unstarRepository(c.var.db, auth, route.repositoryId);
    return c.body(null, 204);
  });

  // GET /api/v3/user/starred/:owner/:repo — 204 starred / 404 not
  router.get("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    return (await isStarred(c.var.db, auth, route.repositoryId))
      ? c.body(null, 204)
      : v3Err(c, 404, "Not Found");
  });

  // GET /api/v3/repos/:owner/:repo/stargazers — GitHub returns user objects;
  // our stars table stores user ids, so the row shape is login-only.
  router.get("/api/v3/repos/:owner/:repo/stargazers", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const rows = await listStargazers(c.var.db, route.repositoryId);
    return c.json(
      rows.map((r) => ({ login: r.userId, starred_at: new Date(r.createdAt).toISOString() }))
    );
  });

  // GET/PUT /api/v3/repos/:owner/:repo/topics — gh repo edit --add-topic
  router.get("/api/v3/repos/:owner/:repo/topics", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    return c.json({ names: await listRepoTopics(c.var.db, route.repositoryId) });
  });

  router.put("/api/v3/repos/:owner/:repo/topics", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return v3Err(c, 404, "Not Found");
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return v3Err(c, 401, "Requires authentication");
    const body = await c.req.json<{ names?: string[] }>().catch(() => null);
    if (!body?.names) return v3Err(c, 422, "names required");
    const topics = normalizeTopics(body.names);
    if (!topics) return v3Err(c, 422, "invalid topic names");
    await setRepoTopics(c.var.db, route.repositoryId, topics);
    return c.json({ names: topics });
  });
}
