import type { AppRouter } from "@/worker/routes/hono";

import { computeEnabled, poolEarnings, poolStatus, repoPoolProject } from "@/worker/compute/pool";
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
    const enabled = computeEnabled(c.env) && route.visibility === "public";
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
}
