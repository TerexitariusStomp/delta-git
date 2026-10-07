import { createLogger } from "@/worker/common";
import { createDb, type Db } from "@/worker/db/d1/client";
import { updatePatLastUsedAt } from "@/worker/db/d1/dal/tokens";
import type { Logger } from "@/worker/common/logger";
import type { RepositoryRoute } from "@/worker/repositories/route";

import {
  PAT_LAST_USED_READ_THROTTLE_MS,
  shouldTouchPatLastUsedAt,
  verifyPat,
  verifyPatIdentity,
  type PatIdentityOk,
  type PatLastUsedOp,
  type PatVerifyError,
  type PatVerifyOk,
} from "./pat";
import { oauthNamespaceAccess, resolveOAuthBearer, type OAuthPrincipal } from "./oauth";

// Decode `Authorization: Basic <b64>` into `{ username, password }`. The
// caller decides whether the credentials are valid; this helper does no
// authorization. Used by Git endpoints that accept PAT credentials over
// HTTP Basic.
export function getBasicCredentials(req: Request): { username: string; password: string } | null {
  const header = req.headers.get("Authorization") || "";
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = atob(match[1]!);
    const idx = decoded.indexOf(":");
    if (idx === -1) return { username: decoded, password: "" };
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

// UI handlers must not import this module; it is the only path that reaches
// `verifyPat`. The kept invariant: PAT credentials authorize git endpoints
// only, never browser surfaces.
export type GitAuthResult =
  | { kind: "anonymous" }
  | { kind: "missing-credentials" }
  | { kind: "pat"; verified: PatVerifyOk }
  | { kind: "pat-rejected"; reason: PatVerifyError["reason"] }
  // OAuth bearer (workers-oauth-provider): token valid; `verified.scopes`
  // carries the granted scope list and `member` the namespace ACL result —
  // gates check both. `oauth-rejected` mirrors `pat-rejected`.
  | { kind: "oauth"; verified: OAuthVerified }
  | { kind: "oauth-rejected" };

export interface OAuthVerified {
  principal: OAuthPrincipal;
  /** userId convenience — matches PatVerifyOk's field for actor plumbing */
  userId: string;
  scopes: string[];
  /** whether the user belongs to the route's namespace */
  member: boolean;
}

export async function authenticateGitRequest(
  env: Env,
  request: Request,
  route: RepositoryRoute,
  options: { db?: Db; enforceDpop?: boolean } = {}
): Promise<GitAuthResult> {
  // GitHub/gh CLI conventions: `Authorization: token <pat>` and
  // `Authorization: Bearer <pat>` both carry a bare PAT with no username.
  // The namespace binding falls back to the route's owner slug, matching
  // GitHub semantics where the token authenticates globally and the grant
  // check scopes it to this repo. OAuth access tokens never look like
  // `goc_*` so shape-routing cannot confuse the two lanes.
  const authz = request.headers.get("Authorization")?.toLowerCase() ?? "";
  const rawAuthz = request.headers.get("Authorization") ?? "";
  const tokenSchemeValue = authz.startsWith("token ") ? rawAuthz.slice(6).trim() : null;
  const bearerValue = authz.startsWith("bearer ") ? rawAuthz.slice(7).trim() : null;
  const barePat = tokenSchemeValue ?? (bearerValue?.startsWith("goc_") ? bearerValue : null);
  if (barePat) {
    const verified = await verifyPat(env, {
      username: route.routeNamespaceSlug,
      plaintext: barePat,
      namespaceId: route.namespaceId,
      repositoryId: route.repositoryId,
      db: options.db,
    });
    if (verified.ok) return { kind: "pat", verified };
    return { kind: "pat-rejected", reason: verified.reason };
  }
  // Bearer lane: OAuth access tokens issued by our own authorization
  // server. A present-but-invalid Bearer is a rejection, not a fallthrough
  // to anonymous — the client clearly attempted authentication.
  if (authz.startsWith("bearer ")) {
    const principal = await resolveOAuthBearer(env, request, {
      enforceDpop: options.enforceDpop,
    });
    if (!principal) return { kind: "oauth-rejected" };
    const member = options.db
      ? await oauthNamespaceAccess(options.db, principal, route.namespaceId).catch(() => false)
      : false;
    return {
      kind: "oauth",
      verified: { principal, userId: principal.userId, scopes: principal.scopes, member },
    };
  }

  const basic = getBasicCredentials(request);
  if (!basic) return { kind: "anonymous" };
  if (!basic.password) return { kind: "missing-credentials" };
  const verified = await verifyPat(env, {
    username: basic.username,
    plaintext: basic.password,
    namespaceId: route.namespaceId,
    repositoryId: route.repositoryId,
    db: options.db,
  });
  if (verified.ok) return { kind: "pat", verified };
  return { kind: "pat-rejected", reason: verified.reason };
}

// Repo-less identity check for user-scoped API surfaces (`/api/v3/user`):
// validates any recognized credential and returns the userId it maps to,
// without a namespace/repo grant check. Distinguishes `null` (no credentials
// presented — caller may still fall back to session auth) from a Response
// (credentials presented but rejected — the client authenticated badly and
// gets 401, not an anonymous fallback).
export async function authenticateIdentity(
  env: Env,
  request: Request,
  options: { db?: Db } = {}
): Promise<{ userId: string; lastUsedAt: number | null; patId?: string } | null | Response> {
  const authz = request.headers.get("Authorization")?.toLowerCase() ?? "";
  const rawAuthz = request.headers.get("Authorization") ?? "";
  const tokenSchemeValue = authz.startsWith("token ") ? rawAuthz.slice(6).trim() : null;
  const bearerValue = authz.startsWith("bearer ") ? rawAuthz.slice(7).trim() : null;
  const barePat = tokenSchemeValue ?? (bearerValue?.startsWith("goc_") ? bearerValue : null);
  if (barePat) {
    const verified: PatIdentityOk | null = await verifyPatIdentity(env, {
      plaintext: barePat,
      db: options.db,
    });
    if (verified)
      return { userId: verified.userId, lastUsedAt: verified.lastUsedAt, patId: verified.patId };
    return new Response(JSON.stringify({ message: "Bad credentials", error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (authz.startsWith("bearer ")) {
    const principal = await resolveOAuthBearer(env, request);
    if (!principal) {
      return new Response(JSON.stringify({ message: "Bad credentials", error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return { userId: principal.userId, lastUsedAt: null };
  }
  const basic = getBasicCredentials(request);
  if (!basic) return null;
  if (!basic.password) {
    return new Response(JSON.stringify({ message: "Bad credentials", error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const verified = await verifyPatIdentity(env, { plaintext: basic.password, db: options.db });
  if (verified) {
    return { userId: verified.userId, lastUsedAt: verified.lastUsedAt, patId: verified.patId };
  }
  return new Response(JSON.stringify({ message: "Bad credentials", error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

// Returns true when the update was scheduled so tests can assert the
// throttle decision without leaning on D1.
export function scheduleTouchPatLastUsedAt(
  env: Env,
  ctx: ExecutionContext,
  verified: PatVerifyOk,
  op: PatLastUsedOp,
  now: number = Date.now(),
  options: { db?: Db; log?: Logger } = {}
): boolean {
  if (!shouldTouchPatLastUsedAt(verified.lastUsedAt, op, now)) return false;
  const log = options.log ?? createLogger(env.LOG_LEVEL, { service: "GitAuth" });
  const db = options.db ?? createDb(env.DB);
  ctx.waitUntil(
    (async () => {
      try {
        await updatePatLastUsedAt(db, verified.patId, now);
        log.debug("pat:last-used-update-ok", { patId: verified.patId, op });
      } catch (error) {
        log.warn("pat:last-used-update-failed", {
          patId: verified.patId,
          op,
          error: String(error),
        });
      }
    })()
  );
  return true;
}

export { PAT_LAST_USED_READ_THROTTLE_MS };
