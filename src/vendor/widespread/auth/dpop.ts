/**
 * DPoP (Demonstrating Proof-of-Possession, RFC 9449) helpers.
 *
 * Consolidates the DPoP verification logic from the worker.
 * Validates: signature, htm, htu, iat (within 60s), jti (single-use via KV).
 */
import { bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8 } from "../crypto/index.js";

export interface DpopStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Compute the JWK thumbprint (RFC 7638) of a DPoP public key.
 * Uses SHA-256 (Web Crypto API, built-in).
 */
export async function computeJwkThumbprint(jwk: {
  kty: string;
  x: string;
  y: string;
}): Promise<string> {
  const canonical = JSON.stringify({ kty: jwk.kty, x: jwk.x, y: jwk.y });
  const hash = await crypto.subtle.digest("SHA-256", utf8ToBytes(canonical) as BufferSource);
  return bytesToBase64Url(new Uint8Array(hash));
}

/**
 * Verify a DPoP proof (RFC 9449).
 * The proof is a JWT signed with the client's DPoP private key.
 * Validates: signature, htm, htu, iat (within 60s), jti (single-use via KV).
 */
export async function verifyDpopProof(
  dpopProof: string,
  expectedHtm: string,
  expectedHtu: string,
  expectedJkt: string,
  store: DpopStore
): Promise<boolean> {
  try {
    const parts = dpopProof.split(".");
    if (parts.length !== 3) return false;
    const headerPart = parts[0];
    const payloadPart = parts[1];
    const signaturePart = parts[2];
    if (!headerPart || !payloadPart || !signaturePart) return false;

    const headerJson = bytesToUtf8(base64UrlToBytes(headerPart));
    const header = JSON.parse(headerJson) as {
      typ: string;
      alg: string;
      jwk: { kty: string; x: string; y: string; crv?: string };
    };
    if (header.typ !== "dpop+jwt") return false;
    if (header.alg !== "ES256") return false;

    const payloadJson = bytesToUtf8(base64UrlToBytes(payloadPart));
    const payload = JSON.parse(payloadJson) as {
      htm: string;
      htu: string;
      iat: number;
      jti: string;
    };
    if (payload.htm !== expectedHtm) return false;
    if (payload.htu !== expectedHtu) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - payload.iat) > 60) return false;

    // Single-use jti check
    const jtiKey = `dpop:${payload.jti}`;
    if (await store.get(jtiKey)) return false;
    await store.put(jtiKey, "1", { expirationTtl: 120 });

    const jkt = await computeJwkThumbprint(header.jwk);
    if (jkt !== expectedJkt) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      { ...header.jwk, key_ops: ["verify"] },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const data = utf8ToBytes(`${headerPart}.${payloadPart}`);
    const signature = base64UrlToBytes(signaturePart);
    return await crypto.subtle
      .verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as BufferSource,
        data as BufferSource
      )
      .then(() => true)
      .catch(() => false);
  } catch {
    return false;
  }
}
