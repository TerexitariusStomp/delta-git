import { FC, useState } from 'react'

import { signInWithBluesky } from '../delta/bsky-oauth'

/**
 * Sign-in — the primary auth surface, styled after the SSR /auth page layout
 * (header/footer chrome + centered card) but keeping the Bluesky OAuth flow
 * fully client-side: PAR + PKCE + DPoP run in the browser via
 * @atproto/oauth-client-browser, tokens live in IndexedDB, and the dg_session
 * cookie is bound to the key-custody worker's non-extractable DPoP key. The
 * server never sees OAuth tokens or account keys.
 *
 * The did:* challenge lane stays on /auth — device keys and agents sign a
 * one-time challenge there (also client-side key custody).
 */
export const SignIn: FC = () => {
  // /auth's island forwards handles here (client-side OAuth is the only
  // Bluesky lane) — prefill so the bounce doesn't lose the typed handle.
  const [identifier, setIdentifier] = useState(
    () => new URLSearchParams(window.location.search).get('handle') ?? ''
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onContinue = async () => {
    const id = identifier.trim()
    setError(null)
    // DIDs aren't OAuth accounts — the did:* challenge lives on /auth.
    if (id.startsWith('did:')) {
      window.location.assign(`/auth?did=${encodeURIComponent(id)}`)
      return
    }
    setBusy(true)
    try {
      // Same-tab redirect: resolves never on success (the page navigates to
      // the authorization server); /oauth/callback finishes the sign-in.
      await signInWithBluesky(id)
    } catch (err) {
      // "User navigated back" = bfcache restore, not a failure — just re-arm.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'User navigated back') setError(msg)
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
        <h1 className="mb-2 text-3xl font-semibold text-cn-1">Sign in</h1>
        <p className="mb-6 text-sm text-cn-2">
          Sign in with your Bluesky account, or prove a DID by signing a one-time challenge.
        </p>

        <div className="rounded-cn-2 border border-cn-2 bg-cn-2 p-6">
          <div className="flex flex-col gap-1.5 text-sm">
            <label htmlFor="signin-handle" className="block text-sm font-semibold text-cn-1">
              Handle or DID
            </label>
            <input
              id="signin-handle"
              type="text"
              placeholder="alice.bsky.social or did:plc:…"
              value={identifier}
              disabled={busy}
              onChange={e => setIdentifier(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void onContinue()
              }}
              className="w-full rounded-cn-2 border border-cn-2 bg-cn-1 px-3 py-2 text-sm text-cn-1"
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onContinue()}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-cn-2 bg-cn-success-primary px-3 py-2 text-sm font-medium text-cn-1 disabled:opacity-50"
          >
            {busy ? 'Waiting for Bluesky…' : 'Continue with Bluesky'}
          </button>
          {error && <p className="mt-4 text-sm text-cn-danger">{error}</p>}
          <div className="mt-4 text-center">
            <a href="/auth" className="text-xs text-cn-3 underline underline-offset-2 hover:text-cn-2">
              Sign with an atproto key instead
            </a>
          </div>
        </div>
      </main>

      <footer className="shrink-0 border-t border-cn-2">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-4 text-xs text-cn-3 sm:px-6">
          <a href="/" className="flex items-center gap-1.5 no-underline hover:no-underline">
            <img src="/gitflare-icon.png" alt="" className="block h-5 w-auto" aria-hidden="true" />
            <span>Gitflare</span>
          </a>
          <a href="/rooted-finance/git-on-cloudflare" className="no-underline hover:underline">
            Source
          </a>
          <a href="https://wpcloud.delta-git.workers.dev" className="no-underline hover:underline">
            Apps
          </a>
          <a
            href="https://limic.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline hover:underline"
          >
            limic.dev
          </a>
        </div>
      </footer>
    </div>
  )
}
