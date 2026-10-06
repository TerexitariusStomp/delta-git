// Shared helpers for the Gitness `/api/v1` facade.
//
// The vendored gitness SPA speaks the Harness code-service REST contract
// (`@harnessio/code-service-client`). These helpers translate between that
// contract and delta-git's model:
//   - gitness "space"  ↔ delta-git namespace (`:owner` segment)
//   - gitness "repo"   ↔ delta-git repository
//   - `repo_ref` URL param is `{owner}/{repo}/+` (trailing `+` marks ref end)
//   - errors use the `UsererrorError` shape: `{message, values?}`
//   - all timestamps are emitted in milliseconds
//
// Every registered route is backed by real state — D1, DO storage, KV
// records, or the git object store. Unregistered `/api/v1` paths 404.

import type { CacheContext } from "@/worker/cache";
import type { Viewer } from "@/client/server/viewer";
import type { RepositoryRoute } from "@/worker/repositories/route";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import type { AppContext } from "@/worker/routes/hono";
import { isValidOwnerRepo } from "@/shared/web";
import { resolveUiRepoAccess } from "@/worker/routes/ui/helpers";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";
import { viewerIsNamespaceMember } from "@/worker/auth/pat";
import { enforceInNamespace, principalForUser } from "@/worker/rbac";
import { getRepoStub, newPrefixedId } from "@/worker/common";
import { deliverWebhookEvent } from "@/worker/agent/webhooks";
import { insertNotification } from "@/worker/db/d1/dal/modules";
import { listMembershipsForNamespace } from "@/worker/db/d1/dal/namespaces";
import { readUserFavorites } from "./stores";

export type GitnessContext = AppContext;

/**
 * Repo ids the viewer starred — one KV read per request, shared by every
 * `toGitnessRepo` call in that response so `is_favorite` is consistent.
 */
export async function favoriteRepoIds(env: Env, userId: string | undefined): Promise<Set<number>> {
  if (!userId) return new Set();
  const favs = await readUserFavorites(env, userId);
  return new Set(favs.filter((f) => f.resource_type === "REPOSITORY").map((f) => f.resource_id));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function gErr(c: GitnessContext, status: number, message: string): Response {
  // Frozen machine code alongside the GitHub-shaped `message` (DGS-02).
  const error =
    status === 400
      ? "bad-request"
      : status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not-found"
            : status === 409
              ? "conflict"
              : status === 422
                ? "validation-failed"
                : status === 429
                  ? "rate-limited"
                  : "internal-error";
  return c.json({ message, error }, status as never);
}

export function gNotFound(c: GitnessContext, what = "resource"): Response {
  return gErr(c, 404, `${what} not found`);
}

// ---------------------------------------------------------------------------
// ref parsing
// ---------------------------------------------------------------------------

/**
 * `repo_ref` arrives as `{owner}/{repo}/+` (gitness marks the ref end with a
 * literal `+` segment). Our owners/repos are flat, so the owner is the first
 * segment and the repo slug is everything between it and the `+`. Slugs are
 * lowercase-canonical, so the URL folds to lowercase for case-insensitive
 * resolution (same as GitHub).
 */
export function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const trimmed = ref.replace(/\/+$/, "");
  const body = trimmed.endsWith("/+") ? trimmed.slice(0, -2) : trimmed.replace(/\+$/, "");
  const parts = body.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].toLowerCase();
  const repo = parts.slice(1).join("/").toLowerCase();
  if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  return { owner, repo };
}

/**
 * User-supplied repo/space identifiers are lowercase-canonical slugs. Fold
 * GitHub-style mixed-case input (`MyFirstRepo` → `myfirstrepo`) at write
 * entry points so creation accepts it instead of rejecting on the validator.
 */
export function normalizeIdentifier(input: string): string {
  return input.trim().toLowerCase();
}

export type GitnessRepoAccess =
  | { kind: "ok"; route: RepositoryRoute; cacheCtx: CacheContext; viewer: Viewer | null }
  | { kind: "response"; response: Response };

