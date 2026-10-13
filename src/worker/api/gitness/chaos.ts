// Chaos experiment engine — real measurement, not a result ledger.
//
// `POST /chaos/:id/run` executes the experiment inline (bounded) and stores
// a report of measured numbers. Three kinds:
//
//   endpoint         — N requests against an HTTP path on this host with the
//                      caller's session forwarded; latency percentiles,
//                      status histogram, error rate. Real edge measurement.
//   receive-flood    — N concurrent streaming receive-pack pushes against a
//                      repo via a minted-then-deleted scoped PAT. Measures
//                      the multi-lease receive under contention: committed,
//                      delta/quarantined (landed), and refused counts.
//   lease-contention — N concurrent beginReceive calls against the repo DO,
//                      measuring how the 8-slot lease pool behaves; all held
//                      leases are aborted afterwards (no state left behind).

import { getRepoStub, newPrefixedId } from "@/worker/common";
import { encodeGitObject } from "@/worker/git/core";
import { serializeTree } from "@/worker/git/core/tree";
import { buildPackV2 } from "@/worker/git/pack/build";
import { generatePatPlaintext, hashPatPlaintext } from "@/worker/auth/pat";
import { insertPatWithGrants, revokePatById } from "@/worker/db/d1/dal/tokens";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";
import type { GitnessContext } from "./shared";

export interface ChaosReport {
  kind: string;
  measured: Record<string, unknown>;
  samples: number;
  durationMs: number;
}

interface RunOutcome {
  outcome: "pass" | "fail" | "aborted";
  report: ChaosReport;
}

