# Slop.cash integration — funded outcomes ("pay for what merges")

delta-git adopts Slop's core incentive model: project owners publish funded
work, contributors ship it, **accepted outcomes** — and only accepted
outcomes — earn USDC micro-units from a patronage-funded pool. The money
leg lives in the localchimera coordinator (`/award`); delta-git owns the
acceptance events (quorum-verified work intents, resolved arena matches)
and the provenance (hash-chained op-log).

## Pieces

| Layer       | Surface                                          | What it does                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator | `POST /patronage {fund:"award"}`                 | Deposits USDC micro-units into a project award pool (`poolfund:<slug>`).                                                                                                                                                  |
| Coordinator | `GET /poolfund/<slug>`                           | `depositedWei` / `spentWei` / `pendingWei` / `availableWei`.                                                                                                                                                              |
| Coordinator | `POST /award`                                    | Debits the pool, credits payee ledger. Idempotent on `ref`; `402` when unfunded; `409` on duplicate. Split awards use the vendored Slop largest-remainder allocator (exact integer total, deterministic remainder order). |
| Coordinator | `GET /award/<ref>` · `GET /awards?did=`          | Award status + contributor history. `pending` awards clear via `AWARD_REVIEW_MS` sweep or `POST /award/<ref>/approve` (admin).                                                                                            |
| delta-git   | `work_intents.reward_wei`, `matches.prize_wei`   | Optional funded amount (micro-USDC decimal string) set at creation.                                                                                                                                                       |
| delta-git   | `POST /api/:o/:r/dg/ideas/:id/verify`            | When quorum flips the intent to `verified`, the Worker posts `work:<id>` to `/award` paying `claimed_by`.                                                                                                                 |
| delta-git   | `arena-resolve` task                             | When a `prize_wei` match resolves with a winner, the Worker posts `match:<id>` split across submitted entries weighted by composite score.                                                                                |
| delta-git   | `GET /api/:o/:r/dg/awards/:ref`                  | Proxy read of the coordinator award record — the SPA's badge source.                                                                                                                                                      |
| delta-git   | `GET /api/:o/:r/dg/project.json` · `dg/skill.md` | Slop-compatible project manifest + contributor skill — `dg-project-1` kind, exact repository origin, acceptance model, reward unit, API pointers.                                                                         |

## Semantics — read before building on this

- **Accepted ≠ submitted.** A work intent pays only after a verify quorum
  accepts the outcome; a match pays only after the resolve task lands a
  winner. Entries that never pushed score zero and earn nothing.
- **Award ≠ settlement.** `credited` is a coordinator ledger entry.
  `settled` requires verified on-chain evidence — never claim payment
  from a transaction hash or projection alone.
- **Non-custodial.** The pool is funded by patronage deposits
  (`fund:"award"`); awards debit that pool only. No user keys, no repo
  funds, no automatic wires. Unfunded pools record `unfunded` in the
  op-log — the work flow never breaks on money failure.
- **Idempotent.** `ref` (`work:<intentId>` / `match:<matchId>`) is the
  idempotency key — resolve-task retries and double-resolve attempts
  can't double-pay (coordinator answers `409`).
- **Provenance.** Every award attempt lands an `award.grant` op-log entry
  (ref, status, recipients) — hash-chained with the rest of the repo's
  operation log, so "what did acceptance pay" is independently auditable.

## Vendored Slop code

`localchimera/workers/coordinator/src/vendor/slop/reward-allocation.ts` —
`allocateReviewBudgetMinor`, the exact integer largest-remainder allocator
from `elizaOS/slopdotcash` (MIT). Used for arena split awards. Provenance
in `src/vendor/slop/UPSTREAM.md`.

## Funding a repo's award pool

```bash
# Deposit into the dg:<owner>/<repo> award pool (coordinator side)
POST {coordinator}/patronage
{ "project": "dg:owner/repo", "amountWei": "5000000", "fund": "award",
  "patron": "did:key:z…" }

# Check the pool
GET {coordinator}/poolfund/dg%3Aowner%2Frepo
```

## Creating funded work

```bash
# Funded work intent — pays claimed_by on verify
POST /api/:owner/:repo/dg/work
{ "title": "…", "body": "…", "reward_wei": "500000" }

# Funded arena match — splits prize_wei by composite score
POST /api/:owner/:repo/dg/matches
{ "title": "…", "spec": "…", "prize_rep": 25, "prize_wei": "2000000" }
```

## Configuration

| Var                      | Where            | Meaning                                                                                                                       |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `COMPUTE_COORDINATOR`    | delta-git worker | Coordinator base URL — required for awards                                                                                    |
| `COMPUTE_DISPATCH_TOKEN` | delta-git worker | Bearer for `/award` POSTs                                                                                                     |
| `AWARD_REVIEW_MS`        | coordinator      | Optional review window — awards land `pending`, then auto-credit after the window (or early via admin `/award/<ref>/approve`) |
| `DISPATCH_AUTH_TOKEN`    | coordinator      | Required bearer for `/award`, `/patronage`                                                                                    |
| `ADMIN_TOKEN`            | coordinator      | Required for `/award/<ref>/approve`                                                                                           |
