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

/** localStorage flag telling /oauth/callback that a Bluesky popup is in flight. */
const BSKY_POPUP_FLAG = 'dg-bsky-popup'
/** localStorage handoff: the popup writes its callback params; the opener's
 *  `storage` listener picks them up and runs the token exchange. */
const BSKY_CALLBACK_KEY = 'dg-bsky-callback'
/** Set by verifyAtpSession when the dg_session is DPoP-bound — the fetch
 *  interceptor (auth-fetch.ts) checks this to decide whether to attach proofs. */
export const DPOP_BOUND_FLAG = 'dg-dpop-bound'

/**
 * Start Bluesky sign-in in a popup. Resolves with the OAuth session after
 * the user authorizes.
 *
 * We deliberately do NOT use the library's signInPopup(): its popup-side
 * initCallback + BroadcastChannel ack handshake is fragile across the
 * COOP-severed cross-origin navigation. Instead the popup writes its callback
 * URL params to localStorage — origin-scoped, survives COOP — and THIS window
 * runs client.callback() to do the token exchange itself.
 */
export async function signInBlueskyPopup(handle: string): Promise<OAuthSession> {
  // Bare names resolve on bsky.social; handles must be valid domains.
  const normalized =
    handle.includes('.') || handle.startsWith('did:') ? handle : `${handle}.bsky.social`
  const client = await getBskyClient()

  // Open synchronously to dodge popup blockers; authorize() navigates it.
  const popup = window.open('about:blank', 'dg-bsky-oauth', 'width=600,height=700,scrollbars=yes')
  try {
    localStorage.setItem(BSKY_POPUP_FLAG, String(Date.now()))
    localStorage.removeItem(BSKY_CALLBACK_KEY)
  } catch {
    /* storage unavailable — the storage listener simply never fires */
  }

  try {
    const url = await client.authorize(normalized, { state: 'deltagit' })
    if (popup) popup.location.href = url.href
    else window.open(url.href, 'dg-bsky-oauth', 'width=600,height=700,scrollbars=yes')
  } catch (err) {
    try {
      popup?.close()
    } catch {
      /* popup may already be gone */
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Bluesky sign-in failed (${normalized}): ${msg}`)
  }

  const startedAt = Date.now()
  const params = await new Promise<URLSearchParams>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('storage', onStorage)
      try {
        localStorage.removeItem(BSKY_CALLBACK_KEY)
        localStorage.removeItem(BSKY_POPUP_FLAG)
      } catch {
        /* ignore */
      }
    }
    const consume = (raw: string) => {
      try {
        const { q, h, ts } = JSON.parse(raw) as { q?: string; h?: string; ts?: number }
        if (typeof ts !== 'number' || ts < startedAt) return // stale
        const p = new URLSearchParams(h ? h.slice(1) : q)
        cleanup()
        resolve(p)
      } catch (err) {
        cleanup()
        reject(err)
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== BSKY_CALLBACK_KEY || !e.newValue) return
      consume(e.newValue)
    }
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new Error('Bluesky sign-in timed out'))
      },
      5 * 60_000
    )
    window.addEventListener('storage', onStorage)
    try {
      const existing = localStorage.getItem(BSKY_CALLBACK_KEY)
      if (existing) consume(existing)
    } catch {
      /* ignore */
    }
  })

  try {
    const { session } = await client.callback(params, {
      redirect_uri: `${window.location.origin}/oauth/callback` as `https://${string}`,
    })
    try {
      popup?.close()
    } catch {
      /* popup may already be gone */
    }
    currentSession = session
    return session
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Bluesky sign-in failed: ${msg}`)
  }
}

/**
 * Called inside the OAuth popup on /oauth/callback — writes the callback URL
 * params to localStorage so the opener can complete the exchange, then closes.
 */
export function handoffBskyPopupCallback(): void {
  try {
    localStorage.setItem(
      BSKY_CALLBACK_KEY,
      JSON.stringify({
        q: window.location.search,
        h: window.location.hash,
        ts: Date.now(),
      })
    )
  } catch {
    /* ignore */
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
  const res = await session.fetchHandler(
    `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}`
  )
  if (!res.ok) {
    // The PDS returns the exact missing scope in the body/WWW-Authenticate.
    let detail = ''
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      /* ignore */
    }
    const wwwAuth = res.headers.get('www-authenticate')
    throw new Error(
      `getServiceAuth failed: ${res.status} ${detail}${wwwAuth ? ` | ${wwwAuth}` : ''}`
    )
  }
  const { token } = (await res.json()) as { token?: string }
  if (!token) throw new Error('No serviceAuth token returned')

  const dpopJwk = await getDpopJwk()
  const verifyRes = await fetch('/auth/atp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ did: session.did, jwt: token, dpop_jwk: dpopJwk }),
  })
  if (!verifyRes.ok) {
    const detail = await verifyRes.text().catch(() => '')
    throw new Error(`session verify failed: ${verifyRes.status} ${detail}`)
  }
  const result = (await verifyRes.json()) as AtpVerifyResult
  if (result.dpop_bound) {
    try {
      localStorage.setItem(DPOP_BOUND_FLAG, session.did)
    } catch {
      /* ignore */
    }
  }
  return result
}

/** Full popup flow: Bluesky OAuth → serviceAuth → bound dg_session cookie. */
export async function signInWithBluesky(handle: string): Promise<AtpVerifyResult> {
  const session = await signInBlueskyPopup(handle)
  return verifyAtpSession(session)
}
