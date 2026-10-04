import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { readObject } from "@/worker/git/object-store/store";
import { importRemoteRepo, type GitFetch } from "@/worker/agent/importer";
import { callStubWithRetry, uniqueRepoId } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo, createTestCacheContext } from "./util/pack-first";

/** Fetch shim that routes remote git traffic through the worker under test. */
function workerFetch(authHeader?: string): GitFetch {
  return async (input, init) => {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };
    if (authHeader && !headers.Authorization) headers.Authorization = authHeader;
    return await workerExports.default.fetch(input, { ...init, headers } as any);
  };
}

describe("repo importer", () => {
  it("clones a remote over smart-HTTP v2 into an empty repo", async () => {
    const owner = "o";
    const srcRepo = uniqueRepoId("import-src");
    const dstRepo = uniqueRepoId("import-dst");
    await setupRepoForTests(env, owner, srcRepo);
    await setupRepoForTests(env, owner, dstRepo);
    const srcId = `${owner}/${srcRepo}`;
    const dstId = `${owner}/${dstRepo}`;
    const seeded = await seedPackFirstRepo(srcId);

    const dstDoId = env.REPO_DO.idFromName(dstId);
    const dstStub = env.REPO_DO.get(dstDoId);

    const outcome = await importRemoteRepo({
      env,
      repoId: dstId,
      stub: dstStub,
      url: `https://example.com/${srcId}`,
      actor: "test-importer",
      cacheCtx: createTestCacheContext("https://example.com/import"),
      fetcher: workerFetch(lookupPushAuth(owner, srcRepo)),
    });
    expect(outcome.kind).toBe("imported");

    const refs = await callStubWithRetry(
      () => dstStub,
      async (stub) => await stub.listRefs()
    );
    const main = refs.find((ref) => ref.name === "refs/heads/main");
    expect(main?.oid).toBe(seeded.nextCommit.oid);
    const head = await callStubWithRetry(
      () => dstStub,
      async (stub) => await stub.getHead()
    );
    expect(head.oid).toBe(seeded.nextCommit.oid);

    // Objects are readable through the pack-first store.
    const obj = await readObject(env, dstId, seeded.nextCommit.oid, undefined);
    expect(obj?.type).toBe("commit");

    const opLog = await callStubWithRetry(
      () => dstStub,
      async (stub) => await stub.listOpLog(-1)
    );
    expect(opLog.some((entry) => entry.kind === "repo.import")).toBe(true);

    // Second import into the same repo is refused — imports can't clobber.
    const again = await importRemoteRepo({
      env,
      repoId: dstId,
      stub: dstStub,
      url: `https://example.com/${srcId}`,
      actor: "test-importer",
      cacheCtx: createTestCacheContext("https://example.com/import2"),
      fetcher: workerFetch(lookupPushAuth(owner, srcRepo)),
    });
    expect(again.kind).toBe("not_empty");
  });

  it("rejects non-https and blocked hosts before touching the remote", async () => {
    const dstDoId = env.REPO_DO.idFromName("o/import-blocked");
    const dstStub = env.REPO_DO.get(dstDoId);
    for (const url of [
      "http://example.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "not-a-url",
    ]) {
      const outcome = await importRemoteRepo({
        env,
        repoId: "o/import-blocked",
        stub: dstStub,
        url,
        actor: "test",
        fetcher: workerFetch(),
      });
      expect(outcome.kind).toBe("failed");
    }
  });
});
