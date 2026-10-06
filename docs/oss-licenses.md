# OSS License Inventory

Combined audit of delta-git and wp-cloud (the first-party app deployed at
`wpcloud.delta-git.workers.dev`, merged into this repo as the `wpcloud/`
subtree). Verified against installed package `license` fields and
wp-cloud's `licenses.yaml`; Trivy's license scanner runs in the deploy
gate as the ongoing check.

## Provenance

delta-git descends from
[`zllovesuki/git-on-cloudflare`](https://github.com/zllovesuki/git-on-cloudflare)
(MIT). The inherited worker/git-protocol scaffold is upstream MIT code;
everything under `src/` that implements merge intents, adjudication,
arena, reputation, agents, atproto identity, federation, and the site
pipeline is original delta-git code.

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
| jose                                                    | MIT                         | HS256 JWT (dg_token, sessions)  |
| standardwebhooks                                        | MIT                         | Svix webhook signing scheme     |
| @atcute/multibase                                       | 0BSD                        | did:key base58btc codec         |
| @atcute/oauth-node-client                               | 0BSD                        | atproto OAuth (PAR/PKCE/DPoP)   |
| @atcute/identity, identity-resolver, lexicons           | 0BSD                        | handle/DID/PDS resolution       |
| @modelcontextprotocol/server                            | MIT → Apache-2.0 transition | MCP JSON-RPC/SSE transport      |
| modern-tar                                              | MIT                         | Archive writer; wpcloud reader  |
| badge-maker                                             | CC0-1.0                     | shields.io SVG badge generator  |
| @simplewebauthn/server                                  | MIT                         | WebAuthn passkey ceremonies     |

## Build/dev tooling (not distributed)

| Component                                      | License           |
| ---------------------------------------------- | ----------------- |
| typescript                                     | Apache-2.0        |
| vite, rolldown, tailwindcss, prettier, vitest  | MIT               |
| wrangler                                       | MIT OR Apache-2.0 |
| @cloudflare/workers-types, vitest-pool-workers | MIT / BSD         |
| pnpm (canary workspace)                        | MIT               |

## Vendored frontend — `frontend/canary/` (Harness/Gitness)

The web UI is a vendored subtree of
[`harness/canary`](https://github.com/harness/canary) pinned at tag
`mfe.alpha.2819`. Repo-root `LICENSE` is Apache-2.0 and covers every vendored
package; see `frontend/canary/UPSTREAM.md` for the exact pin and patches.

Vendored workspace packages (all Apache-2.0, ISC for core-design-system):

| Package                         | Role                                      |
| ------------------------------- | ----------------------------------------- |
| `apps/gitness`                  | The SPA — routes, pages, hooks, app shell |
| `@harnessio/ui`                 | Component library                         |
| `@harnessio/views`              | Prop-driven view layer                    |
| `@harnessio/forms`              | Form engine                               |
| `@harnessio/filters`            | Filter primitives                         |
| `@harnessio/core-design-system` | Design tokens → `--cn-*` CSS vars         |
| `@harnessio/pipeline-graph`     | Pipeline DAG renderer                     |
| `@harnessio/yaml-editor`        | Monaco-backed YAML editor                 |

Published packages consumed from npm:

| Package                          | License | Role                                          |
| -------------------------------- | ------- | --------------------------------------------- |
| `@harnessio/code-service-client` | MIT     | `/api/v1` contract — our facade implements it |
| `@harnessio/oats-cli`            | MIT     | Optional client codegen                       |

Notable transitive runtime deps inside the SPA bundle (all permissive):

| Component                                        | License | Role                          |
| ------------------------------------------------ | ------- | ----------------------------- |
| react 17, react-dom, react-router-dom 6          | MIT     | SPA runtime (isolated bundle) |
| monaco-editor                                    | MIT     | File/editor surface           |
| diff2html, @git-diff-view/react                  | MIT     | PR/commit diffs               |
| react-query (tanstack v4), zustand, jotai, immer | MIT     | Data/state                    |
| i18next family                                   | MIT     | i18n                          |
| react-hook-form, zod                             | MIT     | Forms/validation              |
| tinykeys                                         | MIT     | Repo keyboard shortcuts       |
| rehype-slug, rehype-autolink-headings            | MIT     | README heading anchors        |

S0.6 audit: 220 vendored deps — 190 MIT, 17 Apache-2.0, remainder
ISC/BSD/MIT-0. The only flagged package is `gitness@0.1.0` itself, covered by
the repo's Apache-2.0 root LICENSE. No GPL/AGPL anywhere in the subtree.

## wp-cloud Worker runtime

| Component            | License                        | Context                                |
| -------------------- | ------------------------------ | -------------------------------------- |
| aws4fetch            | MIT                            | R2 S3 presigning                       |
| itty-router          | MIT                            | API routing                            |
| viem                 | MIT                            | SIWE wallet verification, USDC watcher |
| modern-tar           | MIT                            | deploy-git tar reader                  |
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
