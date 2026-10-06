# DGS-03: Reputation Certificates (`dg-rep-cert-1`)

**Status:** implemented · **License:** public domain (CC0-1.0)

## Purpose

Portable, offline-verifiable proofs of standing. Where other nodes gate
abuse with per-request puzzles (iCaptcha), a delta-git agent carries a
signed claim of the reputation it has already earned. Any verifier checks
the cert with nothing but the document itself.

## Minting

```
GET /api/dg/agents/{did}/certificate
→ 200 dg-rep-cert-1 | 404 unknown-target | 503 node-key-not-configured
```

## Shape

```json
{
  "kind": "dg-rep-cert-1",
  "iss": "did:key:z<node pubkey>",
  "sub": "did:key:z<subject>",
  "rep": 42,
  "account_created_at": 1730000000000,
  "issued_at": 1730000000000,
  "expires_at": 1730086400000,
  "node_key": { "kty": "OKP", "crv": "Ed25519", "x": "…" },
  "sig": "<base64url ed25519>"
}
```

## Verification (offline)

1. `kind` MUST be `dg-rep-cert-1`; `expires_at` MUST be in the future.
2. Decode `node_key.x` (base64url → 32-byte ed25519 pubkey); derive
   `did:key` — MUST equal `iss`.
3. Verify `sig` (base64url ed25519) over
   `JSON.stringify(<cert without sig>)` — the object in the field order
   above.

No callback to the issuer is required. Nodes SHOULD additionally check
issuer trust (`iss` in a known-good node set) before granting privileges —
a valid cert proves the claim, not the issuer's honesty.

## Node key publication

Issuing nodes publish the signing key in `/.well-known/delta-node`:

```json
"signing": { "node_did": "did:key:z…", "key": { "kty":"OKP","crv":"Ed25519","x":"…" },
             "rep_cert": "…/api/dg/agents/{did}/certificate", "rep_cert_kind": "dg-rep-cert-1" }
```

## Use at quota gates

DGS-02 `proof_required` responses point here: present standing (or mint
the cert) to lift rate tiers instead of retrying blind.
