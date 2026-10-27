# OTF Internet Freedom Fund — concept note draft

Apply at <https://apply.opentech.fund/internet-freedom-fund-concept-note/> (requires email login on the Hypha portal). Drafted to the official Concept Note Guide (Appendix I).

## Project Title

delta-git: a censorship-resistant, client-custody code forge on minimal edge infrastructure

## Describe your project in 1-3 sentences

Our project is to harden and ship an open-source code forge that keeps user identity, credentials, and repository data out of the host's custody — in order to address the vulnerability of software collaboration infrastructure to account seizure, credential compromise, and jurisdiction pressure. The main beneficiaries are developers, journalists, researchers, and civil-society technologists whose code repositories and contributor identities must survive hostile attention.

## What problem will your project address?

Code forges are the load-bearing infrastructure of open source — and they concentrate three powers in one operator: custody of code and credentials, control of user identity, and the running-cost chokepoint that makes small or independent forges easy to kill. When a forge operator is compromised, pressured, or shut down, contributors lose code history, authentication secrets, and the identity binding between a person and their work at once. Repository deplatforming, account suspensions, and credential-harvesting breaches at centralized forges are documented, recurring events — and they hit hardest for developers working on sensitive topics, whose contributor graphs and signing keys are exactly what an adversary wants.

The change needed is structural: a forge whose trust model holds as little as possible. delta-git inverts the custody relationship — authentication runs on atproto DIDs (portable protocol identity, not provider accounts), agent signing keys and credentials live client-side (the service stores no user secrets), repository objects can remain remote-backed at upstreams, and provenance is a public hash-chained op-log that anyone can verify offline. Because the whole system runs on serverless edge primitives, it has no always-on infrastructure to seize or price out. If this problem goes unaddressed, independent and sensitive software work remains hostage to the operational and jurisdictional posture of a few large forges.

## If this project is funded, what form will it take?

**Technical Development** — improvements and core infrastructure for a working open-source prototype (MIT) that is already live in production.

## Give a brief overview of the activities in this project

Objective 1: Client-side encrypted private repositories — contributors' content is unreadable to the forge operator by construction.
- Activity 1.1: finalize key-wrapping and client encryption layers (spec + client + worker paths)
- Activity 1.2: integration tests and security review of the encryption boundary
Deliverable: opt-in encrypted private repos on the public instance. Estimated: ~3 months.

Objective 2: Never-reject push semantics and merge intents — divergent pushes are never lost or bounced; conflicts resolve via adjudicated merge intents.
- Activity 2.1: implement merge-intent records + adjudication flow in the repo Durable Object
- Activity 2.2: quorum/reputation hardening and audit endpoints
Deliverable: forks-and-divergence workflow live in production. Estimated: ~3 months.

Objective 3: Federation mirror-out — canonical repos replicate to Tangled/Radicle/GitHub so no single host is a point of failure.
- Activity 3.1: outbound mirror workers + signed mirror receipts
- Activity 3.2: self-host packaging so any community can run an equivalent instance
Deliverable: documented federation between at least three forge targets. Estimated: ~3 months.

Objective 4: Hardening, documentation, and reproducible deploy — the path from `wrangler deploy` to a running forge for non-expert operators.
Deliverable: self-host guide + security audit surface clean. Estimated: ~3 months (parallel).

## Are there similar projects that exist already? How is your project different or complementary?

- **Radicle** and **Tangled** are peer-to-peer/forges-on-atproto efforts. delta-git is complementary: it mirrors out to both rather than competing, and provides a web-first, zero-install path (browser + cloud edge) where they require local daemon setups.
- **GitHub/GitLab/Gitea/Gitness** are centralized or self-hosted-server forges; delta-git reuses the Gitness UI but replaces the trust model (DID identity, client custody, remote-backed objects) and runs on serverless edge with no always-on host.
- **git-ssb/Secure Scuttlebutt** ancestry: similar custody goals but abandoned server-side state entirely; delta-git keeps a fast edge-coordinated path so ordinary Git clients work unmodified.

## How long do you estimate activities will take?

12 months.

## How much funding do you estimate you will need? (US Dollars)

$150,000 — within OTF's ideal range for 6–12 month efforts; covers one dedicated maintainer plus security review, infrastructure costs during the funded period, and a small contributor-bounty pool. See `budget-milestones.md` for the tiered breakdown.

## Who would benefit from this project?

Developers and technologists working in or on repressive environments: journalists' and researchers' code infrastructure, civic-tech and human-rights tooling maintainers, and open-source projects whose contributor graphs are sensitive. Concretely: users who need a forge that (a) cannot be compelled to disclose credentials it does not hold, (b) keeps working when a single provider or region cuts access because objects can stay remote-backed and mirrors replicate out, and (c) lets contributors authenticate with portable DIDs rather than accounts that a provider can suspend. The project is itself run by an independent maintainer building public-good infrastructure, and the public instance is free for such communities.
