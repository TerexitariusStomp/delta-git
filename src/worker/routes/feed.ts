import type { AppContext, AppRouter } from "./hono";

import { isValidOwnerRepo } from "@/shared/web";
import { getRepoStub } from "@/worker/common";
import { readCommitInfo, resolveRef } from "@/worker/git/operations/read";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { getLimiter } from "@/worker/git/operations/limits";

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
}
