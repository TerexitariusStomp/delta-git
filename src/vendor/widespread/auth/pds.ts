/**
 * DID signing-key resolution — no PDS required.
 *
 * Consolidates the resolvePdsKey function from worker and gateway.
 * Uses safe-fetch to prevent SSRF.
 *
 * - did:key is self-certifying: the public key is embedded in the DID
 *   identifier, so it is decoded locally — no network call.
 * - did:plc resolves via plc.directory, the authoritative source.
 * - did:web resolves via the method's well-known did.json.
 */
import {
  decodeDidKeyWithCurve,
  decodePublicKeyMultibaseWithCurve,
  type DidKeyCurve,
} from "./didkey.js";

export interface PdsKeyResult {
  key: string;
  handle: string;
  /** Signature curve inferred from the multicodec prefix. */
  curve?: DidKeyCurve;
}

export interface SafeFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

const PLC_DIRECTORY = "https://plc.directory";

interface DidDocument {
  id?: string;
  alsoKnownAs?: string[];
  verificationMethod?: Array<{ id?: string; publicKeyMultibase?: string }>;
}

/**
 * Pick the atproto signing key from a DID document — the verification method
 * whose id ends with `#atproto` (fall back to the first method). DID docs
 * can carry multiple keys and the first entry is not guaranteed to be the
 * repo signing key.
 */
function extractAtprotoKey(doc: DidDocument): { key: string; curve?: DidKeyCurve } | null {
  const methods = doc.verificationMethod;
  if (!methods?.length) return null;
  const atproto = methods.find((m) => m.id?.endsWith("#atproto")) ?? methods[0];
  if (!atproto?.publicKeyMultibase) return null;
  const decoded = decodePublicKeyMultibaseWithCurve(atproto.publicKeyMultibase);
  return decoded ? { key: decoded.hex, curve: decoded.curve } : null;
}

function extractHandle(doc: DidDocument): string {
  const atUri = doc.alsoKnownAs?.find((u) => u.startsWith("at://"));
  return atUri ? atUri.slice("at://".length) : "";
}

async function resolvePlcKey(did: string, safeFetch: SafeFetch): Promise<PdsKeyResult | null> {
  const resp = await safeFetch(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`);
  if (!resp.ok) return null;
  const doc = (await resp.json()) as DidDocument;
  if (doc.id !== did) return null;
  const extracted = extractAtprotoKey(doc);
  if (!extracted) return null;
  return { key: extracted.key, curve: extracted.curve, handle: extractHandle(doc) };
}

// did:web:example.com → https://example.com/.well-known/did.json
// did:web:example.com:u:alice → https://example.com/u/alice/did.json
async function resolveWebKey(did: string, safeFetch: SafeFetch): Promise<PdsKeyResult | null> {
  const parts = did.slice("did:web:".length).split(":");
  const host = decodeURIComponent(parts[0] ?? "");
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return null;
  const path = parts.slice(1).map(decodeURIComponent).join("/");
  const url = path ? `https://${host}/${path}/did.json` : `https://${host}/.well-known/did.json`;
  const resp = await safeFetch(url);
  if (!resp.ok) return null;
  const doc = (await resp.json()) as DidDocument;
  if (doc.id !== did) return null;
  const extracted = extractAtprotoKey(doc);
  if (!extracted) return null;
  return { key: extracted.key, curve: extracted.curve, handle: extractHandle(doc) };
}

/**
 * Resolve the authoritative verification key for a DID.
 * Uses the provided safe-fetch implementation to prevent SSRF.
 * Supports did:key (offline), did:plc (plc.directory) and did:web
 * (well-known did.json) — no PDS is ever contacted.
 */
export async function resolveDidKey(
  did: string,
  safeFetch: SafeFetch
): Promise<PdsKeyResult | null> {
  try {
    if (did.startsWith("did:key:")) {
      const decoded = decodeDidKeyWithCurve(did);
      return decoded ? { key: decoded.hex, curve: decoded.curve, handle: "" } : null;
    }
    if (did.startsWith("did:plc:")) {
      return await resolvePlcKey(did, safeFetch);
    }
    if (did.startsWith("did:web:")) {
      return await resolveWebKey(did, safeFetch);
    }
    return null;
  } catch {
    return null;
  }
}

/** @deprecated Use resolveDidKey — the pdsUrl argument is ignored. */
export async function resolvePdsKey(
  did: string,
  _pdsUrl: string | undefined,
  safeFetch: SafeFetch
): Promise<PdsKeyResult | null> {
  return resolveDidKey(did, safeFetch);
}
