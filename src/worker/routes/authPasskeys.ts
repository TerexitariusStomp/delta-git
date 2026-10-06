import type { AppContext, AppRouter } from "./hono";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

import { json, newPrefixedId } from "@/worker/common";
import { createLogger } from "@/worker/common/logger";
import { createSessionForUser, loadViewer } from "@/worker/auth/session";
import { findUserById } from "@/worker/db/d1/dal/users";
import { insertSecurityEvent } from "@/worker/db/d1/dal/securityEvents";
import {
  deletePasskey,
  findPasskeyByCredential,
  insertPasskey,
  listPasskeys,
  updatePasskeyCounter,
} from "@/worker/db/d1/dal/passkeys";

// WebAuthn passkeys — GitHub's passwordless sign-in lane. Registration is
// session-gated; login is a discoverable-credential ceremony that mints the
// same sealed session cookie OIDC sign-in produces.
//
// Challenges live in ROUTES KV under `pkchal:<challenge>` with a 5-minute
// TTL and are consumed exactly once. The verify endpoints recover the
// challenge from the ceremony's own clientDataJSON so the KV key is the
// challenge itself — a replayed clientData resolves to a deleted key.

const CHALLENGE_TTL_SEC = 300;
const RP_NAME = "delta-git";

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (input: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// The ceremony carries the challenge inside clientDataJSON — decode it to
// find (and consume) the KV record we issued.
function clientChallenge(clientDataJSON: string): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(clientDataJSON)));
    return typeof parsed.challenge === "string" ? parsed.challenge : undefined;
  } catch {
    return undefined;
  }
}

async function issuePasskeyChallenge(
  c: AppContext,
  payload: { kind: "register"; userId: string } | { kind: "login" },
  challenge: string
): Promise<void> {
  await c.env.ROUTES.put(`pkchal:${challenge}`, JSON.stringify(payload), {
    expirationTtl: CHALLENGE_TTL_SEC,
  });
}

async function consumePasskeyChallenge(
  c: AppContext,
  challenge: string
): Promise<{ kind: "register"; userId: string } | { kind: "login" } | null> {
  const key = `pkchal:${challenge}`;
  const raw = await c.env.ROUTES.get(key);
  if (raw === null) return null;
  await c.env.ROUTES.delete(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rpAndOrigin(c: AppContext): { rpID: string; origin: string } {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

function keyView(row: {
  id: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}) {
  return {
    id: row.id,
    name: row.name,
    created_at: new Date(row.createdAt).toISOString(),
    last_used_at: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  };
}

export function registerAuthPasskeyRoutes(router: AppRouter) {
  router.get("/auth/api/passkeys", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return json({ error: "unauthenticated" }, 401);
    const rows = await listPasskeys(c.var.db, viewer.userId);
    return json({ passkeys: rows.map(keyView) });
  });

  router.post("/auth/api/passkeys/register/options", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return json({ error: "unauthenticated" }, 401);
    const { rpID } = rpAndOrigin(c);
    const existing = await listPasskeys(c.var.db, viewer.userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: viewer.primaryNamespaceSlug ?? viewer.userId,
      userID: new TextEncoder().encode(viewer.userId),
      attestationType: "none",
      excludeCredentials: existing.map((k) => ({ id: k.credentialId })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    await issuePasskeyChallenge(c, { kind: "register", userId: viewer.userId }, options.challenge);
    return json(options);
  });

  router.post("/auth/api/passkeys/register/verify", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return json({ error: "unauthenticated" }, 401);
    const log = createLogger(c.env.LOG_LEVEL, { service: "Passkeys" });
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      response?: RegistrationResponseJSON;
    } | null;
    if (!body?.response) return json({ error: "response required" }, 400);

    const challenge = clientChallenge(body.response.response.clientDataJSON);
    const pending = challenge ? await consumePasskeyChallenge(c, challenge) : null;
    if (!challenge || !pending || pending.kind !== "register" || pending.userId !== viewer.userId) {
      return json({ error: "challenge_expired" }, 403);
    }
    const { rpID, origin } = rpAndOrigin(c);
    let credential: WebAuthnCredential;
    try {
      const result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
      if (!result.verified) return json({ error: "verification_failed" }, 400);
      credential = result.registrationInfo.credential;
    } catch (err) {
      log.warn("passkey:register-verify-failed", { error: String(err) });
      return json({ error: "verification_failed" }, 400);
    }

    const row = {
      id: newPrefixedId("pk"),
      userId: viewer.userId,
      credentialId: credential.id,
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports?.join(",") ?? null,
      name: body.name?.trim() || null,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    await insertPasskey(c.var.db, row).catch((err) => {
      log.warn("passkey:register-insert-failed", { error: String(err) });
      throw err;
    });
    await insertSecurityEvent(c.var.db, {
      id: newPrefixedId("sev"),
      userId: viewer.userId,
      kind: "passkey.register",
      detail: row.name,
      createdAt: Date.now(),
    });
    return json({ id: row.id }, 201);
  });

  router.post("/auth/api/passkeys/login/options", async (c) => {
    const { rpID } = rpAndOrigin(c);
    // Discoverable credentials only — no allowCredentials list means the
    // authenticator picks the passkey for this RP itself.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
    });
    await issuePasskeyChallenge(c, { kind: "login" }, options.challenge);
    return json(options);
  });

  router.post("/auth/api/passkeys/login/verify", async (c) => {
    const log = createLogger(c.env.LOG_LEVEL, { service: "Passkeys" });
    const body = (await c.req.json().catch(() => null)) as {
      response?: AuthenticationResponseJSON;
    } | null;
    if (!body?.response) return json({ error: "response required" }, 400);

    const challenge = clientChallenge(body.response.response.clientDataJSON);
    const pending = challenge ? await consumePasskeyChallenge(c, challenge) : null;
    if (!challenge || !pending || pending.kind !== "login") {
      return json({ error: "challenge_expired" }, 403);
    }
    const stored = await findPasskeyByCredential(c.var.db, body.response.id);
    if (!stored) return json({ error: "unknown_credential" }, 400);

    const { rpID, origin } = rpAndOrigin(c);
    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: stored.credentialId,
          publicKey: b64urlDecode(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports?.split(",") as WebAuthnCredential["transports"],
        },
      });
      if (!result.verified) return json({ error: "verification_failed" }, 403);
      newCounter = result.authenticationInfo.newCounter;
    } catch (err) {
      log.warn("passkey:login-verify-failed", { error: String(err) });
      return json({ error: "verification_failed" }, 403);
    }
    await updatePasskeyCounter(c.var.db, stored.credentialId, newCounter);

    const user = await findUserById(c.var.db, stored.userId);
    if (!user) return json({ error: "unknown_credential" }, 400);
    const session = await createSessionForUser(c.env, c, user.id);
    await insertSecurityEvent(c.var.db, {
      id: newPrefixedId("sev"),
      userId: user.id,
      kind: "session.sign_in",
      detail: "passkey",
      createdAt: Date.now(),
    });
    log.info("passkey:sign-in", { userId: user.id });
    return json({ ok: true, session: session.token });
  });

  router.delete("/auth/api/passkeys/:id", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return json({ error: "unauthenticated" }, 401);
    const removed = await deletePasskey(c.var.db, viewer.userId, c.req.param("id"));
    if (!removed) return json({ error: "not_found" }, 404);
    await insertSecurityEvent(c.var.db, {
      id: newPrefixedId("sev"),
      userId: viewer.userId,
      kind: "passkey.revoke",
      createdAt: Date.now(),
    });
    return json({ deleted: true });
  });
}
