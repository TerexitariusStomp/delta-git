import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";

import { getRepoStub } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { readPayload, resolvePathEntry } from "@/worker/agent/patch";
import { isTreeMode } from "@/worker/merge/tree";
import { parseCommitText } from "@/worker/git/core";
import lookupMime from "mime";

// GitHub-Pages-style static serving straight from the object store.
//
// GET /pages/:owner/:repo/*          → serve from main's /site (or repo root)
// GET /pages/:owner/:repo/@:ref/*    → pinned to a branch/ref/commit sha
// Every immutable commit gets a permanent preview URL for free.

const td = new TextDecoder();

async function resolveRoute(c: AppContext): Promise<RepositoryRoute | null> {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  return await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "Pages" }),
  });
}

async function treeOidForRef(
  c: AppContext,
  route: RepositoryRoute,
  refOrSha: string | undefined
): Promise<string | undefined> {
  const stub = getRepoStub(c.env, route.doName);
  let oid = refOrSha;
  if (!oid || !/^[0-9a-f]{40}$/i.test(oid)) {
    const { refs } = await stub.getHeadAndRefs();
    const target = oid?.startsWith("refs/") ? oid : `refs/heads/${oid ?? "main"}`;
    oid =
      refs.find((r) => r.name === target)?.oid ??
      refs.find((r) => r.name === "refs/heads/pages")?.oid;
  }
  if (!oid) return undefined;
  const commit = await readPayload(c.env, route.doName, oid, c.var.cacheCtx);
  if (!commit) return undefined;
  return parseCommitText(td.decode(commit.payload)).tree;
}

export function registerPagesRoutes(router: AppRouter): void {
  router.get("/pages/:owner/:repo/*", async (c) => {
    const route = await resolveRoute(c);
    if (!route) return c.text("not found", 404);
    const url = new URL(c.req.url);
    let ref = url.searchParams.get("ref") ?? undefined;
    let path = decodeURIComponent(
      url.pathname.split(`/pages/${c.req.param("owner")}/${c.req.param("repo")}/`)[1] ?? ""
    );

    // @ref prefix pins the serving ref inline.
    if (path.startsWith("@")) {
      const slash = path.indexOf("/");
      ref = slash === -1 ? path.slice(1) : path.slice(1, slash);
      path = slash === -1 ? "" : path.slice(slash + 1);
    }

    const treeOid = await treeOidForRef(c, route, ref);
    if (!treeOid) return c.text("ref not found", 404);

    // Prefer /site subtree when present (Pages convention), else repo root.
    let rootTree = treeOid;
    const siteEntry = await resolvePathEntry(c.env, route.doName, treeOid, "site", c.var.cacheCtx);
    if (siteEntry && isTreeMode(siteEntry.mode)) rootTree = siteEntry.oid;

    let rel = path.replace(/^\/+|\/+$/g, "");
    if (rel === "") rel = "index.html";
    let entry = await resolvePathEntry(c.env, route.doName, rootTree, rel, c.var.cacheCtx);
    if (!entry && !rel.includes(".")) {
      entry = await resolvePathEntry(
        c.env,
        route.doName,
        rootTree,
        `${rel}/index.html`,
        c.var.cacheCtx
      );
      if (entry) rel = `${rel}/index.html`;
    }
    if (!entry || isTreeMode(entry.mode)) return c.text("not found", 404);

    const blob = await readObject(c.env, route.doName, entry.oid, c.var.cacheCtx);
    if (!blob || blob.type !== "blob") return c.text("not found", 404);
    return new Response(blob.payload as BodyInit, {
      headers: {
        "Content-Type": lookupMime.getType(rel) || "application/octet-stream",
        "Cache-Control": /^[0-9a-f]{40}$/i.test(ref ?? "")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
}
