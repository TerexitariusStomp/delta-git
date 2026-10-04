// did:key + base58btc helpers (vendored from widespread/Rooted didkey.ts,
// adapted to WebCrypto and delta-git's needs).
//
// did:key encodes `<multicodec-prefix> || <raw pubkey>` as base58btc with a
// "z" multibase marker. Supported key types:
//   0xed01 → Ed25519   (did:key:z6Mk…)
//   0x1200 → secp256k1 (did:key:zQ3s…, atproto's primary signing curve)
//   0x8024 → P-256     (did:key:zDn…)

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes — they become leading "1" characters.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = BigInt(0);
  for (const b of bytes) num = num * BigInt(256) + BigInt(b);
  let encoded = "";
  while (num > BigInt(0)) {
    const rem = num % BigInt(58);
    encoded = B58_ALPHABET[Number(rem)] + encoded;
    num = num / BigInt(58);
  }
  return "1".repeat(zeros) + encoded;
}

export function base58btcDecode(input: string): Uint8Array | undefined {
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  let num = BigInt(0);
  for (const ch of input) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) return undefined;
    num = num * BigInt(58) + v;
  }
  const hex = num.toString(16).padStart(Math.ceil(num.toString(2).length / 8) * 2, "0");
  const body = new Uint8Array(hex.length / 2);
  for (let i = 0; i < body.length; i++) body[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

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
  return `did:key:z${base58btcEncode(payload)}`;
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
  const decoded = base58btcDecode(multibase.slice(1));
  if (!decoded || decoded.length < 3) return undefined;
  const prefix = (decoded[0] << 8) | decoded[1];
  const pubkey = decoded.slice(2);
  if (prefix === 0xed01 && pubkey.length === 32) return { curve: "ed25519", pubkey };
  if (prefix === 0xe701 && pubkey.length === 33) return { curve: "k256", pubkey };
  if (prefix === 0x8024 && pubkey.length === 33) return { curve: "p256", pubkey };
  return undefined;
}
