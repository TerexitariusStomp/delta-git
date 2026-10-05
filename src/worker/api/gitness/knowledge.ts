// Repo knowledge-base endpoints behind the gitness `/api/v1` facade.
//
// The KB is built per repo HEAD — symbols, import/dep graph, summaries,
// mermaid diagrams, glossary, guided tours — and cached in KV keyed to the
// resolved HEAD oid. Serving is lazy-fresh: first read at a new HEAD
// rebuilds; the maintenance-queue `knowledge-refresh` task warms it on push.
//
// Access: read-gated by resolveGitnessRepo like every repo endpoint.
// Strict-E2E encrypted repos carry no server-side plaintext — these
// endpoints refuse them; client-side custody owns their knowledge lane.

import type { AppRouter } from "@/worker/routes/hono";
import { loadHeadAndRefsCached } from "@/worker/routes/ui/helpers";
import {
  refreshRepoKnowledge,
  llmsTxt,
  llmsFullTxt,
  symbolXref,
  topModule,
  type RepoKnowledge,
} from "@/worker/knowledge";
import { gErr, parseRepoRef, resolveGitnessRepo, type RepoAccessOk } from "./shared";

/** Resolve the repo + current HEAD and load (building if stale) its KB. */
async function loadKb(
  c: Parameters<typeof resolveGitnessRepo>[0],
  access: RepoAccessOk
): Promise<RepoKnowledge | Response> {
  if (access.route.encrypted) {
    return gErr(
      c,
      403,
      "This repository is end-to-end encrypted — server-side knowledge is unavailable; use client-side custody."
    );
  }
  const refs = await loadHeadAndRefsCached(c.env, access.cacheCtx, access.route.doName);
  const headOid = refs?.head?.oid ?? null;
  const kb = await refreshRepoKnowledge(c.env, access.route.doName, headOid, access.cacheCtx).catch(
    () => null
  );
  if (!kb) return gErr(c, 404, "knowledge unavailable");
  return kb;
}

/** Compact projection: the file/edge graph without per-file symbol detail. */
function graphView(kb: RepoKnowledge) {
  return {
    head: kb.headOid,
    generated: kb.generated,
    nodes: kb.files.map((f) => ({
      path: f.path,
      module: topModule(f.path),
      symbols: f.symbols.length,
    })),
    edges: kb.edges,
    packages: kb.packages,
    entrypoints: kb.entrypoints,
  };
}

export function registerGitnessKnowledge(router: AppRouter) {
  // GET /api/v1/repos/{ref}/+/knowledge — full KB document.
  router.get("/api/v1/repos/:repo_ref{.+}/knowledge", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json(kb);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/knowledge/summary", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json({
      head: kb.headOid,
      generated: kb.generated,
      summary: kb.summary,
      modules: kb.moduleBlurbs,
      entrypoints: kb.entrypoints,
      packages: kb.packages,
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/knowledge/graph", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json(graphView(kb));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/knowledge/diagrams", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json({ head: kb.headOid, diagrams: kb.diagrams });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/knowledge/glossary", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json({ head: kb.headOid, glossary: kb.glossary });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/knowledge/tours", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json({ head: kb.headOid, tours: kb.tours });
  });

  // GET /api/v1/repos/{ref}/+/symbols/{name} — definition + usage xref.
  router.get("/api/v1/repos/:repo_ref{.+}/symbols/:name", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    return c.json(symbolXref(kb, c.req.param("name")));
  });

  // GET /api/v1/repos/{ref}/+/llms.txt — agent-facing repo manifest.
  router.get("/api/v1/repos/:repo_ref{.+}/llms.txt", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    const ref = parseRepoRef(c.req.param("repo_ref"));
    return c.text(llmsTxt(kb, ref?.owner ?? "", ref?.repo ?? ""), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/llms-full.txt", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const kb = await loadKb(c, access);
    if (kb instanceof Response) return kb;
    const ref = parseRepoRef(c.req.param("repo_ref"));
    return c.text(llmsFullTxt(kb, ref?.owner ?? "", ref?.repo ?? ""), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });
}
