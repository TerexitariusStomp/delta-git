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

interface DidDocService {
  id?: string;
  type?: string;
  serviceEndpoint?: string;
}

export interface DidDoc {
  id?: string;
  alsoKnownAs?: string[];
  verificationMethod?: DidDocVerificationMethod[];
  service?: DidDocService[];
}

/**
 * Fetch a DID document from its authoritative source — no auth required:
 *   did:plc → plc.directory   did:web → /.well-known/did.json
 * Falls back to the PDS resolveDid XRPC for other methods (some PDSes
 * answer it unauthenticated; bsky.social gates it, which is why the
 * canonical sources come first).
 */
export async function resolveDidDocument(env: Env, did: string): Promise<DidDoc | undefined> {
  const candidates: string[] = [];
  if (did.startsWith("did:plc:")) {
    candidates.push(`https://plc.directory/${encodeURIComponent(did)}`);
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/%3A/g, ":");
    const [domain, ...path] = host.split(":");
    if (domain && /^[a-zA-Z0-9.-]+(:\d+)?$/.test(domain)) {
      const pathPart = path.length > 0 ? `/${path.join("/")}` : "";
      candidates.push(`https://${domain}${pathPart}/.well-known/did.json`);
    }
  }
  const base = (env.ATP_PDS_URL || "https://bsky.social").replace(/\/$/, "");
  candidates.push(`${base}/xrpc/com.atproto.identity.resolveDid?did=${encodeURIComponent(did)}`);
  for (const url of candidates) {
    const res = await fetch(url, { headers: { Accept: "application/json" } }).catch(
      () => undefined
    );
    if (!res?.ok) continue;
    const doc = (await res.json().catch(() => undefined)) as DidDoc | undefined;
    // Guard: the returned document must be for the DID we asked about.
    if (doc?.id === did) return doc;
  }
  return undefined;
}

/** DID doc → #atproto_pds service endpoint (used for OAuth discovery). */
export async function resolvePdsEndpoint(env: Env, did: string): Promise<string | undefined> {
  const doc = await resolveDidDocument(env, did);
  if (!doc) return undefined;
  const svc = doc.service?.find((s) => s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds"));
  const endpoint = svc?.serviceEndpoint;
  return endpoint && /^https:\/\//.test(endpoint) ? endpoint.replace(/\/$/, "") : undefined;
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
  const doc = await resolveDidDocument(env, did);
  if (!doc) return undefined;
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
