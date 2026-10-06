// Outbound DID resolution — the interop counterpart to the inbound
// resolution in agent/atpauth/pds.ts. External resolvers and git clients
// can resolve our agent identities the same way we resolve theirs:
//
//   GET /1.0/identifiers/{did}
//
//   did:key:*  → deterministic document derived from the identifier
//                (no lookup needed — the key IS the identifier)
//   did:dg:*   → legacy agent format; the pubkey hex is inlined the same
//                way, so it resolves deterministically too
//   did:plc:/did:web:/other → proxied through the canonical resolver
//                chain (plc.directory → did:web → PDS resolveDid)
//
// Response follows the W3C DID Resolution binding:
//   { didDocument, didResolutionMetadata, didDocumentMetadata }
// with `application/did+json` content. Errors report the spec error
// names (invalidDid / notFound / methodNotSupported) in
// didResolutionMetadata.error.

import type { AppRouter } from "./hono";
import { toBase58Btc } from "@atcute/multibase";
import {
  pubkeyFromDidKey,
  didKeyFromPubkey,
  type DecodedDidKey,
} from "@/worker/agent/atpauth/didkey";
import { resolveDidDocument } from "@/worker/agent/atpauth/pds";
import { hexToBytesSafe } from "@/worker/agent/auth";

const DID_JSON = "application/did+json";

const MULTICODEC_PREFIX: Record<DecodedDidKey["curve"], [number, number]> = {
  ed25519: [0xed, 0x01],
  k256: [0xe7, 0x01],
  p256: [0x80, 0x24],
};

function pubkeyMultibase(key: DecodedDidKey): string {
  const [hi, lo] = MULTICODEC_PREFIX[key.curve];
  const payload = new Uint8Array(2 + key.pubkey.length);
  payload[0] = hi;
  payload[1] = lo;
  payload.set(key.pubkey, 2);
  return `z${toBase58Btc(payload)}`;
}

function buildDidDocument(did: string, key: DecodedDidKey): Record<string, unknown> {
  const multibase = pubkeyMultibase(key);
  const vmId = `${did}#${multibase.slice(1, 9)}`;
  const legacyType =
    key.curve === "ed25519" ? ["Multikey", "Ed25519VerificationKey2020"] : ["Multikey"];
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: vmId,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: multibase,
      },
      // Legacy type alias — older toolchains key on
      // Ed25519VerificationKey2018/2020 rather than Multikey.
      ...legacyType.slice(1).map((type) => ({
        id: `${vmId}-legacy`,
        type,
        controller: did,
        publicKeyMultibase: multibase,
      })),
    ],
    authentication: [vmId],
    assertionMethod: [vmId],
  };
}

function resolutionError(
  c: { json: (b: unknown, s: number) => Response },
  status: number,
  error: string
) {
  return c.json(
    {
      didDocument: null,
      didDocumentMetadata: {},
      didResolutionMetadata: { contentType: DID_JSON, error },
    },
    status
  );
}

export function registerDidRoutes(router: AppRouter) {
  router.get("/1.0/identifiers/:did{.+}", async (c) => {
    const did = c.req.param("did") ?? "";

    // Locally-derivable methods resolve without any network I/O.
    if (did.startsWith("did:key:")) {
      const key = pubkeyFromDidKey(did);
      if (!key) return resolutionError(c, 400, "invalidDid");
      return c.json(
        {
          didDocument: buildDidDocument(did, key),
          didDocumentMetadata: {},
          didResolutionMetadata: { contentType: DID_JSON },
        },
        200
      );
    }

    if (did.startsWith("did:dg:")) {
      const pubkey = hexToBytesSafe(did.slice("did:dg:".length));
      if (!pubkey || pubkey.length !== 32) return resolutionError(c, 400, "invalidDid");
      const key: DecodedDidKey = { curve: "ed25519", pubkey };
      return c.json(
        {
          didDocument: {
            ...buildDidDocument(did, key),
            // Cross-reference the canonical did:key spelling of the same
            // key material so consumers can correlate registrations.
            alsoKnownAs: [didKeyFromPubkey(pubkey, "ed25519")],
          },
          didDocumentMetadata: {},
          didResolutionMetadata: { contentType: DID_JSON },
        },
        200
      );
    }

    // Everything else goes through the canonical resolution chain.
    if (!/^did:[a-z0-9]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(did)) {
      return resolutionError(c, 400, "invalidDid");
    }
    const doc = await resolveDidDocument(c.env, did).catch(() => undefined);
    if (!doc) return resolutionError(c, 404, "notFound");
    return c.json(
      {
        didDocument: doc,
        didDocumentMetadata: {},
        didResolutionMetadata: { contentType: DID_JSON },
      },
      200
    );
  });
}
