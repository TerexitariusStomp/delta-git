// SSHSIG (PROTOCOL.sshsig) — git commit signature verification.
//
// Git `gpg.format=ssh` writes an armored SSH signature into the `gpgsig`
// commit header. The wire blob is:
//   "SSHSIG" || uint32 version(1)
//   string publickey        — SSH wire-format pubkey (type + key fields)
//   string namespace        — "git" for commits
//   string reserved         — empty
//   string hash_algorithm   — "sha512" (default) or "sha256"
//   string signature        — SSH wire-format sig (type + raw sig)
//
// Signed data = "SSHSIG" || string(namespace) || string(reserved) ||
//               string(hash_algorithm) || string(H(commit_payload))
// where commit_payload is the commit text minus the gpgsig header block.
// Ed25519 verifies via WebCrypto; other key types report as unverified.

const MAGIC = "SSHSIG";
const te = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function sshString(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  out.set(u32(data.length));
  out.set(data, 4);
  return out;
}

class WireReader {
  constructor(
    private buf: Uint8Array,
    private pos = 0
  ) {}
  string(): Uint8Array | null {
    if (this.pos + 4 > this.buf.length) return null;
    const len = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos).getUint32(0, false);
    this.pos += 4;
    if (this.pos + len > this.buf.length) return null;
    const s = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

/** PEM-armor strip → wire blob, or null when the armor isn't SSH signature. */
export function unarmorSshSig(text: string): Uint8Array | null {
  const m = /-----BEGIN SSH SIGNATURE-----\s*\n([\s\S]+?)\n-----END SSH SIGNATURE-----/.exec(text);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, "");
  try {
    return b64decode(b64);
  } catch {
    return null;
  }
}

/** authorized_keys line → wire-format pubkey blob (base64 field). */
export function parseAuthorizedKey(line: string): { keyType: string; blob: Uint8Array } | null {
  const m = /^(ssh-[a-z0-9-]+|sk-[a-z0-9-]+)\s+([A-Za-z0-9+/=]+)/.exec(line.trim());
  if (!m) return null;
  try {
    return { keyType: m[1], blob: b64decode(m[2]) };
  } catch {
    return null;
  }
}

/** SHA-256 key fingerprint in OpenSSH display form — the keyring lookup key. */
export async function sshFingerprint(pubkeyBlob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", pubkeyBlob.slice().buffer);
  return `SHA256:${b64encode(new Uint8Array(digest)).replace(/=+$/, "")}`;
}

export interface SshSig {
  keyType: string;
  pubkeyBlob: Uint8Array;
  rawPubkey: Uint8Array;
  namespace: string;
  hashAlgo: string;
  signature: Uint8Array;
}

/** Parse the wire blob; null on malformed input. */
export function parseSshSig(blob: Uint8Array): SshSig | null {
  if (blob.length < 10 || new TextDecoder().decode(blob.subarray(0, 6)) !== MAGIC) return null;
  const r = new WireReader(blob, 10); // MAGIC(6) + version(4)
  const pubkeyBlob = r.string();
  const namespace = r.string();
  const reserved = r.string();
  const hashAlgo = r.string();
  const signature = r.string();
  if (!pubkeyBlob || !namespace || !reserved || !hashAlgo || !signature) return null;

  const pr = new WireReader(pubkeyBlob);
  const keyTypeRaw = pr.string();
  const rawPubkey = pr.string();
  const sr = new WireReader(signature);
  const sigTypeRaw = sr.string();
  const rawSig = sr.string();
  if (!keyTypeRaw || !rawPubkey || !sigTypeRaw || !rawSig) return null;
  const keyType = new TextDecoder().decode(keyTypeRaw);
  const algo = new TextDecoder().decode(hashAlgo);
  return {
    keyType,
    pubkeyBlob,
    rawPubkey,
    namespace: new TextDecoder().decode(namespace),
    hashAlgo: algo,
    signature: rawSig,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Verify an ssh-ed25519 commit signature over `message` (the commit payload
 * with the gpgsig block stripped). Returns "verified" | "failed" |
 * "unsupported" for non-ed25519 keys or non-sha256/512 hash algorithms.
 */
export async function verifySshSig(
  sig: SshSig,
  message: Uint8Array
): Promise<"verified" | "failed" | "unsupported"> {
  if (sig.keyType !== "ssh-ed25519" || sig.rawPubkey.length !== 32) return "unsupported";
  const hash = sig.hashAlgo === "sha256" ? "SHA-256" : sig.hashAlgo === "sha512" ? "SHA-512" : null;
  if (!hash) return "unsupported";
  const digest = new Uint8Array(await crypto.subtle.digest(hash, message.slice().buffer));
  const signedData = concat([
    te.encode(MAGIC),
    sshString(te.encode(sig.namespace)),
    sshString(new Uint8Array(0)),
    sshString(te.encode(sig.hashAlgo)),
    sshString(digest),
  ]);
  const key = await crypto.subtle.importKey(
    "raw",
    sig.rawPubkey.slice().buffer,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    sig.signature.slice().buffer,
    signedData.slice().buffer
  );
  return ok ? "verified" : "failed";
}

/**
 * Split a commit payload into (unsigned body, raw sig text). The gpgsig
 * header is `gpgsig <first-line>` followed by space-prefixed continuation
 * lines; the signed payload drops the whole block but keeps the space
 * separator between the preceding header and the next line.
 */
export function splitCommitSignature(payload: Uint8Array): {
  unsigned: Uint8Array;
  sigText: string | null;
} {
  const text = new TextDecoder().decode(payload);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("gpgsig ") || l.startsWith("gpgsig-sha256 "));
  if (start === -1) return { unsigned: payload, sigText: null };
  const sigLines: string[] = [lines[start].replace(/^gpgsig(-sha256)? /, "")];
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith(" ")) {
    sigLines.push(lines[end].slice(1));
    end++;
  }
  const sigText = sigLines.join("\n");
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  return { unsigned: te.encode(rest.join("\n")), sigText };
}
