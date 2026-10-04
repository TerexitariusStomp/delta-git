import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";

import { getRepoStub } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { isValidOwnerRepo } from "@/shared/web";
import { readPayload, resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode, parseTree } from "@/worker/merge/tree";
import { parseCommitText } from "@/worker/git/core";

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
}
