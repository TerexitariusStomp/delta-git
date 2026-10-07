# GitHub parity side-by-side (gh-mirror)

Reference corpus: `~/Documents/github-analysis/gh-mirror` — an HTTrack
snapshot of github.com (repo `cli/cli` crawled deepest). This document maps
every repo-level surface present in that snapshot onto delta-git's surface,
and records the verification method used for each.

Verification legend:

- **live** — exercised against `wrangler dev` + real `git`/`gh` binaries
- **test** — covered by `test/*.worker.test.ts` or the SPA
- **api** — REST `/api/v3` or `/api/v1` surface exists and responds

## Repo surfaces present in the mirror

| GitHub path                            | Purpose                        | delta-git surface                                                                                  | Status                                                                     |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/{o}/{r}`                             | repo home (code tree + README) | `repo-code` / `repo-summary`, `/api/v3/repos/{o}/{r}`, `/readme`                                   | live                                                                       |
| `/tree/{ref}/{path}`                   | directory browsing             | repo files view                                                                                    | live                                                                       |
| `/blob/{ref}/{path}`                   | file view                      | repo file view, `/contents/{path}`                                                                 | live                                                                       |
| `/commits/{ref}`                       | commit list                    | repo-commits page, `GET /commits`                                                                  | live                                                                       |
| `/commit/{sha}`                        | commit detail + diff           | repo-commit-details(+diff), `/git/commits/{sha}`                                                   | live                                                                       |
| `/compare`                             | arbitrary diff                 | pull-request compare view (PR-scoped)                                                              | partial — no standalone `/{o}/{r}/compare/{a}...{b}` page or REST endpoint |
| `/branches`                            | branch list                    | repo-branch-list, `GET /branches`                                                                  | live                                                                       |
| `/tags`                                | tag list                       | repo-tags-list, `GET /git/refs`                                                                    | live                                                                       |
| `/releases` + `releases.atom`          | releases                       | release pages, `GET /releases`, `releases.atom` feed                                               | live + test                                                                |
| `/issues` (+detail)                    | issue tracker                  | issues pages, `GET/POST /issues`                                                                   | live + test                                                                |
| `/pulls`, `/pull/{n}`                  | merge requests                 | PR pages, `GET/POST /pulls`, `/merge`                                                              | live + test                                                                |
| `/discussions` (+categories, labels)   | forum                          | discussion pages, `GET/POST /discussions`                                                          | live + test                                                                |
| `/actions/{workflows,runs}`            | CI                             | pipelines (`repo-pipeline-list`, executions), op-log backed runs                                   | test                                                                       |
| `/projects`                            | boards                         | repo-projects-page                                                                                 | test                                                                       |
| `/wiki`                                | docs                           | repo-wiki-page (edit + view)                                                                       | test                                                                       |
| `/security` + `/advisories`            | vuln surface                   | repo-security-page, GHSA-shaped advisories (`gadvis:` store, codescan)                             | test                                                                       |
| `/pulse`                               | activity insights              | repo-insights-page                                                                                 | test                                                                       |
| `/graphs/contributors`                 | contributor stats              | insights page                                                                                      | test                                                                       |
| `/network`                             | fork graph                     | RepoNetworkPage + `GET /api/v1/repos/.../network`                                                  | test                                                                       |
| `/packages`                            | package listing                | npm registry endpoint (`/npm/@scope/*`) — backend only, no repo-level packages UI page             | partial                                                                    |
| `/attestations/{id}`                   | artifact attestations          | DSSE attestations + `/dg/export` provenance manifest (API)                                         | api                                                                        |
| Sponsor button (`.github/FUNDING.yml`) | funding links                  | `GET /api/v1/repos/{ref}/+/funding` (parsed platform/custom links) + Sponsor heart in `RepoHeader` | test                                                                       |

## Platform surfaces — scope decisions

The plan deferred these; this is the resolution for each.

| Surface                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSH transport**        | Not implementable: Workers ingress is HTTP(S) only — no inbound TCP, so `git@host:` is architecturally impossible on this platform. Substitute: HTTPS remote + PAT via `git config credential.helper store` / `dgit` (which sets the remote and auth up), or `git config url."https://host/".insteadOf "git@host:"` to transparently rewrite SSH-style remotes. Federation relay still _targets_ SSH upstreams (`ssh:`, `tangled:`) via the off-worker contrib-agent relay. |
| **SAML / EMU**           | Out of scope. GitHub's SAML/EMU exists to federate enterprise IdPs; delta-git's identity layer is atproto-native (DID sign-in + atproto OAuth), with OIDC (tessera) as the legacy bridge. An enterprise IdP reaches the same place via an OIDC bridge; managed-user provisioning has no counterpart because accounts are self-custodied DIDs, not org-issued identities.                                                                                                    |
| **Email notifications**  | Implemented. `deliverNotification` wraps the D1 inbox write with best-effort egress through `EMAIL_API_URL`/`EMAIL_API_KEY` (Resend-shaped `POST /emails`); recipient address comes from the `gprofile:{userId}` KV record. Failures never block the mutation that produced the notification. `GET /api/v3/user/emails` exposes the address for `gh`.                                                                                                                       |
| **Git LFS**              | Implemented. Batch API at `/{o}/{r}.git/info/lfs/objects/batch`, object PUT/GET under `/info/lfs/objects/{oid}`, R2-backed, sha256-verified, deduplicated. Verified end-to-end with real `git-lfs` 3.6.1 (`test/lfs.worker.test.ts` + live push). Locks (`/locks/verify`) return 404 — the client treats that as "no locking support", which matches our no-locks model.                                                                                                    |
| **Billing / paid seats** | Out of scope by design — no payment surface. Sponsorship flows through the repo's own FUNDING.yml (above), not a platform billing system.                                                                                                                                                                                                                                                                                                                                   |

## delta-git surfaces with no GitHub equivalent

Ideas, intents, agents, arena, knowledge — the agent-native layer
(`pages-v2/delta/*`) plus MCP (`/mcp`), atproto XRPC (`/xrpc`), agent card
(`/.well-known/delta-node`, `/llms.txt`, `/skill.md`), bundle-URI, and the
merge-intent pipeline. These are the axes where the plan intentionally
exceeds GitHub.

## Client-verification results (literal `gh` over TLS, 2026-10-06)

Run through a self-signed TLS bridge (`localhost:443` in a container →
`wrangler dev` on `0.0.0.0:8787`), `GH_HOST=localhost`,
`GH_ENTERPRISE_TOKEN=<PAT>`:

| `gh` call                                                                                    | Result                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `gh api /user`                                                                               | 200                                                                                     |
| `gh api /repos/{o}/{r}`                                                                      | 200                                                                                     |
| `gh api /repos/{o}/{r}/branches` + `/branches/main`                                          | 200                                                                                     |
| `gh api /repos/{o}/{r}/commits`                                                              | 200 (`[]` on unborn repo, 422 on bad sha)                                               |
| `gh api /repos/{o}/{r}/readme`                                                               | 200 (base64 blob)                                                                       |
| `gh api /repos/{o}/{r}/contents` + `/contents/README.md`                                     | 200                                                                                     |
| `gh api` issues / pulls / releases / stargazers / topics / labels / milestones / discussions | 200                                                                                     |
| `gh api /rate_limit`                                                                         | 200                                                                                     |
| `gh repo view {o}/{r}` (+`--json`)                                                           | resolves via `/api/graphql`, renders README                                             |
| `gh api /repos/{o}/{r}/check-runs` (GET collection)                                          | 404 — correct: upstream GitHub only defines `POST /check-runs` + `GET /check-runs/{id}` |

### Gaps found and fixed during this pass

- `GET /api/v3/user` (added; `verifyPatIdentity` — identity-level PAT check
  without namespace grant, used by `/user` for `token`/`Bearer` lanes)
- `GET /api/v3/rate_limit` (added; GitHub-shaped static ceilings)
- `GET /branches` + `/branches/{b}` (added; plain `:branch` param — a
  `{.+}` catch-all corrupts sibling routes under RegExpRouter)
- `GET /commits` (added; empty-repo `[]` + 422 on bad sha for parity)
- `GET /readme` (added; registered before `contents/*` in the route table)
- GraphQL `repository.owner{id,login}` (added; required by `gh repo view`)

### Known dev-loop footgun discovered

`wrangler dev` resolves the **redirected** config
(`dist/git_on_cloudflare/wrangler.json`) and serves the _prebuilt_ bundle —
it does not rebuild `src/` on save. After editing `src/`, run
`npx vite build` (worker+client) before live verification, or the served
code silently lags the source.
