import { isDid } from "@atcute/lexicons/syntax";
import type { DidDocument } from "@atcute/identity";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  XrpcDidDocumentResolver,
  XrpcHandleResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";

import { decodeKeyMultibase, type DecodedDidKey } from "./didkey";

// atproto DID/handle resolution (vendored from widespread auth pds.ts;
// fetch plumbing delegated to @atcute/identity-resolver).
//
// We intentionally call the *public* identity XRPCs on a PDS — the same
// path bsky.app uses — rather than depending on plc.directory directly:
//   com.atproto.identity.resolveDid    → DID document (fallback resolver)
//   com.atproto.identity.resolveHandle → did for a handle
//
// Loopback PDS hosts are allowed in dev (localhost tests run a fixture PDS).

export interface ResolvedDid {
  did: string;
  handle?: string;
  /** All signing keys declared in the DID document. */
  keys: DecodedDidKey[];
}

export type DidDoc = DidDocument;

/** PDS base used for identity XRPCs (fixture-overridable via ATP_PDS_URL). */
export function pdsBase(env: Env): string {
  return (env.ATP_PDS_URL || "https://bsky.social").replace(/\/$/, "");
}

/**
 * DID document resolvers in preference order: the method's canonical
 * source (plc.directory, did:web well-known) first, then the configured
 * PDS's resolveDid XRPC as a catch-all — some PDSes answer it
 * unauthenticated and it covers methods the canonical pair doesn't.
 */
export function createDidDocumentResolver(env: Env): DidDocumentResolver {
  // Widened to the generic resolver interface — the composite only accepts
  // `did:plc:`/`did:web:` inputs, and we fall through to the PDS resolver
  // for every other method.
  const canonical: DidDocumentResolver = new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  });
  const pds = new XrpcDidDocumentResolver({ serviceUrl: pdsBase(env) });
  return {
    async resolve(did, options) {
      let lastErr: unknown;
      for (const resolver of [canonical, pds] as const) {
        try {
          return await resolver.resolve(did, options);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}

/**
 * Fetch a DID document from its authoritative source — no auth required.
 * Canonical method sources are tried first, then the PDS resolveDid XRPC.
 * The returned document's `id` must match the requested DID.
 */
export async function resolveDidDocument(env: Env, did: string): Promise<DidDoc | undefined> {
  if (!isDid(did)) return undefined;
  try {
    const doc = await createDidDocumentResolver(env).resolve(did);
    return doc.id === did ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** DID doc → #atproto_pds service endpoint (used for OAuth discovery). */
export async function resolvePdsEndpoint(env: Env, did: string): Promise<string | undefined> {
  const doc = await resolveDidDocument(env, did);
  if (!doc) return undefined;
  const svc = doc.service?.find((s) => s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds"));
  const endpoint = svc?.serviceEndpoint;
  // serviceEndpoint can be a map/array per the DID spec; we only consume the
  // plain URL form.
  return typeof endpoint === "string" && /^https:\/\//.test(endpoint)
    ? endpoint.replace(/\/$/, "")
    : undefined;
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
  try {
    const resolver = new XrpcHandleResolver({ serviceUrl: pdsBase(env) });
    // The PDS validates the handle — we pass through whatever the caller
    // supplied (fixture handles in dev may not contain a dot).
    return await resolver.resolve(handle as `${string}.${string}`);
  } catch {
    return undefined;
  }
}
