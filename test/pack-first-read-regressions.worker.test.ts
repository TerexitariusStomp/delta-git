import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { encodeGitObject } from "@/worker/git/core";
import {
  buildPack,
  callStubWithRetry,
  deleteLooseObjectCopies,
  seedLegacyPackedRepo,
  seedPackedRepo,
  toRequestBody,
  uniqueRepoId,
} from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { buildFetchBody, findBytes } from "./util/fetch-protocol";

describe("pack-first read-path regressions", () => {
  it("serves facade and raw routes from packs after all loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-first-ui");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const id = env.REPO_DO.idFromName(repoId);
    const getStub = () => env.REPO_DO.get(id);

    const seeded = await seedPackedRepo(env, repoId, getStub, { mirrorLooseToR2: true });
    await callStubWithRetry(getStub, (stub) => stub.getActivePackCatalog());
    await deleteLooseObjectCopies(env, getStub, seeded.objectOids);

    // SSR tree/blob/commit pages are retired; the same read paths back the
    // gitness facade content/commit endpoints the SPA calls.
    const api = `https://example.com/api/v1/repos/${owner}/${repo}/+`;

    const treeRes = await workerExports.default.fetch(`${api}/content?git_ref=main`);
    expect(treeRes.status).toBe(200);
    const treeJson = (await treeRes.json()) as {
      content?: { entries?: Array<{ name: string }> };
    };
    expect((treeJson.content?.entries ?? []).map((e) => e.name)).toContain("hello.txt");

    const blobRes = await workerExports.default.fetch(`${api}/content/hello.txt?git_ref=main`);
    expect(blobRes.status).toBe(200);
    const blobJson = (await blobRes.json()) as {
      content?: { encoding: string; data: string };
    };
    expect(atob(blobJson.content?.data ?? "")).toContain("hello from packed storage");

    const rawRes = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/raw?oid=${encodeURIComponent(seeded.blob.oid)}&name=hello.txt`
    );
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toBe("hello from packed storage\n");

    const rawPathRes = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/rawpath?ref=main&path=${encodeURIComponent("hello.txt")}&name=hello.txt`,
      {
        headers: {
          referer: `https://example.com/${owner}/${repo}/blob?ref=main&path=hello.txt`,
        },
      }
    );
    expect(rawPathRes.status).toBe(200);
    expect(await rawPathRes.text()).toBe("hello from packed storage\n");

    const commitRes = await workerExports.default.fetch(
      `${api}/commits/${encodeURIComponent(seeded.commit.oid)}`
    );
    expect(commitRes.status).toBe(200);
    const commitJson = (await commitRes.json()) as { title?: string; message?: string };
    expect(commitJson.title ?? commitJson.message ?? "").toContain("packed commit");

    const diffRes = await workerExports.default.fetch(
      `${api}/commits/${encodeURIComponent(seeded.commit.oid)}/diff`
    );
    expect(diffRes.status).toBe(200);
    const diffText = await diffRes.text();
    expect(diffText).toContain("+++ b/hello.txt");
    expect(diffText).toContain("+hello from packed storage");
  });

  it("serves fetch from packs after all loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-first-fetch");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const id = env.REPO_DO.idFromName(repoId);
    const getStub = () => env.REPO_DO.get(id);

    const seeded = await seedPackedRepo(env, repoId, getStub, { mirrorLooseToR2: true });
    await callStubWithRetry(getStub, (stub) => stub.getActivePackCatalog());
    await deleteLooseObjectCopies(env, getStub, seeded.objectOids);

    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
        body: toRequestBody(buildFetchBody({ wants: [seeded.commit.oid], done: true })),
      }
    );

    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const packOffset = findBytes(bytes, new TextEncoder().encode("PACK"));
    expect(packOffset).toBeGreaterThan(-1);
    expect(new TextDecoder().decode(bytes.subarray(packOffset, packOffset + 4))).toBe("PACK");
  });

  it("serves commits and merge fragments from packs after all loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-first-commits");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const id = env.REPO_DO.idFromName(repoId);
    const getStub = () => env.REPO_DO.get(id);

    const author = "You <you@example.com> 0 +0000";
    const tree = await encodeGitObject("tree", new Uint8Array(0));

    const baseCommitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\n` + `author ${author}\n` + `committer ${author}\n\nbase\n`
    );
    const baseCommit = await encodeGitObject("commit", baseCommitPayload);

    const mainCommitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\n` +
        `parent ${baseCommit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\nmainline\n`
    );
    const mainCommit = await encodeGitObject("commit", mainCommitPayload);

    const sideCommitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\n` +
        `parent ${baseCommit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\nside branch\n`
    );
    const sideCommit = await encodeGitObject("commit", sideCommitPayload);

    const mergeCommitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\n` +
        `parent ${mainCommit.oid}\n` +
        `parent ${sideCommit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\nmerge commit\n`
    );
    const mergeCommit = await encodeGitObject("commit", mergeCommitPayload);

    const packBytes = await buildPack([
      { type: "tree", payload: new Uint8Array(0) },
      { type: "commit", payload: baseCommitPayload },
      { type: "commit", payload: mainCommitPayload },
      { type: "commit", payload: sideCommitPayload },
      { type: "commit", payload: mergeCommitPayload },
    ]);

    await seedLegacyPackedRepo({
      env,
      repoId,
      getStub,
      packs: [{ name: "pack-merge.pack", packBytes }],
      refs: [{ name: "refs/heads/main", oid: mergeCommit.oid }],
      head: { target: "refs/heads/main", oid: mergeCommit.oid },
      looseObjects: [tree, baseCommit, mainCommit, sideCommit, mergeCommit],
      mirrorLooseToR2: true,
    });

    await callStubWithRetry(getStub, (stub) => stub.getActivePackCatalog());
    await deleteLooseObjectCopies(env, getStub, [
      tree.oid,
      baseCommit.oid,
      mainCommit.oid,
      sideCommit.oid,
      mergeCommit.oid,
    ]);

    const api = `https://example.com/api/v1/repos/${owner}/${repo}/+`;

    const commitsRes = await workerExports.default.fetch(`${api}/commits?git_ref=main`);
    expect(commitsRes.status).toBe(200);
    const commitsJson = (await commitsRes.json()) as {
      commits?: Array<{ title?: string; message?: string }>;
    };
    const messages = (commitsJson.commits ?? []).map((c) => c.title ?? c.message ?? "");
    expect(messages.some((m) => m.includes("merge commit"))).toBe(true);
    expect(messages.some((m) => m.includes("mainline"))).toBe(true);

    // The retired fragments endpoint walked all ancestors; the facade commits
    // list is first-parent (the SPA's log view). A merged side commit is
    // still resolvable directly by SHA from pack storage.
    const sideRes = await workerExports.default.fetch(
      `${api}/commits/${encodeURIComponent(sideCommit.oid)}`
    );
    expect(sideRes.status).toBe(200);
    const sideJson = (await sideRes.json()) as { title?: string; message?: string };
    expect(sideJson.title ?? sideJson.message ?? "").toContain("side branch");
  });
});
