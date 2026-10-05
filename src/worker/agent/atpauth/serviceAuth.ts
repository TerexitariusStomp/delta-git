// ATProto service-auth JWT verification — client-sovereign sign-in proof.
//
// In the browser-native OAuth lane, @atproto/oauth-client-browser does the
// entire PAR + PKCE + DPoP flow against the user's home PDS; the raw OAuth
// tokens never touch delta-git. To prove DID control the browser asks its
// own PDS for a `com.atproto.server.getServiceAuth` JWT — a JWS signed by
// the DID's repo signing key — and submits it here. We verify:
//
//   iss === claimed DID
//   aud === this gateway's did:web service identifier
//   exp ≤ 90s fresh, iat not in the future
//   signature valid under the DID's declared signing keys
//   single-use (replay guard — a stolen JWT must not rebind to a new session)
//
// Reference implementation: Rooted `apps/social-gateway/lib/assertions.ts`
// serviceAuth lane. Signature/DID primitives reuse delta-git's existing
// resolveDid + verifyKeySignature (supports did:key/plc/web/dg).

import { resolveDid } from "./pds";
import { verifyKeySignature } from "./verify";

const te = new TextEncoder();
const td = new TextDecoder();

/** getServiceAuth JWTs are issued ~immediately before presentation. */
const SERVICE_AUTH_MAX_AGE_SEC = 90;

interface JwtParts {
  payload: {
    iss?: string;
    aud?: string;
    exp?: number;
    iat?: number;
  };
  signingInput: Uint8Array;
  sigBytes: Uint8Array;
}

function b64uToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) =>
    ch.charCodeAt(0)
  );
}

function decodeJwt(token: string): JwtParts | null {
  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return null;
    return {
      payload: JSON.parse(td.decode(b64uToBytes(payloadPart))) as JwtParts["payload"],
      signingInput: te.encode(`${headerPart}.${payloadPart}`),
      sigBytes: b64uToBytes(signaturePart),
    };
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface VerifiedServiceAuth {
  did: string;
  handle: string | undefined;
}

/**
 * Verify a service-auth JWT. `expectedAud` is the gateway's own atproto
 * service identifier (e.g. `did:web:git-on-cloudflare.delta-git.workers.dev`);
 * callers pass the request origin's host so previews/custom domains bind.
 */
export async function verifyServiceAuth(
  env: Env,
  did: string,
  jwt: string,
  expectedAud: string
): Promise<VerifiedServiceAuth | null> {
  // Same DID methods as the challenge lane (resolveDid handles all four).
  if (!/^did:(plc|web|key|dg):[a-zA-Z0-9._:%-]+$/.test(did)) return null;
  if (!jwt || jwt.length > 8192) return null;

  const parts = decodeJwt(jwt);
  if (!parts) return null;
  const { payload } = parts;
  const now = Math.floor(Date.now() / 1000);

  // iss = user's DID; aud = this gateway's service ref (allow the plain
  // did:web or its `#…` fragment-qualified form); ≤90s freshness.
  const audOk = payload.aud === expectedAud || payload.aud?.startsWith(`${expectedAud}#`);
  if (payload.iss !== did || !audOk) return null;
  if (
    typeof payload.exp !== "number" ||
    payload.exp < now ||
    payload.exp > now + SERVICE_AUTH_MAX_AGE_SEC
  ) {
    return null;
  }
  if (typeof payload.iat === "number" && payload.iat > now + 30) return null;

  // Replay guard — a stolen JWT must not be rebinding to another session.
  const dedup = `sauth:${await sha256Hex(parts.sigBytes)}`;
  if (await env.ROUTES.get(dedup)) return null;
  await env.ROUTES.put(dedup, "1", {
    expirationTtl: SERVICE_AUTH_MAX_AGE_SEC + 30,
  });

  const resolved = await resolveDid(env, did);
  if (!resolved || resolved.keys.length === 0) return null;

  for (const key of resolved.keys) {
    if (await verifyKeySignature(key, parts.sigBytes, parts.signingInput)) {
      return { did, handle: resolved.handle };
    }
  }
  return null;
}
