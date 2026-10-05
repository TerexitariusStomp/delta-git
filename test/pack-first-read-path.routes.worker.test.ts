import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { asTypedStorage, type RepoStateSchema } from "@/worker/do/repo/repoState";
import { computeNeededFast } from "@/worker/git/operations/fetch/neededFast";
import {
  deleteLooseObjectCopies,
  runDOWithRetry,
  toRequestBody,
  uniqueRepoId,
} from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { buildFetchBody, decodePktTextLines } from "./util/fetch-protocol";
import { seedPackFirstRepo } from "./util/pack-first";

describe("pack-first read path routes", () => {
  it("serves fetch and UI routes after deleting all loose object copies", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-read-path");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);

    await deleteLooseObjectCopies(env, seeded.getStub, seeded.objectOids);

    const needed = await computeNeededFast(
      env,
      repoId,
      [seeded.nextCommit.oid],
      [seeded.baseCommit.oid]
    );
    expect(new Set(needed)).toEqual(
      new Set([seeded.nextCommit.oid, seeded.nextTree.oid, seeded.nextBlob.oid])
    );

    const ackResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
        body: toRequestBody(
          buildFetchBody({
            wants: [seeded.nextCommit.oid],
            haves: [seeded.baseCommit.oid],
          })
        ),
      }
    );
    expect(ackResponse.status).toBe(200);
    const ackLines = decodePktTextLines(new Uint8Array(await ackResponse.arrayBuffer()));
    expect(ackLines).toContain(`ACK ${seeded.baseCommit.oid} ready`);

    const fetchResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-upload-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
        body: toRequestBody(
          buildFetchBody({
            wants: [seeded.nextCommit.oid],
            haves: [seeded.baseCommit.oid],
            done: true,
          })
        ),
      }
    );
    expect(fetchResponse.status).toBe(200);
    const fetchBytes = new Uint8Array(await fetchResponse.arrayBuffer());
    expect(new TextDecoder().decode(fetchBytes.subarray(4, 13))).toBe("packfile\n");

    const api = `https://example.com/api/v1/repos/${owner}/${repo}/+`;

    const treeResponse = await workerExports.default.fetch(`${api}/content?git_ref=main`);
    expect(treeResponse.status).toBe(200);
    const treeJson = (await treeResponse.json()) as {
      content?: { entries?: Array<{ name: string }> };
    };
    expect((treeJson.content?.entries ?? []).map((e) => e.name)).toContain("README.md");

    const blobResponse = await workerExports.default.fetch(`${api}/content/README.md?git_ref=main`);
    expect(blobResponse.status).toBe(200);
    const blobJson = (await blobResponse.json()) as {
      content?: { encoding: string; data: string };
    };
    expect(atob(blobJson.content?.data ?? "")).toContain("version two");

    const rawResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/raw?oid=${seeded.nextBlob.oid}&name=README.md`
    );
    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.text()).toBe("version two\n");

    const commitResponse = await workerExports.default.fetch(
      `${api}/commits/${seeded.nextCommit.oid}`
    );
    expect(commitResponse.status).toBe(200);
    const commitJson = (await commitResponse.json()) as { title?: string; message?: string };
    expect(commitJson.title ?? commitJson.message ?? "").toContain("second commit");

    const diffResponse = await workerExports.default.fetch(
      `${api}/commits/${seeded.nextCommit.oid}/diff`
    );
    expect(diffResponse.status).toBe(200);
    const diffText = await diffResponse.text();
    expect(diffText).toContain("-version one");
    expect(diffText).toContain("+version two");
  });

  it("keeps admin debug endpoints on the shared DO contract after loose copies are deleted", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-debug-contract");
    const seededRepo = await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await deleteLooseObjectCopies(env, seeded.getStub, seeded.objectOids);

    const commitResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/debug-commit/${seeded.nextCommit.oid}`,
      { headers: { Cookie: seededRepo.cookieHeader } }
    );
    expect(commitResponse.status).toBe(200);
    const commitJson = (await commitResponse.json()) as {
      commit?: { oid?: string; tree?: string; parents?: string[] };
      presence?: {
        hasLooseCommit?: boolean;
        hasLooseTree?: boolean;
        hasR2LooseTree?: boolean;
      };
      membership?: Record<string, { hasCommit?: boolean; hasTree?: boolean }>;
      inPacks?: unknown;
    };
    expect(commitJson.commit?.oid).toBe(seeded.nextCommit.oid);
    expect(commitJson.commit?.tree).toBe(seeded.nextTree.oid);
    expect(commitJson.presence?.hasLooseCommit).toBe(false);
    expect(commitJson.presence?.hasLooseTree).toBe(false);
    expect(commitJson.presence?.hasR2LooseTree).toBe(false);
    expect(commitJson.membership?.[seeded.packKeys[0]]).toEqual({
      hasCommit: true,
      hasTree: true,
    });
    expect(commitJson.inPacks).toBeUndefined();

    const oidResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/debug-oid/${seeded.nextBlob.oid}`,
      { headers: { Cookie: seededRepo.cookieHeader } }
    );
    expect(oidResponse.status).toBe(200);
    const oidJson = (await oidResponse.json()) as {
      oid?: string;
      presence?: { hasLoose?: boolean; hasR2Loose?: boolean; hasPacked?: boolean };
      inPacks?: string[];
    };
    expect(oidJson.oid).toBe(seeded.nextBlob.oid);
    expect(oidJson.presence?.hasLoose).toBe(false);
    expect(oidJson.presence?.hasR2Loose).toBe(false);
    expect(oidJson.presence?.hasPacked).toBeUndefined();
    expect(oidJson.inPacks).toEqual([seeded.packKeys[0]]);
  });

  it("exposes pack catalog state through the admin debug endpoint", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-admin-refs-sidecar");
    const seededRepo = await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    const packKey = seeded.packKeys[0];
    if (!packKey) throw new Error("missing seeded pack key");

    // The SSR admin page is retired; /admin/debug-state carries the same
    // DO-sourced catalog data for members.
    const stateResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/debug-state`,
      { headers: { Cookie: seededRepo.cookieHeader } }
    );
    expect(stateResponse.status).toBe(200);
    const stateJson = (await stateResponse.json()) as {
      activePacks?: Array<{ key: string }>;
    };
    expect(stateJson.activePacks?.map((p) => p.key)).toContain(packKey);
  });

  it("rejects deleting an active pack through the admin route", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-delete-guard");
    const seededRepo = await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    const activePackName = seeded.packKeys[0]?.split("/").pop();
    if (!activePackName) throw new Error("missing active pack name");

    const stateResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/debug-state`,
      { headers: { Cookie: seededRepo.cookieHeader } }
    );
    expect(stateResponse.status).toBe(200);
    const stateJson = (await stateResponse.json()) as {
      activePacks?: Array<{ key: string }>;
      packCatalogVersion?: number;
    };
    expect(stateJson.activePacks?.[0]?.key).toBe(seeded.packKeys[0]);
    expect(typeof stateJson.packCatalogVersion).toBe("number");

    const deleteResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/pack/${encodeURIComponent(activePackName)}`,
      {
        method: "DELETE",
        headers: { Cookie: seededRepo.cookieHeader, Origin: "https://example.com" },
      }
    );
    expect(deleteResponse.status).toBe(409);
    const deleteJson = (await deleteResponse.json()) as { error?: string; rejected?: string };
    expect(deleteJson.rejected).toBe("active-pack");
    expect(deleteJson.error).toContain("Active packs");
  });

  it("rejects deleting a pack that is not superseded", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-delete-non-superseded");
    const seededRepo = await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    await seedPackFirstRepo(repoId);

    const deleteResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/pack/${encodeURIComponent("pack-missing.pack")}`,
      {
        method: "DELETE",
        headers: { Cookie: seededRepo.cookieHeader, Origin: "https://example.com" },
      }
    );
    expect(deleteResponse.status).toBe(409);
    const deleteJson = (await deleteResponse.json()) as {
      error?: string;
      rejected?: string;
      packState?: string;
    };
    expect(deleteJson.rejected).toBe("non-superseded-pack");
    expect(deleteJson.packState).toBe("unknown");
    expect(deleteJson.error).toContain("Only superseded packs");
  });

  it("exposes the active receive lease through the admin debug endpoint", async () => {
    const owner = "o";
    const repo = uniqueRepoId("pack-admin-receiving");
    const seededRepo = await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);

    await runDOWithRetry(seeded.getStub, async (_instance, state) => {
      const store = asTypedStorage<RepoStateSchema>(state.storage);
      const now = Date.now();
      await store.put("receiveLease", {
        token: "test-receive-lease",
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });

    const response = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/debug-state`,
      { headers: { Cookie: seededRepo.cookieHeader } }
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      receiveLease?: { token: string };
    };
    expect(json.receiveLease?.token).toBe("test-receive-lease");
  });
});
