// atproto OAuth sign-in (the browser flow humans expect).
//
// This implements the public-client half of the atproto OAuth profile:
//   1. startOAuth   — resolve the account's authorization server from its
//      handle (handle → DID → DID doc #atproto_pds → protected-resource
//      metadata → AS metadata), then POST a pushed authorization request
//      (PAR) signed with a fresh DPoP key + PKCE challenge.
//   2. completeOAuth — exchange the authorization code at the token
//      endpoint (DPoP + PKCE verifier). The token response `sub` is the
//      user's DID — that is all we need for sign-in; the access token is
//      deliberately discarded (we never act on the user's PDS).
//
// Per-request secrets (PKCE verifier, DPoP private JWK) live in KV under
// `oauthstate:<state>` with a 10-minute TTL and are deleted on first use —
// same single-use semantics as the DID challenge nonces.

import { resolveHandle, resolvePdsEndpoint } from "./pds";

const STATE_PREFIX = "oauthstate:";
const STATE_TTL_SEC = 600;
const DEFAULT_AUTH_SERVER = "https://bsky.social";

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  parEndpoint: string;
}

interface AuthServerMetadataDoc {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  pushed_authorization_request_endpoint?: string;
}

interface ProtectedResourceDoc {
  authorization_servers?: string[];
}

export interface OAuthState {
  codeVerifier: string;
  dpopPrivateJwk: JsonWebKey;
  dpopPublicJwk: JsonWebKey;
  issuer: string;
  tokenEndpoint: string;
  /**
   * Validated cross-app redirect target (e.g. wp-cloud SSO). When set, the
   * callback issues a short-lived `dg_token` handoff JWT instead of only
   * landing on /auth/account. Allowlist-checked in the start route.
   */
  returnTo?: string;
}

export type StartResult = { ok: true; redirectUrl: string } | { ok: false; error: string };
export type CompleteResult = { ok: true; did: string } | { ok: false; error: string };

/** Discover the authorization server that owns `handle` (defaults to bsky.social). */
async function resolveAuthServer(
  env: Env,
  handle?: string
): Promise<AuthServerMetadata | undefined> {
  let issuer = DEFAULT_AUTH_SERVER;
  if (handle) {
    const did = await resolveHandle(env, handle);
    if (!did) return undefined;
    const pds = await resolvePdsEndpoint(env, did);
    if (pds) {
      const prm = (await fetchJson(`${pds}/.well-known/oauth-protected-resource`)) as
        | ProtectedResourceDoc
        | undefined;
      issuer = prm?.authorization_servers?.[0] ?? issuer;
    }
  }
  return await fetchAsMetadata(issuer);
}

async function fetchAsMetadata(issuer: string): Promise<AuthServerMetadata | undefined> {
  const doc = (await fetchJson(`${issuer}/.well-known/oauth-authorization-server`)) as
    | AuthServerMetadataDoc
    | undefined;
  if (
    !doc?.issuer ||
    !doc.authorization_endpoint ||
    !doc.token_endpoint ||
    !doc.pushed_authorization_request_endpoint
  ) {
    return undefined;
  }
  return {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    parEndpoint: doc.pushed_authorization_request_endpoint,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return await res.json().catch(() => undefined);
}

// --- PKCE / DPoP --------------------------------------------------------

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", te.encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

interface DpopKeyMaterial {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/** Fresh extractable P-256 pair; public JWK carries only RFC 7518 members. */
async function generateDpopKey(): Promise<DpopKeyMaterial> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateJwk,
    publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } as JsonWebKey,
  };
}

