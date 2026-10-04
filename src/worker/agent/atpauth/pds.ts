import { decodeKeyMultibase, type DecodedDidKey } from "./didkey";

// atproto DID/handle resolution (vendored from widespread auth pds.ts).
//
// We intentionally call the *public* identity XRPCs on a PDS — the same
// path bsky.app uses — rather than depending on plc.directory directly:
//   com.atproto.identity.resolveDid    → DID document
//   com.atproto.identity.resolveHandle → did for a handle
//
// Loopback PDS hosts are allowed in dev (localhost tests run a fixture PDS).

export interface ResolvedDid {
  did: string;
  handle?: string;
  /** All signing keys declared in the DID document. */
  keys: DecodedDidKey[];
}

interface DidDocVerificationMethod {
  publicKeyMultibase?: string;
}

interface DidDoc {
  id?: string;
  alsoKnownAs?: string[];
  verificationMethod?: DidDocVerificationMethod[];
}

async function xrpc(env: Env, method: string, params: Record<string, string>): Promise<Response> {
  const base = (env.ATP_PDS_URL || "https://bsky.social").replace(/\/$/, "");
  const qs = new URLSearchParams(params).toString();
  return await fetch(`${base}/xrpc/${method}?${qs}`);
}

/** Resolve a DID to its document keys. For did:key the key is in the DID. */
export async function resolveDid(env: Env, did: string): Promise<ResolvedDid | undefined> {
  if (did.startsWith("did:key:")) {
    const decoded = decodeKeyMultibase(`z${did.slice("did:key:z".length)}`);
    return decoded ? { did, keys: [decoded] } : undefined;
  }
  const res = await xrpc(env, "com.atproto.identity.resolveDid", { did }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const doc = (await res.json().catch(() => undefined)) as DidDoc | undefined;
  // Guard: the returned document must be for the DID we asked about.
  if (!doc?.id || doc.id !== did) return undefined;
  const keys = (doc.verificationMethod ?? [])
    .map((m) => (m.publicKeyMultibase ? decodeKeyMultibase(m.publicKeyMultibase) : undefined))
    .filter((k): k is DecodedDidKey => k !== undefined);
  const handle = doc.alsoKnownAs?.find((u) => u.startsWith("at://"))?.slice("at://".length);
  return { did, handle, keys };
}

/** Resolve an atproto handle to a DID (handle → PDS resolveHandle). */
export async function resolveHandle(env: Env, handle: string): Promise<string | undefined> {
  const res = await xrpc(env, "com.atproto.identity.resolveHandle", { handle }).catch(
    () => undefined
  );
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => undefined)) as { did?: string } | undefined;
  return body?.did;
}
