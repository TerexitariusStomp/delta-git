/**
 * Git LFS batch API + object transfer over R2.
 *
 * Covers the wire contract `git lfs push`/`git lfs pull` exercise:
 * POST /info/lfs/objects/batch negotiates same-origin hrefs, PUT/GET
 * `/info/lfs/objects/{oid}` move the bytes, and the push/pull gates match
 * the smart-HTTP transport (push creds to write, anonymous read on public).
 */
import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { setupRepoForTests } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

const CONTENT = new TextEncoder().encode("fake large object payload — lfs test");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function batchReq(
  owner: string,
  repo: string,
  operation: "upload" | "download",
  objects: { oid: string; size: number }[],
  authHeader?: string
) {
  return workerExports.default.fetch(`https://t/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.git-lfs+json",
      Accept: "application/vnd.git-lfs+json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ operation, transfers: ["basic"], objects }),
  });
}

type BatchResp = {
  objects: {
    oid: string;
    size: number;
    actions?: { upload?: { href: string }; download?: { href: string } };
    error?: { code: number; message: string };
  }[];
};

describe("Git LFS", () => {
  it("batch upload → PUT → batch download → GET round-trips the object", async () => {
    const repo = uniqueRepoId("lfs");
    const seeded = await setupRepoForTests(env, "lfs-ns", repo);
    const oid = await sha256Hex(CONTENT);

    // 1. Batch upload negotiation.
    const up = await batchReq(
      seeded.namespaceSlug,
      seeded.repoSlug,
      "upload",
      [{ oid, size: CONTENT.byteLength }],
      seeded.pushAuthHeader
    );
    expect(up.status).toBe(200);
    expect(up.headers.get("Content-Type")).toContain("application/vnd.git-lfs");
    const upBody = (await up.json()) as BatchResp;
    const uploadHref = upBody.objects[0]?.actions?.upload?.href;
    expect(uploadHref).toMatch(/info\/lfs\/objects\/[0-9a-f]{64}$/);

    // 2. PUT the bytes to the negotiated href (same-origin path only).
    const put = await workerExports.default.fetch(`https://t${new URL(uploadHref!).pathname}`, {
      method: "PUT",
      headers: { Authorization: seeded.pushAuthHeader, "Content-Type": "application/octet-stream" },
      body: CONTENT,
    });
    expect(put.status).toBe(200);

    // 3. Re-batching the same oid reports no upload action (already stored).
    const again = await batchReq(
      seeded.namespaceSlug,
      seeded.repoSlug,
      "upload",
      [{ oid, size: CONTENT.byteLength }],
      seeded.pushAuthHeader
    );
    const againBody = (await again.json()) as BatchResp;
    expect(againBody.objects[0]?.actions).toBeUndefined();

    // 4. Batch download — anonymous on a public repo.
    const down = await batchReq(seeded.namespaceSlug, seeded.repoSlug, "download", [
      { oid, size: CONTENT.byteLength },
    ]);
    expect(down.status).toBe(200);
    const downBody = (await down.json()) as BatchResp;
    const downloadHref = downBody.objects[0]?.actions?.download?.href;
    expect(downloadHref).toMatch(/info\/lfs\/objects\/[0-9a-f]{64}$/);

    // 5. GET the bytes back.
    const get = await workerExports.default.fetch(`https://t${new URL(downloadHref!).pathname}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(CONTENT);
  });

  it("rejects a PUT whose body does not hash to the oid", async () => {
    const repo = uniqueRepoId("lfs");
    const seeded = await setupRepoForTests(env, "lfs-ns", repo);
    const wrong = await sha256Hex(new TextEncoder().encode("different bytes"));

    const put = await workerExports.default.fetch(
      `https://t/${seeded.namespaceSlug}/${repo}.git/info/lfs/objects/${wrong}`,
      {
        method: "PUT",
        headers: {
          Authorization: seeded.pushAuthHeader,
          "Content-Type": "application/octet-stream",
        },
        body: CONTENT,
      }
    );
    expect(put.status).toBe(422);
  });

  it("requires push credentials for upload batch on a public repo", async () => {
    const repo = uniqueRepoId("lfs");
    const seeded = await setupRepoForTests(env, "lfs-ns", repo);
    const oid = await sha256Hex(CONTENT);

    const res = await batchReq(seeded.namespaceSlug, repo, "upload", [
      { oid, size: CONTENT.byteLength },
    ]);
    // Same gate as receive-pack discovery: anonymous pushes get challenged.
    expect(res.status).toBe(401);
  });

  it("reports a 404 object error for missing downloads", async () => {
    const repo = uniqueRepoId("lfs");
    const seeded = await setupRepoForTests(env, "lfs-ns", repo);
    const oid = await sha256Hex(CONTENT);

    const res = await batchReq(seeded.namespaceSlug, repo, "download", [
      { oid, size: CONTENT.byteLength },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResp;
    expect(body.objects[0]?.error?.code).toBe(404);
  });
});
