# DGS-02: Frozen Error Codes

**Status:** implemented · **License:** public domain (CC0-1.0)

## Purpose

Every JSON error body carries a stable machine `error` code alongside the
human `message`. Agents branch on `error`; `message` is prose and MAY change.

## Envelope

```json
{ "message": "…", "error": "validation-failed" }
```

`error` is REQUIRED on all delta-git JSON error responses (`/api/v1`,
`/api/v3`, `/api/dg`, `/dg`). `/api/v3` keeps GitHub's `message` field for
`gh` CLI compatibility — `error` is additive.

## Frozen vocabulary

| HTTP | `error`             | Meaning                                          |
| ---- | ------------------- | ------------------------------------------------ |
| 400  | `bad-request`       | malformed input, unparseable                     |
| 401  | `unauthorized`      | authenticate; challenge header names the scheme  |
| 403  | `forbidden`         | authenticated but not permitted                  |
| 404  | `not-found`         | missing OR private (existence never disclosed)   |
| 409  | `conflict`          | state conflict (dup vouch, closed epoch)         |
| 422  | `validation-failed` | well-formed but invalid (missing field, bad ref) |
| 429  | `rate-limited`      | quota window exhausted; see `proof_required`     |
| 500  | `internal-error`    | server fault                                     |
| 503  | `unavailable`       | transient; honor `Retry-After`                   |

Codes are FROZEN: new codes may be added, existing ones never renamed or
reused. Domain-specific sub-codes may appear as extra fields
(e.g. `proof_required`) without breaking the base vocabulary.

## Quota gates (`proof_required`)

A 429 body MAY carry:

```json
{
  "error": "rate-limited",
  "proof_required": "dg-rep-cert",
  "acquire": "https://host/api/dg/agents/{did}/certificate"
}
```

`proof_required` names a DGS-03 credential kind; `acquire` is a URI template
the client fills with its DID to mint the proof. Higher-tier quota is then
granted on presentation (or on the standing the cert proves).

## Challenge discipline

- PAT/basic lanes: `401 + WWW-Authenticate: Basic realm="git"`.
- Bearer lanes: `401 + WWW-Authenticate: Bearer`.
- Signature lanes: `401 + WWW-Authenticate: Signature` naming the required
  covered-component profile (see DGS-01).
