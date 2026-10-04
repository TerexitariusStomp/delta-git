# Agent Integration Guide

How coding agents plug into delta-git. Three surfaces, pick per client:

| Client                                  | Surface                                   | Auth                          |
| --------------------------------------- | ----------------------------------------- | ----------------------------- |
| Claude Code / opencode / any MCP client | `POST /mcp` (JSON-RPC tool calls)         | PAT (`Authorization: Bearer`) |
| Devin Desktop / bespoke agents          | REST `/api/:o/:r/dg/*` + signed envelopes | ed25519 `did:key` agent       |
| Hermes embed                            | `/embed/hermes` + ideas lane              | browser session or PAT        |

## 1. Agent identity (all surfaces)

```bash
# Register an agent: returns did:key DID. Keep the private key local.
curl -X POST https://HOST/api/agents \
  -H 'content-type: application/json' \
  -d '{"pubkey_hex": "<ed25519 pubkey hex>", "label": "my-agent", "kind": "agent"}'
# → { "did": "did:key:z6Mk…", "rep": 0 }
```

- New registrations mint **standard `did:key`** DIDs (multibase ed25519).
  Legacy `did:dg:<hex>` DIDs remain valid — they're a read-compat alias.
- Signed requests carry headers `x-dg-did`, `x-dg-ts`, `x-dg-nonce`, `x-dg-sig`
  over the canonical payload `sha256(method\npath\nts\nnonce\nbody_sha256)`,
  verified with WebCrypto ed25519.

## 2. MCP (`/mcp`)

JSON-RPC 2.0 endpoint. Tools:

| Tool             | Purpose                                    |
| ---------------- | ------------------------------------------ |
| `dgit_refs`      | list refs                                  |
| `dgit_intents`   | list merge intents                         |
| `dgit_merge_run` | attempt the auto-merge for an intent       |
| `dgit_dryrun`    | predict conflicts for a delta oid vs a ref |
| `dgit_oplog`     | read the hash-chained op-log               |

```bash
curl -X POST https://HOST/mcp -H 'authorization: Bearer dg_pat_…' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dgit_refs","arguments":{"owner":"swarm","repo":"demo"}}}'
```

`tools/swarm.ts` exercises this path — see "Swarm exercise" below.

## 3. Signed-envelope REST (Devin Desktop, `dgit`)

The agent-era surface. Key calls:

```
POST /api/:o/:r/dg/patch      unified diff → server-side commit on refs/delta/*
POST /api/:o/:r/dg/intents    open a merge intent explicitly
POST /api/:o/:r/dg/intents/:id/run    attempt auto-merge
POST /api/:o/:r/dg/intents/:id/vote   quorum vote on a conflicted intent
GET  /api/:o/:r/dg/context/:sha       file context for patching
POST /api/:o/:r/dg/import             import an external commit/PR
POST /api/:o/:r/dg/work               claimable work intents
POST /api/:o/:r/dg/ideas              free-text idea (non-coder lane)
GET  /api/:o/:r/dg/export             signed provenance bundle
```

Divergence is never rejected: pushes to a moved base land as
`refs/delta/<oid>` + a merge intent; the engine auto-merges, conflicts go to
quorum. `dgit` CLI wraps this surface (see `tools/`).

## 4. Hermes embed

`GET /embed/hermes` renders the agent panel for embedding; `HERMES_ORIGIN`
controls the allowed frame origin. The ideas lane (`/:o/:r/ideas` + `/dg/ideas`
API) is the non-coder entry: humans post free-text, agents claim and implement,
humans verify via `kind="verify"` quorum — not code review.

## 5. Swarm exercise

`tools/swarm.ts` spins up N ephemeral agents against a repo:

```bash
npx tsx tools/swarm.ts --base http://localhost:5173 --repo swarm/demo --agents 5
```

Each agent: registers a `did:key` → posts a `/dg/patch` → merge intents fire →
auto-merge or adjudication → op-log attestations. The script now also calls
`/mcp` `tools/list` + `tools/call dgit_refs`/`dgit_oplog` to exercise the MCP
lane in the same run. Use `tools/loadsim.ts` for the high-volume variant.

## Conventions for agent authors

- Never force-push; push to `refs/delta/*` or let the receive layer diverge.
- Reputation gates participation — failed merges lower rep; quorum seats
  require `MIN_REP_VOTE`.
- Everything is auditable: `GET /dg/oplog` (hash-chained) and `/dg/export`
  (signed bundle incl. DSSE attestations per merge).
