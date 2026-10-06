/**
 * OAuth 2.1 authorization-server mount — delta-git issues scoped,
 * sender-constrained tokens to agents and tooling.
 *
 * Endpoints served here:
 *   GET  /.well-known/oauth-authorization-server   → RFC 8414 metadata (lib)
 *   GET  /.well-known/oauth-protected-resource[/…] → RFC 9728 metadata (ours)
 *   GET  /oauth/authorize                         → SPA consent page (falls
 *        through to the SPA fallback — deliberately not registered here)
 *   GET  /oauth/authorize/info                    → JSON: client metadata +
 *        requested scopes + consent handle for the signed-in user
 *   POST /oauth/authorize/decision                → approve/deny → redirect URL
 *   POST /oauth/token                             → wrapped: DPoP binding
 *   POST /oauth/register                          → RFC 7591 DCR (lib)
 *
 * Identity for consent is the dg_session cookie (either sign-in lane:
 * Bluesky OAuth or did:key challenge). The interactive page itself is
 * client-rendered — the SPA calls /info and /decision; the server only
 * runs the protocol steps that must exist server-side.
 */
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";

import type { AppContext, AppRouter } from "./hono";
import { readActiveSession } from "@/worker/auth/session";
import {
  bindTokensToDpopJkt,
  boundJktForRefreshToken,
  getAuthorizationServer,
  oauthResource,
  OAUTH_SCOPE_DESCRIPTIONS,
  OAUTH_SCOPES_SUPPORTED,
  type OAuthTokenProps,
} from "@/worker/auth/oauth";
import { computeJwkThumbprint, verifyDpopProof } from "@/vendor/widespread/auth/dpop";
import { base64UrlToBytes, bytesToUtf8 } from "@/vendor/widespread/crypto/index.js";
import { findIdentityByUserId } from "@/worker/db/d1/dal/identities";
import { listNamespacesForUser } from "@/worker/db/d1/dal/namespaces";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Headers }): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

/** RFC 9728 protected-resource metadata — the 401-challenge target MCP
 *  clients discover the AS through. Resource = the forge origin. */
function protectedResourceMetadata(origin: string) {
  return {
    resource: oauthResource(origin),
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_name: "delta-git",
  };
}

/**
 * Rebuild the request as if it arrived at the advertised authorize endpoint.
 * parseAuthRequest() rejects URLs that don't match `authorizeEndpoint`, so
 * the JSON info endpoint can't pass its own Request through.
 */
function asAuthorizeRequest(request: Request, origin: string): Request {
  const url = new URL(request.url);
  return new Request(`${origin}/oauth/authorize${url.search}`, {
    method: "GET",
    headers: request.headers,
  });
}

/**
 * GET /oauth/authorize/info — the consent page's data. Requires dg_session;
 * the SPA turns a 401 into a /signin?return_to= hop.
 */
async function authorizeInfo(c: AppContext): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const server = getAuthorizationServer(origin);
  const api = server.getOAuthApi(c.env);

  const active = await readActiveSession(c);
  if (!active) return jsonResponse({ error: "signin_required" }, { status: 401 });

  const authRequest = await api.parseAuthRequest(asAuthorizeRequest(c.req.raw, origin));
  const [description, tx] = await Promise.all([
    api.describeConsent(authRequest),
    api.beginConsent(authRequest),
  ]);

  const identity = await findIdentityByUserId(c.var.db, active.user.id).catch(() => undefined);
  const namespaces = await listNamespacesForUser(c.var.db, active.user.id).catch(() => []);

  return jsonResponse(
    {
      handle: tx.handle,
      client: {
        clientId: description.clientId,
        name: description.clientName,
        domain: description.clientDomain ?? null,
        uri: description.clientUri ?? null,
        logoUri: description.logoUri ?? null,
        redirectUri: description.redirectUri,
        redirectHost: description.redirectHost,
        redirectIsLoopback: description.redirectIsLoopback,
      },
      scopes: description.scope.map((scope) => ({
        scope,
        description: OAUTH_SCOPE_DESCRIPTIONS[scope] ?? scope,
      })),
      user: {
        handle: identity?.handle ?? null,
        did: identity?.did ?? null,
        namespace: namespaces[0]?.slug ?? null,
      },
    },
    { headers: tx.headers }
  );
}

interface DecisionBody {
  handle?: string;
  approve?: boolean;
  scope?: string[];
  remember?: boolean;
}

/**
 * POST /oauth/authorize/decision — consumes the one-shot consent handle.
 * Approves (minting the code) or denies, returning the client redirect URL.
 */
