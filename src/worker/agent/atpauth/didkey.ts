import { fromBase58Btc, toBase58Btc } from "@atcute/multibase";

// did:key helpers (vendored from widespread/Rooted didkey.ts; base58btc
// codec delegated to @atcute/multibase).
//
// did:key encodes `<multicodec-prefix> || <raw pubkey>` as base58btc with a
// "z" multibase marker. Supported key types:
//   0xed01 → Ed25519   (did:key:z6Mk…)
//   0x1200 → secp256k1 (did:key:zQ3s…, atproto's primary signing curve)
//   0x8024 → P-256     (did:key:zDn…)

export type DidKeyCurve = "ed25519" | "k256" | "p256";

// Fixed 2-byte multicodec varints:
//   ed25519: 0xed 0x01 | secp256k1: 0xe7 0x01 | P-256: 0x80 0x24
const MULTICODEC_PREFIX: Record<DidKeyCurve, [number, number]> = {
  ed25519: [0xed, 0x01],
  k256: [0xe7, 0x01],
  p256: [0x80, 0x24],
};

export function didKeyFromPubkey(pubkey: Uint8Array, curve: DidKeyCurve): string {
  const [hi, lo] = MULTICODEC_PREFIX[curve];
  const payload = new Uint8Array(2 + pubkey.length);
  payload[0] = hi;
  payload[1] = lo;
  payload.set(pubkey, 2);
  return `did:key:z${toBase58Btc(payload)}`;
}

export interface DecodedDidKey {
  curve: DidKeyCurve;
  pubkey: Uint8Array;
}

export function pubkeyFromDidKey(did: string): DecodedDidKey | undefined {
  const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
  if (!match) return undefined;
  return decodeKeyMultibase(`z${match[1]}`);
}

/**
 * Decode a `publicKeyMultibase` value (e.g. a DID document
 * verificationMethod) — currently the `z` (base58btc) encoding with a
 * 2-byte multicodec varint.
 */
export function decodeKeyMultibase(multibase: string): DecodedDidKey | undefined {
  if (!multibase.startsWith("z")) return undefined;
  let decoded: Uint8Array;
  try {
    decoded = fromBase58Btc(multibase.slice(1));
  } catch {
    return undefined;
  }
  if (decoded.length < 3) return undefined;
  const prefix = (decoded[0] << 8) | decoded[1];
  const pubkey = decoded.slice(2);
  if (prefix === 0xed01 && pubkey.length === 32) return { curve: "ed25519", pubkey };
  if (prefix === 0xe701 && pubkey.length === 33) return { curve: "k256", pubkey };
  if (prefix === 0x8024 && pubkey.length === 33) return { curve: "p256", pubkey };
  return undefined;
}
