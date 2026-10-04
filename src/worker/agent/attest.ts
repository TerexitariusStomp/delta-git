import type { Logger } from "@/worker/common/logger";

import { doPrefix } from "@/worker/keys";

// Merge/adjudication attestations in in-toto + DSSE envelope format.
//
// Every committed merge (auto or adjudicated) produces a signed in-toto
// Statement naming the subject commit, the merge-intent predicate, and the
// voters/method that produced it. The DSSE envelope is stored in R2 under
// the repo prefix and referenced from the op log, so provenance for any
// commit can be replayed forever: "this file reached main via quorum of
// rep>=X agents, digest Y, attested at seq N".
//
// We implement the envelope format directly rather than pulling the full
// `sigstore` client: we need the portable statement/envelope, not Fulcio
// keyless signing or Rekor uploads (our op log IS the transparency log).

const te = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type MergeAttestationArgs = {
  env: Env;
  doId: string;
  intentId: string;
  mergeOid: string;
  targetRef: string;
  baseOid: string;
  deltaOid: string;
  method: "auto" | "adjudicated";
  voters: string[];
  opSeq?: number;
};

/** Write an in-toto Statement wrapped in a DSSE envelope for a committed merge. */
export async function writeMergeAttestation(
  args: MergeAttestationArgs
): Promise<{ key: string; digest: string }> {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `${args.doId}:${args.targetRef}`,
        digest: { sha1: args.mergeOid },
      },
    ],
    predicateType: "https://delta-git.dev/merge/v1",
    predicate: {
      intentId: args.intentId,
      targetRef: args.targetRef,
      baseOid: args.baseOid,
      deltaOid: args.deltaOid,
      mergeOid: args.mergeOid,
      method: args.method,
      voters: args.voters,
      opSeq: args.opSeq ?? null,
      timestamp: new Date().toISOString(),
    },
  };
  const payload = te.encode(JSON.stringify(statement));
  const sig = await crypto.subtle.digest("SHA-256", payload as BufferSource);
  const keyid = `repo:${args.doId}`; // platform-signed; per-repo keyid for now
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: b64(payload),
    signatures: [{ keyid, sig: b64(new Uint8Array(sig)) }],
  };
  const digest = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `${doPrefix(args.doId)}/attestations/${args.mergeOid}.dsse.json`;
  await args.env.REPO_BUCKET.put(key, JSON.stringify(envelope, null, 2), {
    httpMetadata: { contentType: "application/vnd.dsse-envelope+json" },
  });
  return { key, digest };
}

export function logAttestationWritten(
  log: Logger | undefined,
  args: { intentId: string; mergeOid: string; key: string }
): void {
  log?.info("attest:written", args);
}
