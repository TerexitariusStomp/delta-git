# Operations Runbook

Multi-tenant operational guide: quota ceilings, housekeeping, secrets inventory,
migrations, and observability.

## Quota ceilings

All limits live in `src/worker/agent/abuse.ts` (`LIMITS`, `DEFAULT_STORAGE_QUOTA_BYTES`).
Rate limits are approximate KV token buckets keyed by caller identity; storage is
approximate byte accounting per namespace.

| Control          | Scope     | Ceiling                       | Enforcement point              |
| ---------------- | --------- | ----------------------------- | ------------------------------ |
| `auth.challenge` | caller IP | 10 / 60s                      | `GET /auth/did/challenge`      |
| `auth.verify`    | caller IP | 20 / 60s                      | `POST /auth/did/verify`        |
| `repo.create`    | user      | 10 / 3600s                    | `POST /api/repos`              |
| `idea.post`      | actor DID | 10 / 3600s                    | `POST /dg/ideas`               |
| `idea.import`    | actor DID | 5 / 3600s                     | `POST /dg/ideas/import`        |
| `patch`          | actor DID | 60 / 60s                      | `POST /dg/patch`               |
| `vote`           | actor DID | 30 / 60s                      | `POST /dg/intents/:id/vote`    |
| open intents     | ref       | `MAX_OPEN_INTENTS_PER_REF`    | merge-intent DAL               |
| storage bytes    | namespace | 2 GiB (`quota:ns:<id>`)       | receive pipeline, pre-finalize |
| rep gates        | agent     | `MIN_REP_*` in `agent/rep.ts` | intents, votes, claims         |

Storage charging happens in `executeReceivePipeline` after pack staging and before
`finalizeReceive`: pack+idx bytes are charged against `quota:ns:<namespaceId>` in
`ROUTES` KV; over-quota receives fail the unpack stage and clean up the staged
pack. Accounting is approximate (KV, non-transactional) — hard invariants stay in
the repo DO. Quota store failures fail open (log + metric, push allowed).

Check usage: `GET /api/:owner/:repo/dg/stats` returns `storage_used_bytes` and
`storage_quota_bytes` for the namespace.

## Housekeeping (queues + DO alarms, zero cron)

- **Idle sweep**: repo DO alarm → `handleIdleAndMaintenance` re-arms while active;
  non-empty idle repos keep their alarm cleared; empty idle repos are purged
  (DO storage + R2 mirror prefix).
- **State snapshots**: on each alarm cycle for active repos, at most once per
  24h, writes `do/<doId>/snapshots/latest.json` to R2 — refs, HEAD, op-log tail,
  merge/work intents, pack catalog. See "Disaster recovery".
- **Compactions, route-cache sync, pack-ref backfill, webhook delivery,
  deploy-on-commit, adjudication, federation, overnight passes**: all run as
  `REPO_TASKS_QUEUE` messages; agent-runtime DOs (`AdjudicatorAgent`,
  `RepoAgent`, `FirehoseAgent`) wrap the agent-lane messages.

## Observability

`metric(env, name, {scope, index, value})` writes one Analytics Engine datapoint
per event into the `ANALYTICS` dataset. Emitted on pushes (`receive`),
merge/adjudication outcomes, federation runs, rate-limit hits, auth events, and
quota rejections. Query with the Analytics Engine SQL API; `?query=` the
`dg/stats` endpoint for per-repo numbers without dashboard work.

## Secrets inventory

| Secret                           | Purpose                                                                     | Rotation                                                 |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `SESSION_SECRET`                 | HMAC key for `dg_session` (DID) + tessera session JWTs                      | rotate → all sessions invalidated                        |
| `DG_KEK`                         | repo secret encryption at rest (DO `repo_secrets`) + provenance-bundle HMAC | rotate requires re-encrypting stored secrets             |
| `CF_API_TOKEN` / `CF_ACCOUNT_ID` | wrangler deploy + Workers-AI remote binding + Artifacts event subscriptions | rotate at Cloudflare dashboard                           |
| `TESSERA_OIDC_*`                 | legacy tessera OIDC client (only when `TESSERA_AUTH=on`)                    | rotate at issuer                                         |
| `HERMES_ORIGIN`                  | allowed origin for `/embed/hermes`                                          | config, not a secret value                               |
| PATs                             | per-user git push credentials (D1 `personal_access_tokens`, argon2 hash)    | user-revocable, never shown after issue                  |
| Agent keys                       | ed25519 agent keypairs — private half never stored server-side              | `POST /auth/did/keys`-style bind/revoke on `agents` rows |
| repo secrets                     | `PUT /dg/secrets/:name` — encrypted write-only values for deploy hooks      | per-repo delete+rewrite                                  |

## Migration runbook

D1 (identity/global state):

```bash
npm run db:generate:d1            # after editing src/worker/db/d1/schema/*
wrangler d1 migrations apply DB --local     # dev
wrangler d1 migrations apply DB --remote    # prod (verify database_id in wrangler.jsonc first!)
```

Repo DO SQLite (per-DO, applied by the DO itself on first touch):

```bash
npm run db:generate               # after editing src/worker/do/repo/db/schema.ts
# migrations under drizzle/repo-do/ ship in the worker bundle; each DO runs
# pending migrations when it opens — no fleet action needed
```

**Known gap**: if `wrangler d1 migrations apply --remote` returns `7404 could
not be found`, the configured `database_id` does not exist on this account —
run `wrangler d1 create delta-git`, update `wrangler.jsonc`, re-apply, then
reseed the `ROUTES` route-cache sync.

## Artifacts event subscriptions

`cf.artifacts.repo.pushed` events reach the `dg-artifacts-events` queue
consumer (`tasks/artifactsEvents.ts`) through **per-repo subscriptions** —
Cloudflare scopes `artifacts.repo` subscriptions to one repo each, so
`tasks/artifactsSubscriptions.ts` calls the event-subscriptions API via
`ctx.waitUntil` whenever an Artifacts repo is created (canonical `dg-*` repos
in `authRepositories.ts`, `ws-*` workspace forks in `agent.ts` workspace
create + match enter).

- Auth: `CF_ACCOUNT_ID` var + `CF_API_TOKEN` secret (same credentials as the
  deploy lane; the token needs Event Subscriptions write on the account).
  Missing credentials → the helper no-ops (dev/test), pull-sync paths stay
  correct without events.
- Idempotent: the API rejects a second subscription on the same
  (source, destination) pair, which the helper treats as already-subscribed.
- One-time bootstrap: repos created before this shipped need subscriptions
  backfilled manually —
  `POST /accounts/{id}/event_subscriptions/subscriptions` with
  `source: {type:"artifacts.repo", namespace:"delta-git", repo_name:<dg-*>}`,
  `events:["pushed"]`, `destination:{type:"queues.queue", queue_id}`).
- Stale subscriptions on deleted repos are inert — no cleanup needed.

## Disaster recovery

Single point of loss is DO SQLite (coordination state); git objects are durable
in R2. Recovery path for a lost/reset DO:

1. Read `do/<doId>/snapshots/latest.json` from R2 (see State snapshots).
2. Re-point a fresh DO: refs/HEAD come straight back; pack catalog rows are
   re-inserted; R2 packs are already content-addressed under `do/<doId>/packs/`.
3. Merge/work intents restore with their statuses; the op-log tail preserves the
   hash chain tip so `verify` continues.
4. Full provenance for an audit/rebuild: `GET /api/:owner/:repo/dg/export`
   (signed bundle: op-log + intents + votes + attestations + refs).
