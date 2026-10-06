import { didKeyFromPubkey } from "./atpauth/didkey";
import { fromBase64Url, toBase64Url } from "@atcute/multibase";

// Portable reputation certificates — the standing-proof counterpart to
// iCaptcha's puzzle proofs. Instead of solving per-node puzzles, an agent
// carries a signed claim of standing minted by the node that knows its rep.
// Any GLIP node verifies offline: `node_key` is the issuer's public JWK,
// `iss` its did:key, `sig` ed25519 over the canonical (sig-less) payload.
//
// The node key lives in the `DG_NODE_ED25519_JWK` secret (JWK private key).
// Absent → the certificate endpoint reports itself unconfigured rather than
// signing with a throwaway key (portability requires a stable issuer DID).

const te = new TextEncoder();

export interface NodeKeyMaterial {
  did: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}

export async function loadNodeKey(env: Env): Promise<NodeKeyMaterial | undefined> {
  const raw = (env as { DG_NODE_ED25519_JWK?: string }).DG_NODE_ED25519_JWK;
  if (!raw) return undefined;
  try {
    const jwk = JSON.parse(raw) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
      "sign",
    ]);
    const rawPub = fromBase64Url(jwk.x!);
    return {
      did: didKeyFromPubkey(rawPub, "ed25519"),
      publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      privateKey,
    };
  } catch {
    return undefined;
  }
}

export interface RepCert {
  kind: "dg-rep-cert-1";
  iss: string;
  sub: string;
  rep: number;
  /** Account creation epoch ms — standing proxy for age-based gates. */
  account_created_at: number;
  issued_at: number;
  expires_at: number;
  node_key: JsonWebKey;
  sig?: string;
}

export const REP_CERT_TTL_MS = 24 * 3600 * 1000;

/** The exact bytes the signature covers — sig-less cert, insertion order. */
export function repCertSignable(cert: RepCert): Uint8Array {
  const { sig: _sig, ...rest } = cert;
  return te.encode(JSON.stringify(rest));
}

export async function issueRepCert(args: {
  node: NodeKeyMaterial;
  sub: string;
  rep: number;
  accountCreatedAt: number;
  now?: number;
}): Promise<RepCert> {
  const now = args.now ?? Date.now();
  const cert: RepCert = {
    kind: "dg-rep-cert-1",
    iss: args.node.did,
    sub: args.sub,
    rep: args.rep,
    account_created_at: args.accountCreatedAt,
    issued_at: now,
    expires_at: now + REP_CERT_TTL_MS,
    node_key: args.node.publicJwk,
  };
  const sig = await crypto.subtle.sign(
    "Ed25519",
    args.node.privateKey,
    repCertSignable(cert) as BufferSource
  );
  cert.sig = toBase64Url(new Uint8Array(sig));
  return cert;
}

/** Stateless verify — other nodes only need the cert itself. */
export async function verifyRepCert(
  cert: RepCert,
  now = Date.now()
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (cert.kind !== "dg-rep-cert-1") return { ok: false, reason: "bad-kind" };
  if (!cert.sig || !cert.node_key?.x) return { ok: false, reason: "missing-fields" };
  if (now > cert.expires_at) return { ok: false, reason: "expired" };
  const pubBytes = fromBase64Url(cert.node_key.x);
  const expected = didKeyFromPubkey(pubBytes, "ed25519");
  if (expected !== cert.iss) return { ok: false, reason: "iss-key-mismatch" };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { ...cert.node_key, key_ops: ["verify"], ext: true },
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return { ok: false, reason: "bad-node-key" };
  }
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64Url(cert.sig) as BufferSource,
    repCertSignable(cert) as BufferSource
  );
  return ok ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}
