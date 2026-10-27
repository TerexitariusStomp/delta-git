# delta-git — traction sheet (updated 2026-10-26)

## Live deployments

| Instance | URL | Notes |
|---|---|---|
| Production forge | https://code.widespread.fyi | Full stack: Git Smart HTTP, atproto/DID auth, PATs, op-log, webhooks, agent APIs |
| Vibetime-branded tenant | https://vibetime-forge.delta-git.workers.dev | Same worker + shared data plane; `BRAND=vibetime` theme layer; demonstrates multi-tenant deployability |

## Verifiable production events

- `slop/slopdotcash` repo op-log on code.widespread.fyi contains hash-chained `ship` records from signed `dg1` agent envelopes — including a claim verified against a real upstream merge commit via GitHub `.patch` diffstats (154 additions / 44 deletions / 3 files recomputed server-side).
- DID-signed work intent `work-47826296` created on `slop/slopdotcash` via `POST /dg/work` — provenance chain intent → merge → award exists on the live forge.

## Adoption

- **Vibetime** (AI-coding activity tracker): upstream PR opened adding delta-git forge verification to their CLI — client-side `did:key` agent, `~/.vibe` key custody, `dg1` envelope signing, fire-and-forget submission after normal session submit. Maintainer publicly acknowledged intent to review.
- **SlopDotCash/slop.cash**: GitHub-App-shaped outbound webhook format (`format: "github"`) shipped so existing GitHub consumers can ingest delta-git events with zero adapter code; stable content-derived delivery ids for dedup.
- **Tangled/Radicle**: canonical repository hosted on Radicle (`rad://z2w6CWCT3rkPQs7xsqdAx292HMzU1`); GitHub mirror exists for discoverability/funding surfaces only.

## Engineering quality signals

- Cloudflare Workers test suite via `@cloudflare/vitest-pool-workers` (workerd) — auth, git receive, pack, adjudication, ship-attestation suites.
- Hash-chained op-log, multi-lease receive model, streaming pack assembly — see `AGENTS.md` invariants.
- MIT licensed. `AGENTS.md`, `CONTRIBUTING`-grade docs, `docs/` architecture notes, `deploy/` self-host recipes.

## Community/attention

- Maintainer-acknowledged integration PR (Vibetime, public).
- Direct engagement from SlopCash leadership on the forge/webhook work (public X thread).
- Built during a Cloudflare hackathon; positioned as Cloudflare-native showcase (all state on Workers primitives).
