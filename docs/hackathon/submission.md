# Submission draft — Next-Gen Git Platform on Cloudflare

## Elevator pitch

**delta-git** is the coordination layer the hackathon brief asks for: a git
forge where concurrent pushes are _never rejected_. On top of Cloudflare
Artifacts it adds agent workspaces (fork-per-task), a competitive coding
arena with blind community judging, quorum-based merge adjudication,
unified human/AI reputation, and a signed operation log — 100% on
Cloudflare primitives.

## The project

- **Repositories on Artifacts** — repos can be created with
  `backend: "artifacts"`; our endpoints 302 to the Artifacts remote with
  PAT/agent auth preserved; `/dg/token` mints scoped Artifacts tokens.
- **Divergence as data** — pushes that would conflict elsewhere land on
  `refs/delta/*`, mint merge intents, and resolve through quorum voting
  with reputation-weighted adjudication.
- **Arena** — time-boxed matches: each entrant gets an Artifacts workspace
  fork (`ws-*`), pushes normally, is scored by automatic signals + blind
  votes, and the winner merges to canonical. `/arena` is a live global feed.
- **Reputation** — one rep currency across agent DIDs and human identities;
  vouches (signed praise/flag), Coordinape-style epochs with peer
  allocation, and a unified leaderboard.
- **Provenance** — every adjudication and match lands in a hash-chained
  op-log; match bundles and repo exports are DSSE/HMAC-signed JSON.
- **Candidate diffs are the judging exhibit** — each arena entry and merge
  intent exposes a unified diff (`/dg/matches/:id/entries/:entryId/diff`);
  voters compare _what changed_, blinded to _who_ changed it.
- **Personal Agent Protocol (Poppy) native** — `/.well-known/poppy.json`
  declares the forge to personal agents (Sierra/Meta draft; Cloudflare is a
  design partner): issuer metadata carries `poppy_domains`, `poppy:read`/
  `poppy:write` are live scope aliases, tokens are already DPoP-bound.
- **WebMCP tools** — the SPA exposes `dg_*` read-only tools via
  `navigator.modelContext`, so agent-capable browsers (Kitesurf, Browser
  Run) drive the forge without click simulation.

## Cloudflare primitives used

Workers (SSR + API + git protocol) · Durable Objects (per-repo authoritative
state, alarms for match lifecycles) · Artifacts (canonical git repos +
workspace forks + push events) · Queues (artifacts events, arena-resolve,
repo maintenance) · D1 (global indices: arena feed, reputation) · R2 (pack
mirrors) · KV (rate limits) · Workers AI — **llama-3.1-8b for merge
synthesis plus `@cf/cloudflare/clef-flash` as a structured decision seat**
(verdict votes on merge resolutions + spec-fit scoring of arena diffs) ·
Analytics Engine (metrics).

## Why it's original

Other entries serialize agent writes behind PRs and merge queues — the
GitHub model with agents bolted on. delta-git makes divergence itself the
data: concurrent pushes land as merge intents, get auto-merged or
adjudicated by a quorum that includes a structured Clef decision seat, and
leave a hash-chained provenance trail. And where every other arena
compares code, delta-git compares _git history_ — blind votes, composite
scoring, provenance bundles, and reputation reuse the same primitives that
adjudicate ordinary agent merges.

## Verified end-to-end on production

The demo video shows the real deployment, not a mock: a concurrent push
race mints a live merge intent (`refs/delta/*`), a 3-agent arena match runs
isolated Artifacts forks → blind judging → winner (`match-7466ad53`), the
signed provenance bundle exports, and a swarm `durable-node` completes a
bwrap-isolated BUILD_VERIFY job with a `did:key`-signed proof
(`verified: true`).

## Links

- Live: https://git-on-cloudflare.delta-git.workers.dev/
- Repo: https://github.com/TerexitariusStomp/delta-git
- License: MIT
- Run instructions: README.md ("Try it in 60 seconds") · demo walkthrough:
  docs/hackathon/demo-script.md
