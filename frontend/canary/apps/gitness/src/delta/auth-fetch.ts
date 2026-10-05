/**
 * DPoP fetch interceptor — installs a window.fetch wrapper that attaches a
 * custody-signed DPoP proof to same-origin requests whenever the session is
 * bound (DPOP_BOUND_FLAG set by verifyAtpSession). Server-side, any request
 * presenting a bound dg_session cookie without a valid proof is rejected —
 * a stolen cookie is useless without the worker's key.
 */

import { signDpop } from './custody'
import { DPOP_BOUND_FLAG } from './bsky-oauth'

let installed = false

export function isDpopBound(): boolean {
  try {
    return Boolean(localStorage.getItem(DPOP_BOUND_FLAG))
  } catch {
    return false
  }
}

export function clearDpopBoundFlag(): void {
  try {
    localStorage.removeItem(DPOP_BOUND_FLAG)
  } catch {
    /* ignore */
  }
}

export function installDpopFetchInterceptor(): void {
  if (installed) return
  installed = true
  const original = window.fetch

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // Only same-origin API/auth requests get proofs — never leak proof headers
    // to third parties, and never block on the worker for off-origin traffic.
    const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin)
    if (!sameOrigin || !isDpopBound()) return original(input, init)

    const absolute = new URL(url, window.location.origin)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    try {
      const proof = await signDpop(`${absolute.origin}${absolute.pathname}`, method)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
      headers.set('DPoP', proof)
      return original(input, { ...init, headers })
    } catch {
      // Custody worker unavailable — send without proof; the server will 401
      // if the session binding is live, which is the fail-closed path anyway.
      return original(input, init)
    }
  }
}
