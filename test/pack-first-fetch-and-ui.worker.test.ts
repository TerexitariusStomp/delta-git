import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import type { RepoStateSchema } from "@/worker/do/repo/repoState";

import { buildPack, callStubWithRetry, runDOWithRetry, uniqueRepoId } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { asTypedStorage, objKey } from "@/worker/do/repo/repoState";
import { encodeGitObject } from "@/worker/git/core";
import { doPrefix, r2LooseKey, r2PackKey } from "@/worker/keys";
import { buildTreePayload } from "./util/packed-repo";
import { indexTestPack } from "./util/test-indexer";
import { getDb, upsertPackCatalogRow } from "@/worker/do/repo/db";
import { buildFetchBody, findBytes } from "./util/fetch-protocol";

async function seedPackedOnlyRepo(repoId: string) {
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);
  const encoder = new TextEncoder();
  const author = "You <you@example.com> 0 +0000";

  const blob1Payload = encoder.encode("hello from v1\n");
  const blob1 = await encodeGitObject("blob", blob1Payload);
  const tree1Payload = buildTreePayload([{ mode: "100644", name: "hello.txt", oid: blob1.oid }]);
  const tree1 = await encodeGitObject("tree", tree1Payload);
  const commit1Payload = encoder.encode(
    `tree ${tree1.oid}\n` + `author ${author}\n` + `committer ${author}\n\n` + `first commit\n`
  );
  const commit1 = await encodeGitObject("commit", commit1Payload);

  const blob2Payload = encoder.encode("hello from v2\n");
  const blob2 = await encodeGitObject("blob", blob2Payload);
  const symlinkPayload = encoder.encode("AGENTS.md");
  const symlinkBlob = await encodeGitObject("blob", symlinkPayload);
  const tree2Payload = buildTreePayload([
    { mode: "100644", name: "hello.txt", oid: blob2.oid },
    { mode: "120000", name: "CLAUDE.md", oid: symlinkBlob.oid },
  ]);
  const tree2 = await encodeGitObject("tree", tree2Payload);
  const commit2Payload = encoder.encode(
    `tree ${tree2.oid}\n` +
      `parent ${commit1.oid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `second commit\n`
  );
  const commit2 = await encodeGitObject("commit", commit2Payload);

  const looseObjects = [blob1, tree1, commit1, blob2, symlinkBlob, tree2, commit2];
  const packs = [
    {
      name: "pack-receive-0002.pack",
      packBytes: await buildPack([
        { type: "blob", payload: blob2Payload },
        { type: "blob", payload: symlinkPayload },
        { type: "tree", payload: tree2Payload },
        { type: "commit", payload: commit2Payload },
      ]),
    },
    {
      name: "pack-receive-0001.pack",
      packBytes: await buildPack([
        { type: "blob", payload: blob1Payload },
        { type: "tree", payload: tree1Payload },
        { type: "commit", payload: commit1Payload },
      ]),
    },
  ];

  await runDOWithRetry(getStub, async (_instance, state) => {
    const prefix = doPrefix(state.id.toString());
    const store = asTypedStorage<RepoStateSchema>(state.storage);
    const db = getDb(state.storage);

    for (const obj of looseObjects) {
      await store.put(objKey(obj.oid), obj.zdata);
      await env.REPO_BUCKET.put(r2LooseKey(prefix, obj.oid), obj.zdata);
    }

    let nextSeq = (await store.get("nextPackSeq")) || 1;
    for (const pack of packs) {
      const packKey = r2PackKey(prefix, pack.name);
      await env.REPO_BUCKET.put(packKey, pack.packBytes);

      const resolveResult = await indexTestPack(env, packKey, pack.packBytes.byteLength);
      const seq = nextSeq++;
      await upsertPackCatalogRow(db, {
        packKey,
        kind: "receive",
        state: "active",
        tier: 0,
        seqLo: seq,
        seqHi: seq,
        objectCount: resolveResult.objectCount,
        packBytes: pack.packBytes.byteLength,
        idxBytes: resolveResult.idxBytes,
        createdAt: Date.now(),
        supersededBy: null,
      });
    }

    const packsetVersion = ((await store.get("packsetVersion")) || 0) + 1;
    await store.put("packsetVersion", packsetVersion);
    await store.put("nextPackSeq", nextSeq);
    await store.put("refs", [{ name: "refs/heads/main", oid: commit2.oid }]);
    await store.put("head", { target: "refs/heads/main", oid: commit2.oid });
  });

  await callStubWithRetry(getStub, (stub) => stub.getActivePackCatalog());

  await runDOWithRetry(getStub, async (_instance, state) => {
    const prefix = doPrefix(state.id.toString());
    for (const obj of looseObjects) {
      await state.storage.delete(objKey(obj.oid));
      await env.REPO_BUCKET.delete(r2LooseKey(prefix, obj.oid));
    }
  });

  return {
    commit1,
    commit2,
    blob2,
    getStub,
  };
}

describe("pack-first fetch and UI", () => {
  it("serves read APIs from packs after loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-first-ui");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const { commit2, blob2 } = await seedPackedOnlyRepo(repoId);
    const api = `https://example.com/api/v1/repos/${owner}/${repo}/+`;

    // Retained raw endpoint.
    const rawRes = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/raw?oid=${encodeURIComponent(blob2.oid)}&name=hello.txt`
    );
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toBe("hello from v2\n");

    // Directory listing through the facade.
    const treeRes = await workerExports.default.fetch(`${api}/content?git_ref=main`);
    expect(treeRes.status).toBe(200);
    const treeJson = (await treeRes.json()) as {
      content?: { entries?: Array<{ name: string; type: string }> };
    };
    const names = (treeJson.content?.entries ?? []).map((e) => e.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("CLAUDE.md");

    // Blob content through the facade (base64 body).
    const blobRes = await workerExports.default.fetch(`${api}/content/hello.txt?git_ref=main`);
    expect(blobRes.status).toBe(200);
    const blobJson = (await blobRes.json()) as {
      type: string;
      content?: { encoding: string; data: string };
    };
    expect(blobJson.type).toBe("file");
    expect(atob(blobJson.content?.data ?? "")).toBe("hello from v2\n");

    // Commit metadata through the facade.
    const commitRes = await workerExports.default.fetch(`${api}/commits/${commit2.oid}`);
    expect(commitRes.status).toBe(200);
    const commitJson = (await commitRes.json()) as { title?: string; message?: string };
    expect(commitJson.title ?? commitJson.message ?? "").toContain("second commit");

    // Commit diff through the facade (unified text).
    const diffRes = await workerExports.default.fetch(`${api}/commits/${commit2.oid}/diff`);
    expect(diffRes.status).toBe(200);
    expect(await diffRes.text()).toContain("hello.txt");
  });

  it("streams fetches from multiple active packs after loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-first-fetch");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const { commit2 } = await seedPackedOnlyRepo(repoId);

    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
        body: buildFetchBody({ wants: [commit2.oid], done: true, agent: false }),
      } as RequestInit
    );

    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const packStart = findBytes(bytes, new TextEncoder().encode("PACK"));
    expect(packStart).toBeGreaterThan(-1);
  });
});
