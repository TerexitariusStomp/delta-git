/**
 * @widespread/crypto — shared crypto/encoding helpers.
 *
 * Consolidates 6 AES-GCM implementations, 6 PBKDF2 implementations,
 * 17 base64 helpers, and 11 hex helpers into thin wrappers around:
 *  - @noble/ciphers (AES-GCM)
 *  - WebCrypto (PBKDF2, HKDF)
 *  - viem (hex encoding)
 *  - @noble/ed25519 (signing)
 */
export * from "./aes.js";
export * from "./kdf.js";
export * from "./encoding.js";
export * from "./signing.js";
