import type { AppRouter } from "./hono";

import type { CacheContext } from "@/worker/cache";
import { isValidOwnerRepo } from "@/shared/web";
import { getRepoStub } from "@/worker/common";
import { getHeadAndRefs, resolveRef } from "@/worker/git/operations/read";
import { getLimiter } from "@/worker/git/operations/limits";
import { readObject } from "@/worker/git/object-store/store";
import { parseCommitText } from "@/worker/git/core";
import { isTreeMode, parseTree } from "@/worker/git/core/tree";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { makeBadge } from "badge-maker";

// Shields.io-compatible badge endpoint — README badges are a core piece of
// GitHub-familiar repo UX. Served as SVG from repo metadata.
//
//   GET /badge/:owner/:repo/:metric
//
// Metrics: branches, tags, intents (open merge intents), license, last-commit.
// Public repos only — private repos answer 404 unconditionally so a badge URL
// can never leak existence into a README/embed context.
//
// Rendering is badge-maker (shields.io's own generator); metric values come
// from the repo DO/refs index. Short cache TTL so badges track freshness.

const td = new TextDecoder();
const BADGE_CACHE_SECONDS = 300;

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function svgBadge(label: string, message: string, color: string): Response {
  const svg = makeBadge({ label, message, color, style: "flat" });
  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${BADGE_CACHE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function relAge(fromSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - fromSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

// Root-tree filename check — same pattern the About sidebar uses.
const LICENSE_NAME = /^(licen[sc]e|copying|unlicen[sc]e|notice)(\.\w{1,4})?$/i;

// Lightweight SPDX signature match on the first chunk of the license body.
// Detection lives in one place so a badge, the About sidebar, and later a
// `detected_license` API field can share the vocabulary.
const LICENSE_SIGNATURES: [RegExp, string][] = [
  [/apache license\s+version 2\.0/i, "Apache-2.0"],
  [/mit license|permission is hereby granted, free of charge/i, "MIT"],
  [/gnu general public license\s+version 3|gpl-3/i, "GPL-3.0"],
  [/gnu general public license\s+version 2|gpl-2/i, "GPL-2.0"],
  [/gnu affero general public license/i, "AGPL"],
  [/gnu lesser general public license/i, "LGPL"],
  [/bsd 3-clause|bsd 2-clause|redistribution and use in source and binary forms/i, "BSD"],
  [/mozilla public license\s+version 2\.0|mpl-2/i, "MPL-2.0"],
  [/the unlicense|free and unencumbered software released into the public domain/i, "Unlicense"],
  [/creative commons/i, "CC"],
  [/isc license/i, "ISC"],
];

async function headCommitOid(env: Env, doName: string, cacheCtx: CacheContext | undefined) {
  return resolveRef(env, doName, "HEAD", cacheCtx);
}

export function registerBadgeRoutes(router: AppRouter) {
  router.get("/badge/:owner/:repo/:metric", async (c) => {
    const log = c.var.logFor({ service: "Badge" });
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const metric = c.req.param("metric") ?? "";
    if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return notFound();

    // Badge fetches are anonymous (README/embed contexts) — never fall back
    // to D1 and never issue an auth challenge. Private repos are invisible.
    const route = await resolveRepositoryRoute(c.env, owner, repo, {
      mode: "route-cache-only",
      db: c.var.db,
      log,
    });
    if (!route || route.visibility !== "public") return notFound();

    const doName = route.doName;
    const cacheCtx = c.var.cacheCtx;

    try {
      switch (metric) {
        case "branches": {
          const { refs } = await getHeadAndRefs(c.env, doName, cacheCtx);
          const n = refs.filter((r) => r.name.startsWith("refs/heads/")).length;
          return svgBadge("branches", String(n), "blue");
        }
        case "tags": {
          const { refs } = await getHeadAndRefs(c.env, doName, cacheCtx);
          const n = refs.filter((r) => r.name.startsWith("refs/tags/")).length;
          return svgBadge("tags", String(n), "blue");
        }
        case "intents": {
          const stub = getRepoStub(c.env, doName);
          const limiter = getLimiter(cacheCtx);
          const open = await limiter.run("do:list-merge-intents", () =>
            stub.listMergeIntents(["open", "merging", "adjudicating", "conflict"])
          );
          return svgBadge(
            "open intents",
            String(open.length),
            open.length ? "yellow" : "brightgreen"
          );
        }
        case "last-commit": {
          const headOid = await headCommitOid(c.env, doName, cacheCtx);
          if (!headOid) return svgBadge("last commit", "none", "lightgrey");
          const commitObj = await readObject(c.env, doName, headOid, cacheCtx);
          const commit = commitObj ? parseCommitText(td.decode(commitObj.payload)) : null;
          const when = commit?.committer?.when ?? commit?.author?.when;
          if (!when) return svgBadge("last commit", "unknown", "lightgrey");
          return svgBadge("last commit", relAge(when), "blue");
        }
        case "license": {
          const headOid = await headCommitOid(c.env, doName, cacheCtx);
          if (!headOid) return svgBadge("license", "none", "lightgrey");
          const commitObj = await readObject(c.env, doName, headOid, cacheCtx);
          if (!commitObj || commitObj.type !== "commit")
            return svgBadge("license", "none", "lightgrey");
          const commit = parseCommitText(td.decode(commitObj.payload));
          const treeObj = await readObject(c.env, doName, commit.tree, cacheCtx);
          if (!treeObj || treeObj.type !== "tree") return svgBadge("license", "none", "lightgrey");
          const entry = [...parseTree(treeObj.payload).values()].find(
            (e) => !isTreeMode(e.mode) && LICENSE_NAME.test(e.name)
          );
          if (!entry?.oid) return svgBadge("license", "none", "lightgrey");
          const blob = await readObject(c.env, doName, entry.oid, cacheCtx);
          if (!blob || blob.type !== "blob") return svgBadge("license", "license", "yellow");
          const headChunk = td.decode(blob.payload.slice(0, 8 * 1024));
          const spdx = LICENSE_SIGNATURES.find(([re]) => re.test(headChunk))?.[1];
          return svgBadge("license", spdx ?? entry.name, spdx ? "blue" : "yellow");
        }
        default:
          return notFound();
      }
    } catch (err) {
      log.warn("badge:metric-failed", { owner, repo, metric, error: String(err) });
      return svgBadge(metric, "unavailable", "lightgrey");
    }
  });
}
