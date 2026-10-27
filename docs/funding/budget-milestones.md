# delta-git — budget & milestones

Two reusable funding tiers. Scale currency/amounts per ask: Sovereign Tech Fund requires >€50k; OTF's sweet spot is $50–200k; smaller programs (FLOSS/fund, bespoke ecosystem grants) use the 6-month tier or a subset.

## Tier A — 6 months, ~$60,000

One full-time-equivalent maintainer plus audit/infra costs.

| Milestone | Months | Deliverable | Share |
|---|---|---|---|
| M1: Never-reject push | 1–2 | Merge-intent flow: divergent pushes are accepted, adjudicated, and resolved through the op-log rather than rejected. Integration tests + docs | $14k |
| M2: Client-side encrypted private repos | 2–4 | Repo-level encryption keys held client-side; forge stores ciphertext; key custody model documented | $18k |
| M3: Attestation & reputation hardening | 4–5 | Ship-claim adjudication, quorum rules, reputation weighting, audit trail — on top of the live `/dg/ship` verifier | $12k |
| M4: Federation mirror-out | 5–6 | Push-to-Tangled/Radicle mirror jobs from the queue worker; verified end-to-end | $10k |
| Security audit (external) | 6 | Scoped to auth envelope, ship verifier, encryption boundary | $6k |

## Tier B — 12 months, ~$150,000

Tier A plus the sustainability/multi-tenant surface.

| Milestone | Months | Deliverable | Share |
|---|---|---|---|
| M1–M4 (as above) | 1–6 | as above | $54k |
| M5: Multi-tenant self-host | 6–8 | One-command deploy recipe (the `deploy/` pattern generalized): any community gets a branded forge on their own Cloudflare account sharing or isolating data planes | $16k |
| M6: wp-cloud lane | 8–10 | WordPress on the same client-first substrate: static snapshot lane free, WASM/Playground execution in-browser, paid container lane for mutable workloads | $20k |
| M7: Agent-native surface | 9–11 | MCP/WebMCP adapters + `dg1` envelope spec finalized; third-party agents can auth, submit claims, and consume op-log proofs | $14k |
| M8: Governance & ecosystem | 10–12 | Public spec (DGS series) finalized, contributor onboarding, second-tenant production launch | $16k |
| Ops/audit/contingency | — | Infra costs beyond free tier, external audit, ~15% contingency | $30k |

## Cost assumptions

- Maintainer time is the dominant cost; Cloudflare free tier covers hosting for the reference deployment.
- Budget is milestone-based; both tiers structure cleanly as performance-based contracts (OTF style) or grant milestones (STF/NLnet style).
- No marketing spend in either tier — adoption grows through integration work (the Vibetime model), which these milestones fund directly.
