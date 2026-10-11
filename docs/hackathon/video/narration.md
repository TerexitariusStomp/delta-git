# delta-git demo narration (~5:00)

Scene timings follow deck.html data-dur. Each line is one scene; speak over the
section shown.

## S1 — 0:00–0:20 · cold open
"Two agents push to main at the same time. On GitHub, one of them gets
rejected — and agents don't retry, they crash or silently overwrite each
other. delta-git never rejects a push. Divergence lands on refs/delta and
becomes a merge intent that a quorum adjudicates."

## S2 — 0:20–1:08 · the race
"Here's the real thing, live on production. Two agents push to the same
branch from the same base, concurrently. The first lands on the ref. The
second — instead of a rejection — the remote says: diverged. Its objects
land on refs/delta, and a merge intent is minted. That second write became
reviewable work, not an error."

## S3 — 1:08–1:28 · intent in the UI
"And there it is in the forge — the merge intent, open, with its delta ref
and zero conflicts, waiting for adjudication. Nothing was lost, nothing was
silently rewritten."

## S4 — 1:28–2:04 · artifacts-native
"Repos can live on Cloudflare Artifacts. Git clone hits our worker and 302s
to the real Artifacts remote. Every push fires an event into a queue, and
the Durable Object syncs the new head back — that's what makes the arena
possible."

## S5 — 2:04–2:54 · arena
"The arena: three did:key agents get isolated Artifacts forks with scoped
tokens, push real git work, the event pipeline records every head, and when
the build window closes the match judges blind and resolves on composite
score. Match 7466ad53 — winner entry 3c952db0, 835 to 833 to 828."

## S6 — 2:54–3:16 · match page
"The resolved match in the UI — all three entries, their recorded push
counts and heads, and the winner's score."

## S7 — 3:16–3:44 · provenance bundle
"Every match exports a signed provenance bundle — the entries, the heads,
the votes, and a hash of the full op-log, so any third party can verify the
result wasn't rewritten."

## S8 — 3:44–4:02 · op-log
"The operation log backs it up: arena create, entries, judging, resolve,
the Artifacts syncs, and the workspace reaper cleaning up — hash-chained,
append-only."

## S9 — 4:02–4:44 · swarm pool
"Off the hot path, swarm workers adjudicate in sandboxes. A durable node
registers with a did:key identity, picks up a build-verify job, runs it
under bwrap network isolation, and signs the result. The coordinator's
verify endpoint confirms the proof."

## S10 — 4:44–5:06 · close
"All of it on Cloudflare — Workers, Durable Objects, D1, R2, KV, Queues,
Artifacts, Workers AI judging with Clef, WebMCP and Poppy so personal
agents can drive it. delta-git: the forge where pushes never lose."
