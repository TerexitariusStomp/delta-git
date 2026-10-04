import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { DecodedDidKey } from "./didkey";

// Signature verification for DID challenge responses.
//
// atproto clients sign with raw r||s signatures:
//   k256  — secp256k1, low-S normalized (noble; WebCrypto lacks the curve)
//   p256  — NIST P-256 (WebCrypto, after decompressing the point via noble)
//   ed25519 — delta-git agent keys (WebCrypto)
//
// `data` is the exact UTF-8 bytes signed — callers pass the canonical JSON
// of the challenge payload.

const te = new TextEncoder();

export async function verifyKeySignature(
  key: DecodedDidKey,
  sig: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  try {
    if (key.curve === "ed25519") {
      const ck = await crypto.subtle.importKey(
        "raw",
        key.pubkey as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify("Ed25519", ck, sig as BufferSource, data as BufferSource);
    }
    if (key.curve === "k256") {
      return secp256k1.verify(sig, data, key.pubkey, { lowS: true });
    }
    if (key.curve === "p256") {
      // WebCrypto expects the uncompressed point for raw ECDSA imports.
      const point = p256.Point.fromBytes(key.pubkey).toBytes(false);
      const ck = await crypto.subtle.importKey(
        "raw",
        point as BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        ck,
        sig as BufferSource,
        data as BufferSource
      );
    }
    return false;
  } catch {
    return false;
  }
}

/** Deterministic JSON with sorted keys — the bytes DID clients must sign. */
export function canonicalJson(value: Record<string, string | number | undefined>): string {
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

export function utf8(s: string): Uint8Array {
  return te.encode(s);
}
