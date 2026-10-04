# Security Posture

Threat model, session/crypto design, and the constraints carried over from the
widespread auth port.

## Sessions & auth

- **DID sessions (`dg_session`)**: httpOnly cookie, HMAC-signed JWT
  (`SESSION_SECRET`), 24h TTL. Revocation authority is the `did_sessions` D1
  row (`revoked_at`), checked on every authed request — logout and compromise
  revocation are immediate, not TTL-bound.
- **OAuth browser sign-in**: `GET /auth/oauth/start` runs the atproto OAuth
  profile as a public client (no client secret): PAR + PKCE(S256) + DPoP,
  with per-request keys generated fresh and stashed in KV under a single-use
  `oauthstate:` nonce (10-min TTL, deleted on callback). The authorization
  server is resolved per-account — handle → DID → `#atproto_pds` service →
  `oauth-protected-resource` metadata — defaulting to `bsky.social`. We
  request the minimal `atproto` scope and discard the access token; only the
  token response `sub` DID feeds the session bootstrap.
- **Challenge flow**: `GET /auth/did/challenge` issues a single-use KV nonce
  (5-min TTL); `POST /auth/did/verify` consumes it before signature
  verification — replay-safe by construction. Kept for did:key/device-key
  sign-in and agents.
- **DID document resolution**: `did:plc` → plc.directory, `did:web` →
  `/.well-known/did.json` (unauthenticated canonical sources; the PDS
  `resolveDid` XRPC is a fallback — bsky.social gates it behind auth).
- **Signature verification**: secp256k1 via `@noble/curves`, ed25519 via
  WebCrypto. DID resolution (PLC directory + `com.atproto.identity.resolveHandle`,
  `ATP_PDS_URL`-configured PDS) is verified against the resolved DID document,
  not the claimed key.
- **Device keys**: session-bound key rotation via `POST /auth/did/keys`
  (bind/revoke). `identities.device_keys` is an append-only JSON audit log —
  revocations record `revokedAt`, entries are never deleted.
- **Tessera**: legacy OIDC path, gated by `TESSERA_AUTH` (`off` default). The
  OIDC client secret is only required when the flag is on.
- **DPoP**: `did_sessions.dpop_jkt` stores the session's DPoP key thumbprint;
  sender-constrained clients bind their session to a key the server never sees.

## Agent requests

- ed25519 signed envelopes (`x-dg-*` headers) over a canonical digest —
  method, path, timestamp, nonce, body hash. Timestamp+nonce windows reject
  replays; nonces are KV-tracked.
- Agent DIDs are `did:key` (legacy `did:dg` read-compat). Server stores public
  keys only; private keys never leave the agent.
- Reputation gates quorum voting and work claiming; rep is earned, not granted.

## Secrets & privacy posture

- **No server-side OAuth/token custody** (widespread constraint carried over):
  no refresh tokens stored, no atproto client secret — the OAuth client is
  public (`token_endpoint_auth_method: none`) and the access token is
  discarded after reading `sub`.
- **Repo secrets are write-only**: `PUT /dg/secrets/:name` encrypts with `DG_KEK`
  before storing in the repo DO; values are never readable back through any API.
- PATs are stored argon2-hashed; the cleartext is shown once at issue.
- Private repos never appear in federation, XRPC, leaderboards, or exports;
  visibility checks happen at route resolution.

## Integrity & auditability

- `op_log` is hash-chained per repo (`prev_hash` → `hash`); `/dg/oplog` and the
  `/dg/export` bundle carry the chain for independent verification.
- Merge attestations are DSSE/in-toto envelopes in R2 (`attestations/<oid>`),
  embedded in the export bundle.
- `/dg/export` produces a signed provenance bundle (HMAC-SHA256 over the
  canonical manifest with `DG_KEK`) — anti-lock-in and post-incident audit.
- DO state snapshots (`do/<id>/snapshots/latest.json`) enable coordination-state
  rebuild without trusting a live DO.

## Abuse controls

See `docs/ops.md` for the ceilings table. Rate limits are KV token buckets;
idea/post/import lanes have the tightest limits since they're the spam surface.
Storage quota is enforced pre-finalize in the receive pipeline.

## Deploy gate

`wrangler deploy` is intercepted by a local security gate (gitleaks + trivy +
semgrep). Do not bypass with `SECURITY_SKIP=1` except emergencies.
