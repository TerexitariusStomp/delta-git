import { FC, useEffect, useState } from 'react'

import { completeBskySignIn } from './bsky-oauth'

/**
 * /oauth/callback — the client-side atproto OAuth redirect target.
 *
 * The Bluesky flow is a same-tab redirect (not a popup): /signin navigates
 * here via the authorization server, this page runs the token exchange,
 * establishes the bound dg_session via /auth/atp/verify, then forwards the
 * user to their namespace. On failure we render the error with a link back.
 */
export const OAuthCallback: FC = () => {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    completeBskySignIn()
      .then(result => {
        if (cancelled) return
        window.location.replace(result.namespace ?? '/')
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
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
