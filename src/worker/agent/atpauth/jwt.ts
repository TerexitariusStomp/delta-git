import { bytesToHex } from "@/worker/common/hex";

// Session JWTs (vendored from widespread auth jwt.ts, adapted to WebCrypto
// HS256 — no oslo/jose dependency).
//
// Sessions are short-lived (15 min default), revocation-checked against the
// `did_sessions` D1 table (jti), and optionally DPoP-bound via cnf.jkt.

const te = new TextEncoder();
const td = new TextDecoder();

export interface DidSessionClaims {
  sub: string; // did
  handle?: string;
  jti: string;
  iat: number;
  exp: number;
  cnf?: { jkt: string };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array | undefined {
  try {
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    te.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signDidSession(secret: string, claims: DidSessionClaims): Promise<string> {
  const header = b64url(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(te.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    te.encode(`${header}.${payload}`) as BufferSource
  );
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyDidSession(
  secret: string,
  token: string
): Promise<DidSessionClaims | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, sig] = parts;
  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) return undefined;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    te.encode(`${header}.${payload}`) as BufferSource
  );
  if (!ok) return undefined;
  try {
    const claims = JSON.parse(td.decode(b64urlDecode(payload)!)) as DidSessionClaims;
    if (!claims.sub || !claims.jti || typeof claims.exp !== "number") return undefined;
    if (claims.exp * 1000 < Date.now()) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** JWK thumbprint (RFC 7638) of a DPoP public key — the cnf.jkt binding. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const members = ["crv", "kty", "x", "y"]
    .filter((k) => jwk[k as keyof JsonWebKey] !== undefined)
    .sort()
    .map((k) => `"${k}":"${String(jwk[k as keyof JsonWebKey])}"`)
    .join(",");
  const digest = await crypto.subtle.digest("SHA-256", te.encode(`{${members}}`));
  return b64url(new Uint8Array(digest));
}

export function hexId(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
