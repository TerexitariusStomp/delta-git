# OSS License Inventory

Combined audit of delta-git and wp-cloud (the first-party app deployed at
`wpcloud.delta-git.workers.dev`). Verified against installed package
`license` fields and wp-cloud's `licenses.yaml`; Trivy's license scanner
runs in the deploy gate as the ongoing check.

## Terminology

- **Runtime** — code that ships in the deployed Worker bundle or runs in a
  tenant container.
- **Build/dev** — tooling only; never distributed.
- **Hosted use** — running software for users without distributing binaries.
  GPL obligations trigger on _distribution_, not hosted use.

## delta-git runtime dependencies (all permissive)

Every production npm dependency verified permissive — no copyleft anywhere in
the shipping bundle.

| Component                                               | License                     | Context                         |
| ------------------------------------------------------- | --------------------------- | ------------------------------- |
| hono, react, react-dom, itty-router, idb, immer, nanoid | MIT                         | Worker + UI runtime             |
| drizzle-orm                                             | Apache-2.0                  | DO SQLite DAL                   |
| diff                                                    | BSD-3-Clause                | Merge/conflict UI               |
| domhandler, highlight.js                                | BSD-2-Clause / BSD-3-Clause | Rendering, syntax highlighting  |
| lucide-react                                            | ISC                         | Icons                           |
| @primer/octicons-react                                  | MIT                         | GitHub's icon set (UI)          |
| @primer/primitives                                      | MIT                         | GitHub design tokens (CSS vars) |
| pako                                                    | MIT / Zlib                  | Git pack inflation              |
| isomorphic-git                                          | MIT                         | Git operations                  |
| zod                                                     | MIT                         | Request validation              |

## Build/dev tooling (not distributed)

| Component                                      | License           |
| ---------------------------------------------- | ----------------- |
| typescript                                     | Apache-2.0        |
| vite, rolldown, tailwindcss, prettier, vitest  | MIT               |
| wrangler                                       | MIT OR Apache-2.0 |
| @cloudflare/workers-types, vitest-pool-workers | MIT / BSD         |

## wp-cloud Worker runtime

| Component            | License                        | Context                                |
| -------------------- | ------------------------------ | -------------------------------------- |
| aws4fetch            | MIT                            | R2 S3 presigning                       |
| itty-router          | MIT                            | API routing                            |
| viem                 | MIT                            | SIWE wallet verification, USDC watcher |
| typescript, wrangler | Apache-2.0 / MIT OR Apache-2.0 | Build                                  |

## wp-cloud container lane (tenant WordPress images)

Pulled at image build time — nothing is vendored into the repo.

| Component                            | License             | Commercial posture                                                                                                 |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| WordPress + wordpress.org plugins    | GPL-2.0+            | Hosted use fine. **Distributing the container image = GPL distribution** — requires source-offer + license notices |
| WooCommerce                          | GPL-3.0             | Same obligations as above                                                                                          |
| MariaDB / MySQL 8                    | GPL-2.0             | Sidecar use fine                                                                                                   |
| FrankenPHP                           | MIT                 | Clean                                                                                                              |
| Apache HTTPD                         | Apache-2.0          | Clean                                                                                                              |
| PHP                                  | PHP-3.01            | Clean                                                                                                              |
| SQLite / sqlite-database-integration | Public domain / MIT | Clean                                                                                                              |
| runit                                | BSD-3-Clause        | Clean                                                                                                              |
| php-wasm                             | Apache-2.0          | Clean                                                                                                              |
| adnanh/webhook, ttyd                 | MIT                 | Clean                                                                                                              |
| Adminer                              | Apache-2.0          | Clean                                                                                                              |
| WP-CLI                               | MIT                 | Clean                                                                                                              |
| rclone, tigrisfs                     | MIT / Apache-2.0    | Clean                                                                                                              |
| htmx                                 | BSD-2-Clause        | Clean                                                                                                              |
| pagefind                             | MIT                 | Clean                                                                                                              |
| S3-Uploads (humanmade)               | GPL-2.0+            | GPL obligations on image distribution                                                                              |
| isomorphic-git                       | MIT                 | Clean                                                                                                              |

## Flagged — restricted or conditional

| Component                 | License                          | Rule                                                                                                 |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Redis**                 | RSALv2 / SSPLv1                  | Source-available, NOT OSS. Permitted as a customer sidecar; **never re-host as a competing service** |
| **Elasticsearch**         | Elastic-2.0 / SSPL / AGPL        | Enterprise tier only; never offered as hosted service                                                |
| **localchimera monorepo** | AGPL-3.0                         | **Never vendor.** Only the MIT-licensed npm SDK may be used                                          |
| **Llama / Gemma weights** | Community licenses (terms-bound) | Opt-in only, never a default sidecar; site owner accepts upstream terms                              |
| **Qwen / SmolLM2**        | Apache-2.0                       | Clean for bundled use                                                                                |
| **Phi-4-mini**            | MIT                              | Clean                                                                                                |

## Reviewed external projects (pattern references, not vendored code)

These projects informed features but ship **no code** — only original
implementations of their mechanics:

| Project                      | License                           | What we took                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confetti (docs.confetti.win) | Proprietary service               | Conviction/stake voting concept → `src/shared/arena.ts` (rep escrow, decay, pool settlement — original math)                                                                                                           |
| CL4R1T4S (elder-plinius)     | No license grant — reference only | Prompt _patterns_ (manifest output, plan-then-write, hard constraints, bounded repair) → `src/worker/agent/prompts/siteSmith.ts` written from scratch. Do **not** copy prompt text; it is leaked proprietary material. |
| Coordinape                   | MIT                               | Epoch allocation windows → `epochs`/`epoch_allocations`                                                                                                                                                                |
| givepraise                   | MIT                               | Peer praise/vouch mechanic → `vouches` table                                                                                                                                                                           |
| tea.xyz                      | Source-available                  | Proof-of-contribution framing only                                                                                                                                                                                     |
| WordPress Playground         | Apache-2.0                        | `blueprint.json` format emitted by site-smith (spec is public; we generate JSON, don't vendor the runtime)                                                                                                             |
| WordPress                    | GPL-2.0+                          | Generated block themes live in _tenant repos_, not this repo — GPL obligations attach to the generated site, not delta-git                                                                                             |

## Policy

1. All first-party runtime code and its direct deps must stay permissive
   (MIT/Apache-2.0/BSD/ISC/Zlib). A new dep needs a license check before merge.
2. GPL components may ship in tenant images only with the license notices
   the Dockerfile already includes; treat image distribution as GPL
   distribution.
3. Source-available components (Redis, Elasticsearch) are sidecar-only.
4. AGPL code never enters the repo or the bundle.
5. Model weights with upstream terms stay opt-in behind a per-site flag.

`wp-cloud/licenses.yaml` is the machine-readable source for the container
lane and stays in sync with this document.
