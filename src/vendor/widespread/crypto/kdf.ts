/**
 * Key derivation functions — PBKDF2 and HKDF.
 *
 * Consolidates 6 duplicate PBKDF2 implementations across the ecosystem.
 * Uses WebCrypto for PBKDF2 (platform primitive, no library needed).
 *
 * OWASP 2023 recommends 600,000 iterations for PBKDF2-SHA256.
 */

/** OWASP 2023 recommended PBKDF2 iterations for SHA-256. */
export const PBKDF2_ITERATIONS = 600_000;

/** Copy a Uint8Array to a fresh ArrayBuffer (avoids SharedArrayBuffer type issues). */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/**
 * Derive an AES-GCM key from a password using PBKDF2.
 * @param password user password
 * @param salt 16+ byte random salt
 * @param iterations PBKDF2 iterations (default: 600,000 per OWASP 2023)
 * @returns WebCrypto CryptoKey (for use with aesEncrypt/aesDecrypt)
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toBuffer(enc.encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toBuffer(salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive a key from a PRF output (e.g., WebAuthn PRF extension) using HKDF.
 * @param prfOutput raw PRF output bytes
 * @param salt HKDF salt
 * @param info HKDF info string (context binding)
 * @returns WebCrypto CryptoKey
 */
export async function deriveKeyFromPrf(
  prfOutput: Uint8Array,
  salt: Uint8Array,
  info: string
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", toBuffer(prfOutput), "HKDF", false, [
    "deriveKey",
  ]);
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toBuffer(salt), info: toBuffer(enc.encode(info)) },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Export a CryptoKey to raw bytes (for storage).
 */
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const buf = await crypto.subtle.exportKey("raw", key);
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new Error("exportKey returned unexpected JsonWebKey");
}

/**
 * Import raw bytes as a CryptoKey for AES-GCM.
 */
export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Derive a raw AES-GCM key from a master secret via HKDF-SHA-256.
 * Used by worker push-crypto and auth for key separation.
 * @param masterKey master secret string (e.g. SESSION_SECRET)
 * @param salt HKDF salt string
 * @param info HKDF info string (context binding)
 * @returns raw key bytes (32 bytes for AES-256)
 */
export async function deriveHkdfKey(
  masterKey: string,
  salt: string,
  info: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toBuffer(enc.encode(masterKey)),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuffer(enc.encode(salt)),
      info: toBuffer(enc.encode(info)),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}
