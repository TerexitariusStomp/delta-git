# delta-git — commercial surface (for for-profit-entity programs)

Programs like Arch Grants, Start-Up Chile, Hub71, and Cyberport fund a **company**, not an OSS project. This document defines the boundary so applications stay honest and consistent.

## The split

| Open-source project (MIT) | Company (commercial surface) |
|---|---|
| The forge: worker, DOs, protocol, UI | Branded multi-tenant instances (the `vibetime-forge` pattern: `BRAND` + theme CSS + shared or isolated data plane) |
| `dg1` envelope, ship verifier, op-log | Hosted verification/attestation APIs for teams that don't want to run anything |
| Self-host deploy recipes (`deploy/`) | Managed deployment + migration assistance for communities leaving GitHub |
| All of it, forever | Enterprise support tier: SSO, audit exports, SLA |

## Why this is coherent (not a rug-pull)

- The project's stated ethos — *no hosted secrets, client-side custody, minimal infrastructure* — is a **property of the architecture**, not a pricing tier. The company sells convenience (run it for you, brand it, verify for you), never custody.
- Remote-backed repositories keep GitHub/upstream canonical, so adopting the commercial surface never locks a customer in — the escape hatch is architectural, not contractual.
- Precedent already live: `vibetime-forge.delta-git.workers.dev` is a branded tenant on the same worker with a shared data plane — the multi-tenant commercial surface exists and works.

## For applications

- **Pitch the company as "the forge-as-a-service layer on a credibly neutral core."** Arch Grants/Hub71 reviewers ask "how does this make money" — this document is the answer.
- **Revenue model per ask:** per-tenant subscription (branded instance) + usage-based verification API + one-time migration/self-host setups.
- The one-pager and traction sheet stay OSS-framed; attach this as the "path to sustainability" annexure.
