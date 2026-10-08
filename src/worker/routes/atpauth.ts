import type { AppContext, AppRouter } from "./hono";

import { newPrefixedId } from "@/worker/common";
import { consumeChallenge, issueChallenge } from "@/worker/agent/atpauth/challenge";
import { resolveDid, resolveHandle } from "@/worker/agent/atpauth/pds";
import { signDidSession, signHs256Jwt, verifyDidSession } from "@/worker/agent/atpauth/jwt";
import { canonicalJson, utf8, verifyKeySignature } from "@/worker/agent/atpauth/verify";
import { completeOAuth, startOAuth } from "@/worker/agent/atpauth/oauth";
import { decodeKeyMultibase } from "@/worker/agent/atpauth/didkey";
import { verifyServiceAuth } from "@/worker/agent/atpauth/serviceAuth";
import { computeJwkThumbprint } from "@/vendor/widespread/auth/dpop";
import {
  clearDidSessionCookie,
  getDidSessionCookie,
  setDidSessionCookie,
} from "@/worker/auth/cookies";
import { loadSessionConfig, loadViewer } from "@/worker/auth/session";
import {
  claimNamespace,
  ensureIdentity,
  findIdentityByDid,
  findIdentityByHandle,
  findMembership,
  findNamespaceBySlug,
  findRepositoryByNamespaceAndSlug,
  insertDidSession,
  insertMembershipIfMissing,
  insertRepositoryIfNew,
  listRepositoriesForUser,
  revokeDidSession,
  updateIdentityDeviceKeys,
} from "@/worker/db/d1/dal";
import { namespaces } from "@/worker/db/d1/schema/namespaces";
import { eq } from "drizzle-orm";
import { repoDidFor } from "@/worker/agent/dids";
import { LIMITS, metric, rateLimit } from "@/worker/agent/abuse";
import { sameOriginViolation } from "@/worker/auth/origin";
import { enqueueRouteCacheSync } from "./authShared";
import { validateSlugForRoute } from "@/shared/slugs";
import { generateNamespaceId } from "@/worker/auth/session";

// atproto DID auth routes — the front door for human sign-in.
//
//   GET  /auth/oauth/start?handle         → PAR → redirect to the PDS OAuth UI
//   GET  /auth/oauth/callback?code&state  → token exchange → dg_session → /auth/account
//   GET  /client-metadata.json            → atproto OAuth client metadata (client_id doc)
//   GET  /auth/did/challenge?did|handle   → nonce + canonical payload
//   POST /auth/did/verify                 → verify sig → httpOnly dg_session
//   POST /auth/atp/verify                 → serviceAuth JWT → DPoP-bound dg_session
//                                          (browser-native lane: OAuth tokens never transit)
//   POST /auth/did/logout                 → revoke jti, clear cookie
//   GET  /auth/did/session                → current identity
//   POST /auth/did/keys                   → bind/revoke device keys (audit-trailed)
//   POST /api/repos                       → one-call namespace+repo creation
//
// DID sessions bridge into `users` rows (tessera_sub = did), so PATs,
// namespace membership, and private-repo ACL all work unchanged.

const SESSION_TTL_SEC = 60 * 60 * 24; // 24h; did_sessions row is revocation authority

function bad(c: AppContext, reason: string, status = 400): Response {
  return c.json({ error: reason } as never, status as never);
}

async function rateGate(
  c: AppContext,
  spec: (typeof LIMITS)[keyof typeof LIMITS],
  key: string
): Promise<Response | null> {
  const result = await rateLimit(c.env, spec, key);
  if (result.ok) return null;
  metric(c.env, "rate.limited", { scope: spec.bucket, index: key.slice(0, 32) });
  return c.json(
    { error: "rate-limited", retry_after: result.retryAfterSec } as never,
    429 as never
  );
}

/** Client IP bucket for unauthenticated rate limits (not an identity). */
function callerKey(c: AppContext): string {
  return (c.req.header("cf-connecting-ip") ?? "anon").slice(0, 45);
}

/**
 * Shared post-identity step for every sign-in path (challenge verify, OAuth
 * callback): upsert the identity/user bridge, bootstrap the caller's
 * namespace, and issue the dg_session cookie. Returns the namespace slug.
 *
 * `dpopJwk` (client-side OAuth lane only) binds the session to the browser's
 * custody-worker DPoP key — every subsequent request must carry a proof from
 * that key (see readActiveSession's sessdpop check). The private key never
 * leaves the browser; only the public JWK's thumbprint is stored.
 */
