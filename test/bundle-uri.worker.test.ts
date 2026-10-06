import { describe, it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { pktLine, flushPkt, concatChunks } from "@/worker/git";
import { uniqueRepoId, runDOWithRetry } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { ensureD1Migrations } from "./util/d1Setup";

// protocol-v2 bundle-uri: capability advertisement, the bundle-uri command,
// and the plain-GET bundle download (GIT BUNDLE V3 header + refs + PACK).

function bundleUriRequest() {
  return concatChunks([pktLine("command=bundle-uri\n"), flushPkt()]);
}

async function postUploadPack(owner: string, repo: string, body: Uint8Array) {
  return await workerExports.default.fetch(`https://example.com/${owner}/${repo}/git-upload-pack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
    },
    body,
  });
}

describe("bundle-uri", () => {
  it("advertises the bundle-uri capability in the v2 advertisement", async () => {
    await ensureD1Migrations(env);
    const owner = "o";
    const repo = uniqueRepoId("rb");
    await setupRepoForTests(env, owner, repo);

    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/info/refs?service=git-upload-pack`
    );
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).toContain("bundle-uri\n");
  });

  it("answers command=bundle-uri with a baseline entry", async () => {
    const owner = "o";
    const repo = uniqueRepoId("rb");
    const seeded = await setupRepoForTests(env, owner, repo);
    const id = env.REPO_DO.idFromName(`${owner}/${repo}`);
    await runDOWithRetry(
      () => env.REPO_DO.get(id),
      async (instance) => instance.seedMinimalRepo()
    );
    void seeded;

    const res = await postUploadPack(owner, repo, bundleUriRequest());
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).toContain("bundle.version=3\n");
    expect(text).toContain("bundle.mode=all\n");
    expect(text).toContain("bundle.baseline.uri=https://example.com/");
    expect(text).toContain("/bundle/");
    expect(text).toContain("bundle.baseline.creationToken=");
  });

  it("serves a GIT BUNDLE V3 stream with refs and a pack over plain GET", async () => {
    const owner = "o";
    const repo = uniqueRepoId("rb");
    await setupRepoForTests(env, owner, repo);
    const id = env.REPO_DO.idFromName(`${owner}/${repo}`);
    await runDOWithRetry(
      () => env.REPO_DO.get(id),
      async (instance) => instance.seedMinimalRepo()
    );

    const listRes = await postUploadPack(owner, repo, bundleUriRequest());
    const listText = new TextDecoder().decode(await listRes.arrayBuffer());
    const uriLine = listText.split("\n").find((l) => l.includes("bundle.baseline.uri="))!;
    const uri = uriLine
      .split("bundle.baseline.uri=")[1]!
      .split("\n")[0]!
      .replace(/[^\x20-\x7e]/g, "")
      .trim();
    expect(uri.startsWith("https://example.com/")).toBe(true);

    const bundleRes = await workerExports.default.fetch(uri);
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.headers.get("Content-Type")).toBe("application/x-git-bundle");
    const bytes = new Uint8Array(await bundleRes.arrayBuffer());
    const text = new TextDecoder().decode(bytes.subarray(0, 4096));
    expect(text.startsWith("GIT BUNDLE V3\n")).toBe(true);
    expect(text).toContain("refs/heads/");
    // The packfile signature follows the ref header.
    const packIdx = new TextDecoder().decode(bytes).indexOf("PACK");
    expect(packIdx).toBeGreaterThan(0);
  });

  it("returns an empty bundle list for a repository with no refs", async () => {
    const owner = "o";
    const repo = uniqueRepoId("rb");
    await setupRepoForTests(env, owner, repo);
    // No seed — zero refs.
    const res = await postUploadPack(owner, repo, bundleUriRequest());
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).not.toContain("bundle.baseline");
  });
});
