/**
 * JWT session issuance and verification.
 *
 * Consolidates the duplicate JWT implementations in worker and social-gateway.
 * Uses oslo/jwt (MIT) for JWT creation and validation.
 *
 * The session JWT contains only { did, handle, iss, aud, exp, iat, jti } — no private keys.
 * If dpopJkt is provided, binds the JWT to the DPoP key via cnf.jkt (RFC 9449).
 */
import { createJWT, validateJWT } from "oslo/jwt";
import { TimeSpan } from "oslo";
import { generateRandomString, alphabet } from "oslo/crypto";
import { deriveHkdfKey } from "../crypto/index.js";
import type { ChallengeStore } from "./challenge.js";

const SESSION_TTL = 15 * 60; // 15 minutes — short-lived to limit exposure
const RESUME_TTL = 30 * 24 * 60 * 60; // 30 days — client-held resume ticket
const KEY_VERSION = "v1";

export interface AuthContext {
  did: string;
  handle: string;
  dpopJkt?: string;
}

export interface JwtEnv {
  /** Deployment-specific session secret (WORKER_SESSION_SECRET or GATEWAY_SESSION_SECRET). */
  sessionSecret: string;
  WORKER_URL: string;
  FRONTEND_URL?: string;
  REVOKED_SESSIONS?: ChallengeStore;
}

/**
 * Derive an HMAC-SHA256 key from the session secret via HKDF (Web Crypto API, built-in).
 * Uses @widespread/crypto/deriveHkdfKey for key separation.
 *
 * SECURITY: Each deployment (worker, gateway) uses a SEPARATE session secret.
 * Compromise of one deployment's secret cannot forge sessions for the other.
 */
async function deriveHmacKey(env: JwtEnv, purpose: string): Promise<Uint8Array> {
  return deriveHkdfKey(env.sessionSecret, `rooted-worker-${purpose}`, purpose);
}

/**
 * Issue a session JWT using oslo/jwt (MIT).
 * If dpopJkt is provided, binds the JWT to the DPoP key via cnf.jkt (RFC 9449).
 */
export async function issueSession(
  did: string,
  handle: string,
  env: JwtEnv,
  dpopJkt?: string
): Promise<string> {
  const rawKey = await deriveHmacKey(env, "hmac");

  const payload: Record<string, unknown> = { did, handle };
  if (dpopJkt) {
    payload.cnf = { jkt: dpopJkt };
  }

  return createJWT("HS256", rawKey, payload, {
    expiresIn: new TimeSpan(SESSION_TTL, "s"),
    issuer: env.WORKER_URL,
    audiences: [env.FRONTEND_URL || ""],
    subject: did,
    includeIssuedTimestamp: true,
    jwtId: generateRandomString(32, alphabet("a-z", "A-Z", "0-9")),
    headers: { kid: KEY_VERSION },
  });
}

/**
 * Verify a session JWT using oslo/jwt (MIT).
 * Checks signature, issuer, audience, and revocation list (if configured).
 */
export async function verifySession(token: string, env: JwtEnv): Promise<AuthContext | null> {
  try {
    const rawKey = await deriveHmacKey(env, "hmac");
    const jwt = await validateJWT("HS256", rawKey, token);

    if (jwt.issuer !== env.WORKER_URL) return null;
    const expectedAudience = env.FRONTEND_URL || "";
    if (!jwt.audiences || !jwt.audiences.includes(expectedAudience)) return null;

    const payload = jwt.payload as {
      did?: string;
      handle?: string;
      cnf?: { jkt?: string };
      jti?: string;
    };
    if (typeof payload.did !== "string" || typeof payload.handle !== "string") return null;

    // Check revocation list — if the JWT's jti is in KV, the session was revoked
    if (payload.jti && env.REVOKED_SESSIONS) {
      const revoked = await env.REVOKED_SESSIONS.get(`revoked:${payload.jti}`);
      if (revoked) return null;
    }

    return { did: payload.did, handle: payload.handle, dpopJkt: payload.cnf?.jkt };
  } catch {
    return null;
  }
}

/** Revoke a session by adding its jti to the KV blocklist (TTL = session TTL). */
export async function revokeSession(
  jti: string,
  env: JwtEnv,
  ttlSeconds = SESSION_TTL
): Promise<void> {
  if (!env.REVOKED_SESSIONS || !jti) return;
  await env.REVOKED_SESSIONS.put(`revoked:${jti}`, "1", { expirationTtl: ttlSeconds });
}

// ─── Resume tickets ─────────────────────────────────────────────────────────
// A long-lived, DPoP-bound ticket returned alongside the session JWT. The
// client stores it (device-bound custody) and presents it + a fresh DPoP
// proof to mint a new session — silent resume for every sign-in provider.
// A stolen ticket is inert: cnf.jkt binds it to a non-extractable key that
// never leaves the device. Tickets are single-use (rotated on redeem).

export interface ResumeTicket {
  did: string;
  handle: string;
  dpopJkt: string;
  jti?: string;
}

/**
 * Issue a resume ticket — a separate HMAC purpose ('resume') so a ticket can
 * never be presented where a session JWT is expected.
 */
export async function issueResumeTicket(
  did: string,
  handle: string,
  env: JwtEnv,
  dpopJkt: string
): Promise<string> {
  const rawKey = await deriveHmacKey(env, "resume");
  return createJWT(
    "HS256",
    rawKey,
    { did, handle, scope: "resume", cnf: { jkt: dpopJkt } },
    {
      expiresIn: new TimeSpan(RESUME_TTL, "s"),
      issuer: env.WORKER_URL,
      audiences: [env.FRONTEND_URL || ""],
      subject: did,
      includeIssuedTimestamp: true,
      jwtId: generateRandomString(32, alphabet("a-z", "A-Z", "0-9")),
      headers: { kid: KEY_VERSION },
    }
  );
}

/** Verify a resume ticket: signature, issuer, audience, scope, revocation. */
export async function verifyResumeTicket(token: string, env: JwtEnv): Promise<ResumeTicket | null> {
  try {
    const rawKey = await deriveHmacKey(env, "resume");
    const jwt = await validateJWT("HS256", rawKey, token);

    if (jwt.issuer !== env.WORKER_URL) return null;
    const expectedAudience = env.FRONTEND_URL || "";
    if (!jwt.audiences || !jwt.audiences.includes(expectedAudience)) return null;

    const payload = jwt.payload as {
      did?: string;
      handle?: string;
      scope?: string;
      cnf?: { jkt?: string };
      jti?: string;
    };
    if (payload.scope !== "resume") return null;
    if (typeof payload.did !== "string" || typeof payload.handle !== "string") return null;
    if (typeof payload.cnf?.jkt !== "string") return null;

    if (payload.jti && env.REVOKED_SESSIONS) {
      const revoked = await env.REVOKED_SESSIONS.get(`revoked:${payload.jti}`);
      if (revoked) return null;
    }

    return { did: payload.did, handle: payload.handle, dpopJkt: payload.cnf.jkt, jti: payload.jti };
  } catch {
    return null;
  }
}

export { SESSION_TTL, RESUME_TTL };
