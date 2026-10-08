import type { AppRouter } from "@/worker/routes/hono";

import { computeEnabled, poolEarnings, poolStatus, repoPoolProject } from "@/worker/compute/pool";
import { listEvalSamples } from "@/worker/db/d1/dal/evalCorpus";
import { resolveGitnessRepo } from "./shared";

// Compute pool surface — the "power this project" card's data source.
//
//   GET /api/v1/repos/{ref}/+/pool
//
// Returns the repo's volunteer-pool status: how many supporters are online
// in its `dg:<owner>/<repo>` project pool and whether the pool path is live.
// Public repos only for the live numbers — private repos get a disabled
// payload since their content never reaches the volunteer network.

export function registerGitnessPool(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/pool", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const { route } = access;
    const project = repoPoolProject(route.routeNamespaceSlug, route.routeRepoSlug);
    // Public and internal repos are pool-eligible (internal rides the
    // INTERNAL lane — durable+DID-bound nodes only). Private/encrypted off.
    const enabled = computeEnabled(c.env) && route.visibility !== "private" && !route.encrypted;
    const [status, earnings] = enabled
      ? await Promise.all([poolStatus(c.env, project), poolEarnings(c.env, project)])
      : [null, null];
    // COMPUTE_COORDINATOR is typed as its wrangler "" literal — widen
    // through string for the http→ws rewrite.
    const coordinator: string = c.env.COMPUTE_COORDINATOR ?? "";
    return c.json({
      project,
      enabled,
      supporters: status?.volunteers ?? 0,
      idle: status?.idle ?? 0,
      pendingJobs: status?.pendingJobs ?? 0,
      jobsSettled: earnings?.jobs ?? 0,
      // Micro-USDC string — card formats to dollars for display.
      earnedWei: earnings?.totalWei ?? "0",
      // Coordinator WebSocket base for the consent script's data-attr —
      // the SPA never needs its own coordinator config.
      coordinatorWs: coordinator
        ? `${coordinator.replace(/^http/, "ws").replace(/\/+$/, "")}/`
        : undefined,
      // Script the SPA lazy-loads for the consent card — vendored copy of
      // the coordinator's visitor node; the card itself owns consent.
      scriptUrl: "/power.js",
    });
  });

  // Eval corpus read surface — the self-improvement loop's visibility.
  //
  //   GET /api/v1/repos/{ref}/+/eval
  //
  // Lists the adjudication samples this public repo contributed: conflict
  // inputs, which engine merged (pool / workers-ai / mixed), and how the
  // intent resolved. Corpus rows only exist for public repos — the write
  // path in the adjudication task applies the same visibility gate, so a
  // private repo can never have rows to leak. Still, the read is gated too
  // rather than relying on write-side discipline alone.
  router.get("/api/v1/repos/:repo_ref{.+}/eval", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const { route } = access;
    if (route.visibility !== "public") {
      return c.json({ enabled: false, samples: [] }, 403);
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = await listEvalSamples(c.var.db, route.repositoryId, limit);
    return c.json({
      enabled: true,
      samples: rows.map((row) => ({
        id: row.id,
        intentId: row.intentId,
        engine: row.engine,
        input: JSON.parse(row.input),
        output: row.output ? JSON.parse(row.output) : null,
        outcome: row.outcome,
        createdAt: row.createdAt,
      })),
    });
  });
}
