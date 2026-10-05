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

const DB_NAME = 'dg-custody'
const STORE = 'keys'
const DPOP_KEY_ID = 'dpopSessionKey'

interface CustodyRequest {
  id: number
  method: 'getDpopJwk' | 'signDpop' | 'clearDpopKey'
  args?: { url?: string; method?: string }
}

const te = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function idb(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode)
      const req = run(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }
  })
}

async function loadDpopKey(): Promise<CryptoKeyPair | undefined> {
  return (await idb('readonly', (s) => s.get(DPOP_KEY_ID)).catch(() => undefined)) as
    | CryptoKeyPair
    | undefined
}

async function saveDpopKey(kp: CryptoKeyPair): Promise<void> {
  await idb('readwrite', (s) => s.put(kp, DPOP_KEY_ID)).catch(() => {})
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
  await idb('readwrite', (s) => s.delete(DPOP_KEY_ID)).catch(() => {})
}

self.onmessage = async (event: MessageEvent<CustodyRequest>) => {
  const { id, method, args } = event.data
  try {
    let result: unknown
    if (method === 'getDpopJwk') result = await getDpopJwk()
    else if (method === 'signDpop') result = await signDpop(args?.url ?? '', args?.method ?? 'GET')
    else if (method === 'clearDpopKey') result = await clearDpopKey()
    else throw new Error(`unknown method: ${method}`)
    ;(self as unknown as Worker).postMessage({ id, ok: true, result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
