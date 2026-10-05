# widespread auth/crypto — vendored from Rooted workspace

Upstream: `/home/terex/Documents/Rooted/packages/{auth,crypto}` (private monorepo,
same author, AGPL-3.0 — permissively reusable inside this project).

## Why vendored, not ported

`@widespread/auth` / `@widespread/crypto` are unpublished workspace packages
(`private: true`, `workspace:*` deps). Vendoring preserves authorship,
update path (re-copy the package dirs), and code parity rather than
maintaining a divergent port.

## Contents

- `auth/` — `packages/auth/src` verbatim: DPoP verification, challenge
  protocol, session JWTs with `cnf.jkt` DPoP binding, service-auth JWT
  helpers, header parsing.
- `crypto/` — `packages/crypto/src` minus `encoding.ts`'s viem dependency:
  hex helpers are reimplemented locally (~30 LOC) so the vendored tree
  doesn't pull in viem. Everything else (AES-GCM, HKDF/PBKDF2, ed25519
  wrappers) is verbatim.

## Import deviations

- `@widespread/crypto` → `../crypto/index.js` (relative vendored path).
- `@widespread/config` was declared as a dep upstream but never imported —
  omitted.
- npm deps: `oslo` (MIT), `@noble/ciphers`, `@noble/hashes`, `@noble/ed25519`.

## Update procedure

Re-copy `packages/{auth,crypto}/src` from the Rooted workspace, re-apply the
two deviations above, run `npm run typecheck`.
