#!/usr/bin/env node
// Seed the deployed worker with the site's own source repository:
//   namespace `rooted-finance` + public repo `git-on-cloudflare` + a push PAT
//   + the KV route record. Run AFTER `wrangler d1 migrations apply
//   git-on-cloudflare --remote` (the tables must exist).
//
//   node tools/seed-prod.mjs                      # dry run — print SQL, KV record, PAT
//   node tools/seed-prod.mjs --apply              # wrangler d1 execute --remote + kv put
//   node tools/seed-prod.mjs --repo wp-cloud      # seed a different repo slug
//
// The seed user's `tessera_sub` and the namespace's `owner_did` are set to the
// handle owner's DID, so a later DID sign-in resolves to the same `users` row
// and inherits the namespace/repo automatically. The PAT authenticates `git
// push` over Basic auth before that first sign-in (username = namespace slug).

import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";

const apply = process.argv.includes("--apply");
const didFlagIndex = process.argv.indexOf("--did");
const ownerDid =
  didFlagIndex >= 0 ? process.argv[didFlagIndex + 1] : "did:plc:umsyxt3vt2uysqeebatedd3i";
const repoFlagIndex = process.argv.indexOf("--repo");
const nsSlug = "rooted-finance";
const repoSlug =
  repoFlagIndex >= 0 ? process.argv[repoFlagIndex + 1] : "git-on-cloudflare";
const doName = `${nsSlug}/${repoSlug}`;
const dbName = "git-on-cloudflare";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function toBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const hexId = (prefix) => `${prefix}_${randomBytes(16).toString("hex")}`;
const patId = hexId("pat");
const patPrefix = `goc_${randomBytes(4).toString("hex")}`;
const patPlaintext = `${patPrefix}_${toBase32(randomBytes(20)).slice(0, 32)}`;
const patHash = createHash("sha256").update(patPlaintext, "utf8").digest("hex");
const now = Date.now();

// Reuse existing rows on repeat runs: the users/namespaces INSERT OR IGNORE
// would no-op, leaving FK references (created_by, namespace_id) pointing at
// never-created ids. Look them up first on --apply.
function d1(query) {
  const out = execFileSync(
    "wrangler",
    ["d1", "execute", dbName, "--remote", "--command", query, "--json"],
    { stdio: ["ignore", "pipe", "inherit"] }
  ).toString();
  return JSON.parse(out)[0]?.results ?? [];
}

let userId, nsId;
if (apply) {
  userId = d1(`SELECT id FROM users WHERE tessera_sub = '${ownerDid}'`)[0]?.id;
  nsId = d1(`SELECT id FROM namespaces WHERE slug = '${nsSlug}'`)[0]?.id;
}
userId ??= hexId("user");
nsId ??= hexId("ns");
const repoId = hexId("repo");

const sql = [
  `INSERT OR IGNORE INTO users (id, tessera_sub, created_at) VALUES ('${userId}', '${ownerDid}', ${now});`,
  `INSERT OR IGNORE INTO namespaces (id, slug, created_by, owner_did, created_at) VALUES ('${nsId}', '${nsSlug}', '${userId}', '${ownerDid}', ${now});`,
  `INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, created_at) VALUES ('${nsId}', '${userId}', ${now});`,
  `INSERT OR IGNORE INTO repositories (id, namespace_id, created_by, slug, do_name, visibility, created_at, updated_at) VALUES ('${repoId}', '${nsId}', '${userId}', '${repoSlug}', '${doName}', 'public', ${now}, ${now});`,
  `INSERT OR IGNORE INTO personal_access_tokens (id, user_id, name, prefix, hash, created_at) VALUES ('${patId}', '${userId}', 'seed-push', '${patPrefix}', '${patHash}', ${now});`,
  `INSERT OR IGNORE INTO pat_namespace_grants (pat_id, namespace_id, level) VALUES ('${patId}', '${nsId}', 'push');`,
].join("\n");

const routeRecord = JSON.stringify({
  repositoryId: repoId,
  namespaceId: nsId,
  doName,
  updatedAt: now,
});
const routeKey = `repo-route:v1:${doName}`;

console.log("--- seed SQL ---");
console.log(sql);
console.log("\n--- KV route record ---");
console.log(`${routeKey} => ${routeRecord}`);
console.log(`\n--- PAT (shown once) ---\n${patPlaintext}`);

if (apply) {
  const tmp = `/tmp/delta-git-seed-${now}.sql`;
  writeFileSync(tmp, sql);
  try {
    console.log("\n--- applying to remote D1 ---");
    execFileSync("wrangler", ["d1", "execute", dbName, "--remote", "--file", tmp], {
      stdio: "inherit",
    });
    console.log("--- writing KV route record ---");
    execFileSync(
      "wrangler",
      ["kv", "key", "put", routeKey, routeRecord, "--binding", "ROUTES", "--remote"],
      { stdio: "inherit" }
    );
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(
    `\nDone. Push the site source with:\n  git push https://${nsSlug}:${patPlaintext}@git-on-cloudflare.delta-git.workers.dev/${doName} main:main`
  );
} else {
  console.log("\nDry run — re-run with --apply to write to remote D1 + KV.");
}
