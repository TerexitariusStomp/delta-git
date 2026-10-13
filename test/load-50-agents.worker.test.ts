// 50-agent load profile — the "never reject a push" contract at real
// concurrency. Phase A fans 40 agents onto distinct branches (parallel
// landing through the multi-lease pool). Phase B races 10 agents onto the
// same branch: one wins, nine are rewritten to delta refs + merge intents
// — zero rejections. Wall time and per-push latency are printed for
// docs/ops.md.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { pushCommit, zero40 } from "./util/git-push";
import { callStubWithRetry, uniqueRepoId } from "./util/test-helpers";
import { setupRepoForTests } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";
import { decodeReportStatus, promoteToStreaming } from "./util/streaming-helpers";

interface TimedPush {
  ms: number;
  status: number;
  ok: boolean;
  commitOid: string;
}

async function timedPush(args: Parameters<typeof pushCommit>[0]): Promise<TimedPush> {
  const t0 = performance.now();
  const { response, commitOid } = await pushCommit(args);
  const ms = performance.now() - t0;
  const body = new Uint8Array(await response.arrayBuffer());
  const lines = decodeReportStatus(body);
  return { ms, status: response.status, ok: lines.some((l) => l.startsWith("ok ")), commitOid };
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

describe("load: 50 concurrent agents", () => {
  it(
    "40 parallel branch pushes land, 10 same-branch racers produce intents, none rejected",
    { timeout: 120_000 },
    async () => {
      const owner = "load";
      const repo = uniqueRepoId("load50");
      await setupRepoForTests(env, owner, repo);
      const seeded = await seedPackFirstRepo(`${owner}/${repo}`);
      await promoteToStreaming(owner, repo);
      const parent = seeded.nextCommit.oid;

      // Phase A — 40 agents, distinct branches.
      const tA = performance.now();
      const branchPushes = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          timedPush({
            owner,
            repo,
            ref: `refs/heads/agent-${i}`,
            oldOid: zero40(),
            parentOid: parent,
            text: `agent ${i} branch\n`,
          })
        )
      );
      const wallA = performance.now() - tA;

      const rejectedA = branchPushes.filter((r) => r.status !== 200 || !r.ok);
      expect(
        rejectedA.map((r) => r.status),
        `${rejectedA.length} rejected pushes in phase A`
      ).toEqual([]);

      // Phase B — 10 agents, same branch.
      const tB = performance.now();
      const racers = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          timedPush({
            owner,
            repo,
            ref: "refs/heads/main",
            parentOid: parent,
            text: `racer ${i}\n`,
          })
        )
      );
      const wallB = performance.now() - tB;

      const rejectedB = racers.filter((r) => r.status !== 200 || !r.ok);
      expect(
        rejectedB.map((r) => r.status),
        `${rejectedB.length} rejected pushes in phase B`
      ).toEqual([]);

      // One racer owns main; the other nine live on delta refs with intents.
      const refs = await callStubWithRetry(seeded.getStub, (stub) => stub.listRefs());
      const agentBranches = refs.filter((r: { name: string }) =>
        r.name.startsWith("refs/heads/agent-")
      );
      expect(agentBranches.length).toBe(40);
      const deltaRefs = refs.filter((r: { name: string }) => r.name.startsWith("refs/delta/"));
      const racerOids = new Set(racers.map((r) => r.commitOid));
      const landedRacers = [
        refs.find((r: { name: string }) => r.name === "refs/heads/main")?.oid,
        ...deltaRefs.map((r: { oid: string }) => r.oid),
      ];
      for (const oid of racerOids) expect(landedRacers).toContain(oid);

      const intents = await callStubWithRetry(seeded.getStub, (stub) =>
        stub.listMergeIntents(["open", "merging", "adjudicating", "conflict"])
      );
      expect(intents.length).toBeGreaterThanOrEqual(9);

      // Numbers for docs/ops.md.
      const all = [...branchPushes, ...racers].map((r) => r.ms).sort((a, b) => a - b);
      console.log(
        `[load50] phaseA: 40 pushes in ${wallA.toFixed(0)}ms ` +
          `(${(40000 / wallA).toFixed(1)} push/s); ` +
          `phaseB: 10 racers in ${wallB.toFixed(0)}ms; ` +
          `latency p50=${pct(all, 0.5).toFixed(0)}ms p95=${pct(all, 0.95).toFixed(0)}ms ` +
          `max=${all[all.length - 1].toFixed(0)}ms; ` +
          `deltaRefs=${deltaRefs.length} intents=${intents.length}`
      );
    }
  );
});
