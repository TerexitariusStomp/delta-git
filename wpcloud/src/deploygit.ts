import { Router } from "itty-router";
import { createTarDecoder } from "modern-tar";
import type { Env } from "./env";
import { whoami } from "./auth";
import { planFor } from "./plans";
import { storageUsed } from "./admin";
import { previewUrl } from "./api";

// Forge-backed deploys — publish a site straight from a delta-git repo.
//
//   POST /api/sites/:id/deploy-git { repo: "owner/slug", ref?: "main", prefix?: "sub/dir" }
//
// Fetches the forge's tar archive (GET /<repo>/-/archive/<ref>.tar), unpacks
// it into R2 under sites/{id}/artifacts/<commit>/, records the manifest, and
// flips the site to it. No client-side R2 credentials needed — the forge is
// the artifact source. Public repos fetch anonymously; FORGE_PAT unlocks
// private repos for repos this site owner controls.
//
// sites.source becomes "git:<repo>@<ref>" — the webhook receiver
// (/api/hooks/deploy) matches on that prefix to redeploy on push.

export const deploygit = Router();

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const te = new TextEncoder();

const MAX_FILES = 5_000;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

// Tar paths must stay inside the archive root — reject traversal and
// absolute paths rather than trying to rescue them.
function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? te.encode(data) : (data as unknown as BufferSource);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deployFromGit(
  env: Env,
  site: { id: string; preview_host: string },
  repo: string,
  ref: string,
  ownerDid: string,
  prefix?: string
): Promise<{ ok: true; sha: string; commit: string | null; files: number; url: string } | { ok: false; status: number; error: string }> {
  if (!env.FORGE_URL) return { ok: false, status: 503, error: "forge not configured" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, status: 400, error: "repo must be owner/slug" };
  if (!ref || /[\0-\x20]/.test(ref) || ref.includes("..")) return { ok: false, status: 400, error: "bad ref" };
  const root = prefix ? cleanPath(prefix) : null;
  if (prefix && !root) return { ok: false, status: 400, error: "bad prefix" };

  const url = `${env.FORGE_URL}/${repo}/-/archive/${encodeURIComponent(ref)}.tar`;
  const headers: Record<string, string> = { accept: "application/x-tar" };
  if (env.FORGE_PAT) headers.authorization = `Basic ${btoa(`${repo.split("/")[0]}:${env.FORGE_PAT}`)}`;

  // Service binding first — workers.dev hosts can't be subrequested from a
  // Worker (CF error 1042); plain fetch stays as the dev/custom-domain path.
  const res = env.FORGE ? await env.FORGE.fetch(url, { headers }) : await fetch(url, { headers });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, status: 502, error: `archive fetch failed: ${res.status} ${detail}` };
  }
  const commit = res.headers.get("x-archive-commit");

  const files: { path: string; size: number; sha: string }[] = [];
  let bytesTotal = 0;
  // modern-tar's streaming decoder handles ustar prefixes, GNU longname/
  // longlink and PAX headers — only regular files carry content through.
  const entries = res.body.pipeThrough(createTarDecoder()).getReader();
  for (;;) {
    const { value: e, done } = await entries.read();
    if (done) break;
    let path = cleanPath(e.header.name);
    if (!path) continue;
    // prefix deploys only keep files under <root>/, re-rooted at "/".
    if (root) {
      if (!path.startsWith(`${root}/`)) continue;
      path = path.slice(root.length + 1);
      if (!path) continue;
    }
    // dirs/symlinks carry no content — the artifact model is files only
    if (e.header.type !== "file") continue;
    if (e.header.size > MAX_FILE) return { ok: false, status: 413, error: "file too large" };
    bytesTotal += e.header.size;
    if (bytesTotal > MAX_BYTES) return { ok: false, status: 413, error: "archive too large" };
    if (files.length >= MAX_FILES) return { ok: false, status: 413, error: "too many files" };
    const body = await new Response(e.body).arrayBuffer().then((b) => new Uint8Array(b)).catch(() => null);
    if (!body) return { ok: false, status: 502, error: "truncated archive" };
    const sha = await sha256Hex(body);
    files.push({ path, size: e.header.size, sha });
    await env.ARTIFACTS.put(`sites/${site.id}/artifacts/${commit ?? "head"}/${path}`, body);
  }
  if (!files.length) return { ok: false, status: 422, error: "archive contained no files" };

  // Same manifest scheme as browser publish: sha over sorted path:size:contentSha.
  const manifestSha = await sha256Hex(files.map((f) => `${f.path}:${f.size}:${f.sha}`).sort().join("\n"));
  const artifactSha = commit ?? manifestSha;

  const user = await env.DB.prepare("SELECT plan FROM users WHERE did=?").bind(ownerDid).first<{ plan: string }>();
  const cap = planFor(user).storage_mb * 1024 * 1024;
  if ((await storageUsed(env, site.id)) + bytesTotal > cap)
    return { ok: false, status: 402, error: "storage_quota" };

  // If we wrote under "head" (no commit header), rename isn't possible — put
  // under the manifest sha instead for content-addressed consistency.
  if (!commit) {
    for (const f of files) {
      const src = `sites/${site.id}/artifacts/head/${f.path}`;
      const dst = `sites/${site.id}/artifacts/${manifestSha}/${f.path}`;
      const obj = await env.ARTIFACTS.get(src);
      if (obj) { await env.ARTIFACTS.put(dst, obj.body); await env.ARTIFACTS.delete(src); }
    }
  }

  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO manifests(site_id, sha, file_count, bytes_total, created_at) VALUES(?,?,?,?,unixepoch())")
      .bind(site.id, artifactSha, files.length, bytesTotal),
    // source encodes repo@ref plus the deploy prefix so redeploys (webhook
    // or forgeSync) reuse the same subtree — source = git:<repo>@<ref>[#<prefix>]
    env.DB.prepare("UPDATE sites SET manifest_sha=?, source=? WHERE id=?")
      .bind(artifactSha, `git:${repo}@${ref}${root ? `#${root}` : ""}`, site.id),
  ]);

  return { ok: true, sha: artifactSha, commit, files: files.length, url: previewUrl(env, site) };
}

