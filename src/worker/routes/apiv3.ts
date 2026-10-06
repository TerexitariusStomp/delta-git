import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";

import { getRepoStub } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { hasOAuthScope, OAUTH_SCOPES } from "@/worker/auth/oauth";
import { isValidOwnerRepo } from "@/shared/web";
import { readPayload, resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode, parseTree } from "@/worker/git/core/tree";
import { parseCommitText } from "@/worker/git/core";
import { listNamespacesForUser } from "@/worker/db/d1/dal/namespaces";
import type { IssueView } from "@/worker/do/repo/catalog/issues";

// GitHub REST v3 compatibility shim — the high-traffic subset that lets
// `GH_HOST=<this host> gh repo view`, IDE git integrations, status bots, and
// deploy hooks interoperate without modification. Not full parity; the
// coverage list lives in ARCHITECTURE.md.

const td = new TextDecoder();

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
    return c.json({ message: "Requires authentication" }, 401);
  }
  if (route.visibility === "public" && c.req.method === "GET") return "anonymous";
  return c.json({ message: "Requires authentication" }, 401);
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
  // GET /api/v3/repos/:owner/:repo — gh repo view
  router.get("/api/v3/repos/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const { head, refs } = await stub.getHeadAndRefs();
    const defaultBranch = head.target.replace(/^refs\/heads\//, "");
    const body = {
      id: route.repositoryId,
      name: c.req.param("repo"),
      full_name: `${c.req.param("owner")}/${c.req.param("repo")}`,
      private: route.visibility === "private",
      owner: { login: c.req.param("owner"), type: "User" },
      html_url: `${new URL(c.req.url).origin}/${c.req.param("owner")}/${c.req.param("repo")}`,
      clone_url: `${new URL(c.req.url).origin}/${c.req.param("owner")}/${c.req.param("repo")}.git`,
      default_branch: defaultBranch,
      visibility: route.visibility,
      refs_count: refs.length,
    };
    return c.json(body);
  });

  // GET /api/v3/repos/:owner/:repo/git/ref(s)
  router.get("/api/v3/repos/:owner/:repo/git/refs", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
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

  // GET /api/v3/repos/:owner/:repo/contents/{path}?ref=
  router.get("/api/v3/repos/:owner/:repo/contents/*", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const ref = c.req.query("ref");
    const oid = commitOidForRef(refs, ref);
    if (!oid) return c.json({ message: "Not Found" }, 404);
    const commit = await readPayload(c.env, route.doName, oid, c.var.cacheCtx);
    if (!commit) return c.json({ message: "Not Found" }, 404);
    const treeOid = parseCommitText(td.decode(commit.payload)).tree;
    if (!treeOid) return c.json({ message: "Not Found" }, 404);

    const path = decodeURIComponent(
      new URL(c.req.url).pathname.split(
        `/api/v3/repos/${c.req.param("owner")}/${c.req.param("repo")}/contents/`
      )[1] ?? ""
    ).replace(/^\/+|\/+$/g, "");

    if (path === "") {
      const treeObj = await readPayload(c.env, route.doName, treeOid, c.var.cacheCtx);
      if (!treeObj) return c.json({ message: "Not Found" }, 404);
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
    if (!entry) return c.json({ message: "Not Found" }, 404);
    if (isTreeMode(entry.mode)) {
      const treeObj = await readPayload(c.env, route.doName, entry.oid, c.var.cacheCtx);
      if (!treeObj) return c.json({ message: "Not Found" }, 404);
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
    if (!blob || blob.type !== "blob") return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const parsed = await c.req
      .json<{ state?: string; context?: string; description?: string; target_url?: string }>()
      .catch(() => null);
    if (!parsed?.state || !parsed.context) {
      return c.json({ message: "state + context required" }, 422);
    }
    if (!["pending", "success", "failure", "error"].includes(parsed.state)) {
      return c.json({ message: "invalid state" }, 422);
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
    return c.json({ state: parsed.state, context: parsed.context }, 201);
  });

  // GET /api/v3/repos/:owner/:repo/commits/:sha/status — combined status
  router.get("/api/v3/repos/:owner/:repo/commits/:sha/status", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
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

  // GET /api/v3/repos/:owner/:repo/pulls — merge intents exposed as PRs
  router.get("/api/v3/repos/:owner/:repo/pulls", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const intents = await stub.listMergeIntents(["open", "merging", "adjudicating", "conflict"]);
    const origin = new URL(c.req.url).origin;
    return c.json(
      intents.map((intent, idx) => ({
        number: idx + 1,
        id: intent.id,
        state: "open",
        title: `merge ${intent.deltaRef} → ${intent.targetRef}`,
        user: { login: intent.actor },
        head: { ref: intent.deltaRef, sha: intent.deltaOid },
        base: { ref: intent.targetRef, sha: intent.baseOid },
        html_url: `${origin}/${c.req.param("owner")}/${c.req.param("repo")}/intents/${intent.id}`,
        mergeable_state: intent.status === "adjudicating" ? "blocked" : "unstable",
        created_at: new Date(intent.createdAt).toISOString(),
      }))
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

  // Writes attribute the primary namespace slug (the actor convention the
  // rest of the forge uses) rather than the raw userId.
  async function actorSlug(c: AppContext, userId: string): Promise<string> {
    const namespaces = await listNamespacesForUser(c.var.db, userId).catch(() => []);
    return namespaces[0]?.slug ?? userId;
  }

  // GET /api/v3/repos/:owner/:repo/issues — gh issue list
  router.get("/api/v3/repos/:owner/:repo/issues", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const stub = getRepoStub(c.env, route.doName);
    const state = c.req.query("state") ?? "open";
    const issues = await stub.listIssues({
      state: state === "open" || state === "closed" ? state : undefined,
    });
    const origin = new URL(c.req.url).origin;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    return c.json(issues.map((i) => issueJson(i, origin, owner, repo)));
  });

  // POST /api/v3/repos/:owner/:repo/issues — gh issue create
  router.post("/api/v3/repos/:owner/:repo/issues", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req
      .json<{ title?: string; body?: string; labels?: string[]; assignees?: string[] }>()
      .catch(() => null);
    if (!body?.title?.trim()) return c.json({ message: "title required" }, 422);
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
    if (result.status !== "created") return c.json({ message: result.reason }, 422);
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")), 201);
  });

  // GET /api/v3/repos/:owner/:repo/issues/:number — gh issue view
  router.get("/api/v3/repos/:owner/:repo/issues/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getIssue(number);
    if (result.status !== "ok") return c.json({ message: "Not Found" }, 404);
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")));
  });

  // PATCH /api/v3/repos/:owner/:repo/issues/:number — gh issue edit/close
  router.patch("/api/v3/repos/:owner/:repo/issues/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
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
    if (result.status === "not-found") return c.json({ message: "Not Found" }, 404);
    if (result.status === "invalid") return c.json({ message: result.reason }, 422);
    const origin = new URL(c.req.url).origin;
    return c.json(issueJson(result.issue, origin, c.req.param("owner"), c.req.param("repo")));
  });

  // GET /api/v3/repos/:owner/:repo/issues/:number/comments — gh issue view --comments
  router.get("/api/v3/repos/:owner/:repo/issues/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.listIssueComments(number);
    if (result.status !== "ok") return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return c.json({ message: "body required" }, 422);
    const actor = await actorSlug(c, auth);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.addIssueComment({ number, body: body.body, actor });
    if (result.status === "not-found") return c.json({ message: "Not Found" }, 404);
    if (result.status === "invalid") return c.json({ message: "body required" }, 422);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.listLabels();
    return c.json(
      rows.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }))
    );
  });

  router.post("/api/v3/repos/:owner/:repo/labels", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req
      .json<{ name?: string; color?: string; description?: string }>()
      .catch(() => null);
    if (!body?.name?.trim() || !body.color)
      return c.json({ message: "name + color required" }, 422);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createLabel({
      name: body.name,
      color: body.color,
      description: body.description ?? null,
      actor: await actorSlug(c, auth),
    });
    if (result.status === "invalid") return c.json({ message: "invalid name or color" }, 422);
    return c.json(
      { name: result.label.name, color: result.label.color, description: result.label.description },
      result.status === "exists" ? 200 : 201
    );
  });

  // GET/POST /api/v3/repos/:owner/:repo/milestones
  router.get("/api/v3/repos/:owner/:repo/milestones", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req
      .json<{ title?: string; description?: string; due_on?: string }>()
      .catch(() => null);
    if (!body?.title?.trim()) return c.json({ message: "title required" }, 422);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createMilestone({
      title: body.title,
      description: body.description ?? null,
      dueOn: body.due_on ? Date.parse(body.due_on) : null,
      actor: await actorSlug(c, auth),
    });
    if (result.status !== "created") return c.json({ message: "title required" }, 422);
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
}
