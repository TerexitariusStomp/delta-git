/**
 * Compute-pool surface — `/+/pool` repo API, the `community` badge metric,
 * and the `/power.js` consent-script route.
 *
 * The test environment has no COMPUTE_COORDINATOR configured, so the pool
 * reports as disabled — which is the state these tests pin: endpoints must
 * exist, return honest zeros, and never expose private-repo pool data.
 */
import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { setupRepoForTests } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

describe("compute pool surface", () => {
  it("GET /+/pool returns a disabled-but-valid payload when unconfigured", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo);
    const res = await workerExports.default.fetch(
      `https://t/api/v1/repos/${seeded.namespaceSlug}/${seeded.repoSlug}/+/pool`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: string;
      enabled: boolean;
      supporters: number;
      scriptUrl: string;
    };
    expect(body.project).toBe(`dg:${seeded.namespaceSlug}/${seeded.repoSlug}`);
    expect(body.enabled).toBe(false);
    expect(body.supporters).toBe(0);
    expect(body.scriptUrl).toBe("/power.js");
  });

  it("community badge renders a supporters SVG for public repos", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo);
    const res = await workerExports.default.fetch(
      `https://t/badge/${seeded.namespaceSlug}/${seeded.repoSlug}/community`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("supporters");
  });

  it("community badge 404s for private repos", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo, { visibility: "private" });
    const res = await workerExports.default.fetch(
      `https://t/badge/${seeded.namespaceSlug}/${seeded.repoSlug}/community`
    );
    expect(res.status).toBe(404);
  });

  it("/power.js serves the vendored consent script, not the SPA fallback", async () => {
    const res = await workerExports.default.fetch("https://t/power.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("chimera");
  });
});
