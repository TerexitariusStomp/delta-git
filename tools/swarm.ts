#!/usr/bin/env -S npx tsx
// Demo swarm — end-to-end agent lifecycle against a delta-git instance:
//   register N ed25519 agents → each lands a divergent /patch → merge intents
//   are claimed and run → conflicts go to adjudication → quorum votes resolve
//   → op-log + leaderboard printed.
//
//   npx tsx tools/swarm.ts <owner>/<repo> --agents 5 --host http://localhost:8787
//
// Unlike loadsim (PAT + patch volume), this exercises the *signed agent* path:
// every mutating request carries the x-dg-* ed25519 envelope verified by
// src/worker/agent/auth.ts.

const args = process.argv.slice(2);
const repo = args[0];
const getOpt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const AGENT_COUNT = Number(getOpt("agents", "5"));
const HOST = (getOpt("host", "http://localhost:8787") as string).replace(/\/$/, "");
const [owner, name] = repo.split("/");
const te = new TextEncoder();

const toHex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const data = typeof s === "string" ? te.encode(s) : s;
  return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

type Agent = {
  did: string;
  pubkeyHex: string;
  privateKey: CryptoKey;
  label: string;
};

async function makeAgent(label: string): Promise<Agent> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubkeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const res = await fetch(`${HOST}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: pubkeyHex, label }),
  });
  if (!res.ok) throw new Error(`register ${label}: ${res.status} ${await res.text()}`);
  const { did } = (await res.json()) as { did: string };
  return { did, pubkeyHex, privateKey: pair.privateKey, label };
}

/** Sign and send a JSON request as an agent. Path is the URL pathname per auth.ts. */
async function agentFetch(
  agent: Agent,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const bodyBytes = body === undefined ? new Uint8Array(0) : te.encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const bodySha = await sha256Hex(bodyBytes);
  const payload = await sha256Hex(
    `dg1\n${agent.did}\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodySha}`
  );
  const sig = toHex(
    await crypto.subtle.sign("Ed25519", agent.privateKey, te.encode(payload) as BufferSource)
  );
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-dg-did": agent.did,
      "x-dg-ts": ts,
      "x-dg-nonce": nonce,
      "x-dg-sig": sig,
    },
    body: body === undefined ? undefined : bodyBytes,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const api = (p: string) => `/api/${owner}/${name}/dg${p}`;

async function main() {
  console.log(`swarm: registering ${AGENT_COUNT} agents against ${HOST} ${repo}`);
  const agents = await Promise.all(
    [...Array(AGENT_COUNT).keys()].map((i) => makeAgent(`swarm-${i}`))
  );
  console.log(`  registered: ${agents.map((a) => a.did.slice(0, 24) + "…").join(", ")}`);

  // Phase 1 — divergent patches. Two agents deliberately collide on the same
  // file to force adjudication; the rest take disjoint files (clean merges).
  console.log(`\nphase 1: ${agents.length} agents submitting divergent patches`);
  const patchResults = await Promise.all(
    agents.map(async (agent, i) => {
      const collide = i < 2;
      const file = collide ? "contested.md" : `agent-${i}.md`;
      const patch = [
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -0,0 +1,1 @@`,
        `+${agent.label} claims this file at ${Date.now()}`,
      ].join("\n");
      const r = await agentFetch(agent, "POST", api("/patch"), {
        base_ref: "main",
        patch,
        message: `${agent.label}: update ${file}`,
      });
      return { agent: agent.label, status: r.status, intent: r.body?.intent?.id, merge: r.body?.merge?.kind };
    })
  );
  for (const r of patchResults) {
    console.log(`  ${r.agent}: HTTP ${r.status} intent=${r.intent?.slice(0, 8) ?? "—"} merge=${r.merge ?? "—"}`);
  }

  // Phase 2 — claim + run any still-open intents.
  const { body: open } = await agentFetch(agents[0], "GET", api("/intents?status=open,merging"));
  const openIntents = (open.intents ?? []) as { id: string }[];
  console.log(`\nphase 2: ${openIntents.length} open intents — running merges`);
  for (const intent of openIntents) {
    const runner = agents[openIntents.indexOf(intent) % agents.length];
    const r = await agentFetch(runner, "POST", api(`/intents/${intent.id}/run`), {});
    console.log(`  ${intent.id.slice(0, 8)}: ${r.body?.kind ?? r.body?.error ?? r.status}`);
  }

  // Phase 3 — adjudication. Find intents in `adjudicating` and vote a shared
  // resolution to quorum (default k=3, majority 2).
  const { body: adjud } = await agentFetch(
    agents[0],
    "GET",
    api("/intents?status=adjudicating,conflict")
  );
  const adjudicating = (adjud.intents ?? []) as { id: string; conflicts: string[] }[];
  console.log(`\nphase 3: ${adjudicating.length} intents awaiting adjudication`);
  for (const intent of adjudicating) {
    const files: Record<string, { content_b64: string }> = {};
    for (const path of intent.conflicts) {
      files[path] = {
        content_b64: btoa(`# quorum resolution\n\nMerged by swarm quorum for ${intent.id}\n`),
      };
    }
    const resolution = { files };
    for (const voter of agents.slice(0, 3)) {
      const r = await agentFetch(voter, "POST", api(`/intents/${intent.id}/vote`), {
        resolution,
        rationale: `${voter.label} endorses shared resolution`,
      });
      console.log(
        `  vote ${voter.label} on ${intent.id.slice(0, 8)}: seat=${r.body?.seat ?? "—"} resolved=${r.body?.resolved ?? r.body?.error ?? r.status}`
      );
      if (r.body?.resolved) break;
    }
  }

  // Phase 4 — receipts.
  const { body: log } = await agentFetch(agents[0], "GET", api("/oplog"));
  const entries = (log.entries ?? []) as { seq: number; kind: string }[];
  console.log(`\nop-log tail (${entries.length} entries):`);
  for (const e of entries.slice(-12)) console.log(`  #${e.seq} ${e.kind}`);

  const lb = await fetch(`${HOST}/api/leaderboard`).then((r) => r.json());
  console.log(`\nleaderboard:`);
  for (const a of (lb.agents ?? []).slice(0, 10)) {
    console.log(`  ${a.rep}  ${a.label ?? a.did.slice(0, 24)}`);
  }
}

void main();
