# delta-git agent layer

Architecture notes for the agent-coordination layer on top of the upstream Git
Smart HTTP v2 server. Read `docs/architecture.md` first for the base design
(Worker ↔ DO ↔ R2 split); this doc only covers what the agent layer adds.

## The core invariant

**A push is never rejected.** When a receive arrives with a stale `old-oid`
(the ref moved since the pusher last fetched), the upstream lease model would
fail the command set. Instead, `finalizeReceiveState` rewrites the commands
inside the same DO transaction to land the commits under
`refs/delta/<intent-id>`, mints a merge-intent row, and commits — the pusher
sees `ok` with a `delta` status message in their push output.

Why inside the transaction: ref authority lives in the DO. Rewriting in the
worker and re-pushing would race; rewriting in the finalize transaction keeps
the divergence atomic with the pack commit.

## State model

Per-repo coordination state lives in the repo DO's SQLite (strongly consistent
with refs):

- `merge_intents` — one row per divergence. Statuses:
  `open → merging → (adjudicating → conflict|merged) | merged | expired | rejected`
- `merge_votes` — `(intent_id, seat)` primary key; seats are assigned
  server-side so a voter can't pick their slot, and `(voter_did)` is unique
  per intent so one agent can't double-vote.
- `op_log` — append-only, `hash = sha256(prev_hash || canonical(payload))`.
  External observers replay the full chain via `/api/:o/:r/dg/oplog`.
- `work_intents`, `commit_status`, `webhook_subs`, `repo_secrets` — same DO.

Global agent identity + reputation lives in the worker D1 (`agents` table) —
rep is cross-repo.

## Merge flow

1. Intent minted (`open`) by the divergent push, or by `POST /dg/patch` /
   GitHub-style pulls.
2. Any actor claims it via `POST .../intents/:id/run` — status `merging`.
3. Worker-side engine (`src/worker/merge/`) walks both trees against the merge
   base, diff3s files (`node-diff3`), and either:
   - **Clean** → writes new tree+commit objects into a thick pack (pack v2 +
     idx via `src/worker/merge/packWriter.ts`), uploads to R2, and CAS-advances
     the target ref against `expectedBaseOid`. Status `merged`. A deploy task
     is enqueued for head-ref merges.
   - **Conflicts** → intent moves to `adjudicating` with the conflict path
     list. A Workers-AI adjudication task is enqueued (one quorum seat).
4. Agents vote via `POST .../vote` with a signed request naming a
   `resolutionDigest`. Quorum = `floor(k/2)+1` matching digests. On majority
   the winning resolution is replayed through `applyResolution` → same
   pack/ref machinery → `merged`; minority voters are slashed, majority
   rewarded. Deadline expiry → `conflict` (needs human/verify pack) or
   `expired`.

CAS on `expectedBaseOid` everywhere means a ref that moved mid-merge simply
re-diverges: the merge commit is orphaned, a new intent can be minted. No
locking, no lost work.

## Agent authentication

Signed headers on every agent request:
`x-dg-did` (identity), `x-dg-ts`, `x-dg-nonce` (replay window), `x-dg-sig`
(ed25519 over the canonical request). `src/worker/agent/auth.ts`. Humans use
the existing PAT/Basic path.

## Attestations

Every committed merge (auto or adjudicated) writes a DSSE envelope
(`src/worker/agent/attest.ts`) recording method, intent id, and actor, stored
in the DO and served at `/dg/attest/:sha`. WebCrypto only — no Fulcio/Rekor
dependency inside the Worker.

## Trust model

Trust moved from write-gates to adjudication + economics + audit:

- Flood → per-actor open-intent quotas; `refs/delta/*` carry TTLs.
- Merge-bomb → adjudication is lazy; conflicts are computed on claim, not mint.
- Sybil → server-assigned seats, rep-gated adjudication (`ADJUDICATOR_MIN_REP`).
- Sabotage → permanent signed op-log + attestations make malice attributable
  and slashable.

## Surfaces

- `/api/:o/:r/dg/*` — agent API (see README table)
- `/api/v3/*` — GitHub REST shim
- `/pages/:o/:r/*` — static serving from the odb; deploy-on-commit via Queue
- `/:o/:r/agents`, `/agents` — SSR views over the same DO/D1 state
- `/embed/hermes` — COOP/COEP host for hermes-browser adjudicator seats
- `/mcp` — MCP JSON-RPC tools
- `cli/dgit.ts` — agent-facing CLI (clone/push/intents/secrets/watch)
