# Federation (mirror-out)

delta-git is authoritative for coordination; public content does not need to
ride our infra. Any public ref advance (push, auto-merge, adjudicated merge)
enqueues a `federate` task that pushes the new tip to configured mirror targets.

## Trust model

- **delta-git → mirror**: we are the writer. HTTPS targets receive a real
  smart-HTTP receive-pack push. The remote must accept the push (token auth via
  URL credential or a target that trusts our signer — see fallback).
- **Mirror → readers**: mirrors are read-only endpoints (Tangled knot, Radicle
  seed). They never write back; the op-log + DSSE attestations exported via
  `GET /dg/export` are the provenance of record if a mirror diverges.
- **Repo DIDs**: every repo gets `did:dg:repo:<sha256(namespace/slug)>` at
  creation (D1 `repositories.did`). Stable across renames; this is the
  federation-addressable identifier appviews index on.

## Mirror configuration

`POST /api/repos` accepts `mirrors: [{name, url}]`; stored on
`repositories.mirror_targets`. URL schemes:

| URL                          | Behavior                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `https://host/path.git`      | smart-HTTP v2 push (info/refs → receive-pack). For Tangled knots, point at the knot's git endpoint         |
| `rad:<rid>`                  | Radicle RID — pushed via the signed-relay fallback; rendered as an `app.radicle.xyz` link on the repo page |
| `tangled:<knot>` / `ssh://…` | signed relay message → contrib-agent/relay performs the push off-worker                                    |

To change targets later, update `mirror_targets` via D1 (admin tooling) — the
column is authoritative at enqueue time.

## Push protocol

`tasks/federate.ts` implements a minimal protocol-v0 push client over the
repo's pkt-line primitives:

1. `GET <url>/info/refs?service=git-receive-pack` → advertised refs.
2. Walk the new tip's history server-side (cap: 256 commits / 5000 objects)
   minus the remote's advertised tips → collect missing commits/trees/blobs.
3. Build a pack + `update` pkt-lines; `POST <url>/git-receive-pack`.
4. Retryable failures (5xx, throttling) rethrow → queue retry; permanent
   failures log + metric and dead-letter.

`ssh:`/`rad:`/`tangled:` targets produce a signed relay outcome instead — a
contrib-agent or the Rooted relay pulls the objects itself (fetch is cheap for
the relay; egress auth stays off the worker).

## Read surface — `sh.tangled.*` XRPC

`src/worker/routes/xrpc.ts` exposes read-only lexicon-shaped endpoints for
appviews/indexers. Repo lookup accepts `repoDid=did:dg:repo:<hash>` or the
`owner/repo` shorthand; only public repos are visible (private repos return
the same 404 as missing ones).

- `GET /xrpc/sh.tangled.repo.describeRepo?repoDid=…`
- `GET /xrpc/sh.tangled.repo.list?owner=…`
- `GET /xrpc/sh.tangled.repo.issue.list?repoDid=…` (`kind="issue"` work intents)
- `GET /xrpc/sh.tangled.repo.pull.list?repoDid=…` (merge intents)

Lexicon rev: pinned to the `sh.tangled.repo` v0 record shapes used by knot1
clients (documented in the `xrpc.ts` header comment). If Tangled revs the wire
format, update the serializers there — the shapes are deliberately plain
objects rather than generated lexicon types.

## Failure semantics

- Mirror push is **best-effort and asynchronous** — a failed mirror never blocks
  or rolls back a receive; the authoritative state is already committed.
- `federate` queue messages carry `{doId, ref, sha, targets?}`; empty `targets`
  = all configured mirrors for the repo.
- Non-public (private) repos never enqueue federation.
