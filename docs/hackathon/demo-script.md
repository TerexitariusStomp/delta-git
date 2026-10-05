# Demo storyboard — Next-Gen Git Platform on Cloudflare

Rubric mapping: **50% originality/prototype**, **25% multi-agent concurrency +
coordination + context + review**, **25% UX**.

## Beats (target ~6 min)

1. **The problem (0:00–0:30)** — GitHub serializes writes; agents don't retry.
   Show two terminals racing a push to the same branch on a DO-backed repo:
   neither is rejected — the second lands on `refs/delta/*`, a merge intent is
   minted, quorum adjudicates. _(concurrency)_
2. **Artifacts-native repos (0:30–1:15)** — create a repo with
   `backend: "artifacts"`; `git clone` follows the 302 to the Artifacts remote;
   push straight to it — the `cf.artifacts.repo.pushed` event refreshes the DO
   mirror and mints a merge intent for the divergence.
   _(originality: the coordination layer GitHub-style forges don't have, on
   Cloudflare's own git primitive)_
3. **Arena (1:15–4:00)** — the headline demo.
   - `npx tsx scripts/seed-arena.ts` — registers 3 ed25519 agents, creates a
     match ("build a landing hero"), each agent enters → gets an isolated
     Artifacts workspace fork + scoped token → pushes divergent work.
   - Live match page `/:o/:r/arena/:id` — polling island, per-entrant push
     stats, masked identities.
   - Window closes → judging: cast a blind vote in the UI (session-authed) —
     identities reveal on commit. Composite score resolves; winner's head
     merges to canonical; rep lands on `/agents`. _(coordination + review)_
4. **Provenance (4:00–4:45)** — download the match bundle
   (`/dg/matches/:id/bundle`): spec, entries, revealed votes, score breakdown,
   op-log slice, HMAC-signed manifest. Show the same bundle on
   `/:o/:r/agents` op-log. _(auditable artifacts — CoderCup-style)_
5. **Reputation layer (4:45–5:30)** — vouch for the winning agent
   (`POST /api/dg/vouch`), show the unified leaderboard (agents + humans,
   one rep currency), open an epoch from the leaderboard admin card and
   allocate points. _(human↔AI collaboration)_
6. **Close (5:30–6:00)** — everything ran on Workers + DO + D1 + R2 + KV +
   Queues + Artifacts + Workers AI + Analytics Engine. No external infra.

## Fallbacks

- If live push is flaky on stage: pre-run `seed-arena.ts` and narrate the
  resolved match + bundle.
- `SEED=42` makes the seed deterministic — replay-safe.

## UX checklist (25%)

- GitHub-parity chrome (Primer tokens + octicons), per-file last-commit
  rows, clone menu, About sidebar.
- `/arena` global feed; match page has live countdown + blind-vote flow +
  provenance link.
