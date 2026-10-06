import { FC, useEffect, useState } from 'react'

import { authLog, completeBskySignIn } from './bsky-oauth'

/**
 * /oauth/callback — the client-side atproto OAuth redirect target.
 *
 * The Bluesky flow is a same-tab redirect (not a popup): /signin navigates
 * here via the authorization server, this page runs the token exchange,
 * establishes the bound dg_session via /auth/atp/verify, then forwards the
 * user to their namespace. On failure we render the error with a link back.
 *
 * Every step writes to the [dg-auth] console log AND a sessionStorage ring
 * buffer (dg-auth-log) that survives the redirect — see getAuthLog().
 */
export const OAuthCallback: FC = () => {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    completeBskySignIn()
      .then(result => {
        if (cancelled) return
        const dest = result.namespace ? `/${result.namespace}` : '/'
        authLog('callback:redirect', { dest })
        window.location.replace(dest)
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        authLog('callback:fatal', { error: msg })
        if (!cancelled) setError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#9aa4b8',
        background: '#0b0e14'
      }}
    >
      {error ? (
        <div style={{ textAlign: 'center', maxWidth: '28rem' }}>
          <p>Sign-in failed: {error}</p>
          <p style={{ fontSize: '0.85em', opacity: 0.7 }}>
            Debug log is in sessionStorage key <code>dg-auth-log</code>
          </p>
          <a href="/signin" style={{ color: '#7c8cff' }}>
            Back to sign in
          </a>
        </div>
      ) : (
        'Completing sign-in…'
      )}
    </div>
  )
}
