import { describe, it, expect } from 'vitest'
import { computeJwkThumbprint, verifyDpopProof } from '@/vendor/widespread/auth/dpop.js'
import { issueChallenge, consumeChallenge, type ChallengeStore } from '@/vendor/widespread/auth/challenge.js'

describe('computeJwkThumbprint', () => {
  it('computes a deterministic base64url thumbprint', async () => {
    const jwk = { kty: 'EC', x: 'test-x', y: 'test-y' }
    const t1 = await computeJwkThumbprint(jwk)
    const t2 = await computeJwkThumbprint(jwk)
    expect(t1).toBe(t2)
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('differs for different keys', async () => {
    const a = await computeJwkThumbprint({ kty: 'EC', x: 'x1', y: 'y1' })
    const b = await computeJwkThumbprint({ kty: 'EC', x: 'x2', y: 'y2' })
    expect(a).not.toBe(b)
  })
})

describe('challenge', () => {
  function makeStore(): ChallengeStore & { _data: Map<string, string> } {
    const _data = new Map<string, string>()
    return {
      _data,
      put: async (k: string, v: string) => { _data.set(k, v) },
      get: async (k: string) => _data.get(k) ?? null,
      delete: async (k: string) => { _data.delete(k) },
    }
  }

  it('issues and consumes a challenge (single-use)', async () => {
    const store = makeStore()
    const nonce = await issueChallenge('did:plc:test', store, 'test-pepper')
    expect(nonce.length).toBeGreaterThan(10)
    const did = await consumeChallenge(nonce, store)
    // Stored value is HMAC(did, pepper), not the raw DID
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-pepper'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('did:plc:test'))
    const expected = '0x' + Array.from(new Uint8Array(sig).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('')
    expect(did).toBe(expected)
    // Second use fails (single-use)
    const did2 = await consumeChallenge(nonce, store)
    expect(did2).toBeNull()
  })

  it('returns null for unknown nonce', async () => {
    const store = makeStore()
    const did = await consumeChallenge('unknown-nonce', store)
    expect(did).toBeNull()
  })
})

describe('verifyDpopProof', () => {
  it('rejects malformed proofs', async () => {
    const store: any = { get: async () => null, put: async () => {} }
    expect(await verifyDpopProof('not-a-jwt', 'GET', '/test', 'jkt', store)).toBe(false)
    expect(await verifyDpopProof('a.b', 'GET', '/test', 'jkt', store)).toBe(false)
  })
})
