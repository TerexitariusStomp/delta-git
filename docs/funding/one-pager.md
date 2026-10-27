# delta-git — one page

**An atproto-native, client-first code forge on Cloudflare's edge — built so the forge holds as little as possible and users hold as much as possible.**

## The problem

Every mainstream code forge concentrates three kinds of power in one place:

- **Custody.** The host stores your code, your tokens, and your secrets. A compromise, a policy change, or a jurisdiction order reaches everything at once.
- **Identity.** Accounts live and die at the provider's discretion. Portability is an export file, not a property.
- **Cost structure.** Always-on servers, databases, and bandwidth price community infrastructure out of most of the world — and make small forges easy to kill.

## The approach

delta-git is a Git Smart HTTP v2 forge implemented on Cloudflare Workers, Durable Objects (SQLite), D1, KV, and R2 — deliberately engineered around the inverse trust model:

- **Client-first custody.** DPoP/PAT credentials, agent signing keys, and (in progress) private-repo encryption keys live on the client. The forge stores no agent private keys, no OAuth bearer secrets, no plaintext credentials.
- **Protocol identity, not accounts.** atproto DIDs (`did:plc`, `did:key`) are the user identity; `dg1` signed envelopes authenticate agent requests; Ed25519 attestations are portable and verifiable offline.
- **Minimal hosted infrastructure.** Everything runs on Cloudflare's free-tier primitives plus the vendored Gitness SPA; repositories can be *remote-backed* — objects stay at upstream forges while delta-git provides identity, collaboration, and provenance layers. There is nothing big to seize and almost nothing to pay for.
- **Provenance over trust.** Repo events land in a hash-chained op-log; work intents link to merges; ship claims are re-verified by the forge (commit objects or upstream `.patch` deltas) before earning reputation or attestations.

## Proof it works

- **Live:** `code.widespread.fyi` (production) and `vibetime-forge.delta-git.workers.dev` (branded tenant — same worker, shared data plane, separate wordmark).
- **Verified ship attestations:** `POST /api/:owner/:repo/dg/ship` verifies claimed commit oids and recomputes file/line deltas — real verification, not self-report. Live in production with hash-chained op-log records.
- **Adoption:** a forge-verified ship integration is upstreamed as a PR to Vibetime (AI-coding activity tracker); GitHub-App-shaped webhook payloads let existing consumers ingest delta-git events unmodified.
- **Federated by design:** the canonical repo lives on Tangled/Radicle; GitHub is a mirror. The forge mirrors *out* to the network rather than trapping code in.

## Why this is a public good

Forge infrastructure is the load-bearing wall of open source, and it is increasingly a single point of failure: custody, censorship, cost. A forge that runs on free-tier edge primitives, holds no user secrets, and treats user identity as portable protocol state is infrastructure that is structurally hard to capture and cheap to keep alive — the properties that make other commons (the web, SMTP, git itself) durable.

## Roadmap funded by grants

Never-reject push resolution and merge intents → client-side encrypted private repositories → adjudication/quorum/reputation hardening → federation mirror-out (Tangled, Radicle) → multi-tenant self-host deployability → agent-native APIs (MCP/WebMCP).

See `budget-milestones.md` for the two funding tiers and `traction.md` for live metrics.
