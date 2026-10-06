# AGENTS.md

## Purpose

This repository is a Git Smart HTTP v2 server implemented on Cloudflare Workers with Durable Objects, R2, KV, and the vendored Gitness SPA (`frontend/canary/`, Apache-2.0) served at the site root over an `/api/v1` facade. A small SSR surface remains for `/auth`, 404, and error pages.

Write changes against the current source tree, not the docs alone. Some documentation is slightly behind the live layout.

## Rules from the user

- Reuse existing types/helpers/methods. Do not invent new types/helpers/method unnecessarily, especially do not use any or casting.
- Prefer clarity over cleverness. Favor explicit names and intermediate types over dense inline expressions. Small duplication is acceptable when it materially improves readability and maintenance.
- Comment the code, especially around nuanced behaviors and footguns. This is also not an excuse to be lean on comments.
- Prioritize lookup on `cloudflare-docs` mcp for up-to-date Cloudflare developer docs (if available). Fallback to searching the web if you cannot find the relevant information on this mcp

### Avoid transitive boundary crossings

- Try to keep cross-runtime boundaries to a single hop from the caller. Workers -> DO, Workers -> R2, or DO -> R2 are allowed, but do not chain boundaries transitively. In particular, Workers -> DO -> R2 is not allowed in most circumstances.
- Retain strict mutation boundaries between R2, Workers, and Durable Object: Durable Objects can hold a transaction against its object. Do not attempt to propose a design that resembles a distributed transaction (e.g. Workers reads a row, decide on resolutions, then invoke Durable Object RPC to mutate)
- If there needs to be resolution, Durable Object can resolve that conflict in a transaction and return a tagged union for Workers to decide
- If you need to reach for `blockConcurrencyWhile` in an Durable Object RPC, your design is probably wrong. Try again.
- In general: Workers stays stateless, no mutations; Durable Objects are stateful, transactional.

### Error handling

- Durable Objects do not throw. Use tagged union between Workers and Durable Objects to communicate outcome.
- Reserve `throw` in Durable Object for FUBAR

### No ad-hoc or duplicated types

- Before introducing a type, check whether a canonical one already exists. Key hubs:
  `src/worker/git/core/objects.ts` (GitObjectType), `src/worker/common/hex.ts` (OID helpers, zeroOid),
  `src/worker/git/object-store/support.ts` (typeCodeToObjectType), `src/worker/git/operations/limits.ts` (Limiter).
- Do not use `ReturnType<>`, `Awaited<ReturnType<>>`, or inline union literals when a named
  type already covers the shape. Extract a named type alias if one doesn't exist yet.
- Do not duplicate helpers. If you need `isZeroOid` or `typeCodeToObjectType`, import the
  existing one—don't redefine it locally.
- Watch for unused imports left behind after refactors; remove them.

### Keep comments in sync with code

- When modifying behavior, update every comment, JSDoc, and inline note that describes the
  old behavior in the same change. Outdated comments are worse than no comments.
- Review neighboring comments when editing a function—if the surrounding prose no longer
  matches the logic, fix it.

### Remove implementation-phase language

- Do not leave wording like "Phase 1/2/3", "TODO: next phase", "streaming-push WIP", or
  similar milestone markers in code, comments, or filenames once the feature is merged or
  the phase boundary is no longer meaningful. These create confusion for future readers.
- If a prior change left such references and you're editing the same area, clean them up.

### Visibility logging on new code paths

- Every non-trivial code path that touches R2, DO RPC, or background work must include
  structured logging using `createLogger` from `src/worker/common/logger.ts` (or the DO's
  `this.logger`).
- Follow the established conventions: kebab-case message identifiers scoped by component
  (e.g. `"receive:finalize-committed"`), appropriate log level (debug for flow, info for
  state changes, warn for recoverable errors, error for hard failures), and structured
  extra fields with relevant context (oid, packKey, counts, etc.).
- When adding a branch or error path to an existing function that already logs, add
  matching visibility for the new path—don't leave silent gaps.

### Limiter usage on platform-bound calls

- Every R2 read/write and outbound DO RPC in a request-scoped code path must go through
  the `Limiter` from `src/worker/git/operations/limits.ts` via `limiter.run(label, fn)`.
  Obtain the limiter with `getLimiter(cacheCtx)` or pass it through options.
- Use a descriptive label prefixed by target (e.g. `"r2:get-pack"`, `"do:get-object-compat"`).
- Respect the subrequest budget (`DEFAULT_SUBREQUEST_BUDGET = 900`). If the code path has
  its own budget (like `RECEIVE_SUBREQUEST_BUDGET`), use `countSubrequest()` to track it.