async function establishDidSession(
  c: AppContext,
  did: string,
  handle: string | undefined,
  dpopJwk?: { kty: string; x: string; y: string }
): Promise<{ namespaceSlug: string | undefined } | Response> {
  const config = loadSessionConfig(c.env);
  if (!config.ok) return bad(c, "session-unavailable", 500);

  const identity = await ensureIdentity(c.var.db, { did, handle });

  // Namespace bootstrap: first-label of the handle, else a did-derived
  // slug. Race-safe via claimNamespace's ON CONFLICT.
  let namespaceSlug: string | undefined;
  const candidate = handle
    ? handle
        .split(".")[0]
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
    : undefined;
  const slug = candidate && candidate.length >= 2 ? candidate : `u-${did.slice(-8).toLowerCase()}`;
  const existing = await findNamespaceBySlug(c.var.db, slug);
  if (!existing) {
    const nsId = generateNamespaceId();
    const claimed = await claimNamespace(c.var.db, {
      id: nsId,
      slug,
      createdBy: identity.userId,
      ownerDid: did,
      createdAt: Date.now(),
    });
    const ns = claimed ?? (await findNamespaceBySlug(c.var.db, slug));
    if (ns) {
      await insertMembershipIfMissing(c.var.db, {
        namespaceId: ns.id,
        userId: identity.userId,
        createdAt: Date.now(),
      });
      await c.var.db.update(namespaces).set({ ownerDid: did }).where(eq(namespaces.id, ns.id));
      namespaceSlug = ns.slug;
    }
  } else if (existing.ownerDid === did) {
    // Re-join membership if the DID already owns this namespace.
    await insertMembershipIfMissing(c.var.db, {
      namespaceId: existing.id,
      userId: identity.userId,
      createdAt: Date.now(),
    });
    namespaceSlug = existing.slug;
  }

  const jti = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  await insertDidSession(c.var.db, {
    jti,
    did,
    expiresAt: Date.now() + SESSION_TTL_SEC * 1000,
  });
  if (dpopJwk) {
    // sessdpop:{jti} → expected JWK thumbprint. Session lifetime bound; the
    // KV entry expires with the session so stale bindings never linger.
    const jkt = await computeJwkThumbprint(dpopJwk);
    await c.env.ROUTES.put(`sessdpop:${jti}`, jkt, {
      expirationTtl: SESSION_TTL_SEC,
    });
  }
  const token = await signDidSession(config.secret, {
    sub: did,
    handle,
    jti,
    iat,
    exp: iat + SESSION_TTL_SEC,
  });
  setDidSessionCookie(c, token);
  return { namespaceSlug };
}

