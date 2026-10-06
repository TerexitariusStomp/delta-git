import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { encodeGitObject } from "@/worker/git/core";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests } from "./util/repoSeed";
import { runDOWithRetry, uniqueRepoId } from "./util/test-helpers";
import { buildPack } from "./util/git-pack";
import { buildTreePayload, seedPackedRepoState } from "./util/packed-repo";

beforeAll(async () => {
  await ensureD1Migrations(env);
});

async function badge(owner: string, repo: string, metric: string): Promise<Response> {
  return await workerExports.default.fetch(`https://example.com/badge/${owner}/${repo}/${metric}`);
}

describe("GET /badge/:owner/:repo/:metric", () => {
  it("renders branch/tag/intent counts for a public repo", async () => {
    const owner = `b-${uniqueRepoId("owner")}`;
    const repo = uniqueRepoId("pub");
    const seeded = await setupRepoForTests(env, owner, repo);

    const id = env.REPO_DO.idFromName(seeded.doName);
    const getStub = () => env.REPO_DO.get(id);
    await runDOWithRetry(getStub, async (instance) => await instance.seedMinimalRepo());

    const branches = await badge(owner, repo, "branches");
    expect(branches.status).toBe(200);
    expect(branches.headers.get("Content-Type")).toContain("image/svg+xml");
    const branchesSvg = await branches.text();
    expect(branchesSvg).toContain("branches");
    expect(branchesSvg).toMatch(/>1</); // refs/heads/main only

    const tags = await badge(owner, repo, "tags");
    expect(tags.status).toBe(200);
    expect(await tags.text()).toMatch(/>0</);

    const intents = await badge(owner, repo, "intents");
    expect(intents.status).toBe(200);
    const intentsSvg = await intents.text();
    expect(intentsSvg).toContain("open intents");
    expect(intentsSvg).toMatch(/>0</);

    const lastCommit = await badge(owner, repo, "last-commit");
    expect(lastCommit.status).toBe(200);
    expect(await lastCommit.text()).not.toContain("none");
  });

  it("detects an MIT license from the root tree", async () => {
    const owner = `b-${uniqueRepoId("owner")}`;
    const repo = uniqueRepoId("lic");
    const seeded = await setupRepoForTests(env, owner, repo);

    const id = env.REPO_DO.idFromName(seeded.doName);
    const getStub = () => env.REPO_DO.get(id);

    const licensePayload = new TextEncoder().encode(
      "MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, " +
        "to any person obtaining a copy of this software.\n"
    );
    const license = await encodeGitObject("blob", licensePayload);
    const treePayload = buildTreePayload([{ mode: "100644", name: "LICENSE", oid: license.oid }]);
    const tree = await encodeGitObject("tree", treePayload);
    const author = "You <you@example.com> 0 +0000";
    const commitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\nauthor ${author}\ncommitter ${author}\n\ninit\n`
    );
    const commit = await encodeGitObject("commit", commitPayload);
    const packBytes = await buildPack([
      { type: "blob", payload: licensePayload },
      { type: "tree", payload: treePayload },
      { type: "commit", payload: commitPayload },
    ]);

    await seedPackedRepoState({
      env,
      repoId: seeded.doName,
      getStub,
      packs: [{ name: "pack-license.pack", packBytes }],
      refs: [{ name: "refs/heads/main", oid: commit.oid }],
      head: { target: "refs/heads/main", oid: commit.oid },
    });

    const res = await badge(owner, repo, "license");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("MIT");
  });

  it("answers 404 for private repos, unknown metrics, and short paths", async () => {
    const owner = `b-${uniqueRepoId("owner")}`;
    const repo = uniqueRepoId("priv");
    await setupRepoForTests(env, owner, repo, { visibility: "private" });

    expect((await badge(owner, repo, "branches")).status).toBe(404);

    const pub = await setupRepoForTests(env, `${owner}p`, uniqueRepoId("ok"));
    expect((await badge(`${owner}p`, pub.repoSlug, "bogus-metric")).status).toBe(404);

    // Missing metric segment must not fall through to the SPA fallback —
    // the SSR 404 (HTML) is correct, a 200 index.html would not be.
    const short = await workerExports.default.fetch(
      `https://example.com/badge/${owner}p/${pub.repoSlug}`
    );
    expect(short.status).toBe(404);
  });
});