- Never bypass the limiter for "just one call"—the hard 1000-subrequest and
  6-concurrent-connection ceilings apply to the entire request, not individual call sites.

## Stack At A Glance

- Runtime: Cloudflare Workers with `nodejs_als`
- Language: TypeScript ESM, strict mode
- UI: vendored Gitness SPA (React 17, `frontend/canary/apps/gitness`) + React 19 SSR for auth/404/error; Tailwind CSS v4, Vite
- Storage: Durable Object storage, Durable Object SQLite via `drizzle-orm/durable-sqlite`, R2, KV
- Routing: `itty-router`
- Path alias: `@/*` maps to `src/*`
- Formatting: Prettier only; no ESLint config is present

## First Files To Read

- `src/worker/index.ts`: top-level router registration and route ordering
- `src/worker/routes/git.ts`: Git Smart HTTP endpoints, upload-pack/receive-pack behavior
- `src/worker/routes/admin.ts`: owner-authenticated admin JSON endpoints
- `src/worker/routes/auth.ts`: auth UI and auth API endpoints
- `src/worker/do/repo/repoDO.ts`: repository Durable Object — metadata authority, receive leases, compaction, and background work
- `src/worker/do/repo/db/dal.ts`: the required access layer for SQLite-backed repo metadata
- `src/client/server/render.tsx` and `src/client/server/registry.tsx`: SSR view registration and rendering
- `wrangler.jsonc`: bindings, vars, assets handling, compatibility date

## Directory Map

- `src/worker/routes/`: HTTP route registration and route handlers
- `src/worker/do/repo/`: repository Durable Object, receive, compaction, idle cleanup, storage, DB
- `src/worker/do/auth/`: authentication Durable Object
- `src/worker/git/core/`: low-level Git protocol parsing and object helpers
- `src/worker/git/operations/`: fetch, read-path logic, streaming upload-pack implementation
- `src/worker/git/pack/`: pack assembly, pack indexing, pack metadata helpers
- `src/client/pages/`: retained SSR pages (auth sign-in, 404, error)
- `src/client/components/`: shared SSR components
- `src/client/islands/`: client-only interactive modules (did-signin, shell)
- `src/client/entries/`: Vite client entrypoints used by SSR pages
- `frontend/canary/`: vendored Harness/Gitness SPA workspace (Apache-2.0)
- `src/worker/api/gitness/`: `/api/v1` facade — translates the SPA's API onto delta-git primitives
- `src/worker/routes/spa.ts`: SPA asset serving + client-route fallback (registered last)
- `src/shared/web/`: browser-safe request parsing, formatting, MIME/JSON helpers
- `src/worker/common/`: Worker response, logging, compression, stubs, progress helpers
- `test/`: Vitest worker integration tests and Node unit tests
- `docs/`: architecture and API notes; useful, but verify against source before relying on path details

## Core Invariants

- Route order matters. `registerAuthRoutes(router)` must stay before `registerUiRoutes(router)` so `/auth` is not shadowed by `/:owner`.
- The Worker owns HTML routing. `wrangler.jsonc` sets `assets.html_handling` to `"none"`; do not move page ownership into the assets layer by accident.
- The repo Durable Object is the source of truth for a single repository. Keep refs/HEAD authority there.
- SQLite access for repo metadata must go through `src/worker/do/repo/db/dal.ts`. Do not add ad hoc raw Drizzle queries in unrelated files.
- `RepoDurableObject.fetch()` intentionally exposes only a small HTTP surface. Keep typed RPC methods as the default internal interface.
- Receive uses a lease model: one active receive lease at a time, acquired via `beginReceive()` and committed via `finalizeReceive()`. Concurrent pushes receive `503 Retry-After: 10`.
- Git fetch paths are streaming-sensitive. Avoid unnecessary buffering on upload-pack and pack assembly paths.
- Git pushes require a D1-backed PAT with `level = "push"`; HTTP Basic username must match the route namespace slug.
- The SPA owns all page routing; `registerSpaRoutes` in `src/worker/routes/spa.ts` must stay registered last and must never shadow `/api`, `/auth`, `/xrpc`, `/mcp`, `/info`, `/objects`, or `/.well-known` paths. SSR rendering (auth/404/error only) goes through `renderUiView()` and the view registry in `src/client/server/registry.tsx`.

## Normal Workflow For Agents

1. Check repo state first with `git status --short`.
2. Read the smallest relevant slice of the codebase before editing.
3. Prefer narrow changes in the subsystem that owns the behavior.
4. Run the smallest useful validation commands before finishing.
5. Update tests when behavior changes.

