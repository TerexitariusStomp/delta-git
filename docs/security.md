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

- **No server-side atproto custody** (widespread constraint carried over):
  no atproto tokens stored, no atproto client secret — the OAuth client is
  public (`token_endpoint_auth_method: none`) and the access token is
  discarded after reading `sub`.
- **delta-git OAuth issuer** (`@cloudflare/workers-oauth-provider`): the
  worker mints its own access/refresh tokens for agents, MCP, and Git Smart
  HTTP. Tokens are stored SHA-256-hashed in `OAUTH_KV` — a KV dump yields no
  usable credentials. Token `props` (userId/did/namespace) are encrypted so
  only the token holder can unwrap them. Scopes (`repo:read`, `repo:write`,
  `offline_access`) are enforced per-surface on top of namespace membership.
  First-party clients sender-constrain tokens with DPoP (`cnf.jkt` bound at
  issuance, single-use `jti` replay protection in KV); the git transport
  accepts bound tokens as plain bearer because stock git cannot mint
  per-request proofs.
- **Repo secrets are write-only**: `PUT /dg/secrets/:name` encrypts with `DG_KEK`
  before storing in the repo DO; values are never readable back through any API.
- PATs are stored SHA-256-hashed; the cleartext is shown once at issue.
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

## Compute sandbox threat model

Platform jobs (CI runs, security scans, mirror pushes, chaos) and dev
workspaces run untrusted-ish code inside ForgeSandbox containers
(`src/worker/compute/`).

**Isolation.** Sandbox ids are derived `job-{ns}-{kind}-{id}` /
`ws-{ns}-{id}` through `compute/sandbox.ts` — the only sanctioned way to
obtain a stub. There is no ambient sandbox registry; cross-space access
requires bypassing the helper. Job sandboxes sleep after 10m idle,
workspaces after 30m.

**Auth.** Every workspace surface (exec, files, preview) requires owning
space membership — previews are never public. Job sandboxes are
queue-internal; no HTTP route touches them directly.

**Egress.** Jobs get an in-container iptables default-DROP policy
(`compute/egress.ts`) resolved per kind: `ci` → package registries + VCS
hosts; `security-scan` → vuln DBs + self; `federate` → self + target host
only. The policy applies *before* job-controlled code or secrets stage.
When the container lacks NET_ADMIN the apply fails open — every caller
logs `*-egress-not-enforced` rather than pretending; the federate path is
the exception and fails closed because it holds the mirror key.

**Secrets.** User secrets are client-sealed — no code path can hand one to
a container. Platform material (mirror SSH key) is written to disk inside
the sandbox (mode 600), never via argv or env, and deleted in `finally`
before the job returns. `runJob`'s `envVars` field is documented
never-secrets.

**Residual risks** (accepted, documented): DNS stays open inside locked
sandboxes (needed for runtime resolution) so DNS-tunnel exfil is
theoretically possible; NET_ADMIN-less containers run egress-open; a
compromised sandbox has no path to other spaces' data because creds never
enter the image.

## Abuse controls

See `docs/ops.md` for the ceilings table. Rate limits are KV token buckets;
idea/post/import lanes have the tightest limits since they're the spam surface.
Storage quota is enforced pre-finalize in the receive pipeline.

## Deploy gate

`wrangler deploy` is intercepted by a local security gate (gitleaks + trivy +
semgrep). Do not bypass with `SECURITY_SKIP=1` except emergencies.
