import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { setupRepoForTests } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

// Contract test for the read-only sh.tangled.* XRPC surface — the shapes
// external appviews/indexers consume (docs/federation.md pins the rev).

async function xrpc(path: string) {
  const res = await workerExports.default.fetch(`https://example.com${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("sh.tangled.* XRPC", () => {
  it("describeRepo returns the pinned repo shape for a public repo", async () => {
    const owner = "xo";
    const repo = uniqueRepoId("xrpc");
    await setupRepoForTests(env, owner, repo);
    const res = await xrpc(
      `/xrpc/sh.tangled.repo.describeRepo?repoDid=${encodeURIComponent(`${owner}/${repo}`)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.repo.name).toBe(repo);
    expect(res.body.repo.owner).toBe(owner);
    expect(res.body.repo.did).toMatch(/^did:dg:repo:/);
    expect(res.body.repo.knot).toBe("delta-git");
    expect(res.body.repo.visibility).toBe("public");
  });

  it("repo.list enumerates only public repos for an owner", async () => {
    const owner = "xl";
    const repo = uniqueRepoId("xrpc-pub");
    const priv = uniqueRepoId("xrpc-priv");
    await setupRepoForTests(env, owner, repo);
    await setupRepoForTests(env, owner, priv, { visibility: "private" });
    const res = await xrpc(`/xrpc/sh.tangled.repo.list?owner=${owner}`);
    expect(res.status).toBe(200);
    const names = (res.body.repos as { name: string }[]).map((r) => r.name);
    expect(names).toContain(repo);
    expect(names).not.toContain(priv);
  });

  it("private repos are indistinguishable from missing ones", async () => {
    const owner = "xp";
    const repo = uniqueRepoId("xrpc-secret");
    await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const res = await xrpc(
      `/xrpc/sh.tangled.repo.describeRepo?repoDid=${encodeURIComponent(`${owner}/${repo}`)}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("repo-not-found");
  });

  it("pull.list returns merge intents in the pinned shape", async () => {
    const owner = "xq";
    const repo = uniqueRepoId("xrpc-pull");
    await setupRepoForTests(env, owner, repo);
    const res = await xrpc(
      `/xrpc/sh.tangled.repo.pull.list?repoDid=${encodeURIComponent(`${owner}/${repo}`)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pulls)).toBe(true);
  });

  it("issue.list returns work intents in the pinned shape", async () => {
    const owner = "xi";
    const repo = uniqueRepoId("xrpc-iss");
    await setupRepoForTests(env, owner, repo);
    const res = await xrpc(
      `/xrpc/sh.tangled.repo.issue.list?repoDid=${encodeURIComponent(`${owner}/${repo}`)}`
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.issues)).toBe(true);
  });
});
