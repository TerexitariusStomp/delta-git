# Vendored upstream: harness/canary

- **Repo**: https://github.com/harness/canary
- **Pinned ref**: tag `mfe.alpha.2819` (commit `4aeb71467366f585b4f98270b872e8fdde13fd2b`)
- **License**: Apache-2.0 (see `LICENSE` in this directory)
- **Vendored**: 2026-10-05 — snapshot import, not a git subtree (upstream history
  intentionally not merged; this file is the provenance record).

## What was imported

- `apps/gitness` — the Gitness SPA (React 17, Vite build)
- `packages/{ui,views,forms,filters,yaml-editor,pipeline-graph,core-design-system}` —
  its full `@harnessio/*` workspace dependency closure

## What was deliberately excluded

- `apps/portal`, `apps/design-system` — docs/preview apps, not needed
- `packages/tests`, `packages/ai-chat-core` — test harness + unused chat package
- Root Dockerfiles, playwright config, CODEOWNERS/CI files — upstream infra

## Local modifications

Tracked below as they accrete (vendor-patch discipline: every deviation from
upstream is documented here so refreshes can reapply them):

- `package.json` — trimmed to gitness-relevant scripts.
- `@harnessio/react-ng-manager-*` deps removed from `apps/gitness/package.json` —
  Harness-platform MFE clients, unused standalone.
- `frontend/canary/packages/core-design-system/` — `github` theme added for the
  delta-git reskin.
- `apps/gitness/src/routes.tsx` + new `src/pages-delta/` — delta-git views
  (arena, ideas, agents, merge intents) wired into the SPA router.
- `window.apiUrl` — same-origin `/api/v1` facade served by the delta-git worker.
