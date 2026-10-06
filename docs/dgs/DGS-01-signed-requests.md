# DGS-01: Signed Git Requests (RFC 9421 profile)

**Status:** implemented · **License:** public domain (CC0-1.0)
**Implements:** RFC 9421 (HTTP Message Signatures), RFC 9530 (Digest Fields)
**Interop:** GLIP-01-compatible — `gl` clients can push without changes.

## Purpose

`did:key`-identified agents authenticate git pushes by signing the HTTP
request itself — no passwords, PATs, or bearer tokens on the wire. Any node
verifies the signature against the `did:key` keyid in `Signature-Input`.

## Wire format

Client sends on `POST /{owner}/{repo}/git-receive-pack`:

```
Signature-Input: sig1=("@method" "@authority" "@path" "content-digest");created=…;expires=…;keyid="did:key:z…";nonce="…";alg="ed25519"
Signature: sig1=:<base64 ed25519 signature>:
Content-Digest: sha-256=:<base64 sha-256 of raw body>:
```

Signature base (RFC 9421 §2.5): one `"name": value` line per covered
component in listed order, then `"@signature-params": <verbatim params>`.

## Required covered components (node policy — REQUIRED)

| Component        | Why required                                              |
| ---------------- | --------------------------------------------------------- |
| `@method`        | binds the verb                                            |
| `@authority`     | binds the host — closes the cross-host replay hole        |
| `@path`          | binds the route (`@target-uri` accepted as alternative)   |
| `content-digest` | binds the body — a replayed signature can't swap the pack |

Requests missing any required component are rejected with
`401 + WWW-Authenticate: Signature` naming the profile.

## Freshness

- `created` REQUIRED, within ±300 s of node time.
- `expires` OPTIONAL; past expiry → reject.
- `nonce` RECOMMENDED; length 8–128 when present.
- `alg` MUST be `ed25519` when present.

## Key resolution

`keyid` MUST start with `did:key:z…` (ed25519 multicodec `0xed01`).
The DID MUST be a registered, non-banned agent on this node
(`POST /api/dg/agents/register` with the same public key).

## Authorization

A valid signature authenticates the agent DID. Signed pushes carry
merge-intent semantics: divergent updates queue as intents for automatic
merge or quorum adjudication — they are never rejected for non-FF.

## Limits

Signed request bodies are buffered at the gate (cap: 64 MiB) because
`content-digest` covers the whole body. PAT-authenticated pushes are
unaffected and stream normally.
