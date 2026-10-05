/**
 * Encoding helpers — base64, hex, UTF-8.
 *
 * Consolidates 28 duplicate helpers across the ecosystem (17 base64 + 11 hex).
 * Hex functions implemented directly (upstream re-exported viem, which we
 * don't ship — see ../UPSTREAM.md for the deviation).
 */

const hexAlphabet = "0123456789abcdef";

/** Convert bytes to lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += hexAlphabet[b >> 4] + hexAlphabet[b & 0xf];
  return out;
}

/** Convert a `0x`-prefixed hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

/** Convert a `0x`-prefixed hex string to bytes (viem-compatible alias). */
export const fromHex = hexToBytes;

/** Convert bytes or a bigint to a `0x`-prefixed hex string. */
export function toHex(value: Uint8Array | bigint): string {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  return bytesToHex(value);
}

/** Type check: `0x`-prefixed hex string. */
export function isHex(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Convert bytes to base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Convert base64 string to bytes.
 */
export function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * Convert bytes to base64url string (no padding, URL-safe).
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Convert base64url string to bytes.
 */
export function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return base64ToBytes(pad ? padded + "=".repeat(4 - pad) : padded);
}

/**
 * Convert string to UTF-8 bytes.
 */
export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Convert UTF-8 bytes to string.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
