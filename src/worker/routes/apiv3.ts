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
import type { DiscussionView } from "@/worker/do/repo/catalog/discussions";
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
    const [repoRow, stars, topics] = await Promise.all([
      findRepositoryById(c.var.db, route.repositoryId),
      starCount(c.var.db, route.repositoryId),
      listRepoTopics(c.var.db, route.repositoryId),
    ]);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req
      .json<{ title?: string; body?: string; head?: string; base?: string }>()
      .catch(() => null);
    if (!body?.head || !body?.base) {
      return c.json({ message: "head and base required" }, 422);
    }
    const targetRef = `refs/heads/${body.base.replace(/^refs\/heads\//, "")}`;
    const sourceRef = `refs/heads/${body.head.replace(/^refs\/heads\//, "")}`;
    if (targetRef === sourceRef) return c.json({ message: "head and base match" }, 422);
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const source = refs.find((r) => r.name === sourceRef);
    if (!source) return c.json({ message: `head ref not found: ${body.head}` }, 422);
    if (!refs.some((r) => r.name === targetRef)) {
      return c.json({ message: `base ref not found: ${body.base}` }, 422);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return c.json({ message: "Not Found" }, 404);
    const actor = await actorSlug(c, auth);
    const body = await c.req
      .json<{ title?: string; body?: string; state?: string }>()
      .catch(() => null);
    const stub = getRepoStub(c.env, route.doName);
    if (body?.state === "closed") {
      const result = await stub.rejectMergeIntent({ id: intent.id, actor });
      if (result.status === "not_found") return c.json({ message: "Not Found" }, 404);
      if (result.status === "not_rejectable") {
        return c.json({ message: `pull request is ${result.state}` }, 409);
      }
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const all = await intentsOrdered(c.env, route.doName);
    const intent = all[number - 1];
    if (!intent) return c.json({ message: "Not Found" }, 404);
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return c.json({ message: "body required" }, 422);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req
      .json<{ title?: string; body?: string; category?: string }>()
      .catch(() => null);
    if (!body?.title?.trim()) return c.json({ message: "title required" }, 422);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.createDiscussion({
      title: body.title,
      body: body.body ?? null,
      category: body.category,
      actor: await actorSlug(c, auth),
    });
    if (result.status !== "created") return c.json({ message: result.reason }, 422);
    const origin = new URL(c.req.url).origin;
    return c.json(
      discussionJson(result.discussion, origin, c.req.param("owner"), c.req.param("repo")),
      201
    );
  });

  // GET /api/v3/repos/:owner/:repo/discussions/:number
  router.get("/api/v3/repos/:owner/:repo/discussions/:number", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.getDiscussion(number);
    if (result.status !== "ok") return c.json({ message: "Not Found" }, 404);
    const origin = new URL(c.req.url).origin;
    return c.json(
      discussionJson(result.discussion, origin, c.req.param("owner"), c.req.param("repo"))
    );
  });

  // GET /api/v3/repos/:owner/:repo/discussions/:number/comments
  router.get("/api/v3/repos/:owner/:repo/discussions/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.listDiscussionComments(number);
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

  // POST /api/v3/repos/:owner/:repo/discussions/:number/comments
  router.post("/api/v3/repos/:owner/:repo/discussions/:number/comments", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const number = parseInt(c.req.param("number"), 10);
    if (Number.isNaN(number)) return c.json({ message: "Not Found" }, 404);
    const body = await c.req.json<{ body?: string }>().catch(() => null);
    if (!body?.body?.trim()) return c.json({ message: "body required" }, 422);
    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.addDiscussionComment({
      number,
      body: body.body,
      actor: await actorSlug(c, auth),
    });
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

  // --- social: stars + topics (gh api / integrations) ----------------------

  // PUT/DELETE /api/v3/user/starred/:owner/:repo — gh api -X PUT user/starred/o/r
  router.put("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    await starRepository(c.var.db, auth, route.repositoryId);
    return c.body(null, 204);
  });

  router.delete("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    await unstarRepository(c.var.db, auth, route.repositoryId);
    return c.body(null, 204);
  });

  // GET /api/v3/user/starred/:owner/:repo — 204 starred / 404 not
  router.get("/api/v3/user/starred/:owner/:repo", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    return (await isStarred(c.var.db, auth, route.repositoryId))
      ? c.body(null, 204)
      : c.json({ message: "Not Found" }, 404);
  });

  // GET /api/v3/repos/:owner/:repo/stargazers — GitHub returns user objects;
  // our stars table stores user ids, so the row shape is login-only.
  router.get("/api/v3/repos/:owner/:repo/stargazers", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
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
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    return c.json({ names: await listRepoTopics(c.var.db, route.repositoryId) });
  });

  router.put("/api/v3/repos/:owner/:repo/topics", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.json({ message: "Not Found" }, 404);
    const auth = await authenticated(c, route);
    if (auth instanceof Response) return auth;
    if (auth === "anonymous") return c.json({ message: "Requires authentication" }, 401);
    const body = await c.req.json<{ names?: string[] }>().catch(() => null);
    if (!body?.names) return c.json({ message: "names required" }, 422);
    const topics = normalizeTopics(body.names);
    if (!topics) return c.json({ message: "invalid topic names" }, 422);
    await setRepoTopics(c.var.db, route.repositoryId, topics);
    return c.json({ names: topics });
  });
}
