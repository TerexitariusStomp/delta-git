import type { AppContext, AppRouter } from "./hono";

import { isValidOwnerRepo } from "@/shared/web";
import { getRepoStub } from "@/worker/common";
import { readCommitInfo, resolveRef } from "@/worker/git/operations/read";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { getLimiter } from "@/worker/git/operations/limits";
import { findRepositoryById, countForks } from "@/worker/db/d1/dal/repositories";
import { starCount } from "@/worker/db/d1/dal/social";

// Atom feeds at GitHub's URLs — feed readers and release monitors poll
// these paths; serving them anonymously for public repos keeps delta-git
// drop-in compatible.
//
//   GET /:owner/:repo/releases.atom  — newest 20 published releases
//   GET /:owner/:repo/commits.atom   — newest 20 first-parent commits on HEAD
//
// Private repos answer 404 unconditionally (same non-enumeration rule as
// badges) so a feed URL can never leak existence.

const FEED_ENTRIES = 20;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function atom(doc: string): Response {
  return new Response(doc, {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function resolvePublicRepo(c: AppContext) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "Feed" }),
  });
  if (!route || route.visibility !== "public") return null;
  return route;
}

export function registerFeedRoutes(router: AppRouter) {
  router.get("/:owner/:repo/releases.atom", async (c) => {
    const route = await resolvePublicRepo(c);
    if (!route) return notFound();
    const stub = getRepoStub(c.env, route.doName);
    const limiter = getLimiter(c.var.cacheCtx);
    const releases = await limiter.run("do:list-releases", () =>
      stub.listReleases({ includeDrafts: false })
    );
    const origin = new URL(c.req.url).origin;
    const repoUrl = `${origin}/${c.req.param("owner")}/${c.req.param("repo")}`;
    const updated = releases[0] ? new Date(releases[0].createdAt).toISOString() : "";
    const entries = releases
      .slice(0, FEED_ENTRIES)
      .map(
        (r) => `<entry>
    <id>${esc(`${repoUrl}/releases/${r.id}`)}</id>
    <title>${esc(r.name ?? r.tagName)}</title>
    <link href="${esc(repoUrl)}" />
    <updated>${new Date(r.createdAt).toISOString()}</updated>
    <author><name>${esc(r.author)}</name></author>
    ${r.body ? `<content type="text">${esc(r.body)}</content>` : ""}
  </entry>`
      )
      .join("\n  ");
    return atom(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(`${repoUrl}/releases`)}</id>
  <title>${esc(`${route.routeNamespaceSlug}/${route.routeRepoSlug} releases`)}</title>
  <link href="${esc(repoUrl)}" />
  <link href="${esc(`${repoUrl}/releases.atom`)}" rel="self" />
  <updated>${updated}</updated>
  ${entries}
</feed>
`);
  });

  router.get("/:owner/:repo/commits.atom", async (c) => {
    const route = await resolvePublicRepo(c);
    if (!route) return notFound();
    const repoUrl = `${new URL(c.req.url).origin}/${c.req.param("owner")}/${c.req.param("repo")}`;
    const branch = c.req.query("branch");
    const headOid = await resolveRef(
      c.env,
      route.doName,
      branch ? `refs/heads/${branch}` : "HEAD",
      c.var.cacheCtx
    );
    if (!headOid) return notFound();

    const entries: string[] = [];
    let updated = "";
    let oid: string | undefined = headOid;
    while (oid && entries.length < FEED_ENTRIES) {
      const commit: CommitInfo | null = await readCommitInfo(
        c.env,
        route.doName,
        oid,
        c.var.cacheCtx
      ).catch(() => null);
      if (!commit) break;
      const subject = commit.message.split("\n", 1)[0].trim();
      const when = commit.committer?.when ?? commit.author?.when ?? 0;
      const iso = new Date(when * 1000).toISOString();
      if (!updated) updated = iso;
      entries.push(`<entry>
    <id>${esc(`${repoUrl}/commit/${oid}`)}</id>
    <title>${esc(subject || oid.slice(0, 7))}</title>
    <link href="${esc(`${repoUrl}/commit/${oid}`)}" />
    <updated>${iso}</updated>
    <author><name>${esc(commit.author?.name ?? "unknown")}</name></author>
  </entry>`);
      oid = commit.parents[0];
    }

    return atom(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(`${repoUrl}/commits`)}</id>
  <title>${esc(`${route.routeNamespaceSlug}/${route.routeRepoSlug} commits`)}</title>
  <link href="${esc(repoUrl)}" />
  <link href="${esc(`${repoUrl}/commits.atom`)}" rel="self" />
  <updated>${updated}</updated>
  ${entries.join("\n  ")}
</feed>
`);
  });

  // GET /embed/:owner/:repo — iframe-able repo card for external sites.
  // Self-contained HTML (no assets) so it renders cross-origin.
  router.get("/embed/:owner/:repo", async (c) => {
    const route = await resolvePublicRepo(c);
    if (!route) return notFound();
    const repoRow = await findRepositoryById(c.var.db, route.repositoryId);
    const [stars, forks] = await Promise.all([
      starCount(c.var.db, route.repositoryId),
      countForks(c.var.db, route.repositoryId),
    ]);
    const headOid = await resolveRef(c.env, route.doName, "HEAD", c.var.cacheCtx);
    const head = headOid
      ? await readCommitInfo(c.env, route.doName, headOid, c.var.cacheCtx).catch(() => null)
      : null;
    const when = head?.committer?.when ?? head?.author?.when ?? 0;
    const age = when ? new Date(when * 1000).toISOString().slice(0, 10) : "";
    const origin = new URL(c.req.url).origin;
    const repoUrl = `${origin}/${route.routeNamespaceSlug}/${route.routeRepoSlug}`;
    const desc = repoRow?.description ?? "";
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 16px;
 background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);
 border-radius:8px}
a{color:LinkText;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:16px;margin:0 0 4px;font-weight:600}
p{margin:0 0 8px;color:color-mix(in srgb,CanvasText 70%,transparent);font-size:13px;
 overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
footer{display:flex;gap:14px;font-size:12px;color:color-mix(in srgb,CanvasText 60%,transparent)}
</style></head>
<body>
<h1><a href="${esc(repoUrl)}" target="_blank" rel="noopener">${esc(
      `${route.routeNamespaceSlug}/${route.routeRepoSlug}`
    )}</a></h1>
${desc ? `<p>${esc(desc)}</p>` : ""}
<footer>
  <span>&#9733; ${stars}</span>
  <span>&#9095; ${forks}</span>
  ${age ? `<span>updated ${esc(age)}</span>` : ""}
  <span style="margin-left:auto">delta-git</span>
</footer>
</body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        // Allow embedding anywhere — that's the point of the card.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });
}
