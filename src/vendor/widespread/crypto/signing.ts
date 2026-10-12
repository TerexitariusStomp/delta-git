/**
 * Ed25519 signing via @noble/curves (deviation from upstream
 * `@noble/ed25519` — see UPSTREAM.md; identical RFC8032 semantics,
 * avoids carrying a second Ed25519 package).
 *
 * Re-exports the library's sign/verify functions and provides a
 * keypair generation helper. Curves' sign/verify are synchronous;
 * callers that `await` them are unaffected.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

export const { sign, verify, getPublicKey } = ed25519;

/**
 * Generate a new Ed25519 keypair.
 * @returns { publicKey, secretKey } as Uint8Array
 */
export function generateEd25519KeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
}
