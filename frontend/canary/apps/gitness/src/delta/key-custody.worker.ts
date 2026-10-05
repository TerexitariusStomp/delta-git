/**
 * Key-custody worker — DPoP lane (ported from Rooted apps/socials-vite
 * key-custody.worker.ts, trimmed to delta-git's needs).
 *
 * SECURITY MODEL: the P-256 signing keypair is generated non-extractable and
 * persisted in the worker's own IndexedDB scope. The main page can request
 * the public JWK (sent to the server for session binding) and DPoP proof
 * signatures — it can never read private key material. XSS on the page can
 * ask for proofs of page-initiated requests, but cannot exfiltrate the key
 * or mint proofs for arbitrary origins' replay elsewhere.
 */

import { SecretsBroker, type BrokerState, type InvokeSpec } from './vendor/secrets-broker'

const DB_NAME = 'dg-custody'
const STORE = 'keys'
const SECRETS_STORE = 'secrets'
const DPOP_KEY_ID = 'dpopSessionKey'
const VAULT_KEY_ID = 'vaultWrapKey'
const BROKER_STATE_ID = 'brokerState'

interface CustodyRequest {
  id: number
  method:
    | 'getDpopJwk'
    | 'signDpop'
    | 'clearDpopKey'
    | 'sealSecret'
    | 'unsealSecret'
    | 'listSecrets'
    | 'createGrant'
    | 'listGrants'
    | 'revokeGrant'
    | 'invokeSecret'
    | 'secretsAudit'
    | 'secretsKillswitch'
  args?: Record<string, unknown>
}

const te = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function idb(
  mode: IDBTransactionMode,
  storeName: string,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // v2 adds the secrets store; onupgradeneeded creates whichever is missing.
    const open = indexedDB.open(DB_NAME, 2)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE)
      if (!open.result.objectStoreNames.contains(SECRETS_STORE))
        open.result.createObjectStore(SECRETS_STORE)
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(storeName, mode)
      const req = run(tx.objectStore(storeName))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }
  })
}

async function loadDpopKey(): Promise<CryptoKeyPair | undefined> {
  return (await idb('readonly', STORE, (s) => s.get(DPOP_KEY_ID)).catch(() => undefined)) as
    | CryptoKeyPair
    | undefined
}

async function saveDpopKey(kp: CryptoKeyPair): Promise<void> {
  await idb('readwrite', STORE, (s) => s.put(kp, DPOP_KEY_ID)).catch(() => {})
}

let cachedPair: CryptoKeyPair | null = null

async function getOrCreateDpopKey(): Promise<CryptoKeyPair> {
  if (cachedPair) return cachedPair
  const stored = await loadDpopKey()
  if (stored?.publicKey && stored?.privateKey) {
    cachedPair = stored
    return stored
  }
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // non-extractable — private key never leaves this worker
    ['sign', 'verify']
  )) as CryptoKeyPair
  await saveDpopKey(kp)
  cachedPair = kp
  return kp
}

