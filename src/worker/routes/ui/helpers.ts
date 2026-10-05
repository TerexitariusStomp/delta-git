import type { CacheContext } from "@/worker/cache";
import type { HeadInfo, Ref } from "@/worker/git";
import type { Viewer } from "@/client/server/viewer";
import { getHeadAndRefs } from "@/worker/git";
import { isValidOwnerRepo } from "@/shared/web";
import { buildCacheKeyFrom, cacheOrLoadJSONForRequest } from "@/worker/cache";
import { isRequestPrivate, markRequestPrivate } from "@/worker/cache/policy";
import { loadSessionMembership } from "@/worker/auth/sessionMembership";
import { loadViewer } from "@/worker/auth/session";
import type { Limiter } from "@/worker/git/operations/limits";
import { resolveRepositoryRoute, type RepositoryRoute } from "@/worker/repositories/route";
import type { AppContext } from "@/worker/routes/hono";
import { renderUiDocumentResponse } from "@/worker/routes/uiResponse";

// Re-export the cache-policy predicates so existing handlers don't need
// to know they live in the cache layer. The lower Git/protocol modules
// import directly from `@/worker/cache/policy`.
export { isRequestPrivate, markRequestPrivate };

export async function loadHeadAndRefsCached(
  env: Env,
  cacheCtx: CacheContext,
  repoId: string
): Promise<{ head: HeadInfo | undefined; refs: Ref[] } | null> {
  const loader = async (): Promise<{ head: HeadInfo | undefined; refs: Ref[] } | null> => {
    try {
      const res = await getHeadAndRefs(env, repoId, cacheCtx);
      return { head: res.head, refs: res.refs };
    } catch {
      return null;
    }
  };
  const cacheKeyRefs = buildCacheKeyFrom(cacheCtx.req, "/_cache/refs", { repo: repoId });
  return cacheOrLoadJSONForRequest<{ head: HeadInfo | undefined; refs: Ref[] }>(
    cacheCtx,
    cacheKeyRefs,
    loader,
    60
  );
}

// Shared 404 response for repo-serving handlers. Centralizes the SSR shell +
// viewer load so handlers don't reach into `index.ts` internals. Callers
// that have already resolved a viewer can pass it through to avoid a
// second D1 round trip.
export async function notFound(
  c: AppContext,
  title?: string,
  viewer?: Viewer | null
): Promise<Response> {
  const resolvedViewer = viewer === undefined ? await loadViewer(c) : viewer;
  return renderUiDocumentResponse(c.env, "404", title ? { title } : {}, {
    status: 404,
    failureBody: "Not found\n",
    failureStatus: 404,
    viewer: resolvedViewer,
  });
}

// Same as `notFound` but returns a JSON 404 — used by data API endpoints
// (`/api/refs`) where SSR shell would be wasted bytes.
export function notFoundJson(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Bundle for the resolve+session+visibility decision shared by every
// repo-serving handler (retained UI routes, raw/refs endpoints, and the
// /api/v1 facade). Returns either:
//   - { kind: "ok", route, cacheCtx, viewer }: caller proceeds. The
//     `cacheCtx` is already marked private when private repository data is
//     served.
//   - { kind: "response", response }: caller returns the response as-is.
//     Centralizes the non-disclosure rule (private + non-member -> 404,
//     identical to private + anonymous).
export type UiRepoAccess =
  | {
      kind: "ok";
      route: RepositoryRoute;
      cacheCtx: CacheContext;
      viewer: Viewer | null;
    }
  | { kind: "response"; response: Response };

export type AdminRepoAccess =
  | { kind: "ok"; route: RepositoryRoute; cacheCtx: CacheContext; viewer: Viewer; limiter: Limiter }
  | { kind: "response"; response: Response };

export type UiRepoAccessOptions = {
  // For data-API endpoints that return JSON (not HTML) on failure.
  responseShape?: "html" | "json";
};

export async function resolveUiRepoAccess(
  c: AppContext,
  owner: string,
  repo: string,
  options: UiRepoAccessOptions = {}
): Promise<UiRepoAccess> {
  const cacheCtx = c.var.cacheCtx;
  if (!isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) {
    return {
      kind: "response",
      response:
        options.responseShape === "json" ? notFoundJson() : await notFound(c, "Invalid owner/repo"),
    };
  }
  const viewer = await loadViewer(c);
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: viewer ? "allow-d1-fallback" : "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "RepoRoute" }),
  });
  if (!route) {
    return {
      kind: "response",
      response: options.responseShape === "json" ? notFoundJson() : await notFound(c),
    };
  }
  if (route.visibility === "public") {
    if (!viewer) {
      return { kind: "ok", route, cacheCtx, viewer };
    }
    const membership = await loadSessionMembership(c, route.namespaceId);
    return {
      kind: "ok",
      route,
      cacheCtx,
      viewer: membership.kind === "anonymous" ? viewer : membership.viewer,
    };
  }
  if (!viewer) {
    const log = c.var.logFor({ service: "UiAcl", repoId: route.doName });
    log.debug("ui-acl:private-non-member-404", { kind: "anonymous" });
    return {
      kind: "response",
      response: options.responseShape === "json" ? notFoundJson() : await notFound(c),
    };
  }
  // Private: gate on session membership. PAT credentials are never honored
  // for UI/data routes (PATs are git-only).
  const membership = await loadSessionMembership(c, route.namespaceId);
  const log = c.var.logFor({ service: "UiAcl", repoId: route.doName });
  if (membership.kind !== "member") {
    log.debug("ui-acl:private-non-member-404", { kind: membership.kind });
    // `loadSessionMembership` returns the viewer for signed-in-non-member
    // results; reuse it so the 404 page renders the correct shell without a
    // second D1 round-trip.
    const passthroughViewer = membership.kind === "signed-in-non-member" ? membership.viewer : null;
    return {
      kind: "response",
      response:
        options.responseShape === "json"
          ? notFoundJson()
          : await notFound(c, undefined, passthroughViewer),
    };
  }
  markRequestPrivate(cacheCtx);
  return { kind: "ok", route, cacheCtx, viewer: membership.viewer };
}

function adminJsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// JSON admin endpoints keep the same disclosure model as the retired admin
// page, but public anonymous callers receive 401 instead of the sign-in
// redirect and public signed-in non-members receive 403.
export async function resolveAdminApiRepoAccess(c: AppContext): Promise<AdminRepoAccess> {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) {
    return { kind: "response", response: adminJsonError("Not found", 404) };
  }

  const viewerForResolution = await loadViewer(c);
  const route = await resolveRepositoryRoute(c.env, owner, repo, {
    mode: viewerForResolution ? "allow-d1-fallback" : "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "RepoRoute" }),
  });
  if (!route) return { kind: "response", response: adminJsonError("Not found", 404) };

  const membership = await loadSessionMembership(c, route.namespaceId);
  if (membership.kind === "anonymous") {
    if (route.visibility === "private") {
      return { kind: "response", response: adminJsonError("Not found", 404) };
    }
    return { kind: "response", response: adminJsonError("Unauthorized", 401) };
  }
  if (membership.kind === "signed-in-non-member") {
    if (route.visibility === "private") {
      return { kind: "response", response: adminJsonError("Not found", 404) };
    }
    return { kind: "response", response: adminJsonError("Forbidden", 403) };
  }

  const cacheCtx = c.var.cacheCtx;
  markRequestPrivate(cacheCtx);
  return { kind: "ok", route, cacheCtx, viewer: membership.viewer, limiter: c.var.limiter };
}
