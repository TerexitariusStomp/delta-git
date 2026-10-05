import { SignJWT, jwtVerify } from "jose";

// Session JWTs (vendored from widespread auth jwt.ts, now backed by jose's
// WebCrypto HS256 implementation).
//
// Sessions are short-lived (15 min default), revocation-checked against the
// `did_sessions` D1 table (jti), and optionally DPoP-bound via cnf.jkt.

const te = new TextEncoder();

export interface DidSessionClaims {
  sub: string; // did
  handle?: string;
  jti: string;
  iat: number;
  exp: number;
  cnf?: { jkt: string };
}

/**
 * Generic HS256 JWT signer — used for the wp-cloud SSO handoff token
 * (dg_token): aud-bound, short-lived, verified by the receiving app with the
 * shared DG_SESSION_SECRET rather than SESSION_SECRET so each side can
 * rotate its own session key independently.
 */
export async function signHs256Jwt(
  secret: string,
  claims: Record<string, string | number | undefined>
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(te.encode(secret));
}

export async function signDidSession(secret: string, claims: DidSessionClaims): Promise<string> {
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(te.encode(secret));
}

export async function verifyDidSession(
  secret: string,
  token: string
): Promise<DidSessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify<DidSessionClaims>(token, te.encode(secret), {
      algorithms: ["HS256"],
    });
    // jose enforces exp when present; require the claims we actually depend on.
    if (!payload.sub || !payload.jti || typeof payload.exp !== "number") return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
