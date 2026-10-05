/**
 * Secrets Broker — use-only secret custody for AI agents.
 *
 * Pure-logic module (no fetch/IndexedDB/worker APIs) so it is fully unit-testable.
 * The key-custody worker instantiates it, resolves handles to secret bytes,
 * executes the resulting request, and redacts the response.
 *
 * Model:
 * - Sealed secrets are WRITE-ONLY: no op returns secret material. Agents get
 *   opaque handles; custody injects the value into an allowed request and
 *   returns only the sanitized response.
 * - Durable grants = approve-once, use-until-revoked. An agent invokes against
 *   a grant id; custody validates handle+host scope on every call.
 * - Canary (honey) handles look like real secrets. Any invoke on one fires the
 *   killswitch cascade — a healthy agent never touches a handle it wasn't
 *   configured to use.
 * - Echo-canary markers: each grant carries an invisible marker; if marker A
 *   appears in a request issued under grant B, the agent is replaying custody
 *   output to a foreign target — trip.
 * - Hash-chained audit records op/handle/grant/outcome — never values.
 *
 * All crypto stays in OSS deps (noble); this module is policy glue only.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type SecretKind = 'sealed' | 'platform' | 'cloud' | 'key' | 'frost'

export interface HandleMeta {
  handle: string
  label: string
  kind: SecretKind
  /** Hostnames (or 'host:port') this secret may be sent to. Empty = none. */
  allowedHosts: string[]
  /** Honey handle — any invoke trips the killswitch. */
  canary: boolean
  createdAt: number
}

export interface SecretGrant {
  id: string
  /** Agent label (client name shown to the owner). */
  label: string
  /** Handle ids usable under this grant, or '*' for all. */
  handles: string[] | '*'
  /** Target hostnames usable under this grant, or '*' for all. */
  hosts: string[] | '*'
  /** Echo-canary marker embedded in this grant's invoke results. */
  marker: string
  /** Optional: invokes under this grant park for owner approval (JIT consent). */
  consentRequired?: boolean
  /** Optional: hard cap on total invokes under this grant (budget). */
  maxInvokes?: number
  /** Optional: grant expires at this epoch-ms — invokes denied after. */
  expiresAt?: number
  /** Invokes served so far under this grant. */
  invokeCount: number
  createdAt: number
  revokedAt?: number
}

export interface SecretInjection {
  /**
   * 'bearer' = Authorization: Bearer, 'header' = named header,
   * 'bodyField' = JSON body field, 'dpop' = sender-constrained proof —
   * the handle holds a non-extractable signing key; custody emits a DPoP
   * proof JWT (RFC 9449) instead of injecting secret bytes. The worker
   * adds the DPoP header after build(); nothing secret crosses the wire.
   */
  type: 'bearer' | 'header' | 'bodyField' | 'dpop'
  name?: string
}

export interface InvokeSpec {
  url: string
  method: string
  headers?: Record<string, string>
  /** JSON-serializable body (string) — secret is injected per `inject`. */
  body?: string
  inject: SecretInjection
}

/** What the worker executes on behalf of an approved invoke. */
export interface BuiltRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface AuditEntry {
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

export interface InvokeDecision {
  ok: boolean
  reason?: string
  trip?: boolean
  /** Grant requires owner consent — caller parks the request for approval. */
  pending?: boolean
}

export interface BrokerState {
  meta: HandleMeta[]
  grants: SecretGrant[]
  /** handle → base64 ciphertext of the raw secret (worker wraps whole blob in secure-KV). */
  secrets: Record<string, string>
  audit: AuditEntry[]
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class BrokerDeny extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'BrokerDeny'
    this.reason = reason
  }
}