const MAX_ENDPOINT_REQUESTS = 100;
const MAX_ENDPOINT_CONCURRENCY = 10;
const MAX_PUSHES = 16;
const RUN_BUDGET_MS = 90_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function latencyStats(samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// endpoint — real HTTP measurement against this host.
// ---------------------------------------------------------------------------

async function runEndpointChaos(
  c: GitnessContext,
  spec: Record<string, unknown>
): Promise<RunOutcome> {
  const path = typeof spec.path === "string" ? spec.path : "/";
  if (!path.startsWith("/")) throw new Error("spec.path must start with /");
  const count = Math.min(Math.max(1, Number(spec.count ?? 20)), MAX_ENDPOINT_REQUESTS);
  const concurrency = Math.min(
    Math.max(1, Number(spec.concurrency ?? 5)),
    MAX_ENDPOINT_CONCURRENCY
  );
  const method = typeof spec.method === "string" ? spec.method.toUpperCase() : "GET";
  // Service binding loopback — exercises the real HTTP/router surface
  // without a public-egress round trip.
  const url = `https://self${path}`;
  const cookie = c.req.header("cookie") ?? "";

  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let transportErrors = 0;
  const started = Date.now();

  const worker = async () => {
    while (Date.now() - started < RUN_BUDGET_MS) {
      const i = claimed++;
      if (i >= count) return;
      const t0 = performance.now();
      const res = await c.env.SELF.fetch(url, {
        method,
        headers: { Cookie: cookie },
      }).catch(() => null);
      latencies.push(performance.now() - t0);
      if (!res) transportErrors++;
      else {
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        // Drain so keep-alive doesn't stall the pool.
        await res.arrayBuffer().catch(() => undefined);
      }
    }
  };
  let claimed = 0;
  await Promise.all(Array.from({ length: concurrency }, worker));

  const errors =
    transportErrors +
    [...statuses.entries()].filter(([s]) => s >= 500).reduce((n, [, c2]) => n + c2, 0);
  const samples = latencies.length;
  const errorRate = samples > 0 ? errors / samples : 1;
  const maxErrorPct = Number(spec.max_error_pct ?? 5) / 100;
  return {
    outcome: errorRate <= maxErrorPct ? "pass" : "fail",
    report: {
      kind: "endpoint",
      samples,
      durationMs: Date.now() - started,
      measured: {
        path,
        method,
        concurrency,
        latencies: latencyStats(latencies),
        statuses: Object.fromEntries(statuses),
        transportErrors,
        errorRate: Number(errorRate.toFixed(4)),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// receive-flood — concurrent pushes at the multi-lease receive.
// ---------------------------------------------------------------------------

async function buildTinyPush(parentOid: string, marker: string): Promise<Uint8Array> {
  const author = "Chaos <chaos@delta-git.local> 0 +0000";
  const blobPayload = new TextEncoder().encode(`chaos ${marker} ${crypto.randomUUID()}\n`);
  const blob = await encodeGitObject("blob", blobPayload);
  const treePayload = serializeTree(
    new Map([
      [`chaos-${marker}.txt`, { mode: "100644", name: `chaos-${marker}.txt`, oid: blob.oid }],
    ])
  );
  const tree = await encodeGitObject("tree", treePayload);
  const commitPayload = new TextEncoder().encode(
    `tree ${tree.oid}\n` +
      `parent ${parentOid}\n` +
      `author ${author}\n` +
      `committer ${author}\n\n` +
      `chaos push ${marker}\n`
  );
  const commit = await encodeGitObject("commit", commitPayload);
  const pack = await buildPackV2([
    { type: "blob", payload: blobPayload },
    { type: "tree", payload: treePayload },
    { type: "commit", payload: commitPayload },
  ]);
  // pkt-line: <old> <new> <ref>\0<caps> + flush + pack
  const enc = new TextEncoder();
  const line = `${parentOid} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=chaos\n`;
  const pktLen = (line.length + 4).toString(16).padStart(4, "0");
  const head = enc.encode(`${pktLen}${line}0000`);
  const out = new Uint8Array(head.length + pack.length);
  out.set(head, 0);
  out.set(pack, head.length);
  return out;
}

async function runReceiveFlood(
  c: GitnessContext,
  nsSlug: string,
  userId: string,
  spec: Record<string, unknown>
): Promise<RunOutcome> {
  const repoSlug = typeof spec.repo === "string" ? spec.repo : "";
  if (!repoSlug) throw new Error("spec.repo required");
  const pushes = Math.min(Math.max(1, Number(spec.pushes ?? 9)), MAX_PUSHES);
  const doName = `${nsSlug}/${repoSlug}`;
  const stub = getRepoStub(c.env, doName);
  const { refs } = await stub.getHeadAndRefs();
  const head = refs.find((r) => r.name === "refs/heads/main")?.oid ?? refs[0]?.oid;
  if (!head) throw new Error("repo has no head to push onto");

  // A scoped push PAT minted for the run and deleted after — real auth,
  // no standing credentials.
  const db = c.var.db;
  const repo = await findRepositoryByDoName(db, doName);
  if (!repo) throw new Error("repository not found");
  const generated = generatePatPlaintext();
  const patId = newPrefixedId("pat");
  await insertPatWithGrants(db, {
    pat: {
      id: patId,
      userId,
      name: `chaos-${Date.now()}`,
      prefix: generated.publicPrefix,
      hash: await hashPatPlaintext(generated.plaintext),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      revokedAt: null,
      lastUsedAt: null,
    },
    namespaceGrants: [],
    repoGrants: [{ patId, repoId: repo.id, level: "push" }],
  });

  const auth = `Basic ${btoa(`${nsSlug}:${generated.plaintext}`)}`;
  const latencies: number[] = [];
  const outcomes = { landed: 0, delta: 0, refused: 0, transport: 0 };
  const started = Date.now();
  try {
    await Promise.all(
      Array.from({ length: pushes }, async (_, i) => {
        const body = await buildTinyPush(head, `${i}`);
        const t0 = performance.now();
        const res = await c.env.SELF.fetch(`https://self/${nsSlug}/${repoSlug}/git-receive-pack`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-git-receive-pack-request",
            Authorization: auth,
          },
          body: body as BodyInit,
        }).catch(() => null);
        latencies.push(performance.now() - t0);
        if (!res) {
          outcomes.transport++;
          return;
        }
        const text = await res.text().catch(() => "");
        if (res.status === 200 && text.includes("ok refs/heads/main")) {
          // Either the branch advanced or the push landed on a delta ref —
          // both are "landed"; a `ng` line is the only real refusal.
          outcomes.landed++;
        } else if (res.status === 200) {
          outcomes.refused++;
        } else {
          outcomes.refused++;
        }
      })
    );
  } finally {
    await revokePatById(db, patId, userId, Date.now()).catch(() => undefined);
  }

  const errorRate = pushes > 0 ? (outcomes.refused + outcomes.transport) / pushes : 1;
  return {
    outcome: errorRate <= 0.5 ? "pass" : "fail",
    report: {
      kind: "receive-flood",
      samples: latencies.length,
      durationMs: Date.now() - started,
      measured: {
        repo: doName,
        pushes,
        latencies: latencyStats(latencies),
        ...outcomes,
        note: "landed = ok report-status (branch or delta); refused = ng/5xx",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// lease-contention — direct DO lease pool behavior, cleaned up after.
// ---------------------------------------------------------------------------

async function runLeaseContention(
  c: GitnessContext,
  nsSlug: string,
  spec: Record<string, unknown>
): Promise<RunOutcome> {
  const repoSlug = typeof spec.repo === "string" ? spec.repo : "";
  if (!repoSlug) throw new Error("spec.repo required");
  const attempts = Math.min(Math.max(1, Number(spec.attempts ?? 12)), MAX_PUSHES);
  const stub = getRepoStub(c.env, `${nsSlug}/${repoSlug}`);
  const started = Date.now();
  const latencies: number[] = [];
  const held: string[] = [];
  let granted = 0;
  let busy = 0;
  try {
    await Promise.all(
      Array.from({ length: attempts }, async () => {
        const t0 = performance.now();
        const begin = await stub.beginReceive();
        latencies.push(performance.now() - t0);
        if (begin.ok) {
          granted++;
          held.push(begin.lease.token);
        } else {
          busy++;
        }
      })
    );
  } finally {
    await Promise.all(held.map((token) => stub.abortReceive(token).catch(() => false)));
  }
  return {
    outcome: granted > 0 ? "pass" : "fail",
    report: {
      kind: "lease-contention",
      samples: latencies.length,
      durationMs: Date.now() - started,
      measured: {
        repo: `${nsSlug}/${repoSlug}`,
        attempts,
        granted,
        busy,
        latencies: latencyStats(latencies),
      },
    },
  };
}

export async function runChaosExperiment(
  c: GitnessContext,
  nsSlug: string,
  userId: string,
  kind: string,
  spec: Record<string, unknown>
): Promise<RunOutcome> {
  switch (kind) {
    case "endpoint":
    case "latency":
    case "failure":
      return runEndpointChaos(c, spec);
    case "receive-flood":
      return runReceiveFlood(c, nsSlug, userId, spec);
    case "lease-contention":
    case "resource":
      return runLeaseContention(c, nsSlug, spec);
    default:
      throw new Error(`unknown chaos kind: ${kind}`);
  }
}
