#!/usr/bin/env tsx
/**
 * Deterministic arena seed — drives a full competitive match end-to-end
 * against a running delta-git deployment:
 *
 *   repo (artifacts) → match → N agents enter → each pushes a divergent
 *   commit to its workspace fork → window closes → blind votes → resolve →
 *   provenance bundle.
 *
 * Environment:
 *   DG_BASE_URL   e.g. http://localhost:8787 or the workers.dev URL
 *   DG_PAT        a push-level PAT (Basic user = namespace slug); used for
 *                 match creation
 *   DG_COOKIE     optional `dg_session` cookie value — when set the script
 *                 (re)creates the canonical repo as an artifacts repo first
 *   DG_OWNER      namespace slug            DG_REPO     repo slug
 *   SEED          integer seed (default 42) — same seed → same agent work
 *
 * Usage:  npx tsx scripts/seed-arena.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

const BASE = (process.env.DG_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const PAT = process.env.DG_PAT ?? "";
const OWNER = process.env.DG_OWNER ?? "demo";
const REPO = process.env.DG_REPO ?? "arena-demo";
const SEED = Number(process.env.SEED ?? 42);
const ENTRANTS = 3;
// Short windows so the demo completes in minutes.
const WINDOW_MINUTES = 1;
const JUDGE_MINUTES = 1;

// Deterministic PRNG (mulberry32) — same SEED replays the same demo.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

const SPEC_TITLE = "Build the best landing hero";
const SPEC_BODY = `Implement a landing hero section.
Requirements: a headline, a subheading, one CTA button, and a short feature
list. Work in your workspace fork; push early and often. Winner is chosen by
composite score: submission + speed + activity + blind community votes.`;

async function api(path: string, init: RequestInit = {}, auth?: string) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (auth) headers.set("Authorization", auth);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data: data as Record<string, unknown> };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
async function sha256HexBytes(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(new Uint8Array(await webcrypto.subtle.digest("SHA-256", buf as BufferSource)));
}

// Minimal ed25519 agent registration + signed-request helper. The agent
// envelope signs sha256("dg1\n" + did + "\n" + ts + "\n" + nonce + "\n" +
// METHOD + "\n" + path + "\n" + bodySha256Hex); ts is unix seconds and
// sig/pubkey are hex (see src/worker/agent/auth.ts).
async function registerAgent(idx: number) {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const res = await api(`/api/agents`, {
    method: "POST",
    body: JSON.stringify({
      pubkey: hex(pubRaw),
      label: `arena-bot-${idx}`,
      family: "arena-bot",
      model: "seed-script",
    }),
  });
  const did = (res.data.did ?? res.data.agent?.did) as string | undefined;
  if (!did) throw new Error(`agent register failed: ${JSON.stringify(res.data)}`);

  const sign = async (method: string, path: string, body: string) => {
    const bodyBytes = new TextEncoder().encode(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const payload = await sha256HexBytes(
      `dg1\n${did}\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${await sha256HexBytes(bodyBytes)}`
    );
    const sig = await webcrypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      new TextEncoder().encode(payload) as BufferSource
    );
    return {
      "x-dg-did": did,
      "x-dg-ts": ts,
      "x-dg-nonce": nonce,
      "x-dg-sig": hex(new Uint8Array(sig)),
    };
  };
  return { did, sign };
}

function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
}

function pushWorkspace(remote: string, token: string, seedTag: string) {
  const dir = mkdtempSync(join(tmpdir(), "dg-ws-"));
  try {
    const authed = remote.replace("https://", `https://x:${token}@`);
    git(["clone", authed, "."], dir, { GIT_TERMINAL_PROMPT: "0" });
    const files = [
      `<h1>${seedTag}</h1>`,
      `<p>Seeded arena submission ${seedTag}</p>`,
      `<button>${pick(["Ship it", "Try now", "Get started"])}</button>`,
    ];
    writeFileSync(join(dir, "index.html"), files.join("\n"));
    writeFileSync(join(dir, "arena.md"), `# ${seedTag}\n\nseed=${SEED}\n`);
    git(["add", "-A"], dir);
    git(
      [
        "-c",
        "user.email=bot@delta-git",
        "-c",
        "user.name=arena-bot",
        "commit",
        "-m",
        `arena entry ${seedTag}`,
      ],
      dir
    );
    git(["push", authed, "HEAD:main"], dir, { GIT_TERMINAL_PROMPT: "0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`seed-arena: base=${BASE} repo=${OWNER}/${REPO} seed=${SEED}`);
  const basic = PAT ? `Basic ${Buffer.from(`${OWNER}:${PAT}`).toString("base64")}` : "";

  // 1. Canonical repo (artifacts backend). Repo creation is session-cookie
  // authed (browser namespace owner), not PAT — pass DG_COOKIE to have the
  // script create it, otherwise it must already exist.
  const cookie = process.env.DG_COOKIE;
  if (cookie) {
    const res = await fetch(`${BASE}/auth/api/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `dg_session=${cookie}` },
      body: JSON.stringify({
        namespaceSlug: OWNER,
        slug: REPO,
        backend: "artifacts",
        visibility: "public",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    console.log(`  repo: ${res.status}`, res.status >= 400 ? data : "");
  } else {
    console.log("  repo: assuming it exists (set DG_COOKIE to create it)");
  }

  // 2. Agents.
  const agents = [];
  for (let i = 0; i < ENTRANTS; i++) agents.push(await registerAgent(i));
  console.log(`  agents: ${agents.map((a) => a.did.slice(0, 24)).join(", ")}`);

  // 3. Match.
  const match = await api(
    `/api/${OWNER}/${REPO}/dg/matches`,
    {
      method: "POST",
      body: JSON.stringify({
        title: SPEC_TITLE,
        spec: SPEC_BODY,
        window_minutes: WINDOW_MINUTES,
        judge_minutes: JUDGE_MINUTES,
        max_entrants: ENTRANTS,
        prize_rep: 25,
      }),
      headers: basic ? { Authorization: basic } : undefined,
    },
    basic || undefined
  );
  const matchId = match.data.id as string;
  if (!matchId) throw new Error(`match create failed: ${JSON.stringify(match.data)}`);
  console.log(`  match: ${matchId} (${WINDOW_MINUTES}m build + ${JUDGE_MINUTES}m judge)`);

  // 4. Entries → workspace forks → divergent pushes.
  for (const [i, agent] of agents.entries()) {
    const path = `/api/${OWNER}/${REPO}/dg/matches/${matchId}/enter`;
    const headers = await agent.sign("POST", path, "{}");
    const res = await api(path, { method: "POST", body: "{}", headers }, undefined);
    const { remote, token, workspace } = res.data as {
      remote?: string;
      token?: string;
      workspace?: string;
    };
    if (!remote || !token) {
      console.log(`  enter ${i}: ${res.status} ${JSON.stringify(res.data)}`);
      continue;
    }
    console.log(`  enter ${i}: ${workspace}`);
    pushWorkspace(remote, token, `hero-${SEED}-${i}`);
  }

  // 5. Wait out the build window, then vote (each agent votes for a random
  //    OTHER entry — blind).
  const waitMs = WINDOW_MINUTES * 60 * 1000 + 10_000;
  console.log(`  waiting ${Math.round(waitMs / 1000)}s for build window…`);
  await sleep(waitMs);

  const detail = await api(`/api/${OWNER}/${REPO}/dg/matches/${matchId}`);
  const entries = (detail.data.entries as { id: string }[] | undefined) ?? [];
  for (const [i, agent] of agents.entries()) {
    const target = entries[(i + 1) % entries.length];
    if (!target) continue;
    const votePath = `/api/${OWNER}/${REPO}/dg/matches/${matchId}/vote`;
    // Stake rides with the vote — conviction is part of the demo.
    const voteBody = JSON.stringify({ entry_id: target.id, stake: 5 });
    const headers = await agent.sign("POST", votePath, voteBody);
    const res = await api(votePath, { method: "POST", body: voteBody, headers });
    if (res.status === 403) {
      // Expected on fresh accounts: voting needs earned rep (+1h age, or
      // rep ≥ the bypass). Run the seed twice — match 1's winner qualifies.
      console.log(`  vote ${i}: gated (${JSON.stringify(res.data)})`);
    } else {
      console.log(`  vote ${i}: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }

  // 6. Wait out judging, then print the result.
  const judgeMs = JUDGE_MINUTES * 60 * 1000 + 15_000;
  console.log(`  waiting ${Math.round(judgeMs / 1000)}s for judging…`);
  await sleep(judgeMs);

  const final = await api(`/api/${OWNER}/${REPO}/dg/matches/${matchId}`);
  console.log("  result:", JSON.stringify(final.data.match, null, 0));
  console.log(`\n  match page: ${BASE}/${OWNER}/${REPO}/arena/${matchId}`);
  console.log(`  provenance: ${BASE}/api/${OWNER}/${REPO}/dg/matches/${matchId}/bundle`);
}

main().catch((e) => {
  console.error("seed-arena failed:", e);
  process.exit(1);
});
