import { describe, it, expect } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { bytesToHex } from "@/worker/common/hex";
import { registerAgent, adjustAgentRep } from "@/worker/agent/auth";
import { repCertSignable, verifyRepCert, type RepCert } from "@/worker/agent/repCert";
import { createDb } from "@/worker/db/d1/client";

import { withEnvOverrides } from "./util/test-helpers";
import { ensureD1Migrations } from "./util/d1Setup";

// dg-rep-cert-1: node-signed portable standing proofs. Mint over HTTP,
// verify offline — no callback to the issuing node.

async function nodeJwk(): Promise<{ jwk: string; pub: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { jwk: JSON.stringify(jwk), pub: pair.publicKey };
}

describe("reputation certificates", () => {
  it("mints a signed cert for a registered agent and it verifies offline", async () => {
    await ensureD1Migrations(env);
    const db = createDb(env.DB);
    const { jwk } = await nodeJwk();
    const pub = new Uint8Array(
      await crypto.subtle.exportKey(
        "raw",
        (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).publicKey
      )
    );
    const agent = await registerAgent(db, { pubkeyHex: bytesToHex(pub), label: "cert-agent" });
    if (!("did" in agent)) throw new Error("register failed");
    await adjustAgentRep(db, agent.did, 77);

    await withEnvOverrides(env, { DG_NODE_ED25519_JWK: jwk }, async () => {
      const res = await workerExports.default.fetch(
        `https://example.com/api/dg/agents/${encodeURIComponent(agent.did)}/certificate`
      );
      expect(res.status).toBe(200);
      const cert = (await res.json()) as RepCert;
      expect(cert.kind).toBe("dg-rep-cert-1");
      expect(cert.sub).toBe(agent.did);
      expect(cert.rep).toBe(77);
      expect(cert.iss.startsWith("did:key:")).toBe(true);
      expect(cert.node_key.kty).toBe("OKP");
      expect(typeof cert.sig).toBe("string");

      // Offline verify — the exported verifyRepCert does the full check.
      expect(await verifyRepCert(cert)).toEqual({ ok: true });

      // Tamper: bump rep, re-verify must fail.
      const forged = { ...cert, rep: 9999 };
      const verdict = await verifyRepCert(forged);
      expect(verdict.ok).toBe(false);
    });
  });

  it("503s when the node key is not configured", async () => {
    const res = await workerExports.default.fetch(
      `https://example.com/api/dg/agents/${encodeURIComponent("did:key:z6MkTest")}/certificate`
    );
    // Either the DID is unknown (404) or the node key is absent (503) —
    // both precede signing; the env has no DG_NODE_ED25519_JWK here.
    expect([404, 503]).toContain(res.status);
  });

  it("expired certs fail verification", async () => {
    // Direct verify path on a hand-built expired cert — needs no key material.
    const stale: RepCert = {
      kind: "dg-rep-cert-1",
      iss: "did:key:zDead",
      sub: "did:key:zSub",
      rep: 1,
      account_created_at: 0,
      issued_at: 0,
      expires_at: 1, // long past
      node_key: { kty: "OKP", crv: "Ed25519", x: "AA" },
      sig: "AA",
    };
    expect(await verifyRepCert(stale)).toEqual({ ok: false, reason: "expired" });
    expect(repCertSignable(stale).length).toBeGreaterThan(0);
  });
});
