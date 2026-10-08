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

import { createDb } from "@/worker/db/d1/client";
import { insertEvalSample } from "@/worker/db/d1/dal/evalCorpus";
import { ensureD1Migrations } from "./util/d1Setup";
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

  it("intent dispatch rejects anonymous callers", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo);
    const res = await workerExports.default.fetch(
      `https://t/api/${seeded.namespaceSlug}/${seeded.repoSlug}/dg/work/work-nope/dispatch`,
      { method: "POST" }
    );
    expect(res.status).toBe(401);
  });

  it("intent dispatch refuses private repos before anything else", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo, { visibility: "private" });
    const res = await workerExports.default.fetch(
      `https://t/api/${seeded.namespaceSlug}/${seeded.repoSlug}/dg/work/work-nope/dispatch`,
      {
        method: "POST",
        headers: { authorization: seeded.pushAuthHeader, "content-type": "application/json" },
        body: "{}",
      }
    );
    expect(res.status).toBe(403);
  });

  it("intent dispatch on an internal repo passes the visibility gate", async () => {
    // internal repos are pool-eligible — their jobs carry the INTERNAL
    // classification so the coordinator only routes them to durable+DID
    // nodes. Unconfigured pool → 503 (not the private-repo 403).
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo, { visibility: "internal" });
    const res = await workerExports.default.fetch(
      `https://t/api/${seeded.namespaceSlug}/${seeded.repoSlug}/dg/work/work-nope/dispatch`,
      {
        method: "POST",
        headers: { authorization: seeded.pushAuthHeader, "content-type": "application/json" },
        body: "{}",
      }
    );
    expect(res.status).toBe(503);
  });

  it("internal repos stay hidden from anonymous callers", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo, { visibility: "internal" });
    // Anonymous eval read → 404 like private (non-enumerable).
    const res = await workerExports.default.fetch(
      `https://t/api/v1/repos/${seeded.namespaceSlug}/${seeded.repoSlug}/+/eval`
    );
    expect(res.status).toBe(404);
  });

  it("intent dispatch 503s when the pool is unconfigured", async () => {
    const repo = uniqueRepoId("pool");
    const seeded = await setupRepoForTests(env, "pool-ns", repo);
    const res = await workerExports.default.fetch(
      `https://t/api/${seeded.namespaceSlug}/${seeded.repoSlug}/dg/work/work-nope/dispatch`,
      {
        method: "POST",
        headers: { authorization: seeded.pushAuthHeader, "content-type": "application/json" },
        body: "{}",
      }
    );
    expect(res.status).toBe(503);
  });

  it("GET /+/eval lists corpus samples for a public repo", async () => {
    await ensureD1Migrations(env);
    const repo = uniqueRepoId("eval");
    const seeded = await setupRepoForTests(env, "eval-ns", repo);
    const db = createDb(env.DB);
    await insertEvalSample(db, {
      id: crypto.randomUUID(),
      repositoryId: seeded.repositoryId,
      intentId: "intent-test-1",
      engine: "compute-pool",
      input: JSON.stringify([{ path: "a.ts", ours: "x", theirs: "y" }]),
      output: JSON.stringify({ "a.ts": "b64" }),
      outcome: "merged",
      createdAt: Date.now(),
    });
    const res = await workerExports.default.fetch(
      `https://t/api/v1/repos/${seeded.namespaceSlug}/${seeded.repoSlug}/+/eval`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      samples: { intentId: string | null; engine: string; outcome: string | null }[];
    };
    expect(body.enabled).toBe(true);
    const row = body.samples.find((s) => s.intentId === "intent-test-1");
    expect(row).toBeDefined();
    expect(row?.engine).toBe("compute-pool");
    expect(row?.outcome).toBe("merged");
  });

  it("GET /+/eval does not expose private repos", async () => {
    await ensureD1Migrations(env);
    const repo = uniqueRepoId("eval");
    const seeded = await setupRepoForTests(env, "eval-ns", repo, { visibility: "private" });
    // Anonymous viewers get 404 — private repo existence is hidden before
    // the eval surface ever runs.
    const res = await workerExports.default.fetch(
      `https://t/api/v1/repos/${seeded.namespaceSlug}/${seeded.repoSlug}/+/eval`
    );
    expect(res.status).toBe(404);
  });
});
