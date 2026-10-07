#!/usr/bin/env tsx
/**
 * Live git-protocol smoke against a running dev server — exercises the real
 * TCP socket a `git` binary talks to, not the vitest pool:
 *
 *   seed (wrangler d1 --local) → clone empty repo → push a commit →
 *   clone --depth 1 → clone --filter=blob:none → bundle-uri fetch →
 *   gh api (token-scheme PAT lane)
 *
 * Usage:
 *   npm run dev            # in another shell — vite dev on :5173
 *   npx tsx scripts/smoke-git.ts
 *
 * Environment:
 *   DG_BASE_URL   default http://localhost:5173
 *   DG_OWNER      namespace slug  (default smoke-ns)
 *   DG_REPO       repo slug       (default smoke-repo)
 *   DG_KEEP_TMP   set to keep the clone workdir for inspection
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newPrefixedId } from "../src/worker/common/ids";
import { generatePatPlaintext, hashPatPlaintext } from "../src/worker/auth/pat";

const BASE = (process.env.DG_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const OWNER = process.env.DG_OWNER ?? "smoke-ns";
// Fresh slug per run keeps the push/clone sequence deterministic even when
// re-run against the same persist dir.
const REPO = process.env.DG_REPO ?? `smoke-${Date.now().toString(36)}`;
// When the dev server runs with a non-default state dir (e.g.
// `wrangler dev --persist-to /tmp/dg-smoke-state`), the d1 execute must
// target the same dir or the seed lands in the wrong database.
const PERSIST = process.env.DG_PERSIST ?? "";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

async function main() {
  // 0. Dev server up? Any HTTP response proves the socket; the SPA fallback
  // answers unknown paths too, so we don't assert a specific status.
  try {
    await fetch(BASE);
  } catch {
    console.error(`dev server not reachable at ${BASE} — run \`wrangler dev\` first`);
    process.exit(2);
  }

  // 1. Apply migrations, then seed: user + namespace + membership + PAT
  // (+push grant) + repo row. Idempotent — INSERT OR IGNORE throughout.
  run("npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    ...(PERSIST ? ["--persist-to", PERSIST] : []),
  ]);
  // Deterministic ids keep the seed idempotent across re-runs; the PAT id
  // stays random so its fresh hash always lands (stale PATs accumulate
  // harmlessly in the local dev db).
  const userId = `user_smoke_${OWNER}`;
  const now = Date.now();
  const pat = generatePatPlaintext();
  const patHash = await hashPatPlaintext(pat.plaintext);
  const patId = newPrefixedId("pat");

  const sqlFile = join(mkdtempSync(join(tmpdir(), "dg-smoke-sql-")), "seed.sql");
  writeFileSync(
    sqlFile,
    [
      `INSERT OR IGNORE INTO users (id, tessera_sub, created_at) VALUES ('${userId}', 'smoke-${userId}', ${now});`,
      `INSERT OR IGNORE INTO namespaces (id, slug, created_by, created_at) VALUES ('ns_smoke_${OWNER}', '${OWNER}', '${userId}', ${now});`,
    ].join("\n")
  );
  const d1 = (...args: string[]) =>
    run("npx", ["wrangler", "d1", "execute", "DB", "--local", ...args]);
  const d1Json = (query: string): { id: string }[] => {
    const out = d1("--command", query, "--json", ...(PERSIST ? ["--persist-to", PERSIST] : []));
    return JSON.parse(out)[0]?.results ?? [];
  };
  d1("--file", sqlFile, ...(PERSIST ? ["--persist-to", PERSIST] : []));
  // Resolve the namespace id back — an existing row (INSERT OR IGNORE) keeps
  // its original id, so we cannot assume ours.
  const nsId = d1Json(`SELECT id FROM namespaces WHERE slug = '${OWNER}'`)[0]?.id;
  if (!nsId) throw new Error("seed: namespace row missing after insert");
  writeFileSync(
    sqlFile,
    [
      `INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, created_at) VALUES ('${nsId}', '${userId}', ${now});`,
      `INSERT INTO personal_access_tokens (id, user_id, name, prefix, hash, created_at) VALUES ('${patId}', '${userId}', 'smoke-push', '${pat.publicPrefix}', '${patHash}', ${now});`,
      `INSERT OR IGNORE INTO pat_namespace_grants (pat_id, namespace_id, level) VALUES ('${patId}', '${nsId}', 'push');`,
      `INSERT OR IGNORE INTO repositories (id, namespace_id, created_by, slug, do_name, visibility, created_at, updated_at) VALUES ('repo_smoke_${REPO}', '${nsId}', '${userId}', '${REPO}', '${OWNER}/${REPO}', 'public', ${now}, ${now});`,
    ].join("\n")
  );
  d1("--file", sqlFile, ...(PERSIST ? ["--persist-to", PERSIST] : []));
  const repoId = d1Json(
    `SELECT id FROM repositories WHERE namespace_id = '${nsId}' AND slug = '${REPO}'`
  )[0]?.id;
  if (!repoId) throw new Error("seed: repository row missing after insert");
  // Anonymous git reads resolve via the ROUTES KV candidate cache — D1
  // fallback is deliberately off the unauthenticated path.
  run("npx", [
    "wrangler",
    "kv",
    "key",
    "put",
    "--binding",
    "ROUTES",
    "--local",
    `repo-route:v1:${OWNER}/${REPO}`,
    JSON.stringify({
      repositoryId: repoId,
      namespaceId: nsId,
      doName: `${OWNER}/${REPO}`,
      updatedAt: now,
    }),
    ...(PERSIST ? ["--persist-to", PERSIST] : []),
  ]);
  console.log(`seeded ${OWNER}/${REPO} (pat ${pat.publicPrefix}…)`);

  const authed = BASE.replace("://", `://${OWNER}:${pat.plaintext}@`);
  const cloneUrl = `${authed}/${OWNER}/${REPO}`;
  const tmp = mkdtempSync(join(tmpdir(), "dg-smoke-"));

  try {
    // 2. Clone the empty repo — exercises info/refs + ls-refs on an empty DO.
    let out = run("git", ["clone", cloneUrl, join(tmp, "empty")], { env: { GIT_TRACE: "" } });
    check("clone empty repo", true);

    // 3. Commit + push — real git binary drives git-receive-pack.
    const wc = join(tmp, "empty");
    run("git", ["config", "user.email", "smoke@test.local"], { cwd: wc });
    run("git", ["config", "user.name", "Smoke"], { cwd: wc });
    writeFileSync(join(wc, "README.md"), "# smoke\n");
    run("git", ["add", "README.md"], { cwd: wc });
    run("git", ["commit", "-m", "smoke: initial"], { cwd: wc });
    out = run("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: wc });
    check("push initial commit", true);

    // Second commit so shallow depth is observable.
    writeFileSync(join(wc, "second.txt"), "two\n");
    run("git", ["add", "second.txt"], { cwd: wc });
    run("git", ["commit", "-m", "smoke: second"], { cwd: wc });
    run("git", ["push"], { cwd: wc });
    check("push second commit", true);

    // 4. Shallow clone — --depth 1 must produce exactly one commit.
    out = run("git", ["clone", "--depth", "1", cloneUrl, join(tmp, "shallow")]);
    const count = run("git", ["rev-list", "--count", "HEAD"], { cwd: join(tmp, "shallow") }).trim();
    check("clone --depth 1", count === "1", `rev-list count ${count}`);

    // 5. Partial clone — --filter=blob:none must succeed (server-side filter).
    out = run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      cloneUrl,
      join(tmp, "filtered"),
    ]);
    check("clone --filter=blob:none", true);

    // 6. bundle-uri — capability advertised; clone straight off the bundle
    // endpoint (creationToken is the HEAD oid) and verify the object count.
    const infoRefs = run("curl", [
      "-sf",
      `${BASE}/${OWNER}/${REPO}/info/refs?service=git-upload-pack`,
    ]);
    check("info/refs advertises bundle-uri", infoRefs.includes("bundle-uri"));
    const headOid = run("git", ["rev-parse", "HEAD"], { cwd: wc }).trim();
    const bundleUrl = `${authed}/${OWNER}/${REPO}/bundle/${headOid}`;
    run("git", ["clone", "--bundle-uri", bundleUrl, cloneUrl, join(tmp, "bundled")]);
    const bundled = run("git", ["rev-list", "--count", "HEAD"], {
      cwd: join(tmp, "bundled"),
    }).trim();
    check("clone via bundle-uri", bundled === "2", `rev-list count ${bundled}`);

    // 6b. push-option — lands on the push.received op-log entry. Push a new
    // ref: an up-to-date push never contacts receive-pack.
    run("git", ["push", "-o", "smoke-opt=1", "origin", "HEAD:refs/heads/smoke-opt"], { cwd: wc });
    const oplog = run("curl", ["-sf", `${BASE}/api/${OWNER}/${REPO}/dg/oplog`]);
    check("push-option recorded in op-log", oplog.includes("smoke-opt=1"));

    // 7. gh-CLI wire contract — `gh` hard-requires TLS even on localhost, so
    // a plaintext dev port can't host it; verify the exact request shape it
    // sends (`Authorization: token <pat>` against /api/v3) instead.
    try {
      const v3 = run("curl", [
        "-sf",
        "-H",
        `Authorization: token ${pat.plaintext}`,
        `${BASE}/api/v3/repos/${OWNER}/${REPO}`,
      ]);
      check("v3 repos/{o}/{r} (gh token lane)", v3.includes(`"${REPO}"`));
    } catch (e) {
      check("v3 repos/{o}/{r} (gh token lane)", false, String(e).slice(0, 200));
    }
  } finally {
    if (!process.env.DG_KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
    else console.log(`workdir kept: ${tmp}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
