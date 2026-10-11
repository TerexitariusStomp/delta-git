#!/usr/bin/env tsx
/**
 * End-to-end demo dry-run against a running delta-git deployment.
 * Exercises the video beats that don't need a live stage:
 *
 *   1. did:key sign-in (challenge → signed verify → dg_session)
 *   2. PAT mint (push-level, namespace scope)
 *   3. Repo create (artifacts backend w/ r2 fallback)
 *   4. Push race: two clones push divergent heads — loser lands refs/delta/*
 *      → merge intent minted → adjudication progresses
 *
 * Prints a beat-by-beat report; exits non-zero on any hard failure.
 *
 * Env: DG_BASE_URL (default http://localhost:8787), DG_OWNER, DG_REPO, SEED
 */

import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { didKeyFromPubkey } from "../src/worker/agent/atpauth/didkey";

const BASE = (process.env.DG_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const OWNER = process.env.DG_OWNER ?? `dry-${Math.floor(Math.random() * 1e4)}`;
const REPO = process.env.DG_REPO ?? "race-demo";
const ORIGIN = new URL(BASE).origin;

const results: { beat: string; ok: boolean; detail: string }[] = [];
function beat(name: string, ok: boolean, detail = "") {
  results.push({ beat: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    console.log("\n=== beat summary ===");
    for (const r of results) console.log(` ${r.ok ? "✓" : "✗"} ${r.beat}: ${r.detail}`);
    process.exit(1);
  }
}

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Origin", ORIGIN);
  if (cookie) headers.set("Cookie", `__Host-dg_session=${cookie}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { res, data, headers: res.headers };
}

const b64url = (b: Uint8Array) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function canonicalJson(value: Record<string, string | number | undefined>): string {
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(",")}}`;
}

function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    stdio: "pipe",
  }).toString();
}

function gitAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout + stderr))
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`dry-run: base=${BASE} namespace=${OWNER} repo=${REPO}\n`);

  // ---- Beat 1: did:key sign-in ---------------------------------------------
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const did = didKeyFromPubkey(pubRaw, "ed25519");

  const chal = await api(`/auth/did/challenge?did=${encodeURIComponent(did)}`);
  if (chal.res.status !== 200) {
    beat("did:challenge", false, `${chal.res.status} ${JSON.stringify(chal.data)}`);
    return;
  }
  const { nonce, iat, exp } = chal.data as { nonce: string; iat: number; exp: number };
  const payload = canonicalJson({ did, exp, iat, nonce });
  const sig = new Uint8Array(
    await webcrypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload))
  );

  const verify = await api(`/auth/did/verify`, {
    method: "POST",
    body: JSON.stringify({ did, nonce, iat, exp, sig: b64url(sig) }),
  });
  const setCookie = verify.headers.get("set-cookie") ?? "";
  const cookie = setCookie.match(/dg_session=([^;]+)/)?.[1];
  const namespace = (verify.data.namespace as string) ?? OWNER;
  beat(
    "did:key sign-in",
    verify.res.status === 200 && !!cookie,
    `${verify.res.status} ns=${namespace} ${verify.res.status !== 200 ? JSON.stringify(verify.data) : ""}`
  );

  // ---- Beat 2: PAT mint ------------------------------------------------------
  const pat = await api(
    `/auth/api/tokens`,
    { method: "POST", body: JSON.stringify({ scope: "namespace", name: "dry-run", namespaceSlug: namespace, level: "push" }) },
    cookie
  );
  const patPlain = pat.data.plaintext as string | undefined;
  beat("PAT mint", pat.res.status === 200 && !!patPlain, `${pat.res.status} prefix=${pat.data.prefix ?? JSON.stringify(pat.data)}`);

  // ---- Beat 3: artifacts repo + art_v1 token (beat 2 of the video) -----------
  const artRepo = await api(
    `/auth/api/repositories`,
    { method: "POST", body: JSON.stringify({ namespaceSlug: namespace, slug: `${REPO}-art`, backend: "artifacts", visibility: "public" }) },
    cookie
  );
  beat("artifacts repo create", artRepo.res.status < 400, `${artRepo.res.status} ${artRepo.res.status >= 400 ? JSON.stringify(artRepo.data) : ""}`);

  // The /api/dg/* surface resolves repos route-cache-only; the KV record is
  // warmed by an async route-cache-sync queue task — poll until it lands.
  const waitCache = async (slug: string) => {
    for (let i = 0; i < 90; i++) {
      const probe = await api(`/api/${namespace}/${slug}/dg/intents`);
      if (probe.res.status !== 404) return probe.res.status;
      await sleep(1000);
    }
    return 404;
  };
  const cacheStatus = await waitCache(`${REPO}-art`);
  beat("route-cache warm", cacheStatus !== 404, `intents → ${cacheStatus}`);

  const basic = `Basic ${Buffer.from(`${namespace}:${patPlain}`).toString("base64")}`;
  const tok = await api(`/api/${namespace}/${REPO}-art/dg/token`, {
    method: "POST",
    headers: { Authorization: basic },
    body: JSON.stringify({ scope: "write" }),
  });
  const artToken = (tok.data.token ?? tok.data.plaintext) as string | undefined;
  beat("artifacts art_v1 token", !!artToken, `${tok.res.status} ${artToken ? artToken.slice(0, 12) + "…" : JSON.stringify(tok.data)}`);

  // The git remote 302s to the artifacts service — capture the Location.
  const refsProbe = await fetch(`${BASE}/${namespace}/${REPO}-art.git/info/refs?service=git-upload-pack`, {
    headers: { Authorization: basic },
    redirect: "manual",
  });
  const artRemote = refsProbe.headers.get("location") ?? "";
  beat("artifacts remote 302", refsProbe.status === 302 && /artifacts/.test(artRemote), `${refsProbe.status} → ${artRemote.slice(0, 80)}`);

  // ---- Beat 4: r2 repo + push race → refs/delta/* -----------------------------
  const repo = await api(
    `/auth/api/repositories`,
    { method: "POST", body: JSON.stringify({ namespaceSlug: namespace, slug: REPO, backend: "do", visibility: "public" }) },
    cookie
  );
  beat("do repo create", repo.res.status < 400, `${repo.res.status} ${repo.res.status >= 400 ? JSON.stringify(repo.data) : ""}`);
  await waitCache(REPO);

  // Git auth: Basic username must equal the namespace slug (AGENTS.md).
  const remoteHttp = `${ORIGIN.replace("https://", `https://${namespace}:${patPlain}@`).replace("http://", `http://${namespace}:${patPlain}@`)}/${namespace}/${REPO}.git`;

  const dirA = mkdtempSync(join(tmpdir(), "dg-raceA-"));
  const dirB = mkdtempSync(join(tmpdir(), "dg-raceB-"));
  try {
    git(["init"], dirA);
    writeFileSync(join(dirA, "README.md"), "# race demo\n");
    git(["add", "-A"], dirA);
    git(["-c", "user.email=a@dg", "-c", "user.name=a", "commit", "-m", "init"], dirA);
    git(["push", remoteHttp, "HEAD:main"], dirA);

    // Two clones of main, each with a divergent commit.
    git(["clone", remoteHttp, "."], dirB);
    const dirC = mkdtempSync(join(tmpdir(), "dg-raceC-"));
    git(["clone", remoteHttp, "."], dirC);

    writeFileSync(join(dirB, "agent-b.txt"), `b-${Date.now()}\n`);
    git(["add", "-A"], dirB);
    git(["-c", "user.email=b@dg", "-c", "user.name=b", "commit", "-m", "agent B head"], dirB);

    writeFileSync(join(dirC, "agent-c.txt"), `c-${Date.now()}\n`);
    git(["add", "-A"], dirC);
    git(["-c", "user.email=c@dg", "-c", "user.name=c", "commit", "-m", "agent C head"], dirC);

    // A real race: both clients advertise refs before either finalizes, so
    // the loser's receive lands with a stale old-oid → refs/delta/* rewrite.
    // (Sequential pushes can't reach that path — git checks FF client-side
    // against the fresh advertisement and refuses before sending.) The
    // window is probabilistic — retry with fresh branch names.
    let intentId: string | undefined;
    for (let attempt = 0; attempt < 5 && !intentId; attempt++) {
      const branch = `race-${Date.now()}`;
      // C carries a big blob: its advertisement completes fast but its pack
      // upload takes seconds — B lands its finalize in between, so C's POST
      // arrives with a stale zero old-oid → delta rewrite. That's the
      // deterministic way to hold the race window open over WAN RTT.
      const blob = Buffer.alloc(16 * 1024 * 1024);
      for (let off = 0; off < blob.length; off += 65536)
        webcrypto.getRandomValues(blob.subarray(off, off + 65536));
      writeFileSync(join(dirC, `fill-${attempt}.bin`), blob);
      git(["add", "-A"], dirC);
      git(["-c", "user.email=c@dg", "-c", "user.name=c", "commit", "-m", `agent C head ${attempt}`], dirC);
      const pushC = gitAsync(["push", remoteHttp, `HEAD:${branch}`], dirC);
      await sleep(1000); // let C advertise, then B races its small pack in
      const pushB = gitAsync(["push", remoteHttp, `HEAD:${branch}`], dirB);
      const results = await Promise.allSettled([pushB, pushC]);
      console.log(`  race attempt ${attempt}: B=${results[0].status} C=${results[1].status}`);
      await sleep(2000);
      const intents = await api(`/api/${namespace}/${REPO}/dg/intents`);
      const list = (intents.data.intents ?? []) as { id: string }[];
      intentId = list[0]?.id;
      if (!intentId) console.log(`  race attempt ${attempt}: no delta yet`);
    }
    beat("race: divergent push → refs/delta/* + intent", !!intentId, intentId ?? "no delta after 5 attempts");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }

  // ---- Handoff vars for seed-arena -------------------------------------------
  wf("/tmp/dg-dry-run.env", `DG_BASE_URL=${BASE}\nDG_PAT=${patPlain}\nDG_COOKIE=${cookie}\nDG_OWNER=${namespace}\nDG_REPO=arena-demo\n`);
  console.log(`\ncookie+pat → /tmp/dg-dry-run.env  (owner=${namespace})`);
  console.log("\n=== beat summary ===");
  for (const r of results) console.log(` ${r.ok ? "✓" : "✗"} ${r.beat}: ${r.detail}`);
}

main().catch((e) => {
  console.error("dry-run failed:", e);
  process.exit(1);
});
