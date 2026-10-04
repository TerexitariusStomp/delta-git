import { hexToBytesSafe } from "./auth";
import { asBufferSource } from "@/worker/common";

// Repo-secret encryption. Values are AES-256-GCM encrypted at rest in the
// repo DO; the KEK is the worker secret `DG_KEK` (64-hex, set via
// `wrangler secret put`). Storage format: base64(nonce || ciphertext),
// matching the write-only `wrangler secret` contract — values are only ever
// decrypted in-memory at deploy time for binding injection.

const te = new TextEncoder();
const td = new TextDecoder();

async function kek(env: Env): Promise<CryptoKey> {
  const hex = env.DG_KEK;
  const bytes = hexToBytesSafe(hex);
  if (!bytes || bytes.length !== 32) throw new Error("DG_KEK must be 32-byte hex");
  return await crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptRepoSecret(env: Env, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce) },
      await kek(env),
      asBufferSource(te.encode(value))
    )
  );
  const packed = new Uint8Array(nonce.length + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, nonce.length);
  return b64encode(packed);
}

export async function decryptRepoSecret(env: Env, ciphertext: string): Promise<string> {
  const packed = b64decode(ciphertext);
  const nonce = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBufferSource(nonce) },
    await kek(env),
    asBufferSource(ct)
  );
  return td.decode(plain);
}

