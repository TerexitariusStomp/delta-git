import { FC, useEffect } from 'react'

import { handoffBskyPopupCallback } from './bsky-oauth'

/**
 * /oauth/callback — the client-side atproto OAuth redirect target.
 * Runs inside the authorization popup: hands the callback params to the
 * opener window via localStorage (survives COOP cross-origin navigation),
 * then closes itself.
 *
 * `window.close()` only works for script-opened popups; when the browser
 * opened the OAuth URL as a normal tab (or blocks the self-close), we fall
 * back to a visible "you can close this" message so the tab doesn't sit blank.
 */
export const OAuthCallback: FC = () => {
  useEffect(() => {
    handoffBskyPopupCallback()
    window.close()
    // If self-close was blocked, swap in the fallback text after a beat.
    const t = setTimeout(() => {
      const el = document.getElementById('oauth-callback-msg')
      if (el) el.textContent = 'Signed in — you can close this window now.'
    }, 800)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      id="oauth-callback-msg"
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
      Completing sign-in…
    </div>
  )
}
