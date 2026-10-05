import { Router } from "itty-router";
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
const td = new TextDecoder();

const MAX_FILES = 5_000;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

// ---- tar reader (ustar + GNU longname/longlink) ----

class TarReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  private done = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf); next.set(value, this.buf.length);
      this.buf = next;
    }
    return this.buf.length >= n;
  }

  private take(n: number): Uint8Array {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private octal(h: Uint8Array, off: number, len: number): number {
    const s = td.decode(h.subarray(off, off + len)).replace(/\0.*$/s, "").trim();
    return s ? parseInt(s, 8) : 0;
  }

  private str(h: Uint8Array, off: number, len: number): string {
    const end = h.indexOf(0, off);
    return td.decode(h.subarray(off, end === -1 || end > off + len ? off + len : end));
  }

  /** Iterate file/dir entries; returns null entries for anything unreadable. */
  async *entries(): AsyncGenerator<{ name: string; type: string; size: number; link: string; body: Uint8Array | null }> {
    let longname: string | undefined;
    let longlink: string | undefined;
    for (;;) {
      if (!(await this.fill(512))) return;
      const h = this.take(512);
      if (h.every((b) => b === 0)) return; // end-of-archive
      const size = this.octal(h, 124, 12);
      const type = String.fromCharCode(h[156]);
      let name = this.str(h, 0, 100);
      const magic = this.str(h, 257, 5);
      if (magic === "ustar") {
        const prefix = this.str(h, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      let link = this.str(h, 157, 100);
      if (name) { name = longname ?? name; longname = undefined; }
      if (link) { link = longlink ?? link; longlink = undefined; }
      const body = size > 0 && (await this.fill(size)) ? this.take(size) : size === 0 ? new Uint8Array(0) : null;
      const pad = (512 - (size % 512)) % 512;
      if (pad && (await this.fill(pad))) this.take(pad);
      if (type === "L") { longname = body ? td.decode(body).replace(/\0+$/, "") : undefined; continue; }
      if (type === "K") { longlink = body ? td.decode(body).replace(/\0+$/, "") : undefined; continue; }
      if (type === "x" || type === "g") continue; // pax headers — body already consumed
      yield { name, type, size, link, body };
    }
  }
}

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
  const reader = new TarReader(res.body);
  for await (const e of reader.entries()) {
    let path = cleanPath(e.name);
    if (!path) continue;
    // prefix deploys only keep files under <root>/, re-rooted at "/".
    if (root) {
      if (!path.startsWith(`${root}/`)) continue;
      path = path.slice(root.length + 1);
      if (!path) continue;
    }
    // dirs/symlinks carry no content — the artifact model is files only
    if (e.type !== "0" && e.type !== "" && e.type !== "\0") continue;
    if (!e.body) return { ok: false, status: 502, error: "truncated archive" };
    if (e.size > MAX_FILE) return { ok: false, status: 413, error: "file too large" };
    bytesTotal += e.size;
    if (bytesTotal > MAX_BYTES) return { ok: false, status: 413, error: "archive too large" };
    if (files.length >= MAX_FILES) return { ok: false, status: 413, error: "too many files" };
    const sha = await sha256Hex(e.body);
    files.push({ path, size: e.size, sha });
    await env.ARTIFACTS.put(`sites/${site.id}/artifacts/${commit ?? "head"}/${path}`, e.body);
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