/** ES256 dpop+jwt proof — WebCrypto emits raw r||s, which is exactly JWS. */
async function dpopProof(
  material: DpopKeyMaterial,
  htm: string,
  htu: string,
  nonce?: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    material.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: material.publicJwk };
  const payload: Record<string, string | number> = {
    jti: crypto.randomUUID(),
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  const signingInput = `${b64url(te.encode(JSON.stringify(header)))}.${b64url(
    te.encode(JSON.stringify(payload))
  )}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    te.encode(signingInput) as BufferSource
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// --- state store ----------------------------------------------------------

/** Single-use read: the state is deleted on first retrieval. */
export async function takeOAuthState(
  kv: KVNamespace,
  nonce: string
): Promise<OAuthState | undefined> {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return undefined;
  const key = `${STATE_PREFIX}${nonce}`;
  const raw = await kv.get(key);
  if (raw === null) return undefined;
  await kv.delete(key);
  try {
    return JSON.parse(raw) as OAuthState;
  } catch {
    return undefined;
  }
}

// --- flow ---------------------------------------------------------------------

/**
 * Run the PAR half of the flow. Returns the authorization URL the browser
 * should be redirected to. The caller stashes the returned OAuthState in KV
 * under the `state` nonce embedded in the PAR.
 */
export async function startOAuth(opts: {
  env: Env;
  kv: KVNamespace;
  origin: string;
  handle?: string;
  returnTo?: string;
}): Promise<StartResult> {
  const as = await resolveAuthServer(opts.env, opts.handle);
  if (!as) return { ok: false, error: "authorization-server-unresolved" };

  const pkce = await generatePkce();
  const dpop = await generateDpopKey();
  const clientId = `${opts.origin}/client-metadata.json`;
  const redirectUri = `${opts.origin}/auth/oauth/callback`;
  const stateNonce = crypto.randomUUID().replace(/-/g, "");

  const parBody = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: stateNonce,
    scope: "atproto",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  if (opts.handle) parBody.set("login_hint", opts.handle);

  // PAR can demand a DPoP nonce; retry once when the AS asks for one.
  let nonce: string | undefined;
  let requestUri: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(as.parEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        DPoP: await dpopProof(dpop, "POST", as.parEndpoint, nonce),
      },
      body: parBody.toString(),
    }).catch(() => undefined);
    if (!res) return { ok: false, error: "par-request-failed" };
    const body = (await res.json().catch(() => undefined)) as
      | { request_uri?: string; error?: string }
      | undefined;
    const nonceHeader = res.headers.get("DPoP-Nonce") ?? undefined;
    if (res.ok && body?.request_uri) {
      requestUri = body.request_uri;
      break;
    }
    if (body?.error === "use_dpop_nonce" && nonceHeader) {
      nonce = nonceHeader;
      continue;
    }
    return { ok: false, error: `par-${body?.error ?? res.status}` };
  }
  if (!requestUri) return { ok: false, error: "par-no-request-uri" };

  const state: OAuthState = {
    codeVerifier: pkce.verifier,
    dpopPrivateJwk: dpop.privateJwk,
    dpopPublicJwk: dpop.publicJwk,
    issuer: as.issuer,
    tokenEndpoint: as.tokenEndpoint,
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
  };
  await opts.kv.put(`${STATE_PREFIX}${stateNonce}`, JSON.stringify(state), {
    expirationTtl: STATE_TTL_SEC,
  });

  const redirect = new URL(as.authorizationEndpoint);
  redirect.searchParams.set("client_id", clientId);
  redirect.searchParams.set("request_uri", requestUri);
  return { ok: true, redirectUrl: redirect.toString() };
}

/** Exchange the callback code for the identity (`sub` DID). */
export async function completeOAuth(opts: {
  origin: string;
  code: string;
  state: OAuthState;
}): Promise<CompleteResult> {
  const dpop: DpopKeyMaterial = {
    privateJwk: opts.state.dpopPrivateJwk,
    publicJwk: opts.state.dpopPublicJwk,
  };
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: `${opts.origin}/auth/oauth/callback`,
    code_verifier: opts.state.codeVerifier,
    client_id: `${opts.origin}/client-metadata.json`,
  });

  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(opts.state.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        DPoP: await dpopProof(dpop, "POST", opts.state.tokenEndpoint, nonce),
      },
      body: body.toString(),
    }).catch(() => undefined);
    if (!res) return { ok: false, error: "token-request-failed" };
    const parsed = (await res.json().catch(() => undefined)) as
      | { sub?: string; error?: string }
      | undefined;
    const nonceHeader = res.headers.get("DPoP-Nonce") ?? undefined;
    if (res.ok && parsed?.sub && parsed.sub.startsWith("did:")) {
      return { ok: true, did: parsed.sub };
    }
    if (parsed?.error === "use_dpop_nonce" && nonceHeader) {
      nonce = nonceHeader;
      continue;
    }
    return { ok: false, error: `token-${parsed?.error ?? res.status}` };
  }
  return { ok: false, error: "token-exchange-failed" };
}
