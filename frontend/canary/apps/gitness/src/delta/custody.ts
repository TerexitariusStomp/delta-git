/**
 * Client wrapper for the key-custody worker. The page can only ever see the
 * public JWK or signed proofs — private key material stays in the worker.
 *
 * Ported from Rooted apps/socials-vite `worker-client.ts` + `dpop-keys.ts`
 * (DPoP lane only; upstream also exposes vault/secrets-broker methods).
 */

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, PendingCall>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./key-custody.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const { id, ok, result, error } = event.data as {
        id: number
        ok: boolean
        result?: unknown
        error?: string
      }
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (ok) entry.resolve(result)
      else entry.reject(new Error(error ?? 'custody error'))
    }
  }
  return worker
}

function call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
  const w = getWorker()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ id, method, args })
  })
}

/** Public JWK of the custody DPoP key — sent to /auth/atp/verify for binding. */
export function getDpopJwk(): Promise<JsonWebKey> {
  return call<JsonWebKey>('getDpopJwk')
}

/** RFC 9449 DPoP proof for (method, url) — signed inside the worker. */
export function signDpop(url: string, method: string): Promise<string> {
  return call<string>('signDpop', { url, method })
}

/** Forget the DPoP keypair (logout / key rotation). */
export function clearDpopKey(): Promise<void> {
  return call<void>('clearDpopKey')
}
