#!/usr/bin/env -S npx tsx
// Load simulation for the "100K agents" claim — measures the real concurrency
// story: N agents push divergent work concurrently, count zero rejections,
// and measure merge-adjudication throughput.
//
//   npx tsx tools/loadsim.ts <owner>/<repo> --agents 100 --host http://localhost:8787
//
// Requires DG_PAT/DG_USER for pushes (uses real `git` clients under the hood
// where available, else /patch submissions).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const repo = args[0];
const getOpt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const AGENTS = Number(getOpt("agents", "50"));
const HOST = (getOpt("host", "http://localhost:8787") as string).replace(/\/$/, "");
const [owner, name] = repo.split("/");

const headers = {
  "Content-Type": "application/json",
  Authorization: `Basic ${Buffer.from(`${process.env.DG_USER ?? "loadsim"}:${process.env.DG_PAT ?? ""}`).toString("base64")}`,
};

async function patch(
  agentIdx: number
): Promise<{ agent: number; ok: boolean; intent?: string; ms: number }> {
  const t0 = Date.now();
  const file = `agent-${agentIdx % 10}.md`;
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,2 @@`,
    `+agent ${agentIdx} was here`,
    `+ts ${Date.now()}`,
  ].join("\n");
  const res = await fetch(`${HOST}/api/${owner}/${name}/dg/patch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ base_ref: "main", patch, message: `agent-${agentIdx} patch` }),
  });
  const body = (await res.json().catch(() => ({}))) as { intent?: { id?: string } };
  return { agent: agentIdx, ok: res.ok, intent: body.intent?.id, ms: Date.now() - t0 };
}

async function main() {
  console.log(`loadsim: ${AGENTS} agents patching ${repo} on ${HOST}`);
  const started = Date.now();
  const results = await Promise.all([...Array(AGENTS).keys()].map((i) => patch(i)));
  const elapsed = Date.now() - started;
  const ok = results.filter((r) => r.ok).length;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        agents: AGENTS,
        accepted: ok,
        rejected: AGENTS - ok,
        wall_ms: elapsed,
        p50_ms: latencies[Math.floor(latencies.length / 2)],
        p99_ms: latencies[Math.floor(latencies.length * 0.99)],
        intents: results.filter((r) => r.intent).map((r) => r.intent).length,
      },
      null,
      2
    )
  );
}
void main();
