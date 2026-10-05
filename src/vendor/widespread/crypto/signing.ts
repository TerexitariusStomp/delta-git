/**
 * Ed25519 signing via @noble/ed25519.
 *
 * Re-exports the library's sign/verify functions and provides a
 * keypair generation helper.
 */
export { sign, verify, getPublicKey } from "@noble/ed25519";

/**
 * Generate a new Ed25519 keypair.
 * @returns { publicKey, secretKey } as Uint8Array
 */
export async function generateEd25519KeyPair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  const { getPublicKey } = await import("@noble/ed25519");
  const publicKey = await getPublicKey(secretKey);
  return { publicKey, secretKey };
}