/** Thrown when a canary/echo trip fires — the worker runs the killswitch. */
export class CanaryTrip extends Error {
  readonly detail: string
  constructor(detail: string) {
    super(`canary_trip: ${detail}`)
    this.name = 'CanaryTrip'
    this.detail = detail
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function randId(prefix: string): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

export function secretToBytes(secret: string): Uint8Array {
  return encoder.encode(secret)
}

export function bytesToSecret(b: Uint8Array): string {
  return decoder.decode(b)
}

/** Host match: exact or subdomain of an allowed host; '*' entries wildcard. */
export function hostMatches(host: string, allowed: string[] | '*'): boolean {
  if (allowed === '*') return true
  const h = host.toLowerCase()
  return allowed.some((a) => {
    const al = a.toLowerCase()
    return al === '*' || h === al || h.endsWith(`.${al}`)
  })
}

/**
 * Literal-match egress redaction: replaces the secret (and its common
 * transforms — base64, hex, urlencoded) inside a response body so a platform
 * echo cannot leak the credential to the caller.
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text
  const variants = new Set<string>([
    secret,
    btoa(secret),
    bytesToHexLocal(encoder.encode(secret)),
    encodeURIComponent(secret),
  ])
  let out = text
  for (const v of variants) {
    if (v.length < 4) continue
    out = out.split(v).join('[REDACTED]')
  }
  return out
}

function bytesToHexLocal(b: Uint8Array): string {
  return bytesToHex(b)
}

function b64Encode(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sha256HexStr(input: string): string {
  return bytesToHex(sha256(encoder.encode(input)))
}

// ─── Broker ─────────────────────────────────────────────────────────────────

/**
 * Handle resolver — the worker supplies how a handle maps to secret bytes.
 * Sealed secrets resolve from the broker's own store; platform/cloud handles
 * resolve from the worker's existing token maps (no duplication).
 */
export type SecretResolver = (handle: string) => Uint8Array | null

const MAX_AUDIT = 2000
const MAX_SECRET_BYTES = 64 * 1024
const MAX_REQUEST_BYTES = 256 * 1024

export class SecretsBroker {
  private meta = new Map<string, HandleMeta>()
  private grants = new Map<string, SecretGrant>()
  private secrets = new Map<string, Uint8Array>()
  private auditLog: AuditEntry[] = []
  private auditSeq = 0
  private lastAuditHash = 'genesis'
  private tripped = false

  // ── Sealing (owner path — worker gates with fresh assertion) ──

  seal(label: string, secret: Uint8Array, allowedHosts: string[], canary = false, kind: SecretKind = 'sealed'): HandleMeta {
    if (!label.trim()) throw new BrokerDeny('label_required')
    if (!secret.length || secret.length > MAX_SECRET_BYTES) throw new BrokerDeny('secret_size')
    if (!allowedHosts.length) throw new BrokerDeny('allowed_hosts_required')
    const meta: HandleMeta = {
      handle: randId('sec'),
      label: label.slice(0, 120),
      kind,
      allowedHosts: allowedHosts.map((h) => h.toLowerCase()).slice(0, 50),
      canary,
      createdAt: Date.now(),
    }
    this.secrets.set(meta.handle, secret.slice())
    this.meta.set(meta.handle, meta)
    return { ...meta }
  }

  /** Register a virtual handle backed by an external store (platform token). */
  registerVirtual(handle: string, label: string, kind: SecretKind, allowedHosts: string[], canary = false): HandleMeta {
    const meta: HandleMeta = {
      handle, label: label.slice(0, 120), kind,
      allowedHosts: allowedHosts.map((h) => h.toLowerCase()).slice(0, 50),
      canary, createdAt: Date.now(),
    }
    this.meta.set(handle, meta)
    return { ...meta }
  }

  unseal(handle: string): boolean {
    const had = this.secrets.delete(handle)
    const meta = this.meta.get(handle)
    if (meta?.canary) throw new CanaryTrip(`unseal attempted on canary ${handle}`)
    const existed = this.meta.delete(handle)
    // Revoke the handle from every grant so a re-sealed id can't inherit rights
    for (const g of this.grants.values()) {
      if (g.handles !== '*') g.handles = g.handles.filter((h) => h !== handle)
    }
    return had || existed
  }

  /** Metadata only — canaries are listed normally (deception requires it). */
  list(): HandleMeta[] {
    return [...this.meta.values()].map((m) => ({ ...m }))
  }

  /**
   * Internal: resolve a sealed secret's bytes (copy). Never exposed through
   * any public/API surface — the worker calls this only during inject.
   */
  secretBytes(handle: string): Uint8Array | null {
    const b = this.secrets.get(handle)
    return b ? new Uint8Array(b) : null
  }

  // ── Grants (durable — approve once, use until revoked) ──

  grant(
    label: string,
    handles: string[] | '*',
    hosts: string[] | '*',
    opts?: { consentRequired?: boolean; maxInvokes?: number; expiresAt?: number; id?: string },
  ): SecretGrant {
    if (!label.trim()) throw new BrokerDeny('label_required')
    const g: SecretGrant = {
      id: opts?.id || randId('grt'),
      label: label.slice(0, 120),
      handles: handles === '*' ? '*' : [...new Set(handles)],
      hosts: hosts === '*' ? '*' : [...new Set(hosts.map((h) => h.toLowerCase()))],
      marker: `wsp-echo-${randId('mk').slice(3)}`,
      consentRequired: opts?.consentRequired,
      maxInvokes: opts?.maxInvokes,
      expiresAt: opts?.expiresAt,
      invokeCount: 0,
      createdAt: Date.now(),
    }
    this.grants.set(g.id, g)
    return { ...g }
  }

  listGrants(): SecretGrant[] {
    return [...this.grants.values()].map((g) => ({ ...g }))
  }

  revokeGrant(id: string): boolean {
    const g = this.grants.get(id)
    if (!g) return false
    g.revokedAt = Date.now()
    return true
  }

  /**
   * Rotation primitive — swap every grant's reference from oldHandle to
   * newHandle, then tombstone the old handle's secret + metadata. Grants keep
   * their id/scope so holder-facing behavior is unchanged; the old credential
   * is dead. Returns grants rebound.
   */
  rebindHandle(oldHandle: string, newHandle: string): number {
    let n = 0
    for (const g of this.grants.values()) {
      if (g.handles === '*') continue
      const i = g.handles.indexOf(oldHandle)
      if (i !== -1) { g.handles[i] = newHandle; n++ }
    }
    this.secrets.delete(oldHandle)
    this.meta.delete(oldHandle)
    this.record('rotate', oldHandle, undefined, 'ok', `→ ${newHandle.slice(0, 16)}`)
    return n
  }

  private liveGrant(id: string | undefined): SecretGrant {
    if (!id) throw new BrokerDeny('grant_required')
    const g = this.grants.get(id)
    if (!g || g.revokedAt) throw new BrokerDeny('invalid_grant')
    if (g.expiresAt !== undefined && Date.now() > g.expiresAt) throw new BrokerDeny('grant_expired')
    return g
  }

  // ── Invoke ──

  /**
   * Validate an invoke and return the request the worker should execute.
   * Throws BrokerDeny (audited 'denied') or CanaryTrip (audited 'trip').
   * `ownerOk` = caller proved fresh assertion — bypasses grant requirement.
   */
  authorize(
    handle: string,
    spec: InvokeSpec,
    grantId: string | undefined,
    ownerOk: boolean,
  ): { grant: SecretGrant | null; meta: HandleMeta; pending: boolean } {
    try {
      return this.authorizeInner(handle, spec, grantId, ownerOk)
    } catch (e) {
      if (e instanceof BrokerDeny) {
        this.record('invoke', handle, grantId, 'denied', e.reason)
      }
      throw e
    }
  }

  private authorizeInner(
    handle: string,
    spec: InvokeSpec,
    grantId: string | undefined,
    ownerOk: boolean,
  ): { grant: SecretGrant | null; meta: HandleMeta; pending: boolean } {
    if (this.tripped) throw new BrokerDeny('vault_locked')
    const specText = `${spec.url} ${JSON.stringify(spec.headers || {})} ${spec.body || ''}`

    // Planted-canary leak detection: a decoy secret VALUE appearing anywhere in
    // an outbound request means someone found and tried to use a tripwire
    // credential — fires regardless of which handle is being invoked.
    for (const [h, m] of this.meta) {
      if (!m.canary) continue
      const canaryBytes = this.secrets.get(h)
      if (canaryBytes && canaryBytes.length >= 8) {
        const canaryStr = bytesToSecret(canaryBytes)
        if (specText.includes(canaryStr)) {
          this.record('invoke', h, grantId, 'trip', 'canary_value_leak')
          throw new CanaryTrip(`planted canary value used in request`)
        }
      }
    }

    const meta = this.meta.get(handle)
    if (!meta) throw new BrokerDeny('unknown_handle')

    let grant: SecretGrant | null = null
    if (!ownerOk) {
      grant = this.liveGrant(grantId)
      if (grant.handles !== '*' && !grant.handles.includes(handle)) {
        throw new BrokerDeny('handle_not_in_grant')
      }
      if (grant.maxInvokes !== undefined && grant.invokeCount >= grant.maxInvokes) {
        throw new BrokerDeny('grant_budget_exhausted')
      }
    }

    // URL rules: https only, host allowed by secret AND (for agents) by grant.
    let parsed: URL | null = null
    try {
      parsed = new URL(spec.url)
    } catch { /* falls through to the check below */ }
    if (!parsed) throw new BrokerDeny('invalid_url')
    if (parsed.protocol !== 'https:') throw new BrokerDeny('https_required')
    if (!hostMatches(parsed.host, meta.allowedHosts)) throw new BrokerDeny('host_not_allowed_for_secret')
    if (grant && !hostMatches(parsed.host, grant.hosts)) throw new BrokerDeny('host_not_allowed_for_grant')
    if (spec.body && spec.body.length > MAX_REQUEST_BYTES) throw new BrokerDeny('request_too_large')

    // Canary: scope checks PASSED (the handle looked in-scope) — any use is a probe.
    if (meta.canary) {
      this.record('invoke', handle, grantId, 'trip', 'canary_handle')
      throw new CanaryTrip(`canary handle invoked: ${handle}`)
    }

    // Echo-canary: this grant's outbound must not carry ANOTHER grant's marker.
    if (grant) this.checkEcho(specText, grant)

    return { grant, meta, pending: grant?.consentRequired === true }
  }

  /**
   * Build the outbound request with the secret injected. Caller supplies the
   * resolved secret bytes; the returned request must be executed then its
   * response passed to `redactResponse` — never returned raw.
   */
  build(spec: InvokeSpec, secret: Uint8Array): BuiltRequest {
    const headers: Record<string, string> = { ...(spec.headers || {}) }
    let body = spec.body
    switch (spec.inject.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${bytesToSecret(secret)}`
        break
      case 'header':
        if (!spec.inject.name) throw new BrokerDeny('header_name_required')
        headers[spec.inject.name] = bytesToSecret(secret)
        break
      case 'bodyField': {
        if (!spec.inject.name) throw new BrokerDeny('field_name_required')
        let obj: Record<string, unknown>
        try {
          obj = body ? JSON.parse(body) : {}
        } catch {
          throw new BrokerDeny('body_must_be_json')
        }
        obj[spec.inject.name] = bytesToSecret(secret)
        body = JSON.stringify(obj)
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
        break
      }
      case 'dpop':
        // No secret bytes on the wire — the worker signs a DPoP proof JWT
        // with the handle's non-extractable key and adds the DPoP header.
        break
    }
    return { url: spec.url, method: spec.method.toUpperCase(), headers, body }
  }

  /** Literal-redact the secret (and transforms) from a response body. */
  redactResponse(text: string, secret: Uint8Array): string {
    return redactSecret(text, bytesToSecret(secret))
  }

  /** Dry-run: same authorization path, secret never resolved. */
  simulate(handle: string, spec: InvokeSpec, grantId: string | undefined, ownerOk: boolean): InvokeDecision {
    try {
      this.authorizeSim(handle, spec, grantId, ownerOk)
      return { ok: true }
    } catch (e) {
      if (e instanceof CanaryTrip) return { ok: false, trip: true, reason: e.detail }
      return { ok: false, reason: (e as BrokerDeny).reason || 'denied' }
    }
  }

  private authorizeSim(
    handle: string,
    spec: InvokeSpec,
    grantId: string | undefined,
    ownerOk: boolean,
  ): void {
    const meta = this.meta.get(handle)
    if (!meta) throw new BrokerDeny('unknown_handle')
    if (meta.canary) throw new CanaryTrip('canary_handle')
    let grant: SecretGrant | null = null
    if (!ownerOk) {
      grant = this.liveGrant(grantId)
      if (grant.handles !== '*' && !grant.handles.includes(handle)) throw new BrokerDeny('handle_not_in_grant')
      if (grant.maxInvokes !== undefined && grant.invokeCount >= grant.maxInvokes) throw new BrokerDeny('grant_budget_exhausted')
    }
    let parsed: URL
    try {
      parsed = new URL(spec.url)
    } catch {
      throw new BrokerDeny('invalid_url')
    }
    if (parsed.protocol !== 'https:') throw new BrokerDeny('https_required')
    if (!hostMatches(parsed.host, meta.allowedHosts)) throw new BrokerDeny('host_not_allowed_for_secret')
    if (grant && !hostMatches(parsed.host, grant.hosts)) throw new BrokerDeny('host_not_allowed_for_grant')
  }

  // ── Echo-canary ──

  private checkEcho(payloadText: string, grant: SecretGrant): void {
    for (const g of this.grants.values()) {
      if (g.id === grant.id || g.revokedAt) continue
      if (payloadText.includes(g.marker)) {
        this.record('invoke', undefined, grant.id, 'trip', 'echo_marker_leak')
        throw new CanaryTrip(`echo marker of grant ${g.id} replayed under grant ${grant.id}`)
      }
    }
  }

  /** Marker embedded into this grant's invoke results by the worker. */
  markerFor(grantId: string): string | null {
    return this.grants.get(grantId)?.marker ?? null
  }

  /** Count a served invoke against the grant budget (called after execution). */
  noteExecuted(grantId: string | undefined): void {
    const g = grantId ? this.grants.get(grantId) : undefined
    if (g) g.invokeCount++
  }

  // ── Killswitch ──

  /** Whether the vault was tripped (all further invokes denied until wipe+clear). */
  isTripped(): boolean {
    return this.tripped
  }

  /**
   * killswitch — revoke every grant immediately and lock the vault.
   * wipe=true additionally erases all sealed secret bytes (scorched earth;
   * virtual handles are external and handled by the worker's own clearing).
   */
  killswitch(wipe: boolean): { revokedGrants: number; wipedSecrets: number } {
    const revoked = [...this.grants.values()].filter((g) => !g.revokedAt)
    for (const g of revoked) g.revokedAt = Date.now()
    let wiped = 0
    if (wipe) {
      for (const b of this.secrets.values()) b.fill(0)
      wiped = this.secrets.size
      this.secrets.clear()
      this.meta.clear()
    }
    this.tripped = true
    this.record('killswitch', undefined, undefined, 'trip', wipe ? 'wipe' : 'lock')
    return { revokedGrants: revoked.length, wipedSecrets: wiped }
  }

  /** Clear the trip flag after owner re-unlock (worker gates with assertion). */
  resetTrip(): void {
    this.tripped = false
  }

  /**
   * Drop all in-memory state on session lock — secrets zeroed, maps cleared.
   * Persistence is unaffected (the last serialize() already captured state);
   * the worker reloads from encrypted KV on next unlock. Does NOT persist.
   */
  clearMemory(): void {
    for (const b of this.secrets.values()) b.fill(0)
    this.secrets.clear()
    this.meta.clear()
    this.grants.clear()
    this.auditLog = []
    this.auditSeq = 0
    this.lastAuditHash = 'genesis'
  }

  // ── Audit (hash-chained, values never recorded) ──

  record(op: string, handle: string | undefined, grantId: string | undefined, outcome: AuditEntry['outcome'], detail?: string): AuditEntry {
    const seq = ++this.auditSeq
    const ts = Date.now()
    const prevHash = this.lastAuditHash
    const hash = sha256HexStr(`${seq}|${ts}|${op}|${handle || ''}|${grantId || ''}|${outcome}|${detail?.slice(0, 200) || ''}|${prevHash}`)
    const entry: AuditEntry = {
      seq, ts, op, handle, grantId, outcome,
      detail: detail?.slice(0, 200), prevHash, hash,
    }
    this.lastAuditHash = hash
    this.auditLog.push(entry)
    if (this.auditLog.length > MAX_AUDIT) this.auditLog.shift()
    return { ...entry }
  }

  audit(limit = 200): AuditEntry[] {
    return this.auditLog.slice(-limit).map((e) => ({ ...e }))
  }

  /** Verify the audit chain is unbroken and every hash recomputes (tamper evidence). */
  verifyAudit(): boolean {
    let prev = 'genesis'
    for (const e of this.auditLog) {
      if (e.prevHash !== prev) return false
      const recomputed = sha256HexStr(`${e.seq}|${e.ts}|${e.op}|${e.handle || ''}|${e.grantId || ''}|${e.outcome}|${e.detail || ''}|${e.prevHash}`)
      if (recomputed !== e.hash) return false
      prev = e.hash
    }
    return true
  }

  // ── Persistence ──

  serialize(): BrokerState {
    const secrets: Record<string, string> = {}
    for (const [h, b] of this.secrets) secrets[h] = b64Encode(b)
    return {
      meta: [...this.meta.values()],
      grants: [...this.grants.values()],
      secrets,
      audit: this.auditLog.slice(-500),
    }
  }

  restore(state: BrokerState): void {
    this.meta = new Map((state.meta || []).map((m) => [m.handle, m]))
    this.grants = new Map(
      (state.grants || []).map((g) => [g.id, { ...g, invokeCount: g.invokeCount ?? 0 }]),
    )
    this.secrets = new Map(
      Object.entries(state.secrets || {}).map(([h, s]) => [h, b64Decode(s)] as const),
    )
    this.auditLog = state.audit || []
    this.auditSeq = this.auditLog[this.auditLog.length - 1]?.seq || 0
    this.lastAuditHash = this.auditLog[this.auditLog.length - 1]?.hash || 'genesis'
  }
}