export async function resolveGitnessRepo(
  c: GitnessContext,
  ref: string
): Promise<GitnessRepoAccess> {
  const parsed = parseRepoRef(ref);
  if (!parsed) return { kind: "response", response: gNotFound(c, "repository") };
  const access = await resolveUiRepoAccess(c, parsed.owner, parsed.repo, {
    responseShape: "json",
  });
  if (access.kind !== "ok") return { kind: "response", response: access.response };
  // Private-repo access marks the request's cache context private; the
  // `/api/v1` middleware in index.ts stamps `Cache-Control: no-store` on the
  // outgoing response.
  return {
    kind: "ok",
    route: access.route,
    cacheCtx: access.cacheCtx,
    viewer: access.viewer,
  };
}

// ---------------------------------------------------------------------------
// Shape mappers
// ---------------------------------------------------------------------------

/**
 * Gitness ids are numeric. Ours are opaque strings — squash them into a stable
 * positive int32 (FNV-1a) for the `id` fields the SPA uses as React keys and
 * principal lookups. Collision risk is acceptable: ids are display-only.
 */
export function numericId(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

export function toGitnessUser(viewer: Viewer) {
  const uid = viewer.primaryNamespaceSlug ?? viewer.userId;
  return {
    id: numericId(viewer.userId),
    uid,
    display_name: uid,
    email: "",
    admin: false,
    blocked: false,
    created: 0,
    updated: 0,
  };
}

export function toGitnessPrincipal(uid: string) {
  return {
    id: numericId(uid),
    uid,
    display_name: uid,
    email: "",
    type: "user",
    created: 0,
    updated: 0,
  };
}

// Git trailer block — the `Co-authored-by: Name <email>` tail GitHub uses to
// render commit co-authors. Only the trailing contiguous trailer lines count;
// a "Co-authored-by:" mid-message body is just prose.
const CO_AUTHOR_RE = /^Co-authored-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/i;

export function parseCoAuthors(message: string): { name: string; email: string }[] {
  const lines = message.split("\n");
  const out: { name: string; email: string }[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      if (out.length === 0) continue; // blank separator before the trailer block
      break; // blank inside a block → trailers ended
    }
    const m = CO_AUTHOR_RE.exec(line);
    if (!m) {
      if (out.length === 0) {
        // Non-trailer tail line: no trailer block at all once we hit prose.
        if (!/^[A-Za-z-]+:/.test(line)) break;
        continue; // other trailer keys (Signed-off-by:, …) — keep scanning
      }
      // Inside the block: another trailer key is fine, prose ends the block.
      if (!/^[A-Za-z-]+:/.test(line)) break;
      continue;
    }
    out.unshift({ name: m[1], email: m[2] });
  }
  return out;
}

/**
 * `CommitInfo` → gitness `TypesCommit`. `when` wants RFC3339; our author.time
 * is unix seconds (git format).
 */
export function toGitnessCommit(info: CommitInfo) {
  const sig = (s?: CommitInfo["author"]) =>
    s
      ? {
          identity: { name: s.name, email: s.email },
          when: new Date(s.when * 1000).toISOString(),
        }
      : undefined;
  return {
    sha: info.oid,
    title: info.message.split("\n", 1)[0] ?? "",
    message: info.message,
    author: sig(info.author),
    committer: sig(info.committer),
    parent_shas: info.parents,
    co_authors: parseCoAuthors(info.message),
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface GitnessPage {
  page: number;
  limit: number;
}

/**
 * The SPA reads `x-total`, `x-total-pages`, `x-page`, `x-per-page`,
 * `x-next-page`, `x-prev-page` headers (see apps/gitness/src/types.ts).
 */
export function pageParams(c: GitnessContext, defaultLimit = 30): GitnessPage {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(c.req.query("limit") ?? `${defaultLimit}`, 10) || defaultLimit)
  );
  return { page, limit };
}

export function setPageHeaders(c: GitnessContext, page: GitnessPage, total: number): void {
  const totalPages = Math.max(1, Math.ceil(total / page.limit));
  c.header("x-total", String(total));
  c.header("x-total-pages", String(totalPages));
  c.header("x-page", String(page.page));
  c.header("x-per-page", String(page.limit));
  c.header("x-next-page", String(page.page < totalPages ? page.page + 1 : ""));
  c.header("x-prev-page", String(page.page > 1 ? page.page - 1 : ""));
}