async function authorizeDecision(c: AppContext): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const server = getAuthorizationServer(origin);
  const api = server.getOAuthApi(c.env);

  const active = await readActiveSession(c);
  if (!active) return jsonResponse({ error: "signin_required" }, { status: 401 });

  const body = (await c.req.json().catch(() => null)) as DecisionBody | null;
  if (!body?.handle) return jsonResponse({ error: "handle_required" }, { status: 400 });

  if (!body.approve) {
    const denied = await api.denyConsent(c.req.raw, body.handle);
    return jsonResponse({ redirect: denied.redirectTo }, { headers: denied.headers });
  }

  const approved = await api.approveConsent(c.req.raw, body.handle, {
    scope: body.scope,
  });

  const identity = await findIdentityByUserId(c.var.db, active.user.id).catch(() => undefined);
  const namespaces = await listNamespacesForUser(c.var.db, active.user.id).catch(() => []);

  const props: OAuthTokenProps = {
    userId: active.user.id,
    did: identity?.did ?? undefined,
    handle: identity?.handle ?? undefined,
    namespace: namespaces[0]?.slug,
  };
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: active.user.id,
    scope: approved.request.scope,
    metadata: { consentedAt: Date.now() },
    props,
  });

  return jsonResponse({ redirect: redirectTo }, { headers: approved.headers });
}

/**
 * POST /oauth/token — wraps the library token endpoint with DPoP binding:
 * a valid `DPoP` proof on the request binds the issued access token to that
 * key's thumbprint; refreshing a bound refresh token requires the same key,
 * so a stolen refresh token can't shed the constraint.
 */
async function tokenEndpoint(c: AppContext): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const server = getAuthorizationServer(origin);
  const log = c.var.logFor({ service: "OAuthToken" });

  // Read the form body once for grant inspection, then replay it.
  const formText = await c.req.raw.clone().text();
  const form = new URLSearchParams(formText);
  const grantType = form.get("grant_type") ?? "";

  const proof = c.req.header("DPoP");
  let requestJkt: string | null = null;
  if (proof) {
    // No stored jkt to compare against at issuance — verify structure +
    // signature, then take the proof's own thumbprint as the binding.
    const headerB64 = proof.split(".")[0];
    try {
      const header = JSON.parse(bytesToUtf8(base64UrlToBytes(headerB64!))) as {
        jwk: { kty: string; x: string; y: string };
      };
      requestJkt = await computeJwkThumbprint(header.jwk);
      const ok = await verifyDpopProof(
        proof,
        "POST",
        `${origin}/oauth/token`,
        requestJkt,
        c.env.OAUTH_KV
      );
      if (!ok) requestJkt = null;
    } catch {
      requestJkt = null;
    }
  }

  // Refresh rotation: a bound refresh token must present the same key.
  const refreshToken = form.get("refresh_token");
  if (grantType === "refresh_token" && refreshToken) {
    const boundJkt = await boundJktForRefreshToken(c.env, refreshToken);
    if (boundJkt && boundJkt !== requestJkt) {
      log.info("oauth-token:refresh-binding-violation", {});
      return jsonResponse(
        {
          error: "invalid_dpop_proof",
          error_description: "bound refresh token requires the original DPoP key",
        },
        { status: 401 }
      );
    }
  }

  const replayHeaders = new Headers(c.req.raw.headers);
  replayHeaders.delete("content-length");
  replayHeaders.delete("host");
  replayHeaders.delete("dpop");
  const replay = new Request(c.req.url, {
    method: "POST",
    headers: replayHeaders,
    body: formText,
  });
  const res = await server.fetch(replay, c.env, c.executionCtx as ExecutionContext);

  // On success, persist the binding for the minted tokens.
  if (res.ok && requestJkt) {
    const payload = (await res
      .clone()
      .json()
      .catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
    } | null;
    if (payload?.access_token) {
      await bindTokensToDpopJkt(c.env, payload.access_token, payload.refresh_token, requestJkt);
      log.debug("oauth-token:dpop-bound", { grantType });
    }
  }
  return res;
}

export function registerOAuthProviderRoutes(router: AppRouter): void {
  // Protocol-owned endpoints — delegate to the authorization server.
  router.all("/.well-known/oauth-authorization-server", async (c) =>
    getAuthorizationServer(new URL(c.req.url).origin).fetch(
      c.req.raw,
      c.env,
      c.executionCtx as ExecutionContext
    )
  );

  router.all("/oauth/token", async (c) => tokenEndpoint(c));
  router.all("/oauth/register", async (c) =>
    getAuthorizationServer(new URL(c.req.url).origin).fetch(
      c.req.raw,
      c.env,
      c.executionCtx as ExecutionContext
    )
  );

  // RFC 9728 protected-resource metadata (+ the /mcp-suffixed variant MCP
  // clients probe when the resource has a path).
  const serveResourceMetadata = (c: AppContext) =>
    jsonResponse(protectedResourceMetadata(new URL(c.req.url).origin));
  router.get("/.well-known/oauth-protected-resource", serveResourceMetadata);
  router.get("/.well-known/oauth-protected-resource/*", serveResourceMetadata);

  // Consent API — the SPA page at /oauth/authorize calls these.
  router.get("/oauth/authorize/info", async (c) => {
    try {
      return await authorizeInfo(c);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return jsonResponse(
          {
            error: err.code,
            description: err.description,
            redirect: err.redirectTo ?? null,
          },
          { status: 400 }
        );
      }
      throw err;
    }
  });
  router.post("/oauth/authorize/decision", async (c) => {
    try {
      return await authorizeDecision(c);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return jsonResponse({ error: err.code, description: err.description }, { status: 400 });
      }
      throw err;
    }
  });
}
