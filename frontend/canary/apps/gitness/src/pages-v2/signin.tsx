import { FC, useEffect } from 'react'

/**
 * delta-git bridge: auth lives in the SSR `/auth` flow (DID sign-in + tessera
 * OIDC), not gitness password auth — `/api/v1/login` only succeeds when a
 * session already exists. Bounce straight there and let it return with a
 * sealed session cookie.
 */
export const SignIn: FC = () => {
  useEffect(() => {
    window.location.assign('/auth')
  }, [])
  return null
}
