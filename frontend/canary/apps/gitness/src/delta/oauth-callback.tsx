import { FC, useEffect } from 'react'

import { handoffBskyPopupCallback } from './bsky-oauth'

/**
 * /oauth/callback — the client-side atproto OAuth redirect target.
 * Runs inside the authorization popup: hands the callback params to the
 * opener window via localStorage (survives COOP cross-origin navigation),
 * then closes itself.
 */
export const OAuthCallback: FC = () => {
  useEffect(() => {
    handoffBskyPopupCallback()
    window.close()
  }, [])
  return null
}
