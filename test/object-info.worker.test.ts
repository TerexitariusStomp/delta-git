import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { concatChunks, delimPkt, flushPkt, pktLine } from "@/worker/git/core";
import { computeOid, encodeGitObject } from "@/worker/git/core/objects";
import { decodePktLinePayloads } from "./util/fetch-protocol";
import { buildAppendOnlyDelta, buildPack } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { toRequestBody, uniqueRepoId } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";

function buildObjectInfoBody(oids: string[]): Uint8Array {
  return concatChunks([
    pktLine("command=object-info\n"),
    pktLine("size\n"),
    delimPkt(),
    ...oids.map((oid) => pktLine(`oid ${oid}\n`)),
    flushPkt(),
  ]);
}

async function postObjectInfo(owner: string, repo: string, body: Uint8Array): Promise<Response> {
  return await workerExports.default.fetch(`https://example.com/${owner}/${repo}/git-upload-pack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-upload-pack-request",
      "Git-Protocol": "version=2",
    },
    body: toRequestBody(body),
  });
}

describe("upload-pack object-info", () => {
  it("returns inflated sizes for queried objects", async () => {
    const owner = "o";
    const repo = uniqueRepoId("objinfo-basic");
    await setupRepoForTests(env, owner, repo);
    const seeded = await seedPackFirstRepo(`${owner}/${repo}`);

    const response = await postObjectInfo(
      owner,
      repo,
      buildObjectInfoBody([seeded.nextBlob.oid, seeded.nextTree.oid])
    );
    expect(response.status).toBe(200);
    const lines = decodePktLinePayloads(new Uint8Array(await response.arrayBuffer()));
    expect(lines[0]).toBe("size\n");
    // "version two\n" is the seeded blob payload.
    expect(lines).toContain(`${seeded.nextBlob.oid} 12\n`);
    const treeLine = lines.find((line) => line.startsWith(`${seeded.nextTree.oid} `));
    expect(treeLine).toBeTruthy();
    expect(Number(treeLine!.split(" ")[1])).toBeGreaterThan(0);
  });

  it("reports the resolved result size for a deltified object", async () => {
    const owner = "o";
    const repo = uniqueRepoId("objinfo-delta");
    await setupRepoForTests(env, owner, repo);
    const seeded = await seedPackFirstRepo(`${owner}/${repo}`);

    // Push a pack whose blob is stored as a ref-delta against the seeded
    // blob — object-info must report the resolved result size, not the
    // delta's stored entry size.
    const basePayload = new TextEncoder().encode("version two\n");
    const suffix = new TextEncoder().encode("delta tail\n");
    const delta = buildAppendOnlyDelta(basePayload, suffix);
    const blobPayload = concatChunks([basePayload, suffix]);
    const blobOid = await computeOid("blob", blobPayload);
    const treePayload = buildTreePayload([{ mode: "100644", name: "README.md", oid: blobOid }]);
    const tree = await encodeGitObject("tree", treePayload);
    const author = "You <you@example.com> 0 +0000";
    const commitPayload = new TextEncoder().encode(
      `tree ${tree.oid}\n` +
        `parent ${seeded.nextCommit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\n` +
        `delta push\n`
    );
    const commit = await encodeGitObject("commit", commitPayload);
    const pack = await buildPack([
      { type: "ref-delta", baseOid: seeded.nextBlob.oid, delta },
      { type: "tree", payload: treePayload },
      { type: "commit", payload: commitPayload },
    ]);

    const pushResponse = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: lookupPushAuth(owner, repo)!,
        },
        body: toRequestBody(
          concatChunks([
            pktLine(
              `${seeded.nextCommit.oid} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=test\n`
            ),
            flushPkt(),
            pack,
          ])
        ),
      } as any
    );
    expect(pushResponse.status).toBe(200);

    const response = await postObjectInfo(owner, repo, buildObjectInfoBody([blobOid]));
    expect(response.status).toBe(200);
    const lines = decodePktLinePayloads(new Uint8Array(await response.arrayBuffer()));
    expect(lines).toContain(`${blobOid} ${blobPayload.byteLength}\n`);
  });

  it("advertises object-info in the v2 capability list", async () => {
    const owner = "o";
    const repo = uniqueRepoId("objinfo-adv");
    const seeded = await setupRepoForTests(env, owner, repo);
    await seedPackFirstRepo(`${owner}/${repo}`);

    const url = new URL(`https://example.com/${owner}/${repo}/info/refs`);
    url.searchParams.set("service", "git-upload-pack");
    const response = await workerExports.default.fetch(
      new Request(url, { headers: { Authorization: seeded.pushAuthHeader } })
    );
    expect(response.status).toBe(200);
    const lines = decodePktLinePayloads(new Uint8Array(await response.arrayBuffer()));
    expect(lines).toContain("object-info\n");
  });

  it("fails the request with ERR when an oid is unknown", async () => {
    const owner = "o";
    const repo = uniqueRepoId("objinfo-missing");
    await setupRepoForTests(env, owner, repo);
    await seedPackFirstRepo(`${owner}/${repo}`);

    const missing = "ab".repeat(20);
    const response = await postObjectInfo(owner, repo, buildObjectInfoBody([missing]));
    expect(response.status).toBe(200);
    const lines = decodePktLinePayloads(new Uint8Array(await response.arrayBuffer()));
    expect(lines.some((line) => line.startsWith("ERR object-info:"))).toBe(true);
  });
});
