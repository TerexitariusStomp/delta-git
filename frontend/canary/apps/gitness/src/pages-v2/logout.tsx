import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { clearDpopBoundFlag } from '../delta/auth-fetch'
import { clearBskySession, getBskyClient, getBskySession } from '../delta/bsky-oauth'
import { clearDpopKey } from '../delta/custody'
import { useRoutes } from '../framework/context/NavigationContext'

export const Logout: React.FC = () => {
  const routes = useRoutes()
  const navigate = useNavigate()

  useEffect(() => {
    const run = async () => {
      // Server-side revocation + cookie clear (covers both session types).
      await fetch('/auth/did/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
      // Client-side: drop the OAuth session and the custody DPoP key so a
      // fresh sign-in mints a fresh binding.
      const bskyDid = getBskySession()?.did
      clearBskySession()
      if (bskyDid) {
        await getBskyClient()
          .then((c) => c.revoke(bskyDid))
          .catch(() => {})
      }
      await clearDpopKey().catch(() => {})
      clearDpopBoundFlag()
      navigate(routes.toSignIn())
    }
    void run()
  }, [navigate])

  return <div>Signing out...</div>
}