Dirty worktrees are normal here. Do not overwrite or revert unrelated user changes.

## Commands

### Install and run

```bash
npm install
npm run dev
```

### Build and static validation

```bash
npm run build
npm run typecheck
npm run format:check
```

### Formatting

```bash
npm run format
```

### Tests

`npm run test` runs Node Vitest tests for non-worker units in `test/**/*.test.ts` excluding `*.worker.test.ts`.

`npm run test:workers` runs Vitest against Cloudflare worker integration tests.

`npm run test:auth` runs only `test/auth.worker.test.ts`.

The 42 MiB pack-indexer fixture test is opt-in. Use `PACK_INDEXER_FIXTURE=1 npx vitest run --config vitest.config.ts test/pack-indexer-fixture.worker.test.ts` when you intentionally want to run it.

Targeted commands:

```bash
npx vitest run --config vitest.unit.config.ts test/object-parse.test.ts
npx vitest run --config vitest.config.ts test/streaming-receive.worker.test.ts
npx vitest run --config vitest.config.ts test/auth.worker.test.ts
```

### Cloudflare and schema maintenance

```bash
npm run cf-typegen
npm run db:generate
```

Do not edit generated migrations under `drizzle/repo-do/` manually. Treat `src/worker/do/repo/db/schema.ts` as the source of truth: make the schema change there first, then run `npm run db:generate` to generate the migration.

## Validation By Change Type

- Git protocol, DO, pack, compaction, caching, or routing changes:
  run `npm run typecheck` and the relevant worker tests in `test/*.worker.test.ts`
- Auth changes:
  run `npm run test:auth`
- Pure parsing or helper changes:
  run the targeted Node Vitest test plus `npm run typecheck`
- UI-only SSR/component changes:
  run `npm run typecheck`; if route behavior changed, add relevant worker coverage
- SPA changes (`frontend/canary/`):
  run `npm run build:spa` and the worker tests that cover `/api/v1` or SPA routing
- SQLite schema or DAL changes:
  run `npm run db:generate`, `npm run typecheck`, and the worker tests that cover the affected flow

## UI Notes

- Design context (audience, brand personality, aesthetic direction, color/typography choices) lives in `PRODUCT.md` at the project root. Read it before making visual or UX decisions.
- The user-facing UI is the vendored Gitness SPA at `/` — repo, space, PR, and delta surfaces live under `frontend/canary/apps/gitness/src/` (delta views in `pages-v2/delta/`).
- The GitHub reskin is token-driven: edit `frontend/canary/apps/gitness/src/delta/github-theme.css`, never the generated design-system CSS.
- SSR pages (auth sign-in, 404, error) live in `src/client/pages/`; shared shell/document logic in `src/client/server/`; islands in `src/client/islands/`; entrypoints wired through `src/client/entrypoints.ts` and `src/client/server/registry.tsx`.
- Shared SSR CSS starts at `src/client/styles.css`, which imports `src/client/styles/app.css`.

## Testing Notes

- Worker Vitest uses `@cloudflare/vitest-pool-workers` and points at `src/worker/index.ts`.
- Node unit tests use `vitest.unit.config.ts`.
- The Vitest pool compatibility date should stay aligned with `wrangler.jsonc`.
- Stable test env vars are defined in `test/vitest.bindings.ts`.

## Good Change Patterns

- When adding a route, modify the owning module under `src/worker/routes/` and keep registration order safe.
- When adding repo metadata, decide whether it belongs in DO storage or SQLite; if SQLite, add schema and DAL changes together.
- New user-facing pages go in the SPA (`frontend/canary/apps/gitness/src/routes.tsx`); the SSR registry is only for auth/error chrome.
- When changing pack or fetch behavior, look for existing worker tests before writing new code; the repo already has strong coverage for those paths.

## Avoid

- Broad refactors across route, DO, and UI layers unless the task truly needs it
- Raw SQL/Drizzle access outside the repo DB DAL
- Accidental route shadowing with `/:owner` and `/:owner/:repo`
- Suffix literals after a `{.+}` param that share the previous segment's
  prefix — Hono's RegExpRouter silently fails to match them when exact
  sibling routes exist (e.g. `/repos/:repo_ref{.+}/dr/drill` 404s while
  `/repos/import` and `/repos/link` are registered; `/dr/verify` works).
  If a new subroute 404s mysteriously, rename the suffix so its last
  segment doesn't start with the same letters as the one before it.
- Re-introducing loose objects as a correctness dependency
- Assuming README or docs reflect every current file path without checking the source tree
