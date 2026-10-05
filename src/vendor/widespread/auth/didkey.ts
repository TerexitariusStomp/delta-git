/**
 * did:key decoding and multibase public-key extraction.
 *
 * did:key = did:key:z<multibase> where multibase is 'z' + base58btc of
 * (multicodec-prefix || public key). This app's keystore format also emits
 * base64url bodies. Multicodec prefixes:
 *   0xe7 0x01 = secp256k1 compressed (33 bytes)
 *   0x80 0x24 = P-256 compressed (33 bytes)
 *   0xed 0x01 = ed25519 (32 bytes)
 */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btcDecode(s: string): Uint8Array | null {
  try {
    const digits = [0];
    for (const ch of s) {
      const v = B58_ALPHABET.indexOf(ch);
      if (v < 0) return null;
      let carry = v;
      for (let i = 0; i < digits.length; i++) {
        const x = (digits[i] ?? 0) * 58 + carry;
        digits[i] = x & 0xff;
        carry = x >> 8;
      }
      while (carry) {
        digits.push(carry & 0xff);
        carry >>= 8;
      }
    }
    let zeros = 0;
    while (zeros < s.length && s[zeros] === "1") zeros++;
    const out = new Uint8Array(zeros + digits.length);
    for (let i = 0; i < digits.length; i++) out[zeros + i] = digits[digits.length - 1 - i] ?? 0;
    return out;
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export type DidKeyCurve = "k256" | "p256" | "ed25519";

/**
 * Extract the raw public key bytes + curve from a multicodec-prefixed key.
 * Returns null for unsupported codecs.
 */
function unwrapMulticodecWithCurve(
  bytes: Uint8Array
): { key: Uint8Array; curve: DidKeyCurve } | null {
  if (bytes.length === 35 && bytes[0] === 0xe7 && bytes[1] === 0x01)
    return { key: bytes.slice(2), curve: "k256" };
  if (bytes.length === 35 && bytes[0] === 0x80 && bytes[1] === 0x24)
    return { key: bytes.slice(2), curve: "p256" };
  if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01)
    return { key: bytes.slice(2), curve: "ed25519" };
  return null;
}

function unwrapMulticodec(bytes: Uint8Array): Uint8Array | null {
  return unwrapMulticodecWithCurve(bytes)?.key ?? null;
}

/**
 * Decode a did:key identifier to the embedded public key (compressed hex).
 * Returns null if the DID is malformed or uses an unsupported codec.
 */
export function decodeDidKeyPublicKeyHex(did: string): string | null {
  const m = did.match(/^did:key:z([a-zA-Z0-9_-]+)$/i);
  const body = m?.[1];
  if (!body) return null;
  // Try this app's base64url encoding first, then standard base58btc.
  for (const bytes of [base64UrlDecode(body), base58btcDecode(body)]) {
    if (!bytes) continue;
    const key = unwrapMulticodec(bytes);
    if (key) return bytesToHex(key);
  }
  return null;
}

/**
 * Decode a publicKeyMultibase string (e.g. from a DID document
 * verificationMethod) to hex. Supports 'z' (base58btc) multibase.
 */
export function decodePublicKeyMultibase(multibase: string): string | null {
  return decodePublicKeyMultibaseWithCurve(multibase)?.hex ?? null;
}

/**
 * Curve-aware variant of decodePublicKeyMultibase — callers verifying
 * signatures need the curve, which only the multicodec prefix carries.
 */
export function decodePublicKeyMultibaseWithCurve(
  multibase: string
): { hex: string; curve: DidKeyCurve } | null {
  if (!multibase.startsWith("z")) return null;
  const bytes = base58btcDecode(multibase.slice(1));
  if (!bytes) return null;
  const decoded = unwrapMulticodecWithCurve(bytes);
  return decoded ? { hex: bytesToHex(decoded.key), curve: decoded.curve } : null;
}

/**
 * Decode a did:key identifier to the embedded public key + curve.
 */
export function decodeDidKeyWithCurve(did: string): { hex: string; curve: DidKeyCurve } | null {
  const m = did.match(/^did:key:z([a-zA-Z0-9_-]+)$/i);
  const body = m?.[1];
  if (!body) return null;
  for (const bytes of [base64UrlDecode(body), base58btcDecode(body)]) {
    if (!bytes) continue;
    const decoded = unwrapMulticodecWithCurve(bytes);
    if (decoded) return { hex: bytesToHex(decoded.key), curve: decoded.curve };
  }
  return null;
}
