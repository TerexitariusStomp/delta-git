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
    // Without these, a worker that fails to load (script error, blocked
    // module, CSP) leaves every pending call awaiting a reply that never
    // comes — the page hangs with no signal. Reject everything instead.
    const failAll = (reason: string) => {
      const entries = [...pending.values()]
      pending.clear()
      for (const entry of entries) entry.reject(new Error(reason))
      worker = null
    }
    worker.onerror = (e) =>
      failAll(`custody worker error: ${e.message || 'script failed to load'}`)
    worker.onmessageerror = () => failAll('custody worker message error')
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

// ─── Secrets broker ops ─────────────────────────────────────────────────────
// Types mirror the vendored broker; kept structurally compatible so the page
// never imports worker internals.

export interface SecretHandleMeta {
  handle: string
  label: string
  kind: 'sealed' | 'platform' | 'cloud' | 'key' | 'frost'
  allowedHosts: string[]
  canary: boolean
  createdAt: number
}

export interface SecretGrantInfo {
  id: string
  label: string
  handles: string[] | '*'
  hosts: string[] | '*'
  consentRequired?: boolean
  maxInvokes?: number
  expiresAt?: number
  invokeCount: number
  createdAt: number
  revokedAt?: number
}

export interface SecretInvokeSpec {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  inject: { type: 'bearer' | 'header' | 'bodyField' | 'dpop'; name?: string }
}

export interface SecretInvokeResult {
  status: number
  body: string
  pending?: boolean
}

export interface SecretAuditEntry {
  seq: number
  ts: number
  op: string
  handle?: string
  grantId?: string
  outcome: 'ok' | 'denied' | 'trip'
  detail?: string
  prevHash: string
  hash: string
}

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** Seal a secret — write-only. Returns the handle metadata, never the value. */
export function sealSecret(
  label: string,
  secret: string,
  allowedHosts: string[],
  canary = false
): Promise<SecretHandleMeta> {
  return call<SecretHandleMeta>('sealSecret', {
    label,
    secretB64: b64encode(new TextEncoder().encode(secret)),
    allowedHosts,
    canary,
  })
}

export function unsealSecret(handle: string): Promise<boolean> {
  return call<boolean>('unsealSecret', { handle })
}

export function listSecrets(): Promise<SecretHandleMeta[]> {
  return call<SecretHandleMeta[]>('listSecrets')
}

export function createGrant(
  label: string,
  handles: string[] | '*',
  hosts: string[] | '*',
  opts?: { consentRequired?: boolean; maxInvokes?: number; expiresAt?: number }
): Promise<SecretGrantInfo> {
  return call<SecretGrantInfo>('createGrant', { label, handles, hosts, opts })
}

export function listGrants(): Promise<SecretGrantInfo[]> {
  return call<SecretGrantInfo[]>('listGrants')
}

export function revokeGrant(grantId: string): Promise<boolean> {
  return call<boolean>('revokeGrant', { grantId })
}

/**
 * Invoke through the broker — the worker authorizes (grant scope, host
 * allowlist, canary checks), injects the secret, executes the fetch, redacts
 * the response, and returns only the sanitized result.
 */
export function invokeSecret(
  handle: string,
  spec: SecretInvokeSpec,
  grantId?: string,
  ownerOk = false
): Promise<SecretInvokeResult> {
  return call<SecretInvokeResult>('invokeSecret', { handle, spec, grantId, ownerOk })
}

export function secretsAudit(limit = 200): Promise<SecretAuditEntry[]> {
  return call<SecretAuditEntry[]>('secretsAudit', { limit })
}

export function secretsKillswitch(wipe = false): Promise<{
  revokedGrants: number
  wipedSecrets: number
}> {
  return call('secretsKillswitch', { wipe })
}

// ---------------------------------------------------------------------------
// E2E private-repo key custody — repo AES keys wrapped per member inside the
// worker; the server only ever stores wrapped ciphertext.
// ---------------------------------------------------------------------------

export interface WrappedRepoKey {
  v: 1
  from: JsonWebKey
  iv: string
  ct: string
}

/** Public JWK of this device's wrap key — publish via PUT /user/wrapkey. */
export function getWrapPubJwk(): Promise<JsonWebKey> {
  return call<JsonWebKey>('getWrapPubJwk')
}

/** Generate a fresh repo AES key, hold it in worker memory, return the
 *  wrapped copy to store server-side for this member. */
export function repoKeyInit(repoId: string): Promise<{ wrapped: WrappedRepoKey }> {
  return call('repoKeyInit', { repoId })
}

/** Unlock a repo key from this member's server-stored wrapped copy. */
export function repoKeyUnwrap(repoId: string, wrapped: WrappedRepoKey): Promise<{ ok: boolean }> {
  return call('repoKeyUnwrap', { repoId, wrapped })
}

/** Produce another member's wrapped copy of the unlocked repo key —
 *  memberJwk comes from GET /users/{uid}/wrapkey. */
export function repoKeyWrapFor(
  repoId: string,
  memberJwk: JsonWebKey
): Promise<{ wrapped: WrappedRepoKey }> {
  return call('repoKeyWrapFor', { repoId, memberJwk })
}

/** AES-GCM encrypt/decrypt with the unlocked repo key (base64url in/out;
 *  wire format is iv || ciphertext). */
export function repoEncrypt(repoId: string, data: string): Promise<{ data: string }> {
  return call('repoEncrypt', { repoId, data })
}
export function repoDecrypt(repoId: string, data: string): Promise<{ data: string }> {
  return call('repoDecrypt', { repoId, data })
}

/** Drop the unlocked repo key from worker memory (logout / scope switch). */
export function repoKeyForget(repoId: string): Promise<{ ok: boolean }> {
  return call('repoKeyForget', { repoId })
}
