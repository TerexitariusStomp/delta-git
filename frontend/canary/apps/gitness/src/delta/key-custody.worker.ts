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
    | 'getWrapPubJwk'
    | 'repoKeyInit'
    | 'repoKeyUnwrap'
    | 'repoKeyWrapFor'
    | 'repoEncrypt'
    | 'repoDecrypt'
    | 'repoKeyForget'
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

// Accepts both standard and base64url alphabets — the repo-key lane emits
// base64url while legacy blobs are standard b64.
function b64decodeAny(s: string): Uint8Array {
  return b64decode(s.replace(/-/g, '+').replace(/_/g, '/'))
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

// ---------------------------------------------------------------------------
// Repo-key lane — E2E-encrypted private repos.
//
// A per-member non-extractable P-256 ECDH key ("wrap key") wraps the repo's
// AES-256-GCM content key. Wrapped blobs are `{v,from,iv,ct}` where `from`
// is the *wrapper's* public JWK so the recipient can derive the shared
// secret with their own private key. The raw repo key lives only in this
// worker's memory — the server stores ciphertext.
// ---------------------------------------------------------------------------

const WRAP_KEY_ID = 'repoWrapKey'
const REPO_AES: AesKeyAlgorithm = { name: 'AES-GCM', length: 256 }

interface WrappedRepoKey {
  v: 1
  from: JsonWebKey
  iv: string
  ct: string
}

let wrapPair: CryptoKeyPair | null = null
// Raw repo key bytes held in worker memory only — needed to re-wrap for
// other members. Never persisted; unwraps are re-fetched per session.
const repoKeys = new Map<string, Uint8Array>()

async function getOrCreateWrapPair(): Promise<CryptoKeyPair> {
  if (wrapPair) return wrapPair
  const stored = (await idb('readonly', STORE, (s) => s.get(WRAP_KEY_ID)).catch(
    () => undefined
  )) as CryptoKeyPair | undefined
  if (stored?.publicKey && stored?.privateKey) {
    wrapPair = stored
    return stored
  }
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // private non-extractable; public half stays exportable
    ['deriveBits']
  )) as CryptoKeyPair
  await idb('readwrite', STORE, (s) => s.put(kp, WRAP_KEY_ID)).catch(() => {})
  wrapPair = kp
  return kp
}

async function getWrapPubJwk(): Promise<JsonWebKey> {
  const kp = await getOrCreateWrapPair()
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

/** ECDH(priv, peerPub) -> HKDF -> AES-256-GCM wrap key. `from` records the
 *  wrapper's public half so the peer can re-derive on unwrap. */
async function wrapKeyFor(jwk: JsonWebKey, raw: Uint8Array): Promise<WrappedRepoKey> {
  const pair = await getOrCreateWrapPair()
  const peer = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true } as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    pair.privateKey,
    256
  )
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: te.encode('dg-repo-key-wrap'), info: te.encode('v1'), hash: 'SHA-256' },
    hkdf,
    REPO_AES,
    false,
    ['wrapKey', 'unwrapKey']
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, raw as BufferSource)
  const from = await getWrapPubJwk()
  return { v: 1, from, iv: base64url(iv), ct: base64url(new Uint8Array(ct)) }
}

async function unwrapRepoKey(blob: WrappedRepoKey): Promise<Uint8Array> {
  const pair = await getOrCreateWrapPair()
  const peer = await crypto.subtle.importKey(
    'jwk',
    { ...blob.from, ext: true } as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    pair.privateKey,
    256
  )
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: te.encode('dg-repo-key-wrap'), info: te.encode('v1'), hash: 'SHA-256' },
    hkdf,
    REPO_AES,
    false,
    ['wrapKey', 'unwrapKey']
  )
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decodeAny(blob.iv) as BufferSource },
    aes,
    b64decodeAny(blob.ct) as BufferSource
  )
  return new Uint8Array(pt)
}

async function repoAesKey(repoId: string): Promise<CryptoKey> {
  const raw = repoKeys.get(repoId)
  if (!raw) throw new Error('repo key not unlocked')
  return crypto.subtle.importKey('raw', raw as BufferSource, REPO_AES, false, [
    'encrypt',
    'decrypt',
  ])
}

async function dispatchRepoKey(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'getWrapPubJwk':
      return getWrapPubJwk()
    case 'repoKeyInit': {
      const repoId = String(args?.repoId ?? '')
      if (!repoId) throw new Error('repoId required')
      const raw = crypto.getRandomValues(new Uint8Array(32))
      repoKeys.set(repoId, raw)
      const own = await getWrapPubJwk()
      return { wrapped: await wrapKeyFor(own, raw) }
    }
    case 'repoKeyUnwrap': {
      const repoId = String(args?.repoId ?? '')
      const raw = await unwrapRepoKey(args?.wrapped as WrappedRepoKey)
      repoKeys.set(repoId, raw)
      return { ok: true }
    }
    case 'repoKeyWrapFor': {
      const repoId = String(args?.repoId ?? '')
      const raw = repoKeys.get(repoId)
      if (!raw) throw new Error('repo key not unlocked')
      return { wrapped: await wrapKeyFor(args?.memberJwk as JsonWebKey, raw) }
    }
    case 'repoEncrypt': {
      const repoId = String(args?.repoId ?? '')
      const key = await repoAesKey(repoId)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        b64decodeAny(String(args?.data ?? '')) as BufferSource
      )
      // wire format: iv || ciphertext
      const out = new Uint8Array(12 + ct.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(ct), 12)
      return { data: base64url(out) }
    }
    case 'repoDecrypt': {
      const repoId = String(args?.repoId ?? '')
      const key = await repoAesKey(repoId)
      const buf = b64decodeAny(String(args?.data ?? ''))
      if (buf.length < 13) throw new Error('ciphertext too short')
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf.slice(0, 12) as BufferSource },
        key,
        buf.slice(12) as BufferSource
      )
      return { data: base64url(new Uint8Array(pt)) }
    }
    case 'repoKeyForget': {
      repoKeys.delete(String(args?.repoId ?? ''))
      return { ok: true }
    }
    default:
      throw new Error(`unknown repo-key method: ${method}`)
  }
}

self.onmessage = async (event: MessageEvent<CustodyRequest>) => {
  const { id, method, args } = event.data
  try {
    let result: unknown
    if (method === 'getDpopJwk') result = await getDpopJwk()
    else if (method === 'signDpop') result = await signDpop(args?.url as string, args?.method as string)
    else if (method === 'clearDpopKey') result = await clearDpopKey()
    else if (method === 'getWrapPubJwk' || method.startsWith('repo'))
      result = await dispatchRepoKey(method, args ?? {})
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
