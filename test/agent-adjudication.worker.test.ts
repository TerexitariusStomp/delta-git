import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import { buildPack, zero40 } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { callStubWithRetry, uniqueRepoId } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";
import { decodeReportStatus } from "./util/streaming-helpers";
import { writeServerPack } from "@/worker/merge/packWriter";
import { attemptMerge } from "@/worker/merge/engine";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Seed a repo and land one divergent push; returns the minted merge intent. */
async function seedDivergentRepo() {
  const owner = "o";
  const repo = uniqueRepoId("agent-adj");
  await setupRepoForTests(env, owner, repo);
  const repoId = `${owner}/${repo}`;
  const seeded = await seedPackFirstRepo(repoId);

  const author = "Agent <a@example.com> 0 +0000";
  const blobPayload = encoder.encode("divergent work\n");
  const blob = await encodeGitObject("blob", blobPayload);
  const treePayload = buildTreePayload([{ mode: "100644", name: "README.md", oid: blob.oid }]);
  const tree = await encodeGitObject("tree", treePayload);
  const commitPayload = encoder.encode(
    `tree ${tree.oid}\n` +
      `parent ${seeded.nextCommit.oid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `divergent commit\n`
  );
  const commit = await encodeGitObject("commit", commitPayload);
  const pack = await buildPack([
    { type: "blob", payload: blobPayload },
    { type: "tree", payload: treePayload },
    { type: "commit", payload: commitPayload },
  ]);

  // Stale old-oid (zero while refs/heads/main exists) — lands on refs/delta/*.
  const body = concatChunks([
    pktLine(`${zero40()} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=test\n`),
    flushPkt(),
    pack,
  ]);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-git-receive-pack-request",
  };
  const auth = lookupPushAuth(owner, repo);
  if (auth) headers.Authorization = auth;
  const response = await workerExports.default.fetch(
    `https://example.com/${owner}/${repo}/git-receive-pack`,
    { method: "POST", headers, body } as any
  );
  expect(response.status).toBe(200);
  expect(decodeReportStatus(new Uint8Array(await response.arrayBuffer()))).toContain(
    "ok refs/heads/main"
  );

  const intents = await callStubWithRetry(seeded.getStub, (stub) =>
    stub.listMergeIntents(["open"])
  );
  expect(intents.length).toBe(1);
  return { owner, repo, repoId, seeded, commit, intent: intents[0] };
}