/** Public JWK of the DPoP key — sent to the server at session issuance. */
async function getDpopJwk(): Promise<JsonWebKey> {
  const kp = await getOrCreateDpopKey()
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

/** RFC 9449 DPoP proof for (method, url). */
async function signDpop(url: string, method: string): Promise<string> {
  const kp = await getOrCreateDpopKey()
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y },
  }
  const payload = {
    htm: method.toUpperCase(),
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  }
  const encoded =
    `${base64url(te.encode(JSON.stringify(header)))}.` +
    `${base64url(te.encode(JSON.stringify(payload)))}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    kp.privateKey,
    te.encode(encoded)
  )
  return `${encoded}.${base64url(new Uint8Array(signature))}`
}

async function clearDpopKey(): Promise<void> {
  cachedPair = null
  await idb('readwrite', STORE, (s) => s.delete(DPOP_KEY_ID)).catch(() => {})
}

// ─── Secrets lane (vendored secrets-broker) ─────────────────────────────────
//
// The broker holds secret BYTES in worker memory; the persisted form is a
// serialized BrokerState wrapped with a non-extractable AES-GCM vault key in
// this worker's IDB. The page only ever sees handle metadata, grant
// records, and redacted invoke responses — never secret material.

const broker = new SecretsBroker()
let vaultKey: CryptoKey | null = null

async function getVaultKey(): Promise<CryptoKey> {
  if (vaultKey) return vaultKey
  const stored = (await idb('readonly', STORE, (s) => s.get(VAULT_KEY_ID)).catch(
    () => undefined
  )) as CryptoKey | undefined
  if (stored) {
    vaultKey = stored
    return stored
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await idb('readwrite', STORE, (s) => s.put(key, VAULT_KEY_ID)).catch(() => {})
  vaultKey = key
  return key
}

interface WrappedBlob {
  iv: string
  ct: string
}

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function wrapState(state: BrokerState): Promise<WrappedBlob> {
  const key = await getVaultKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    te.encode(JSON.stringify(state))
  )
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) }
}

async function unwrapState(blob: WrappedBlob): Promise<BrokerState | null> {
  try {
    const key = await getVaultKey()
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(blob.iv) as BufferSource },
      key,
      b64decode(blob.ct) as BufferSource
    )
    return JSON.parse(new TextDecoder().decode(pt)) as BrokerState
  } catch {
    return null
  }
}

async function persistBroker(): Promise<void> {
  const blob = await wrapState(broker.serialize())
  await idb('readwrite', SECRETS_STORE, (s) => s.put(blob, BROKER_STATE_ID)).catch(() => {})
}

async function restoreBroker(): Promise<void> {
  const blob = (await idb('readonly', SECRETS_STORE, (s) => s.get(BROKER_STATE_ID)).catch(
    () => undefined
  )) as WrappedBlob | undefined
  if (!blob) return
  const state = await unwrapState(blob)
  if (state) broker.restore(state)
}

let brokerLoaded = false
async function ensureBroker(): Promise<SecretsBroker> {
  if (!brokerLoaded) {
    brokerLoaded = true
    await restoreBroker()
  }
  return broker
}

interface InvokeArgs {
  handle?: string
  spec?: InvokeSpec
  grantId?: string
  ownerOk?: boolean
}

interface InvokeResult {
  status: number
  body: string
  pending?: boolean
}

/**
 * Execute a broker-authorized request inside the worker: authorize → inject
 * → fetch → redact → budget count → persist. Secret bytes never leave this
 * function's scope; the page receives only the sanitized response.
 */
async function invokeSecret(args: InvokeArgs): Promise<InvokeResult> {
  const b = await ensureBroker()
  const { handle, spec, grantId, ownerOk } = args
  if (!handle || !spec) throw new Error('handle+spec required')

  const { grant, pending } = b.authorize(handle, spec, grantId, ownerOk === true)
  if (pending) return { status: 202, body: '', pending: true }

  const secret = b.secretBytes(handle)
  if (!secret && spec.inject.type !== 'dpop') throw new Error('secret_unresolvable')

  const req = b.build(spec, secret ?? new Uint8Array(0))
  if (spec.inject.type === 'dpop') {
    // Sender-constrained handle — sign a proof with the custody key instead
    // of injecting bytes.
    req.headers['DPoP'] = await signDpop(req.url, req.method)
  }
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
  const text = await res.text()
  const redacted = secret ? b.redactResponse(text, secret) : text
  b.noteExecuted(grant?.id)
  await persistBroker()
  return { status: res.status, body: redacted }
}

async function sealSecret(args: Record<string, unknown>): Promise<unknown> {
  const b = await ensureBroker()
  const meta = b.seal(
    String(args.label ?? ''),
    b64decode(String(args.secretB64 ?? '')),
    (args.allowedHosts as string[]) ?? [],
    args.canary === true
  )
  await persistBroker()
  return meta
}

async function dispatchSecret(
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const b = await ensureBroker()
  switch (method) {
    case 'sealSecret':
      return sealSecret(args)
    case 'unsealSecret': {
      const ok = b.unseal(String(args.handle ?? ''))
      await persistBroker()
      return ok
    }
    case 'listSecrets':
      return b.list()
    case 'createGrant': {
      const g = b.grant(
        String(args.label ?? ''),
        (args.handles as string[] | '*') ?? [],
        (args.hosts as string[] | '*') ?? [],
        args.opts as { consentRequired?: boolean; maxInvokes?: number; expiresAt?: number }
      )
      await persistBroker()
      return g
    }
    case 'listGrants':
      return b.listGrants()
    case 'revokeGrant': {
      const ok = b.revokeGrant(String(args.grantId ?? ''))
      await persistBroker()
      return ok
    }
    case 'invokeSecret':
      return invokeSecret(args as InvokeArgs)
    case 'secretsAudit':
      return b.audit(Number(args.limit) || 200)
    case 'secretsKillswitch': {
      const r = b.killswitch(args.wipe === true)
      await persistBroker()
      return r
    }
    default:
      throw new Error(`unknown secret method: ${method}`)
  }
}

self.onmessage = async (event: MessageEvent<CustodyRequest>) => {
  const { id, method, args } = event.data
  try {
    let result: unknown
    if (method === 'getDpopJwk') result = await getDpopJwk()
    else if (method === 'signDpop') result = await signDpop(args?.url as string, args?.method as string)
    else if (method === 'clearDpopKey') result = await clearDpopKey()
    else result = await dispatchSecret(method, args ?? {})
    ;(self as unknown as Worker).postMessage({ id, ok: true, result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
