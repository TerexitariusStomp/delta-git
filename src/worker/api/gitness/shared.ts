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
// Endpoints we cannot honestly back return `501 {message}` through `gStub`;
// the SPA degrades gracefully on those.

import type { CacheContext } from "@/worker/cache";
import type { Viewer } from "@/client/server/viewer";
import type { RepositoryRoute } from "@/worker/repositories/route";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import type { AppContext } from "@/worker/routes/hono";
import { isValidOwnerRepo } from "@/shared/web";
import { resolveUiRepoAccess } from "@/worker/routes/ui/helpers";

export type GitnessContext = AppContext;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function gErr(c: GitnessContext, status: number, message: string): Response {
  return c.json({ message }, status as never);
}

export function gNotFound(c: GitnessContext, what = "resource"): Response {
  return gErr(c, 404, `${what} not found`);
}

export function gStub(c: GitnessContext, feature: string): Response {
  return gErr(c, 501, `${feature} is not supported by this backend`);
}

// ---------------------------------------------------------------------------
// ref parsing
// ---------------------------------------------------------------------------

/**
 * `repo_ref` arrives as `{owner}/{repo}/+` (gitness marks the ref end with a
 * literal `+` segment). Our owners/repos are flat, so the owner is the first
 * segment and the repo slug is everything between it and the `+`.
 */
export function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const trimmed = ref.replace(/\/+$/, "");
  const body = trimmed.endsWith("/+") ? trimmed.slice(0, -2) : trimmed.replace(/\+$/, "");
  const parts = body.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts.slice(1).join("/");
  if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  return { owner, repo };
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
