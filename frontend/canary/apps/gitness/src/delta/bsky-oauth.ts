/**
 * Bluesky sign-in via ATProto OAuth — @atproto/oauth-client-browser (MIT).
 *
 * Ported from Rooted apps/socials-vite lib/bsky-oauth.ts + social-signin.ts.
 * The library handles handle→DID→PDS resolution, PAR, PKCE, and DPoP-bound
 * token exchange entirely in the browser. Session tokens live in the
 * library's IndexedDB store — delta-git's servers are never in the token path.
 *
 * After OAuth, we obtain a serviceAuth JWT from the user's OWN home PDS
 * (com.atproto.server.getServiceAuth, aud = our did:web service ref) and hand
 * it to POST /auth/atp/verify — proof of DID control signed by the user's
 * repo key. The resulting dg_session cookie is bound to the custody worker's
 * DPoP key (see custody.ts).
 */
import {
  BrowserOAuthClient,
  type OAuthSession,
} from '@atproto/oauth-client-browser'

import { getDpopJwk } from './custody'

let clientPromise: Promise<BrowserOAuthClient> | null = null
let currentSession: OAuthSession | null = null

/** sessionStorage ring buffer — console output dies on navigation, and the
 *  OAuth flow navigates twice (out to the AS, back to /oauth/callback). */
const AUTH_LOG_KEY = 'dg-auth-log'
const AUTH_LOG_MAX = 80