describe("merge adjudication", () => {
  it("runs claim → adjudicating → votes → quorum with a hash-chained op log", async () => {
    const { seeded, intent } = await seedDivergentRepo();

    // Merge lease: engine claims the intent before attempting a merge.
    const claimed = await callStubWithRetry(
      seeded.getStub,
      async (stub) => await stub.claimMergeIntent(intent.id)
    );
    expect(claimed?.status).toBe("merging");

    // Merge found conflicts → intent moves to adjudication with a path list.
    const marked = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.markMergeAdjudicating({
          intentId: intent.id,
          conflicts: ["README.md"],
          actor: "merge-engine",
        })
    );
    expect(marked.status).toBe("ok");

    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const quorumK = 3;

    const vote1 = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.castMergeVote({
          intentId: intent.id,
          voterDid: "did:dg:agent-1",
          resolutionDigest: digestA,
          signature: "sig1",
          quorumK,
        })
    );
    expect(vote1.status).toBe("accepted");
    if (vote1.status === "accepted") {
      expect(vote1.seat).toBe(1);
      expect(vote1.resolved).toBe(false);
    }

    // Same voter may not take a second seat.
    const dup = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.castMergeVote({
          intentId: intent.id,
          voterDid: "did:dg:agent-1",
          resolutionDigest: digestA,
          signature: "sig1b",
          quorumK,
        })
    );
    expect(dup).toEqual({ status: "rejected", reason: "duplicate-voter" });

    const vote2 = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.castMergeVote({
          intentId: intent.id,
          voterDid: "did:dg:agent-2",
          resolutionDigest: digestB,
          signature: "sig2",
          quorumK,
        })
    );
    expect(vote2.status).toBe("accepted");
    if (vote2.status === "accepted") expect(vote2.resolved).toBe(false);

    // Third vote gives digestA a 2/3 majority → quorum reached.
    const vote3 = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.castMergeVote({
          intentId: intent.id,
          voterDid: "did:dg:hermes-3",
          resolutionDigest: digestA,
          signature: "sig3",
          quorumK,
        })
    );
    expect(vote3.status).toBe("accepted");
    if (vote3.status === "accepted") {
      expect(vote3.resolved).toBe(true);
      expect(vote3.winningDigest).toBe(digestA);
    }

    // Post-quorum the intent awaits resolution application; no more votes.
    const late = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.castMergeVote({
          intentId: intent.id,
          voterDid: "did:dg:agent-4",
          resolutionDigest: digestA,
          signature: "sig4",
          quorumK,
        })
    );
    expect(late.status).toBe("rejected");

    const resolved = await callStubWithRetry(
      seeded.getStub,
      async (stub) => await stub.getMergeIntent(intent.id)
    );
    expect(resolved?.status).toBe("conflict");

    // Replay the op log and re-verify the hash chain end to end.
    const opLog = await callStubWithRetry(seeded.getStub, async (stub) => await stub.listOpLog(-1));
    expect(opLog.length).toBeGreaterThanOrEqual(5);
    let prevHash = "genesis";
    for (const row of opLog) {
      const canonical = JSON.stringify({
        seq: row.seq,
        kind: row.kind,
        actor: row.actor ?? null,
        payload: JSON.parse(row.payload),
        createdAt: row.createdAt,
      });
      expect(row.prevHash).toBe(prevHash);
      expect(row.hash).toBe(await sha256Hex(prevHash + canonical));
      prevHash = row.hash;
    }
    const kinds = opLog.map((row) => row.kind);
    expect(kinds).toContain("push.delta");
    expect(kinds).toContain("merge.adjudicating");
    expect(kinds.filter((kind) => kind === "merge.vote").length).toBe(3);
    expect(kinds).toContain("merge.quorum");
  });

  it("commitMerge advances the target ref under CAS and rejects replays", async () => {
    const { seeded, commit, intent } = await seedDivergentRepo();
    const baseOid = seeded.nextCommit.oid;

    // Wrong expected base → base_moved, no ref change.
    const moved = await callStubWithRetry(
      seeded.getStub,
      async (stub) =>
        await stub.commitMerge({
          intentId: intent.id,
          expectedBaseOid: zero40(),
          mergeOid: commit.oid,
          stagedPack: { packKey: "unused.pack", packBytes: 0, idxBytes: 0, objectCount: 0 },
          actor: "merge-engine",
          method: "auto",
        })
    );
    expect(moved.status).toBe("base_moved");

    // Build a real merge commit (two parents: base + delta tip) and stage its
    // pack the same way the engine does.
    const author = "Merge <m@example.com> 0 +0000";
    const refs = await callStubWithRetry(seeded.getStub, async (stub) => await stub.listRefs());
    const deltaRef = refs.find((ref: { name: string }) => ref.name.startsWith("refs/delta/"));
    expect(deltaRef?.oid).toBe(commit.oid);

    // The merge commit gets a real tree; the merge payload itself is a new
    // blob+tree produced by the file-level merge.
    const blobPayload = encoder.encode("merged readme\n");
    const mergeBlob = await encodeGitObject("blob", blobPayload);
    const mergeTreePayload = buildTreePayload([
      { mode: "100644", name: "README.md", oid: mergeBlob.oid },
    ]);
    const mergeTree = await encodeGitObject("tree", mergeTreePayload);
    const mergeCommitPayload = encoder.encode(
      `tree ${mergeTree.oid}\n` +
        `parent ${baseOid}\n` +
        `parent ${commit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\n` +
        `merge delta\n`
    );
    const mergeCommit = await encodeGitObject("commit", mergeCommitPayload);

    const pack = await writeServerPack([
      { type: "blob", payload: blobPayload, oid: mergeBlob.oid },
      { type: "tree", payload: mergeTreePayload, oid: mergeTree.oid },
      { type: "commit", payload: mergeCommitPayload, oid: mergeCommit.oid },
    ]);

    const stub = seeded.getStub();
    const packKey = r2PackKey(
      doPrefix(stub.id.toString()),
      `pack-merge-${mergeCommit.oid.slice(0, 12)}.pack`
    );
    await env.REPO_BUCKET.put(packKey, pack.packBytes);
    await env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

    const committed = await callStubWithRetry(
      seeded.getStub,
      async (s) =>
        await s.commitMerge({
          intentId: intent.id,
          expectedBaseOid: baseOid,
          mergeOid: mergeCommit.oid,
          stagedPack: {
            packKey,
            packBytes: pack.packBytes.byteLength,
            idxBytes: pack.idxBytes.byteLength,
            objectCount: pack.objectCount,
          },
          actor: "merge-engine",
          method: "adjudicated",
        })
    );
    expect(committed.status).toBe("committed");

    const after = await callStubWithRetry(seeded.getStub, async (s) => await s.listRefs());
    expect(after.find((ref: { name: string }) => ref.name === "refs/heads/main")?.oid).toBe(
      mergeCommit.oid
    );
    const head = await callStubWithRetry(seeded.getStub, async (s) => await s.getHead());
    expect(head.oid).toBe(mergeCommit.oid);

    const done = await callStubWithRetry(
      seeded.getStub,
      async (s) => await s.getMergeIntent(intent.id)
    );
    expect(done?.status).toBe("merged");
    expect(done?.resultOid).toBe(mergeCommit.oid);

    // Replay protection: a merged intent is not committable again.
    const replay = await callStubWithRetry(
      seeded.getStub,
      async (s) =>
        await s.commitMerge({
          intentId: intent.id,
          expectedBaseOid: mergeCommit.oid,
          mergeOid: commit.oid,
          stagedPack: { packKey, packBytes: 1, idxBytes: 1, objectCount: 1 },
          actor: "merge-engine",
          method: "auto",
        })
    );
    expect(replay.status).toBe("intent_state");
  });
});

