/**
 * OAuth 2.1 bearer lane — delta-git as its own authorization server.
 *
 * Powered by @cloudflare/workers-oauth-provider (MIT): it owns PKCE, code
 * exchange, refresh rotation, client registration (DCR + Client ID Metadata
 * Documents), and KV storage — where tokens and codes are kept only as
 * SHA-256 hashes and grant `props` are encrypted so only the token holder
 * can unwrap them. A KV/D1 dump therefore yields nothing usable.
 *
 * Sender constraint (RFC 9449, DPoP): clients that present a `DPoP` proof on
 * `/oauth/token` get their access token bound to that proof's key thumbprint
 * (`oauthdpop:at:<sha256(token)>` → jkt in OAUTH_KV). Bound tokens are
 * rejected at resource endpoints unless a fresh matching proof arrives —
 * a stolen token is useless without the client's private key. First-party
 * clients (dgit CLI, custody worker) always bind; third-party MCP clients
 * that can't DPoP still get hashed-at-rest, short-lived bearer tokens.
 *
 * Identity: tokens carry `props` = { userId, did, handle, namespace } set at
 * consent time, so an OAuth principal resolves to the same user/namespace
 * actor model as PATs and dg_session.
 */
import {
  OAuthAuthorizationServer,
  type OAuthAuthorizationServerOptions,
} from "@cloudflare/workers-oauth-provider";

import { verifyDpopProof } from "@/vendor/widespread/auth/dpop";
import { findMembership } from "@/worker/db/d1/dal/namespaces";
import type { Db } from "@/worker/db/d1/client";

/** Scope vocabulary — the contract consent screens render and gates check. */
export const OAUTH_SCOPES = {
  /** clone/fetch private repos, read APIs, MCP read tools */
  REPO_READ: "repo:read",
  /** push/receive-pack, repo create, mutations, MCP mutating tools */
  REPO_WRITE: "repo:write",
  /** refresh tokens */
  OFFLINE: "offline_access",
} as const;

export const OAUTH_SCOPES_SUPPORTED: string[] = [
  OAUTH_SCOPES.REPO_READ,
  OAUTH_SCOPES.REPO_WRITE,
  OAUTH_SCOPES.OFFLINE,
];

/** What the consent page shows for each scope. */
export const OAUTH_SCOPE_DESCRIPTIONS: Record<string, string> = {
  [OAUTH_SCOPES.REPO_READ]: "Read and clone repositories you can access",
  [OAUTH_SCOPES.REPO_WRITE]: "Push to repositories and create or change content",
  [OAUTH_SCOPES.OFFLINE]: "Stay connected without re-authorizing",
};

/**
 * The single resource identifier this forge protects: the origin itself.
 * One token audience covers /mcp, /api/*, and Git Smart HTTP so agents hold
 * one credential for the whole surface.
 */
export function oauthResource(origin: string): string {
  return origin;
}

/** Props stashed on the grant at consent; surfaced by validateToken(). */
export interface OAuthTokenProps {
  userId: string;
  did?: string;
  handle?: string;
  namespace?: string;
}

/** Scope check with write⊃read subsumption: a writer can always read. */
export function hasOAuthScope(
  scopes: string[],
  required: typeof OAUTH_SCOPES.REPO_READ | typeof OAUTH_SCOPES.REPO_WRITE
): boolean {
  if (required === OAUTH_SCOPES.REPO_READ) {
    return scopes.includes(OAUTH_SCOPES.REPO_READ) || scopes.includes(OAUTH_SCOPES.REPO_WRITE);
  }
  return scopes.includes(OAUTH_SCOPES.REPO_WRITE);
}

export interface OAuthPrincipal {
  userId: string;
  did?: string;
  handle?: string;
  namespace?: string;
  scopes: string[];
  clientId: string;
  /** true when the access token required a matching DPoP proof */
  dpopBound: boolean;
}

// One AS per issuer origin (multi-host support if custom domains land later).
const serverByIssuer = new Map<string, OAuthAuthorizationServer<Env>>();

