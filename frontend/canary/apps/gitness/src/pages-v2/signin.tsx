import { FC, useEffect } from 'react'

/**
 * /signin is a redirect shim to the SSR /auth page — the single sign-in
 * surface. The SSR page owns both the Bluesky OAuth lane and the did:key
 * challenge lane, so unauthenticated SPA redirects and direct visits land on
 * real page chrome instead of a floating card.
 */
export const SignIn: FC = () => {
  useEffect(() => {
    window.location.assign('/auth')
  }, [])

  return null
}