describe("server-side patch", () => {
  it("registers the patch pack so the auto-merge lands on the target ref", async () => {
    const owner = "o";
    const repo = uniqueRepoId("agent-patch");
    await setupRepoForTests(env, owner, repo);
    const seeded = await seedPackFirstRepo(`${owner}/${repo}`);
    const auth = lookupPushAuth(owner, repo);
    expect(auth).toBeDefined();

    // README.md is "version two\n" in the seeded head; append a line.
    const patch = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,2 @@",
      " version two",
      "+patched by an agent",
    ].join("\n");

    const response = await workerExports.default.fetch(
      `https://example.com/api/${owner}/${repo}/dg/patch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth! },
        body: JSON.stringify({ base_ref: "main", patch, message: "agent patch" }),
      } as any
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      intent: { id: string };
      merge: { kind: string; mergeOid?: string };
    };
    // The merge only succeeds if the delta objects are readable — i.e. the
    // staged patch pack made it into the DO pack catalog.
    expect(body.merge.kind).toBe("merged");

    const done = await callStubWithRetry(
      seeded.getStub,
      async (stub) => await stub.getMergeIntent(body.intent.id)
    );
    expect(done?.status).toBe("merged");
    expect(done?.resultOid).toBe(body.merge.mergeOid);

    const { refs } = await callStubWithRetry(
      seeded.getStub,
      async (stub) => await stub.getHeadAndRefs()
    );
    expect(refs.find((ref: { name: string }) => ref.name === "refs/heads/main")?.oid).toBe(
      body.merge.mergeOid
    );
  });

  it("releases the merge lease when the attempt cannot proceed", async () => {
    const owner = "o";
    const repo = uniqueRepoId("agent-release");
    await setupRepoForTests(env, owner, repo);
    const seeded = await seedPackFirstRepo(`${owner}/${repo}`);
    const stub = seeded.getStub();

    // Mint an intent whose delta objects were never staged — the historical
    // missing-stagedPack path that wedged intents in `merging` forever.
    const accepted = await callStubWithRetry(
      seeded.getStub,
      async (s) =>
        await s.acceptPatchCommit({
          targetRef: "refs/heads/main",
          newOid: "1".repeat(40),
          actor: "test",
          kind: "push.patch",
        })
    );
    expect(accepted.status).toBe("accepted");

    const repoId = `${owner}/${repo}`;
    const result = await attemptMerge({
      env,
      repoId,
      stub,
      intentId: accepted.intent.id,
      actor: "test",
    });
    expect(result).toEqual({ kind: "skipped", reason: "missing-commit-objects" });

    // The lease was released: the intent is open again and re-claimable.
    const after = await callStubWithRetry(
      seeded.getStub,
      async (s) => await s.getMergeIntent(accepted.intent.id)
    );
    expect(after?.status).toBe("open");
    const reclaimed = await callStubWithRetry(
      seeded.getStub,
      async (s) => await s.claimMergeIntent(accepted.intent.id)
    );
    expect(reclaimed?.status).toBe("merging");
  });
});