export function paginate<T>(items: T[], page: GitnessPage): T[] {
  return items.slice((page.page - 1) * page.limit, page.page * page.limit);
}

// ---------------------------------------------------------------------------
// Write-side access
// ---------------------------------------------------------------------------

export type RepoAccessOk = Extract<GitnessRepoAccess, { kind: "ok" }>;

/**
 * Resolve the repo and require a signed-in namespace member — the write
 * side's access bar, matching the /auth/api repository routes. Returns the
 * access bundle plus the actor string used for oplog/intent authorship.
 */
export async function requireWriter(
  c: GitnessContext
): Promise<(RepoAccessOk & { actor: string }) | Response> {
  const access = await resolveGitnessRepo(c, c.req.param("repo_ref") ?? "");
  if (access.kind !== "ok") return access.response;
  if (!access.viewer) return gErr(c, 401, "unauthorized");
  const row = await findRepositoryByDoName(c.var.db, access.route.doName);
  if (!row) return gNotFound(c, "repository");
  if (!(await viewerIsNamespaceMember(c.var.db, access.viewer.userId, row.namespaceId))) {
    return gErr(c, 403, "not a member of this space");
  }
  // RBAC: writes need a developer-or-owner role in this namespace (casbin
  // evaluates memberships + group expansion + custom rules).
  const allowed = await enforceInNamespace(
    c.var.db,
    row.namespaceId,
    principalForUser(access.viewer.userId),
    `repo:${row.doName}`,
    "write"
  );
  if (!allowed) return gErr(c, 403, "insufficient role for writes");
  return {
    ...access,
    actor: access.viewer.primaryNamespaceSlug ?? access.viewer.userId,
  };
}

/**
 * Same bar as `requireWriter` but boolean — used where write-level state
 * (e.g. draft releases) is *visible* to members but the read itself is open.
 */
export async function viewerCanWrite(c: GitnessContext, access: RepoAccessOk): Promise<boolean> {
  if (!access.viewer) return false;
  const row = await findRepositoryByDoName(c.var.db, access.route.doName);
  if (!row) return false;
  if (!(await viewerIsNamespaceMember(c.var.db, access.viewer.userId, row.namespaceId))) {
    return false;
  }
  return await enforceInNamespace(
    c.var.db,
    row.namespaceId,
    principalForUser(access.viewer.userId),
    `repo:${row.doName}`,
    "write"
  );
}

/**
 * Best-effort repo-webhook fan-out — enqueues one queue message per matching
 * subscriber; failures never block the mutation that emitted the event.
 */
export function emitRepoEvent(
  c: GitnessContext,
  access: RepoAccessOk,
  kind: string,
  payload: Record<string, unknown>
): void {
  const stub = getRepoStub(c.env, access.route.doName);
  c.executionCtx.waitUntil(
    deliverWebhookEvent(c.env, access.route.repositoryId, stub, {
      kind,
      payload: {
        repo: `${access.route.routeNamespaceSlug}/${access.route.routeRepoSlug}`,
        ...payload,
      },
    }).catch(() => {})
  );
}

/**
 * Best-effort namespace notification fan-out — same "every member except the
 * actor" model as the receive pipeline's push notifications. Runs in
 * waitUntil; failures never block the mutation.
 */
export function notifyMembers(
  c: GitnessContext,
  access: RepoAccessOk,
  args: { kind: string; title: string; body: string; excludeUserId?: string; link?: string }
): void {
  // SPA repo pages live under /{space}/repos/{repo} — match that for deep links.
  const link =
    args.link ?? `/${access.route.routeNamespaceSlug}/repos/${access.route.routeRepoSlug}`;
  c.executionCtx.waitUntil(
    (async () => {
      const members = await listMembershipsForNamespace(c.var.db, access.route.namespaceId);
      for (const member of members) {
        if (member.userId === args.excludeUserId) continue;
        await insertNotification(c.var.db, {
          id: newPrefixedId("ntf"),
          userId: member.userId,
          kind: args.kind,
          title: args.title,
          body: args.body,
          link,
          createdAt: Date.now(),
          readAt: null,
        });
      }
    })().catch(() => {})
  );
}
