import { Router } from "itty-router";
import type { Env } from "./env";
import { issueToken } from "./auth";

// delta-git SSO — one Bluesky sign-in covers both apps.
//
//   GET /auth/delta-git  → redirect into the forge's atproto OAuth with a
//                          return_to back here.
//   GET /auth/callback?dg_token=<jwt>  → verify the forge's handoff JWT
//                          (HS256, shared DG_SESSION_SECRET, aud="wpcloud"),
//                          upsert the DID user, mint a wp-cloud session token,
//                          and hand it to the SPA via a tiny completion page.
//
// The dg_token is short-lived and single-purpose (aud-bound). Revocation is
// exp-bound only — the forge's did_sessions jti check doesn't extend here.

export const sso = Router();

const te = new TextEncoder();

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verifyDgToken(env: Env, token: string): Promise<{ sub: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !env.DG_SESSION_SECRET) return null;
  const key = await crypto.subtle.importKey(
    "raw", te.encode(env.DG_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]) as BufferSource, te.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const claims = JSON.parse(td.decode(b64urlDecode(parts[1]))) as {
      sub?: string; aud?: string; exp?: number; iss?: string;
    };
    if (claims.aud !== "wpcloud" || !claims.sub?.startsWith("did:")) return null;
    if (!claims.exp || claims.exp < Date.now() / 1000) return null;
    return { sub: claims.sub };
  } catch { return null; }
}

const td = new TextDecoder();

sso.get("/auth/delta-git", (req, env: Env) => {
  if (!env.FORGE_URL) return new Response("forge not configured", { status: 503 });
  const appHost = env.APP_HOST ?? new URL(req.url).hostname;
  const returnTo = `https://${appHost}/auth/callback`;
  return Response.redirect(
    `${env.FORGE_URL}/auth/oauth/start?return_to=${encodeURIComponent(returnTo)}`, 302);
});

sso.get("/auth/callback", async (req, env: Env) => {
  const token = new URL(req.url).searchParams.get("dg_token") ?? "";
  const verified = token ? await verifyDgToken(env, token) : null;
  if (!verified) return new Response("sign-in failed — invalid or expired handoff", { status: 401 });

  await env.DB.prepare(
    "INSERT INTO users(did, deposit_salt, created_at) VALUES(?, abs(random()) % 900 + 1, unixepoch()) ON CONFLICT(did) DO NOTHING"
  ).bind(verified.sub).run();
  const wpcToken = await issueToken(env, verified.sub);

  // Token handoff page: the SPA keeps its session in localStorage, so the
  // callback lands here long enough to store it, then boots the app.
  return new Response(`<!doctype html><meta charset="utf-8"><title>wp-cloud</title>
<script>localStorage.setItem("wpc_token", ${JSON.stringify(wpcToken)}); location.replace("/");</script>
<body>signed in — redirecting…</body>`, { headers: { "content-type": "text/html" } });
});

// Unmatched /auth/* must return a Response — itty-router resolves undefined
// for misses, which the Workers runtime turns into a 500. Registered last so
// the real routes above still match first.
sso.all("*", () => new Response("not found", { status: 404 }));
