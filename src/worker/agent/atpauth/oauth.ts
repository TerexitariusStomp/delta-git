// atproto OAuth sign-in (the browser flow humans expect), backed by
// @atcute/oauth-node-client's public-client implementation:
//   1. startOAuth   — the client resolves the account's authorization
//      server from its handle (handle → DID → DID doc #atproto_pds →
//      protected-resource metadata → AS metadata), then POSTs a pushed
//      authorization request (PAR) signed with a fresh DPoP key + PKCE
//      challenge.
//   2. completeOAuth — the client exchanges the authorization code at the
//      token endpoint (DPoP + PKCE verifier), validates `iss` (RFC 9207)
//      and `state`, and returns the session. The token response `sub` is
//      the user's DID — that is all we need for sign-in; the session is
//      deliberately discarded (we never act on the user's PDS).
//
// Per-request secrets (PKCE verifier, DPoP private JWK) live in KV under
// `oauthstate:<stateId>` with a 10-minute TTL; the client deletes the
// state on first callback use — same single-use semantics as the DID
// challenge nonces.

import { isHandle, type Handle } from "@atcute/lexicons/syntax";
import { OAuthCallbackError, OAuthClient, MemoryStore } from "@atcute/oauth-node-client";
import type { StoredState, Store } from "@atcute/oauth-node-client";
import { LocalActorResolver, XrpcHandleResolver } from "@atcute/identity-resolver";

import { createDidDocumentResolver, pdsBase } from "./pds";

const STATE_PREFIX = "oauthstate:";
const STATE_TTL_SEC = 600;

/** KV-backed OAuth state store — the client's StoredState is JSON-clean. */
class KvStateStore implements Store<string, StoredState> {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<StoredState | undefined> {
    const raw = await this.kv.get(`${STATE_PREFIX}${key}`);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as StoredState;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: StoredState): Promise<void> {
    await this.kv.put(`${STATE_PREFIX}${key}`, JSON.stringify(value), {
      expirationTtl: STATE_TTL_SEC,
    });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(`${STATE_PREFIX}${key}`);
  }

  // The client never enumerates states; clear() exists only to satisfy the
  // Store interface.
  async clear(): Promise<void> {}
}

function oauthClient(env: Env, kv: KVNamespace, origin: string): OAuthClient {
  return new OAuthClient({
    metadata: {
      client_id: `${origin}/client-metadata.json`,
      client_name: "delta-git",
      client_uri: origin,
      redirect_uris: [`${origin}/auth/oauth/callback`],
      scope: "atproto",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    },
    actorResolver: new LocalActorResolver({
      handleResolver: new XrpcHandleResolver({ serviceUrl: pdsBase(env) }),
      didDocumentResolver: createDidDocumentResolver(env),
    }),
    stores: {
      states: new KvStateStore(kv),
      // Sessions are keyed by DID and never restored — the access token is
      // discarded after the exchange, so an in-memory store is sufficient.
      sessions: new MemoryStore(),
    },
  });
}

export type StartResult = { ok: true; redirectUrl: string } | { ok: false; error: string };
export type CompleteResult =
  | { ok: true; did: string; returnTo?: string }
  | { ok: false; error: string };

function errorTag(err: unknown): string {
  // Surface the library's error taxonomy for metrics without leaking
  // internals into the redirect.
  if (err instanceof OAuthCallbackError) return `oauth-${err.error}`;
  return err instanceof Error ? err.name : "oauth-unknown";
}

/**
 * Run the PAR half of the flow. Returns the authorization URL the browser
 * should be redirected to. The client stores its state under a random
 * state ID in the KV-backed store; `returnTo` rides through the flow as
 * the client's opaque userState.
 */
export async function startOAuth(opts: {
  env: Env;
  kv: KVNamespace;
  origin: string;
  handle?: string;
  returnTo?: string;
}): Promise<StartResult> {
  let handle: Handle | undefined;
  if (opts.handle) {
    if (!isHandle(opts.handle)) {
      return { ok: false, error: "invalid-handle" };
    }
    handle = opts.handle;
  }
  try {
    const client = oauthClient(opts.env, opts.kv, opts.origin);
    const { url } = await client.authorize({
      // Without a handle we send the browser to the default PDS's
      // authorization server (same fallback as before).
      target: handle
        ? { type: "account", identifier: handle }
        : { type: "pds", serviceUrl: pdsBase(opts.env) },
      state: opts.returnTo,
    });
    return { ok: true, redirectUrl: url.toString() };
  } catch (err) {
    return { ok: false, error: errorTag(err) };
  }
}

/**
 * Consume the OAuth callback params and exchange the code for the identity
 * (`sub` DID). State validation, issuer matching, and the DPoP nonce retry
 * are handled inside the client.
 */
export async function completeOAuth(opts: {
  env: Env;
  kv: KVNamespace;
  origin: string;
  params: URLSearchParams;
}): Promise<CompleteResult> {
  try {
    const client = oauthClient(opts.env, opts.kv, opts.origin);
    const { session, state } = await client.callback(opts.params);
    return {
      ok: true,
      did: session.sub,
      returnTo: typeof state === "string" ? state : undefined,
    };
  } catch (err) {
    return { ok: false, error: errorTag(err) };
  }
}
