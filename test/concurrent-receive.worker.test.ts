// Concurrent receive coverage — the "never reject a push" contract under
// real concurrency. Multiple receives may stage at once (bounded by
// MAX_CONCURRENT_RECEIVES); finalize stays serialized inside the DO, and
// same-branch races resolve through the divergence planner instead of a
// 503.

import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import type { BeginReceiveResult } from "@/worker/do/repo/catalog/shared";
import type { FinalizeReceiveResult } from "@/worker/do/repo/catalog/receive";
import { buildPack, zero40 } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { callStubWithRetry, uniqueRepoId } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";
import { decodeReportStatus, promoteToStreaming } from "./util/streaming-helpers";

const PUSH_URL_BASE = "https://example.com";

/**
 * Push one commit `<parentOid> → <ref>` carrying a README with `text`,
 * through the real HTTP path. Returns the response and the commit oid.
 */
async function pushCommit(args: {
  owner: string;
  repo: string;
  ref: string;
  parentOid: string;
  /** Expected old oid for the command — `zero40` when creating a ref. */
  oldOid?: string;
  text: string;
}): Promise<{ response: Response; commitOid: string }> {
  const author = "You <you@example.com> 0 +0000";
  const blobPayload = new TextEncoder().encode(args.text);
  const blob = await encodeGitObject("blob", blobPayload);
  const treePayload = buildTreePayload([{ mode: "100644", name: "README.md", oid: blob.oid }]);
  const tree = await encodeGitObject("tree", treePayload);
  const commitPayload = new TextEncoder().encode(
    `tree ${tree.oid}\n` +
      `parent ${args.parentOid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `${args.text}\n`
  );
  const commit = await encodeGitObject("commit", commitPayload);
  const pack = await buildPack([
    { type: "blob", payload: blobPayload },
    { type: "tree", payload: treePayload },
    { type: "commit", payload: commitPayload },
  ]);
  const response = await workerExports.default.fetch(
    `${PUSH_URL_BASE}/${args.owner}/${args.repo}/git-receive-pack`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        Authorization: lookupPushAuth(args.owner, args.repo),
      },
      body: concatChunks([
        pktLine(
          `${args.oldOid ?? args.parentOid} ${commit.oid} ${args.ref}\0 report-status ofs-delta agent=test\n`
        ),
        flushPkt(),
        pack,
      ]),
    } as any
  );
  return { response, commitOid: commit.oid };
}

describe("concurrent receive", () => {
  it("lands two simultaneous pushes to distinct branches", async () => {
    const owner = "o";
    const repo = uniqueRepoId("cc-branches");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await promoteToStreaming(owner, repo);

    const [a, b] = await Promise.all([
      pushCommit({
        owner,
        repo,
        ref: "refs/heads/branch-a",
        oldOid: zero40(),
        parentOid: seeded.nextCommit.oid,
        text: "branch a\n",
      }),
      pushCommit({
        owner,
        repo,
        ref: "refs/heads/branch-b",
        oldOid: zero40(),
        parentOid: seeded.nextCommit.oid,
        text: "branch b\n",
      }),
    ]);

    for (const push of [a, b]) {
      expect(push.response.status).toBe(200);
      const lines = decodeReportStatus(new Uint8Array(await push.response.arrayBuffer()));
      expect(lines.some((line) => line.startsWith("ok "))).toBe(true);
    }

    const refs = await callStubWithRetry(seeded.getStub, (stub) => stub.listRefs());
    expect(refs.find((ref: { name: string }) => ref.name === "refs/heads/branch-a")?.oid).toBe(
      a.commitOid
    );
    expect(refs.find((ref: { name: string }) => ref.name === "refs/heads/branch-b")?.oid).toBe(
      b.commitOid
    );
  });

  it("converges two simultaneous pushes to the same branch — one advances, one becomes a merge intent, neither is rejected", async () => {
    const owner = "o";
    const repo = uniqueRepoId("cc-same-branch");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await promoteToStreaming(owner, repo);

    const [a, b] = await Promise.all([
      pushCommit({
        owner,
        repo,
        ref: "refs/heads/main",
        parentOid: seeded.nextCommit.oid,
        text: "racer one\n",
      }),
      pushCommit({
        owner,
        repo,
        ref: "refs/heads/main",
        parentOid: seeded.nextCommit.oid,
        text: "racer two\n",
      }),
    ]);

    // Both report success — the loser is rewritten to a delta ref.
    for (const push of [a, b]) {
      expect(push.response.status).toBe(200);
    }

    const refs = await callStubWithRetry(seeded.getStub, (stub) => stub.listRefs());
    const headRef = refs.find((ref: { name: string }) => ref.name === "refs/heads/main");
    const deltaRefs = refs.filter((ref: { name: string }) => ref.name.startsWith("refs/delta/"));
    const winner = headRef?.oid;
    expect([a.commitOid, b.commitOid]).toContain(winner);
    // The loser's commit still landed, under refs/delta/*.
    const loserOid = winner === a.commitOid ? b.commitOid : a.commitOid;
    expect(deltaRefs.map((ref: { oid: string }) => ref.oid)).toContain(loserOid);

    const intents = await callStubWithRetry(seeded.getStub, (stub) =>
      stub.listMergeIntents(["open"])
    );
    expect(intents.length).toBeGreaterThanOrEqual(1);
  });

  it("a ninth concurrent receive waits in line and commits once a lease frees", async () => {
    const owner = "o";
    const repo = uniqueRepoId("cc-queue");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await promoteToStreaming(owner, repo);

    // Occupy all 8 slots with live leases.
    const heldTokens: string[] = [];
    for (let i = 0; i < 8; i++) {
      const begin = await callStubWithRetry<BeginReceiveResult>(seeded.getStub, (stub) =>
        stub.beginReceive()
      );
      if (!begin.ok) throw new Error(`lease ${i} not granted`);
      heldTokens.push(begin.lease.token);
    }

    const push = pushCommit({
      owner,
      repo,
      ref: "refs/heads/waited",
      oldOid: zero40(),
      parentOid: seeded.nextCommit.oid,
      text: "waited in line\n",
    });

    // Give the waiter a moment in its backoff loop, then free a slot.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await callStubWithRetry(seeded.getStub, (stub) => stub.abortReceive(heldTokens[0]));

    const { response, commitOid } = await push;
    expect(response.status).toBe(200);

    const refs = await callStubWithRetry(seeded.getStub, (stub) => stub.listRefs());
    expect(refs.find((ref: { name: string }) => ref.name === "refs/heads/waited")?.oid).toBe(
      commitOid
    );

    for (const token of heldTokens.slice(1)) {
      await callStubWithRetry(seeded.getStub, (stub) => stub.abortReceive(token));
    }
  });

  it("releases only the finalized lease — sibling receives survive another's commit", async () => {
    const owner = "o";
    const repo = uniqueRepoId("cc-siblings");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await promoteToStreaming(owner, repo);

    // Hold a lease while a normal push commits — the sibling's lease must
    // still be valid afterwards.
    const begin = await callStubWithRetry<BeginReceiveResult>(seeded.getStub, (stub) =>
      stub.beginReceive()
    );
    if (!begin.ok) throw new Error("lease not granted");

    const { response } = await pushCommit({
      owner,
      repo,
      ref: "refs/heads/main",
      parentOid: seeded.nextCommit.oid,
      text: "sibling push\n",
    });
    expect(response.status).toBe(200);

    const activity = await callStubWithRetry(seeded.getStub, (stub) => stub.getRepoActivity());
    expect(activity?.state).toBe("receiving");

    await callStubWithRetry(seeded.getStub, (stub) => stub.abortReceive(begin.lease.token));
    const after = await callStubWithRetry(seeded.getStub, (stub) => stub.getRepoActivity());
    expect(after?.state).not.toBe("receiving");
  });

  it("rejects a finalize carrying a token that isn't a live lease", async () => {
    const owner = "o";
    const repo = uniqueRepoId("cc-bad-token");
    await setupRepoForTests(env, owner, repo);
    const repoId = `${owner}/${repo}`;
    const seeded = await seedPackFirstRepo(repoId);
    await promoteToStreaming(owner, repo);

    const result = await callStubWithRetry<FinalizeReceiveResult>(seeded.getStub, async (stub) =>
      stub.finalizeReceive({
        token: "not-a-real-lease",
        commands: [{ oldOid: zero40(), newOid: seeded.nextCommit.oid, ref: "refs/heads/main" }],
      })
    );
    expect(result.status).toBe("lease_mismatch");
  });
});
