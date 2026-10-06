// OpenPGP detached-signature handling for commit `gpgsig` blocks.
//
// Git stores `gpg --detach-sign --armor` output in the gpgsig header — a
// binary-type signature over the exact commit bytes with the header
// stripped (the `unsigned` payload from splitCommitSignature). openpgp.js
// does the real work; it lazy-loads because the package is heavy and
// PGP commits are the minority path. LGPL-3.0 — see docs/oss-licenses.md.

import { bytesToHex } from "@/worker/common/hex";

type OpenPgp = typeof import("openpgp");

async function pgp(): Promise<OpenPgp> {
  return await import("openpgp");
}

/** True for armored PGP signature blocks (distinguishes PGP from SSHSIG). */
export function isPgpSignatureArmor(text: string): boolean {
  return text.includes("-----BEGIN PGP SIGNATURE-----");
}

/**
 * Hex issuer identifiers the signature claims — full fingerprints (v5 sigs,
 * uppercase) and 64-bit key IDs (v4 sigs). Callers use these to find the
 * registered key that signed; both index into `gpgfp:` KV.
 */
export async function pgpIssuerIds(armoredSignature: string): Promise<string[]> {
  const openpgp = await pgp();
  const signature = await openpgp.readSignature({ armoredSignature });
  const out = new Set<string>();
  for (const packet of signature.packets) {
    // Narrow to SignaturePacket — the only packet carrying issuer hints.
    const p = packet as {
      issuerKeyID?: { toHex: () => string } | null;
      issuerFingerprints?: Uint8Array[] | null;
    };
    for (const fp of p.issuerFingerprints ?? []) out.add(bytesToHex(fp).toUpperCase());
    if (p.issuerKeyID) out.add(p.issuerKeyID.toHex().toUpperCase());
  }
  return [...out];
}

export type PgpVerify =
  | { status: "verified"; fingerprint: string }
  | { status: "failed"; reason: string };

/**
 * Verify `armoredSignature` as a detached signature over `unsigned` (the
 * commit bytes minus the gpgsig header). `armoredKeys` are candidate public
 * keys (the issuer-registered ones); verification against a subkey that
 * belongs to a listed primary still verifies — openpgp resolves the chain.
 */
export async function verifyPgpDetached(
  unsigned: Uint8Array,
  armoredSignature: string,
  armoredKeys: string[]
): Promise<PgpVerify> {
  const openpgp = await pgp();
  const signature = await openpgp.readSignature({ armoredSignature });
  const message = await openpgp.createMessage({ binary: unsigned });
  const keys = [];
  for (const armored of armoredKeys) {
    keys.push(await openpgp.readKey({ armoredKey: armored }).catch(() => null));
  }
  const verificationKeys = keys.filter((k) => k !== null);
  if (verificationKeys.length === 0) return { status: "failed", reason: "no-parseable-keys" };
  const result = await openpgp.verify({ message, signature, verificationKeys });
  const first = result.signatures[0];
  if (!first) return { status: "failed", reason: "no-signature-packet" };
  try {
    await first.verified;
    return { status: "verified", fingerprint: first.keyID.toHex().toUpperCase() };
  } catch {
    return { status: "failed", reason: "signature-mismatch" };
  }
}
