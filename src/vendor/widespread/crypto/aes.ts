/**
 * AES-GCM encryption via @noble/ciphers.
 *
 * Consolidates 6 duplicate AES-GCM implementations across the ecosystem
 * (wallet ×3, socials-vite ×1, worker/gateway ×2 identical).
 *
 * Uses managedNonce to handle nonce generation internally (CSPRNG nonce
 * prepended to ciphertext).
 */
import { gcm } from "@noble/ciphers/aes.js";
import { managedNonce } from "@noble/ciphers/utils.js";

const gcmManaged = managedNonce(gcm);

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param key 32-byte encryption key
 * @param plaintext data to encrypt
 * @param aad additional authenticated data (optional)
 * @returns ciphertext (includes managed nonce prefix)
 */
export function aesEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const cipher = gcmManaged(key, aad);
  return cipher.encrypt(plaintext);
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 * @param key 32-byte encryption key
 * @param ciphertext data to decrypt (includes managed nonce prefix)
 * @param aad additional authenticated data (must match encryption)
 * @returns plaintext
 */
export function aesDecrypt(key: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const cipher = gcmManaged(key, aad);
  return cipher.decrypt(ciphertext);
}

/**
 * Generate a random 32-byte AES-256 key.
 */
export function generateAesKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