export function registerAtpAuthRoutes(router: AppRouter): void {
  // --- challenge ------------------------------------------------------------
  // Returns a nonce and the exact canonical-JSON payload the client must
  // sign. Nonces are single-use (KV consume) with a 5-minute TTL.

  router.get("/auth/did/challenge", async (c) => {
    const limited = await rateGate(c, LIMITS.authChallenge, callerKey(c));
    if (limited) return limited;

    let did = c.req.query("did")?.trim();
    // Handles are domains (alice.bsky.social). Forgive the common shorthand:
    // a bare word gets the default bsky.social TLD; a leading @ is stripped.
    const rawHandle = c.req.query("handle")?.trim().toLowerCase().replace(/^@/, "");
    const handle = rawHandle && !rawHandle.includes(".") ? `${rawHandle}.bsky.social` : rawHandle;
    if (!did && handle) {
      did = await resolveHandle(c.env, handle);
      if (!did) return bad(c, `handle "${handle}" did not resolve`, 404);
    }
    if (!did || !/^did:(plc|web|key|dg):[a-zA-Z0-9._:%-]+$/.test(did)) {
      return bad(c, "did-or-handle-required");
    }

    const { nonce } = await issueChallenge(c.env.ROUTES);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 300;
    const payload = canonicalJson({ did, exp, iat, nonce });
    metric(c.env, "auth.did", { scope: "challenge", index: did });
    return c.json({ did, nonce, payload, iat, exp });
  });

  // --- verify -----------------------------------------------------------------

  router.post("/auth/did/verify", async (c) => {
    const limited = await rateGate(c, LIMITS.authVerify, callerKey(c));
    if (limited) return limited;

    const config = loadSessionConfig(c.env);
    if (!config.ok) return bad(c, "session-unavailable", 500);

    const parsed = await c.req
      .json<{
        did?: string;
        nonce?: string;
        sig?: string;
        iat?: number;
        exp?: number;
        key_multibase?: string;
      }>()
      .catch(() => null);
    if (!parsed?.did || !parsed.nonce || !parsed.sig || !parsed.iat || !parsed.exp) {
      return bad(c, "did+nonce+sig+iat+exp required");
    }
    if (parsed.exp * 1000 < Date.now() || parsed.exp - parsed.iat > 600) {
      return bad(c, "challenge-expired");
    }
    if (!(await consumeChallenge(c.env.ROUTES, parsed.nonce))) {
      metric(c.env, "auth.did", { scope: "nonce-replay", index: parsed.did });
      return bad(c, "nonce-consumed", 401);
    }

    const resolved = await resolveDid(c.env, parsed.did);
    if (!resolved || resolved.keys.length === 0) return bad(c, "did-unresolved", 404);

    const data = utf8(
      canonicalJson({
        did: parsed.did,
        exp: parsed.exp,
        iat: parsed.iat,
        nonce: parsed.nonce,
      })
    );
    let sigBytes: Uint8Array | undefined;
    try {
      const b64 = parsed.sig.replace(/-/g, "+").replace(/_/g, "/");
      sigBytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    } catch {
      return bad(c, "bad-sig-encoding");
    }

    // If the client names a key, verify against exactly that DID-document
    // key; otherwise try all declared keys (did:key has exactly one).
    let verified = false;
    if (parsed.key_multibase) {
      const claimed = decodeKeyMultibase(parsed.key_multibase);
      const match = resolved.keys.find(
        (k) =>
          claimed && k.curve === claimed.curve && k.pubkey.every((b, i) => b === claimed.pubkey[i])
      );
      if (match) verified = await verifyKeySignature(match, sigBytes, data);
    } else {
      for (const key of resolved.keys) {
        if (await verifyKeySignature(key, sigBytes, data)) {
          verified = true;
          break;
        }
      }
    }
    if (!verified) {
      metric(c.env, "auth.did", { scope: "verify-failed", index: parsed.did });
      return bad(c, "signature-invalid", 401);
    }

    const established = await establishDidSession(c, parsed.did, resolved.handle);
    if (established instanceof Response) return established;
    metric(c.env, "auth.did", { scope: "verified", index: parsed.did });
    return c.json({
      did: parsed.did,
      handle: resolved.handle ?? null,
      namespace: established.namespaceSlug ?? null,
      session_expires_at: Date.now() + SESSION_TTL_SEC * 1000,
    });
  });

  // --- atproto OAuth (browser sign-in) -----------------------------------------
  // Public-client OAuth: PAR + PKCE + DPoP, no client secret. The state KV
  // entry holds the PKCE verifier + DPoP key until the callback consumes it.

  router.get("/client-metadata.json", async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      client_id: `${origin}/client-metadata.json`,
      client_name: "delta-git",
      client_uri: origin,
      // /oauth/callback first: @atproto/oauth-client-browser defaults to
      // redirect_uris[0] — the SPA callback. The server lane builds
      // /auth/oauth/callback explicitly, so ordering is safe there.
      redirect_uris: [`${origin}/oauth/callback`, `${origin}/auth/oauth/callback`],
      // `atproto` alone can't mint service-auth JWTs — the client-side lane
      // needs rpc:* scoped to this deployment's service ref so the PDS's
      // assertRpc({aud, lxm:*}) check inside getServiceAuth passes.
      scope: `atproto rpc:*?aud=did:web:${new URL(c.req.url).hostname}#delta_git`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    });
  });

  // Cross-app SSO handoffs: `return_to` must land on an allowlisted host
  // (ALLOWED_RETURN_HOSTS). Only its hostname is trusted — the callback
  // appends `?dg_token=` after the session is established.
  function allowedReturnTo(env: Env, raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
      const u = new URL(raw);
      const loopback = ["localhost", "127.0.0.1"].includes(u.hostname);
      if (u.protocol !== "https:" && !loopback) return undefined;
      const hosts = (env.ALLOWED_RETURN_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      return hosts.includes(u.hostname) ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  router.get("/auth/oauth/start", async (c) => {
    const limited = await rateGate(c, LIMITS.authChallenge, callerKey(c));
    if (limited) return limited;

    const rawHandle = c.req.query("handle")?.trim().toLowerCase().replace(/^@/, "");
    const handle = rawHandle
      ? rawHandle.includes(".")
        ? rawHandle
        : `${rawHandle}.bsky.social`
      : undefined;
    const returnTo = allowedReturnTo(c.env, c.req.query("return_to"));
    if (c.req.query("return_to") && !returnTo) {
      metric(c.env, "auth.did", { scope: "oauth-return-to-rejected", index: "none" });
      return c.redirect(`/auth?error=bad_return_to`);
    }
    const result = await startOAuth({
      env: c.env,
      kv: c.env.ROUTES,
      origin: new URL(c.req.url).origin,
      handle,
      returnTo,
    });
    if (!result.ok) {
      metric(c.env, "auth.did", { scope: "oauth-start-failed", index: result.error });
      return c.redirect(`/auth?error=oauth_start`);
    }
    metric(c.env, "auth.did", { scope: "oauth-start", index: handle ?? "none" });
    return c.redirect(result.redirectUrl);
  });

  router.get("/auth/oauth/callback", async (c) => {
    const origin = new URL(c.req.url).origin;
    const result = await completeOAuth({
      env: c.env,
      kv: c.env.ROUTES,
      origin,
      params: new URL(c.req.url).searchParams,
    });
    if (!result.ok) {
      metric(c.env, "auth.did", { scope: "oauth-token-failed", index: result.error });
      // OAuthCallbackError invalid_request covers missing params, unknown
      // state, and issuer mismatch — the codes this route surfaced before.
      const code = result.error === "oauth-invalid_request" ? "invalid_request" : "oauth_token";
      return c.redirect(`/auth?error=${code}`);
    }
    const resolved = await resolveDid(c.env, result.did);
    const established = await establishDidSession(c, result.did, resolved?.handle);
    if (established instanceof Response) {
      return c.redirect(`/auth?error=session_create_failed`);
    }
    metric(c.env, "auth.did", { scope: "oauth-verified", index: result.did });

    // SSO handoff: the start request carried an allowlisted return_to — issue
    // a short-lived dg_token (aud="wpcloud", signed with the shared
    // DG_SESSION_SECRET) and bounce the browser to the app's callback.
    if (result.returnTo) {
      if (!c.env.DG_SESSION_SECRET) {
        return c.redirect(`/auth?error=sso_unconfigured`);
      }
      const iat = Math.floor(Date.now() / 1000);
      const dgToken = await signHs256Jwt(c.env.DG_SESSION_SECRET, {
        iss: origin,
        aud: "wpcloud",
        sub: result.did,
        iat,
        exp: iat + 300,
      });
      const sep = result.returnTo.includes("?") ? "&" : "?";
      metric(c.env, "auth.did", { scope: "oauth-sso-handoff", index: result.did });
      return c.redirect(`${result.returnTo}${sep}dg_token=${dgToken}`);
    }
    return c.redirect("/");
  });

  // --- client-side OAuth lane ---------------------------------------------------
  // POST /auth/atp/verify { did, jwt, dpop_jwk? }
  //
  // Browser-native sign-in: @atproto/oauth-client-browser runs the whole
  // PAR/PKCE/DPoP flow client-side (tokens stay in browser IndexedDB, never
  // transit delta-git). The browser then asks its own PDS for a service-auth
  // JWT proving DID control and submits it here. The resulting dg_session is
  // bound to the client's custody-worker DPoP key — cookie theft alone can
  // never mint proofs, so the session is non-transferable.

  router.post("/auth/atp/verify", async (c) => {
    const limited = await rateGate(c, LIMITS.authVerify, callerKey(c));
    if (limited) return limited;

    const parsed = await c.req
      .json<{
        did?: string;
        jwt?: string;
        dpop_jwk?: { kty?: string; crv?: string; x?: string; y?: string };
      }>()
      .catch(() => null);
    if (!parsed?.did || !parsed.jwt) return bad(c, "did+jwt required");

    // Audience binds to this deployment's service identifier.
    const expectedAud = `did:web:${new URL(c.req.url).host}`;
    const verified = await verifyServiceAuth(c.env, parsed.did, parsed.jwt, expectedAud);
    if (!verified) {
      metric(c.env, "auth.did", { scope: "serviceauth-failed", index: parsed.did });
      return bad(c, "service-auth-invalid", 401);
    }

    const jwk =
      parsed.dpop_jwk?.kty === "EC" &&
      parsed.dpop_jwk.crv === "P-256" &&
      parsed.dpop_jwk.x &&
      parsed.dpop_jwk.y
        ? { kty: parsed.dpop_jwk.kty, x: parsed.dpop_jwk.x, y: parsed.dpop_jwk.y }
        : undefined;

    const established = await establishDidSession(c, verified.did, verified.handle, jwk);
    if (established instanceof Response) return established;
    metric(c.env, "auth.did", { scope: "serviceauth-verified", index: verified.did });
    return c.json({
      did: verified.did,
      handle: verified.handle ?? null,
      namespace: established.namespaceSlug ?? null,
      dpop_bound: Boolean(jwk),
      session_expires_at: Date.now() + SESSION_TTL_SEC * 1000,
    });
  });

  // --- logout / session -------------------------------------------------------

  router.post("/auth/did/logout", async (c) => {
    const violation = sameOriginViolation(c);
    if (violation) return violation;
    const config = loadSessionConfig(c.env);
    const token = getDidSessionCookie(c);
    if (config.ok && token) {
      const claims = await verifyDidSession(config.secret, token);
      if (claims) await revokeDidSession(c.var.db, claims.jti);
    }
    clearDidSessionCookie(c);
    return c.json({ ok: true });
  });

  router.get("/auth/did/session", async (c) => {
    const config = loadSessionConfig(c.env);
    const token = getDidSessionCookie(c);
    if (!config.ok || !token) return bad(c, "no-session", 401);
    const claims = await verifyDidSession(config.secret, token);
    if (!claims) return bad(c, "no-session", 401);
    return c.json({ did: claims.sub, handle: claims.handle ?? null, exp: claims.exp });
  });

  // --- device key rotation ------------------------------------------------------
  // POST /auth/did/keys { action: "bind"|"revoke", key: "<multibase>" }
  // Session-gated: the DID session itself authorizes rotation (the atproto
  // pattern — the PDS key stays offline, device keys do day-to-day work).
  // `identities.device_keys` is a JSON audit log — revocations are recorded
  // with revokedAt, never deleted.

  router.post("/auth/did/keys", async (c) => {
    const violation = sameOriginViolation(c);
    if (violation) return violation;
    const config = loadSessionConfig(c.env);
    const token = getDidSessionCookie(c);
    if (!config.ok || !token) return bad(c, "no-session", 401);
    const claims = await verifyDidSession(config.secret, token);
    if (!claims) return bad(c, "no-session", 401);

    const parsed = await c.req.json<{ action?: string; key?: string }>().catch(() => null);
    if ((parsed?.action !== "bind" && parsed?.action !== "revoke") || !parsed.key) {
      return bad(c, "action+key required");
    }
    const decoded = decodeKeyMultibase(parsed.key);
    if (!decoded) return bad(c, "key-not-multibase");

    const identity = await findIdentityByDid(c.var.db, claims.sub);
    if (!identity) return bad(c, "identity-missing", 404);

    let keys: { key: string; addedAt: number; revokedAt?: number }[];
    try {
      const existing = JSON.parse(identity.deviceKeys);
      keys = Array.isArray(existing) ? existing : [];
    } catch {
      keys = [];
    }
    const now = Date.now();
    const idx = keys.findIndex((k) => k.key === parsed.key && !k.revokedAt);
    if (parsed.action === "bind") {
      if (idx >= 0) return bad(c, "key-already-bound", 409);
      keys.push({ key: parsed.key, addedAt: now });
    } else {
      if (idx < 0) return bad(c, "key-not-found", 404);
      keys[idx] = { ...keys[idx], revokedAt: now };
    }
    await updateIdentityDeviceKeys(c.var.db, claims.sub, JSON.stringify(keys));
    metric(c.env, "auth.did", { scope: `key-${parsed.action}`, index: claims.sub });
    return c.json({ ok: true, keys });
  });

  // --- one-call repo creation ---------------------------------------------------
  // POST /api/repos { slug, visibility?, namespace?, mirrors? }
  // Works for DID sessions and tessera sessions (loadViewer covers both).

  router.post("/api/repos", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return bad(c, "unauthorized", 401);
    const limited = await rateGate(c, LIMITS.repoCreate, viewer.userId);
    if (limited) return limited;

    const parsed = await c.req
      .json<{
        slug?: string;
        repo?: string;
        visibility?: string;
        namespace?: string;
        mirrors?: { name: string; url: string }[];
      }>()
      .catch(() => null);
    const slugRaw = parsed?.slug ?? parsed?.repo;
    const slugCheck = slugRaw ? validateSlugForRoute(slugRaw) : null;
    if (!slugCheck?.ok) return bad(c, "invalid-slug");
    // "internal" repos are member-gated like private ones but pool-eligible:
    // their compute jobs carry the INTERNAL classification (durable+DID-only
    // nodes at the coordinator). "private" (incl. E2E-encrypted) never pools.
    const visibility =
      parsed?.visibility === "private" || parsed?.visibility === "internal"
        ? parsed.visibility
        : "public";
    const mirrors = Array.isArray(parsed?.mirrors)
      ? parsed!
          .mirrors!.filter(
            (m) => typeof m?.name === "string" && typeof m?.url === "string" && m.url.length < 300
          )
          .slice(0, 8)
      : [];

    const db = c.var.db;
    let namespaceSlug = parsed?.namespace;
    let namespace = namespaceSlug ? await findNamespaceBySlug(db, namespaceSlug) : undefined;
    if (!namespace) {
      // Fall back to the caller's primary namespace (first membership).
      const rows = await listRepositoriesForUser(db, viewer.userId);
      const first = rows[0]?.namespace.slug;
      if (first) namespace = await findNamespaceBySlug(db, first);
    }
    if (!namespace) {
      return bad(c, "namespace-not-found", 404);
    }
    const membership = await findMembership(db, namespace.id, viewer.userId);
    if (!membership) return bad(c, "not-member", 403);

    if (await findRepositoryByNamespaceAndSlug(db, namespace.id, slugCheck.slug)) {
      return bad(c, "slug-taken", 409);
    }
    const now = Date.now();
    const repositoryId = newPrefixedId("repo");
    const did = await repoDidFor(namespace.slug, slugCheck.slug);
    const inserted = await insertRepositoryIfNew(db, {
      id: repositoryId,
      namespaceId: namespace.id,
      createdBy: viewer.userId,
      slug: slugCheck.slug,
      doName: `repo:${repositoryId.slice("repo_".length)}`,
      did,
      mirrorTargets: mirrors.length > 0 ? JSON.stringify(mirrors) : null,
      visibility,
      createdAt: now,
      updatedAt: now,
    });
    if (!inserted) return bad(c, "slug-taken", 409);

    const log = c.var.logFor({ service: "RepoCreate" });
    enqueueRouteCacheSync(c, log, {
      repositoryId: inserted.id,
      namespaceSlug: namespace.slug,
      repoSlug: slugCheck.slug,
    });
    metric(c.env, "request", { scope: "repo.create", index: viewer.userId });
    return c.json({
      ok: true,
      id: inserted.id,
      did,
      namespaceSlug: namespace.slug,
      slug: inserted.slug,
      visibility: inserted.visibility,
    });
  });

  router.get("/api/repos/mine", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return bad(c, "unauthorized", 401);
    const rows = await listRepositoriesForUser(c.var.db, viewer.userId);
    return c.json({
      repositories: rows.map((row) => ({
        id: row.repository.id,
        slug: row.repository.slug,
        did: row.repository.did,
        namespaceSlug: row.namespace.slug,
        visibility: row.repository.visibility,
      })),
    });
  });

  // --- handle resolution --------------------------------------------------------
  // GET /api/handles/:handle → {did} — used by clients resolving
  // alice.bsky.social/repo URLs to namespace slugs.

  router.get("/api/handles/:handle", async (c) => {
    const handle = c.req.param("handle").toLowerCase();
    const identity = await findIdentityByHandle(c.var.db, handle);
    if (identity) return c.json({ handle, did: identity.did, namespace: null });
    const did = await resolveHandle(c.env, handle);
    if (!did) return bad(c, "handle-unresolved", 404);
    return c.json({ handle, did, namespace: null });
  });
}
