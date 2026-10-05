// E2E substrate for encrypted private repos.
//
// Three stores, all opaque to the server:
//  - `wrapkey:{userId}` -> member's P-256 ECDH wrap pubkey (JWK). Public by
//    design — it can only ever wrap, never unwrap.
//  - `repokey:{doName}:{userId}` -> that member's wrapped copy of the repo
//    AES key. The server stores the ciphertext; only the member's custody
//    worker can unwrap it.
//  - R2 `do/{doId}/enc/{chunk}` -> encrypted repo content (ref manifests,
//    pack chunks) for `encrypted=1` repos. Smart-HTTP object endpoints are
//    refused for these repos; this surface is their only data plane.
//
// All crypto happens client-side (custody worker): the server never sees a
// plaintext key, object, or ref name.

import { createLogger } from "@/worker/common";
import { doPrefix } from "@/worker/keys";
import { loadViewer } from "@/worker/auth/session";
import { findUserById } from "@/worker/db/d1/dal/users";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import type { AppRouter } from "@/worker/routes/hono";

import { gErr, gNotFound, resolveGitnessRepo, requireWriter, type GitnessContext } from "./shared";

const MAX_WRAPKEY_BYTES = 4096;
const MAX_WRAPPED_KEY_CHARS = 16384;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

function wrapKeyKvKey(userId: string): string {
  return `wrapkey:${userId}`;
}

function repoKeyKvKey(doName: string, userId: string): string {
  return `repokey:${doName}:${userId}`;
}

export interface RepoKeyRecord {
  wrapped: string;
  wrapped_by: string;
  created: number;
  updated: number;
}

function encR2Key(doId: string, chunk: string): string {
  return `${doPrefix(doId)}/enc/${chunk}`;
}

/** Only P-256 JWKs are valid wrap targets — matches the custody worker's
 *  non-extractable ECDH key. */
function isValidWrapJwk(jwk: unknown): jwk is JsonWebKey {
  const j = jwk as JsonWebKey | null;
  return (
    !!j && j.kty === "EC" && j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string"
  );
}

/** The :uid param accepts either the internal user id or the member's
 *  namespace slug (what UIs display). Returns the user id or null. */
async function resolveMemberParam(c: GitnessContext, uid: string): Promise<string | null> {
  const direct = await findUserById(c.var.db, uid);
  if (direct) return direct.id;
  const ns = await findNamespaceBySlug(c.var.db, uid);
  return ns?.createdBy ?? null;
}

function readRepoKeyBody(body: unknown): string | null {
  const b = body as { wrapped?: unknown } | null;
  if (typeof b?.wrapped !== "string" || !b.wrapped || b.wrapped.length > MAX_WRAPPED_KEY_CHARS) {
    return null;
  }
  return b.wrapped;
}

/** E2E repos only: refuse the opaque-chunk surface on non-encrypted repos
 *  so the surface can't quietly become a second blob store for plaintext. */
function notEncrypted(c: GitnessContext, encrypted: boolean): Response | null {
  return encrypted ? null : gErr(c, 400, "repo is not encrypted");
}