export function authLog(event: string, data?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${event}${data ? ` ${JSON.stringify(data)}` : ''}`
  console.log(`[dg-auth] ${event}`, data ?? '')
  try {
    const prev = JSON.parse(sessionStorage.getItem(AUTH_LOG_KEY) ?? '[]') as string[]
    prev.push(line)
    sessionStorage.setItem(AUTH_LOG_KEY, JSON.stringify(prev.slice(-AUTH_LOG_MAX)))
  } catch {
    /* storage unavailable — console line still emitted */
  }
}

/** Recent auth-flow events for support/debugging — survives redirects. */
export function getAuthLog(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_LOG_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export function getBskyClient(): Promise<BrowserOAuthClient> {
  if (!clientPromise) {
    clientPromise = BrowserOAuthClient.load({
      // client_id is a URL — the worker serves the metadata document there.
      clientId: `${window.location.origin}/client-metadata.json`,
      // Handle → DID resolution goes to the public Bluesky AppView.
      handleResolver: 'https://bsky.social',
    })
    clientPromise.catch(() => {
      clientPromise = null
    })
  }
  return clientPromise
}

/** Set by verifyAtpSession when the dg_session is DPoP-bound — the fetch
 *  interceptor (auth-fetch.ts) checks this to decide whether to attach proofs. */
export const DPOP_BOUND_FLAG = 'dg-dpop-bound'

/** Normalize a typed handle: bare names resolve on bsky.social; handles and
 *  DIDs pass through unchanged. */
function normalizeHandle(handle: string): string {
  return handle.includes('.') || handle.startsWith('did:')
    ? handle
    : `${handle}.bsky.social`
}

/**
 * Start Bluesky sign-in as a same-tab redirect. On success this never
 * resolves — the browser navigates to the authorization server and returns
 * to /oauth/callback, where completeBskyRedirect() finishes the flow.
 *
 * A redirect (not a popup) is deliberate: popup variants lose the opener
 * handle when COOP severs the relationship mid-flow, and browsers that open
 * window.open as a plain tab leave the callback window unclosable.
 * signInRedirect() rejects with "User navigated back" if bfcache restores
 * this page instead of navigating — callers should treat that as cancel.
 */
export async function signInBlueskyRedirect(handle: string): Promise<never> {
  const normalized = normalizeHandle(handle)
  authLog('redirect:start', { handle: normalized })
  const client = await getBskyClient()
  try {
    // Inline of client.signInRedirect so we can log where the browser is
    // actually heading (PAR endpoint, AS origin) before the page unloads.
    const url = await client.authorize(normalized, { state: 'deltagit' })
    authLog('redirect:authorize', { host: url.host, path: url.pathname })
    window.location.href = url.href
    // Never resolves — same contract as signInRedirect.
    return new Promise<never>(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    authLog('redirect:error', { handle: normalized, error: msg })
    throw new Error(`Bluesky sign-in failed (${normalized}): ${msg}`)
  }
}

/**
 * Run on /oauth/callback after the authorization server redirects back.
 * initCallback() performs the token exchange against the PKCE/DPoP state the
 * client persisted before navigating, strips the oauth params from the URL,
 * and returns the fresh session.
 */
export async function completeBskyRedirect(): Promise<OAuthSession> {
  const client = await getBskyClient()
  authLog('callback:start', {
    hasCode: new URLSearchParams(window.location.search).has('code'),
    url: window.location.pathname,
  })
  try {
    const { session } = await client.initCallback()
    currentSession = session
    authLog('callback:session', { did: session.did })
    return session
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    authLog('callback:error', { error: msg })
    throw new Error(`Bluesky sign-in failed: ${msg}`)
  }
}

/** Restore a persisted Bluesky OAuth session (IndexedDB) by DID. */
export async function restoreBskySession(did: string): Promise<OAuthSession | null> {
  try {
    const client = await getBskyClient()
    currentSession = await client.restore(did)
    return currentSession
  } catch {
    return null
  }
}

export function getBskySession(): OAuthSession | null {
  return currentSession
}

export function clearBskySession(): void {
  currentSession = null
}

export interface AtpVerifyResult {
  did: string
  handle: string | null
  namespace: string | null
  dpop_bound: boolean
}

/**
 * Complete sign-in: OAuth session → serviceAuth JWT from the user's PDS →
 * POST /auth/atp/verify with the custody worker's DPoP public JWK. The server
 * sets the dg_session cookie bound to the key's thumbprint.
 */
export async function verifyAtpSession(session: OAuthSession): Promise<AtpVerifyResult> {
  // Service-audience refs must be absolute did#serviceId — the PDS's rpc:
  // scope aud param rejects bare DIDs.
  const aud = `did:web:${window.location.hostname}#delta_git`
  const url = `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}`
  authLog('verify:service-auth', { aud })
  // fetchHandler runs getTokenSet + a DPoP-signed fetch to the user's PDS.
  // A pending-forever promise leaves the callback page stuck on
  // "Completing sign-in…" with no signal — race it against a timeout and
  // retry once (the first call can stall on a stale IndexedDB nonce read).
  const callServiceAuth = async (attempt: number): Promise<Response> => {
    try {
      const res = await Promise.race([
        session.fetchHandler(url),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error(`getServiceAuth timed out (attempt ${attempt})`)), 15_000)
        ),
      ])
      authLog('verify:service-auth-res', { status: res.status, attempt })
      return res
    } catch (err) {
      authLog('verify:service-auth-throw', { attempt, error: String(err) })
      if (attempt >= 2) throw err
      return callServiceAuth(attempt + 1)
    }
  }
  const res = await callServiceAuth(1)
  if (!res.ok) {
    // The PDS returns the exact missing scope in the body/WWW-Authenticate.
    let detail = ''
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      /* ignore */
    }
    const wwwAuth = res.headers.get('www-authenticate')
    authLog('verify:service-auth-error', { status: res.status, detail, wwwAuth })
    throw new Error(
      `getServiceAuth failed: ${res.status} ${detail}${wwwAuth ? ` | ${wwwAuth}` : ''}`
    )
  }
  authLog('verify:service-auth-parse')
  const { token } = (await res.json()) as { token?: string }
  if (!token) throw new Error('No serviceAuth token returned')
  authLog('verify:service-auth-token', { ok: true })

  // The custody worker has no built-in timeout — a worker that fails to
  // boot (script error, blocked module) would leave this pending forever.
  authLog('verify:dpop-jwk')
  const dpopJwk = await Promise.race([
    getDpopJwk(),
    new Promise<JsonWebKey>((_, reject) =>
      setTimeout(() => reject(new Error('custody worker timed out')), 15_000)
    ),
  ])
  authLog('verify:atp-verify', { did: session.did })
  const verifyRes = await fetch('/auth/atp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ did: session.did, jwt: token, dpop_jwk: dpopJwk }),
  })
  if (!verifyRes.ok) {
    const detail = await verifyRes.text().catch(() => '')
    authLog('verify:atp-verify-error', { status: verifyRes.status, detail })
    throw new Error(`session verify failed: ${verifyRes.status} ${detail}`)
  }
  const result = (await verifyRes.json()) as AtpVerifyResult
  authLog('verify:done', {
    did: result.did,
    handle: result.handle,
    namespace: result.namespace,
    dpop_bound: result.dpop_bound,
  })
  if (result.dpop_bound) {
    try {
      localStorage.setItem(DPOP_BOUND_FLAG, session.did)
    } catch {
      /* ignore */
    }
  }
  return result
}

/**
 * Kick off sign-in from /signin: same-tab redirect to the authorization
 * server. Never resolves on success — the page unloads. The post-auth step
 * (callback → serviceAuth → dg_session → namespace redirect) runs in
 * completeBskySignIn() on /oauth/callback.
 */
export async function signInWithBluesky(handle: string): Promise<never> {
  return signInBlueskyRedirect(handle)
}

/**
 * Finish sign-in on /oauth/callback: token exchange → serviceAuth JWT →
 * bound dg_session cookie. Returns the verify result so the caller can
 * route to the user's namespace.
 */
export async function completeBskySignIn(): Promise<AtpVerifyResult> {
  const session = await completeBskyRedirect()
  return verifyAtpSession(session)
}
