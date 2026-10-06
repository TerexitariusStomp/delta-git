import { FC, useEffect, useState } from 'react'

import { authLog } from './bsky-oauth'

/**
 * /oauth/authorize — the delta-git OAuth 2.1 consent page, rendered
 * client-side like everything else in the SPA. The worker owns only the
 * protocol steps: this page calls GET /oauth/authorize/info (which replays
 * our query string as the real authorize request) for the client's verified
 * metadata and the one-shot consent handle, then POSTs the decision. The
 * code minting itself happens server-side — there is no way around that —
 * but every byte of the UI is rendered here.
 *
 * An unauthenticated visit gets a 401 from /info → we bounce to /signin
 * with ?return_to= pointing back at this exact URL; the sign-in callback
 * (oauth-callback.tsx) resumes the flow after dg_session is established.
 */

interface AuthorizeInfo {
  handle: string
  client: {
    clientId: string
    name: string
    /** Verified only for Client ID Metadata Document clients — shown
     *  prominently because registered-client names are self-asserted. */
    domain: string | null
    uri: string | null
    redirectHost: string
    redirectIsLoopback: boolean
  }
  scopes: { scope: string; description: string }[]
  user: { handle: string | null; did: string | null; namespace: string | null }
}

interface AuthorizeError {
  error: string
  description?: string
  /** Present when the library validated the client enough to safely
   *  redirect the error back to it (RFC 9207). */
  redirect?: string | null
}

export const OAuthAuthorize: FC = () => {
  const [info, setInfo] = useState<AuthorizeInfo | null>(null)
  const [error, setError] = useState<AuthorizeError | null>(null)
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Forward the exact authorize query — the server replays it through
    // parseAuthRequest, so nothing is re-validated client-side.
    fetch(`/oauth/authorize/info${window.location.search}`, {
      credentials: 'same-origin'
    })
      .then(async res => {
        if (res.status === 401) {
          // Not signed in: stash nothing here — /signin?return_to= carries
          // the whole URL, and the callback resumes it after dg_session.
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.assign(`/signin?return_to=${encodeURIComponent(returnTo)}`)
          return
        }
        const body = (await res.json()) as AuthorizeInfo | AuthorizeError
        if (!res.ok) {
          setError(body as AuthorizeError)
          return
        }
        const ok = body as AuthorizeInfo
        setInfo(ok)
        setGranted(new Set(ok.scopes.map(s => s.scope)))
      })
      .catch(err => setError({ error: 'fetch_failed', description: String(err) }))
  }, [])

  const decide = async (approve: boolean) => {
    if (!info) return
    setBusy(true)
    try {
      const res = await fetch('/oauth/authorize/decision', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: info.handle,
          approve,
          // Send the narrowed scope list so an approval never grants more
          // than the checkboxes left ticked.
          scope: approve ? [...granted] : undefined
        })
      })
      const body = (await res.json()) as { redirect?: string } & AuthorizeError
      if (!res.ok || !body.redirect) {
        setError({ error: body.error ?? 'decision_failed', description: body.description })
        setBusy(false)
        return
      }
      authLog('oauth:decision', { approve, redirect: body.redirect })
      window.location.assign(body.redirect)
    } catch (err) {
      setError({ error: 'decision_failed', description: String(err) })
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-cn-1">
      <header className="w-full border-b border-cn-2">
        <div className="flex w-full items-center gap-3 px-4 py-3 sm:px-6">
          <a href="/" className="flex items-center gap-2.5 no-underline hover:no-underline">
            <img src="/gitflare-icon.png" alt="" className="block h-8 w-auto" aria-hidden="true" />
            <span className="hidden sm:block">
              <strong className="block text-sm font-semibold text-cn-1">Gitflare</strong>
              <small className="block text-xs text-cn-2">GitHub on Cloudflare</small>
            </span>
          </a>
        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-md flex-1 px-4 py-10">
        {error ? (
          <div className="rounded-cn-2 border border-cn-2 bg-cn-2 p-6">
            <h1 className="mb-2 text-xl font-semibold text-cn-1">Authorization failed</h1>
            <p className="text-sm text-cn-danger">{error.description ?? error.error}</p>
            {error.redirect && (
              <a
                href={error.redirect}
                className="mt-4 inline-block text-sm text-cn-3 underline underline-offset-2 hover:text-cn-2"
              >
                Return to the application
              </a>
            )}
          </div>
        ) : !info ? (
          <p className="text-sm text-cn-2">Loading authorization request…</p>
        ) : (
          <div className="rounded-cn-2 border border-cn-2 bg-cn-2 p-6">
            <h1 className="mb-2 text-2xl font-semibold text-cn-1">Authorize application</h1>
            <p className="mb-6 text-sm text-cn-2">
              <strong className="text-cn-1">{info.client.name}</strong>
              {info.client.domain && (
                <span className="text-cn-3"> ({info.client.domain})</span>
              )}{' '}
              wants to access delta-git on behalf of{' '}
              <strong className="text-cn-1">
                {info.user.handle ?? info.user.namespace ?? info.user.did ?? 'you'}
              </strong>
              .
            </p>

            <div className="flex flex-col gap-2">
              {info.scopes.map(({ scope, description }) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-start gap-2.5 rounded-cn-2 border border-cn-2 bg-cn-1 px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={granted.has(scope)}
                    disabled={busy}
                    onChange={e => {
                      const next = new Set(granted)
                      if (e.target.checked) next.add(scope)
                      else next.delete(scope)
                      setGranted(next)
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    <code className="text-xs text-cn-1">{scope}</code>
                    <span className="block text-xs text-cn-3">{description}</span>
                  </span>
                </label>
              ))}
            </div>

            <p className="mt-4 text-xs text-cn-3">
              Redirects to <code className="text-cn-2">{info.client.redirectHost}</code>
              {info.client.redirectIsLoopback && (
                <span>
                  {' '}
                  — a local app on this machine. Whatever is listening there will receive the
                  credential.
                </span>
              )}
            </p>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
                className="flex-1 rounded-cn-2 border border-cn-2 bg-cn-1 px-3 py-2 text-sm font-medium text-cn-1 disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                disabled={busy || granted.size === 0}
                onClick={() => void decide(true)}
                className="flex-1 rounded-cn-2 bg-cn-success-primary px-3 py-2 text-sm font-medium text-cn-1 disabled:opacity-50"
              >
                Authorize
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