export function registerGitnessRepoKeys(router: AppRouter): void {
  const log = createLogger("info", { service: "GitnessRepoKeys" });

  // --- member wrap pubkeys -------------------------------------------------

  router.put("/api/v1/user/wrapkey", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => null)) as { jwk?: JsonWebKey } | null;
    if (!isValidWrapJwk(body?.jwk)) return gErr(c, 400, "P-256 ECDH JWK required");
    if (JSON.stringify(body.jwk).length > MAX_WRAPKEY_BYTES) return gErr(c, 400, "jwk too large");
    await c.env.ROUTES.put(wrapKeyKvKey(viewer.userId), JSON.stringify(body.jwk));
    return c.json({ ok: true });
  });

  router.get("/api/v1/user/wrapkey", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const raw = await c.env.ROUTES.get(wrapKeyKvKey(viewer.userId));
    if (!raw) return gNotFound(c, "wrapkey");
    return c.json({ jwk: JSON.parse(raw) as JsonWebKey });
  });

  // Any member's wrap pubkey — needed to produce their wrapped repo-key copy.
  // Pubkeys are not sensitive; the uid resolves either the user id or the
  // member's namespace slug.
  router.get("/api/v1/users/:uid/wrapkey", async (c) => {
    const userId = await resolveMemberParam(c, c.req.param("uid"));
    if (!userId) return gNotFound(c, "user");
    const raw = await c.env.ROUTES.get(wrapKeyKvKey(userId));
    if (!raw) return gNotFound(c, "wrapkey");
    return c.json({ jwk: JSON.parse(raw) as JsonWebKey });
  });

  // --- per-member repo keys ------------------------------------------------
  // Reads need repo access; writes need writer — a member who can already
  // unwrap the key produces the wrapped blobs for everyone else.

  router.get("/api/v1/repos/:repo_ref{.+}/keys", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const prefix = repoKeyKvKey(access.route.doName, "");
    const listed = await c.env.ROUTES.list({ prefix });
    const members = await Promise.all(
      listed.keys.map(async (k) => {
        const raw = await c.env.ROUTES.get(k.name);
        const rec = raw ? (JSON.parse(raw) as RepoKeyRecord) : null;
        return {
          user_id: k.name.slice(prefix.length),
          wrapped_by: rec?.wrapped_by ?? null,
          created: rec?.created ?? 0,
          updated: rec?.updated ?? 0,
        };
      })
    );
    return c.json(members);
  });

  router.get("/api/v1/repos/:repo_ref{.+}/keys/me", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const raw = await c.env.ROUTES.get(repoKeyKvKey(access.route.doName, access.viewer.userId));
    if (!raw) return gNotFound(c, "repokey");
    return c.json(JSON.parse(raw) as RepoKeyRecord);
  });

  router.put("/api/v1/repos/:repo_ref{.+}/keys/me", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const wrapped = readRepoKeyBody(await c.req.json().catch(() => null));
    if (!wrapped) return gErr(c, 400, "wrapped required");
    const uid = gate.viewer?.userId;
    if (!uid) return gErr(c, 401, "unauthorized");
    const kv = repoKeyKvKey(gate.route.doName, uid);
    const now = Date.now();
    const existing = await c.env.ROUTES.get(kv);
    const prior = existing ? (JSON.parse(existing) as RepoKeyRecord) : null;
    const rec: RepoKeyRecord = {
      wrapped,
      wrapped_by: gate.actor,
      created: prior?.created ?? now,
      updated: now,
    };
    await c.env.ROUTES.put(kv, JSON.stringify(rec));
    log.info("repokey:self-stored", { doName: gate.route.doName, actor: gate.actor });
    return c.json(rec);
  });

  router.put("/api/v1/repos/:repo_ref{.+}/keys/:uid", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const userId = await resolveMemberParam(c, c.req.param("uid"));
    if (!userId) return gNotFound(c, "user");
    const wrapped = readRepoKeyBody(await c.req.json().catch(() => null));
    if (!wrapped) return gErr(c, 400, "wrapped required");
    const kv = repoKeyKvKey(gate.route.doName, userId);
    const now = Date.now();
    const existing = await c.env.ROUTES.get(kv);
    const prior = existing ? (JSON.parse(existing) as RepoKeyRecord) : null;
    const rec: RepoKeyRecord = {
      wrapped,
      wrapped_by: gate.actor,
      created: prior?.created ?? now,
      updated: now,
    };
    await c.env.ROUTES.put(kv, JSON.stringify(rec));
    log.info("repokey:member-stored", {
      doName: gate.route.doName,
      actor: gate.actor,
      member: c.req.param("uid"),
    });
    return c.json(rec);
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/keys/:uid", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const userId = await resolveMemberParam(c, c.req.param("uid"));
    if (!userId) return gNotFound(c, "user");
    await c.env.ROUTES.delete(repoKeyKvKey(gate.route.doName, userId));
    log.info("repokey:member-revoked", {
      doName: gate.route.doName,
      actor: gate.actor,
      member: c.req.param("uid"),
    });
    return c.json({});
  });

  // --- opaque encrypted chunks --------------------------------------------
  // The data plane for `encrypted=1` repos: ciphertext chunk blobs in R2
  // under `do/{doId}/enc/`. Repo access gates reads; writers push chunks.

  router.get("/api/v1/repos/:repo_ref{.+}/objects", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const enc = notEncrypted(c, access.route.encrypted);
    if (enc) return enc;
    const doId = c.env.REPO_DO.idFromName(access.route.doName).toString();
    const prefix = `${doPrefix(doId)}/enc/`;
    const chunks = await c.env.REPO_BUCKET.list({ prefix, limit: 1000 });
    return c.json(chunks.objects.map((o) => ({ key: o.key.slice(prefix.length), size: o.size })));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/objects/:chunk{.+}", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const enc = notEncrypted(c, access.route.encrypted);
    if (enc) return enc;
    const doId = c.env.REPO_DO.idFromName(access.route.doName).toString();
    const obj = await c.env.REPO_BUCKET.get(encR2Key(doId, c.req.param("chunk")));
    if (!obj) return gNotFound(c, "chunk");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(obj.size),
        "Cache-Control": "no-store",
      },
    });
  });

  router.put("/api/v1/repos/:repo_ref{.+}/objects/:chunk{.+}", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const enc = notEncrypted(c, gate.route.encrypted);
    if (enc) return enc;
    const chunk = c.req.param("chunk");
    if (!chunk || chunk.includes("..") || chunk.startsWith("/"))
      return gErr(c, 400, "bad chunk key");
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (len > MAX_CHUNK_BYTES) return gErr(c, 413, "chunk too large");
    if (!c.req.raw.body) return gErr(c, 400, "body required");
    const doId = c.env.REPO_DO.idFromName(gate.route.doName).toString();
    await c.env.REPO_BUCKET.put(encR2Key(doId, chunk), c.req.raw.body);
    log.info("enc:chunk-put", { doName: gate.route.doName, chunk, bytes: len });
    return c.json({ key: chunk, size: len });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/objects/:chunk{.+}", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const enc = notEncrypted(c, gate.route.encrypted);
    if (enc) return enc;
    const doId = c.env.REPO_DO.idFromName(gate.route.doName).toString();
    await c.env.REPO_BUCKET.delete(encR2Key(doId, c.req.param("chunk")));
    return c.json({});
  });
}
