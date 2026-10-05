import { FC, useState } from 'react'

import { signInWithBluesky } from '../delta/bsky-oauth'

/**
 * Sign-in. The default lane is client-side Bluesky OAuth: the whole PAR +
 * PKCE + DPoP flow runs in the browser, OAuth tokens live in IndexedDB and
 * never transit delta-git's servers, and the resulting dg_session cookie is
 * bound to a non-extractable DPoP key held in the key-custody worker.
 *
 * The legacy DID-challenge flow (sign with your own atproto keypair, no PDS
 * round-trip) remains available at /auth for agents and advanced users.
 */
export const SignIn: FC = () => {
  const [handle, setHandle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onBluesky = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await signInWithBluesky(handle.trim())
      window.location.assign(result.namespace ? `/${result.namespace}` : '/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cn-1">
      <div className="w-full max-w-sm rounded-lg border border-cn-borders-2 bg-cn-2 p-8">
        <h1 className="mb-2 text-xl font-semibold text-cn-foreground-1">Sign in to delta-git</h1>
        <p className="mb-6 text-sm text-cn-foreground-2">
          Authenticate with your Bluesky handle — OAuth runs entirely in your browser; your tokens
          and keys never reach our servers.
        </p>
        <input
          type="text"
          placeholder="you.bsky.social"
          value={handle}
          disabled={busy}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && handle.trim()) void onBluesky()
          }}
          className="mb-4 w-full rounded border border-cn-borders-2 bg-cn-1 px-3 py-2 text-sm text-cn-foreground-1"
        />
        <button
          type="button"
          disabled={busy || !handle.trim()}
          onClick={() => void onBluesky()}
          className="w-full rounded bg-cn-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Waiting for Bluesky…' : 'Continue with Bluesky'}
        </button>
        {error && <p className="mt-4 text-sm text-cn-foreground-danger">{error}</p>}
        <p className="mt-6 text-center text-xs text-cn-foreground-3">
          Have an agent key?{' '}
          <a href="/auth" className="text-cn-accent underline">
            DID sign-in
          </a>
        </p>
      </div>
    </div>
  )
}