export function getAuthorizationServer(origin: string): OAuthAuthorizationServer<Env> {
  let server = serverByIssuer.get(origin);
  if (!server) {
    const options: OAuthAuthorizationServerOptions<Env> = {
      issuer: origin,
      authorizeEndpoint: `${origin}/oauth/authorize`,
      tokenEndpoint: `${origin}/oauth/token`,
      clientRegistrationEndpoint: `${origin}/oauth/register`,
      resources: [oauthResource(origin)],
      defaultResource: oauthResource(origin),
      scopesSupported: OAUTH_SCOPES_SUPPORTED,
      // Agents carry no client_secret — their client_id is an HTTPS metadata
      // document URL, the same URL-as-client pattern atproto uses.
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 24 * 3600,
    };
    server = new OAuthAuthorizationServer<Env>(options);
    serverByIssuer.set(origin, server);
  }
  return server;
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const OAUTH_DPOP_ACCESS_PREFIX = "oauthdpop:at:";
export const OAUTH_DPOP_REFRESH_PREFIX = "oauthdpop:rt:";

/** Record the DPoP key binding for freshly issued tokens. Called by the
 *  /oauth/token wrapper after a successful token response. */
export async function bindTokensToDpopJkt(
  env: Env,
  accessToken: string,
  refreshToken: string | undefined,
  jkt: string
): Promise<void> {
  await env.OAUTH_KV.put(OAUTH_DPOP_ACCESS_PREFIX + (await sha256Hex(accessToken)), jkt, {
    // Access tokens outlive their binding entry only if the entry TTL
    // expires early — keep margin over accessTokenTTL.
    expirationTtl: 7200,
  });
  if (refreshToken) {
    await env.OAUTH_KV.put(OAUTH_DPOP_REFRESH_PREFIX + (await sha256Hex(refreshToken)), jkt, {
      expirationTtl: 31 * 24 * 3600,
    });
  }
}

/** Carry-over lookup for refresh: a bound refresh token forces the same jkt
 *  on every rotation so a stolen refresh token can't shed the binding. */
export async function boundJktForRefreshToken(
  env: Env,
  refreshToken: string
): Promise<string | null> {
  return env.OAUTH_KV.get(OAUTH_DPOP_REFRESH_PREFIX + (await sha256Hex(refreshToken)));
}

/**
 * Validate `Authorization: Bearer <token>` for this origin's resource.
 * Returns null for absent/invalid tokens; enforces the DPoP binding when the
 * token was issued to a proof key.
 *
 * `enforceDpop` (default true): bound tokens additionally require a fresh
 * proof on every request. Git Smart HTTP passes false — stock git carries
 * one static `http.extraHeader` across a multi-request conversation, which
 * can never satisfy per-request htu or single-use jti, so bound tokens
 * degrade to plain bearer on the git transport only. API/MCP surfaces keep
 * the enforcement.
 */
export async function resolveOAuthBearer(
  env: Env,
  request: Request,
  options: { enforceDpop?: boolean } = {}
): Promise<OAuthPrincipal | null> {
  const token = getBearerToken(request);
  if (!token) return null;

  const origin = new URL(request.url).origin;
  const server = getAuthorizationServer(origin);
  const validated = await server
    .validateToken<OAuthTokenProps>(oauthResource(origin), token, env)
    .catch(() => null);
  if (!validated) return null;

  // Sender constraint: bound tokens require a fresh proof on every request
  // (skipped on transports that structurally can't produce one).
  const jkt = await env.OAUTH_KV.get(OAUTH_DPOP_ACCESS_PREFIX + (await sha256Hex(token)));
  if (jkt && options.enforceDpop !== false) {
    const proof = request.headers.get("DPoP");
    const url = new URL(request.url);
    const ok =
      proof &&
      (await verifyDpopProof(proof, request.method, `${url.origin}${url.pathname}`, jkt, env.OAUTH_KV));
    if (!ok) return null;
  }

  return {
    userId: validated.userId,
    did: validated.props.did,
    handle: validated.props.handle,
    namespace: validated.props.namespace,
    scopes: validated.scope,
    clientId: validated.clientId,
    dpopBound: jkt !== null,
  };
}

/** Namespace ACL for OAuth principals: the analog of the PAT grant check.
 *  A token may only act inside namespaces the user belongs to. */
export async function oauthNamespaceAccess(
  db: Db,
  principal: OAuthPrincipal,
  namespaceId: string
): Promise<boolean> {
  const membership = await findMembership(db, namespaceId, principal.userId);
  return membership !== undefined;
}
