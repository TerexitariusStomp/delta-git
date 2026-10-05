import { Router } from "itty-router";
import type { Env } from "./env";
import { deployFromGit } from "./deploygit";

// Delta-git webhook receiver — push events redeploy forge-backed sites.
//
// Subscriptions are registered per-repo on the forge
// (POST /api/:owner/:repo/dg/webhooks, events:["push"], secret=DEPLOY_HOOK_SECRET)
// and delivered with Standard Webhooks headers:
//   webhook-id, webhook-timestamp, webhook-signature: v1,<b64 hmac-sha256>
// signature covers `${id}.${ts}.${rawBody}`.
//
// A site opts into push-deploys by having source = "git:<repo>@<ref>" (set by
// deploy-git). On push to the matching branch we re-pull the archive — the
// site content always reflects the repo, not webhook payload bytes.

export const hooks = Router();

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

const te = new TextEncoder();
const SKEW_S = 300;

async function hmacB64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function branchOfRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

hooks.post("/api/hooks/deploy", async (req, env: Env) => {
  if (!env.DEPLOY_HOOK_SECRET) return json({ error: "webhooks not configured" }, 503);

  const raw = await req.text();
  const id = req.headers.get("webhook-id") ?? "";
  const ts = Number(req.headers.get("webhook-timestamp") ?? "0");
  const presented = req.headers.get("webhook-signature") ?? "";

  if (!id || !ts || Math.abs(Date.now() / 1000 - ts) > SKEW_S)
    return json({ error: "stale or missing webhook headers" }, 401);

  const expected = `v1,${await hmacB64(env.DEPLOY_HOOK_SECRET, `${id}.${ts}.${raw}`)}`;
  // Constant-time compare — signatures are fixed-length `v1,<b64>` here.
  let diff = presented.length === expected.length ? 0 : 1;
  for (let i = 0; i < expected.length; i++) {
    diff |= (presented.charCodeAt(i) ^ expected.charCodeAt(i)) || 0;
  }
  if (diff) return json({ error: "bad signature" }, 401);

  const event = JSON.parse(raw) as { type?: string; data?: { repo?: string; ref?: string; oid?: string } };
  if (event.type !== "push" || !event.data?.repo || !event.data?.ref || !event.data?.oid)
    return json({ ok: true, skipped: "not a push event" });

  const { repo, ref, oid } = event.data;
  const branch = branchOfRef(ref);
  const sites = await env.DB.prepare(
    "SELECT id, owner_did, preview_host, manifest_sha FROM sites WHERE source=?"
  ).bind(`git:${repo}@${branch}`).all<{ id: string; owner_did: string; preview_host: string; manifest_sha: string | null }>();

  const results = [];
  for (const site of sites.results) {
    // Idempotent: if this site is already on the pushed commit, skip.
    if (site.manifest_sha === oid) { results.push({ id: site.id, skipped: "already-current" }); continue; }
    const out = await deployFromGit(env, site, repo, branch, site.owner_did);
    results.push({ id: site.id, ...(out.ok ? { ok: true, sha: out.sha } : { ok: false, error: out.error }) });
  }
  return json({ ok: true, repo, ref, oid, sites: results });
});