// Cron sweep — redeploys forge-backed sites whose ref moved.
//
// Signed delta-git webhooks are the fast path, but they can only deliver to a
// custom domain (workers.dev blocks inbound Worker subrequests too), so the
// 5-minute cron also polls ref→commit via the FORGE service binding and
// redeploys on drift. Idempotent: manifest_sha holds the deployed commit.
export async function forgeSync(env: Env): Promise<void> {
  if (!env.FORGE || !env.FORGE_URL) return;
  const sites = await env.DB.prepare(
    "SELECT id, owner_did, preview_host, manifest_sha, source FROM sites WHERE source LIKE 'git:%' AND status<>'archived'"
  ).all<{ id: string; owner_did: string; preview_host: string; manifest_sha: string | null; source: string }>();
  for (const site of sites.results) {
    try {
      // source = git:<repo>@<ref>[#<prefix>]
      const m = /^git:([\w.-]+\/[\w.-]+)@([^#]+)(?:#(.+))?$/.exec(site.source);
      if (!m) continue;
      const [, repo, ref, prefix] = m;
      const headers: Record<string, string> = {};
      if (env.FORGE_PAT) headers.authorization = `Basic ${btoa(`${repo.split("/")[0]}:${env.FORGE_PAT}`)}`;
      const res = await env.FORGE.fetch(`${env.FORGE_URL}/${repo}/-/resolve/${encodeURIComponent(ref)}`, { headers });
      if (!res.ok) continue;
      const { commit } = (await res.json()) as { commit?: string };
      if (!commit || commit === site.manifest_sha) continue;
      await deployFromGit(env, site, repo, ref, site.owner_did, prefix);
    } catch {
      // Per-site failure must not stall the sweep — next tick retries.
    }
  }
}

deploygit.post("/api/sites/:id/deploy-git", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const site = await env.DB.prepare("SELECT id, owner_did, preview_host FROM sites WHERE id=? AND owner_did=?")
    .bind(req.params!.id, did).first<{ id: string; owner_did: string; preview_host: string }>();
  if (!site) return json({ error: "not found" }, 404);
  const { repo, ref = "main", prefix } = await req.json().catch(() => ({})) as { repo?: string; ref?: string; prefix?: string };
  if (!repo) return json({ error: "repo required" }, 400);
  const out = await deployFromGit(env, site, repo, ref, did, prefix);
  return out.ok ? json(out) : json({ error: out.error }, out.status);
});
