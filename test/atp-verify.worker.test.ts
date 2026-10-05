import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { didKeyFromPubkey } from "@/worker/agent/atpauth/didkey";
import { computeJwkThumbprint } from "@/vendor/widespread/auth/dpop";
import { ensureD1Migrations } from "./util/d1Setup";

const te = new TextEncoder();

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A did:key signer + serviceAuth-JWT minter (stands in for the user's PDS). */
async function makeIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
  const pubkey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const did = didKeyFromPubkey(pubkey, "ed25519");
  const mintServiceAuth = async (aud: string, expDelta = 60) => {
    const header = b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "EdDSA" })));
    const payload = b64url(
      te.encode(
        JSON.stringify({
          iss: did,
          aud,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + expDelta,
        })
      )
    );
    const sig = await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      te.encode(`${header}.${payload}`)
    );
    return `${header}.${payload}.${b64url(sig)}`;
  };
  return { did, mintServiceAuth };
}

/** Extractable P-256 custody key + proof factory (stands in for the browser worker). */
async function makeDpopSigner() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk = { kty: "EC", crv: "P-256", x: pub.x!, y: pub.y! };
  const jkt = await computeJwkThumbprint(jwk);
  const proof = async (method: string, url: string, jti = crypto.randomUUID()) => {
    const header = b64url(te.encode(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })));
    const payload = b64url(
      te.encode(JSON.stringify({ htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti }))
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      te.encode(`${header}.${payload}`)
    );
    return `${header}.${payload}.${b64url(sig)}`;
  };
  return { jwk, jkt, proof };
}

async function postAtpVerify(body: Record<string, unknown>) {
  const res = await workerExports.default.fetch("https://example.com/auth/atp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie") ?? "",
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("client-side OAuth lane (serviceAuth + DPoP binding)", () => {
  beforeAll(async () => {
    await ensureD1Migrations(env);
  });

  it("issues a DPoP-bound dg_session from a valid serviceAuth JWT", async () => {
    const { did, mintServiceAuth } = await makeIdentity();
    const { jwk } = await makeDpopSigner();
    const jwt = await mintServiceAuth("did:web:example.com#delta_git");

    const res = await postAtpVerify({ did, jwt, dpop_jwk: jwk });
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(did);
    expect(res.body.dpop_bound).toBe(true);
    expect(res.cookie).toContain("dg_session=");
  });

  it("rejects a serviceAuth JWT bound to a different audience", async () => {
    const { did, mintServiceAuth } = await makeIdentity();
    const jwt = await mintServiceAuth("did:web:attacker.example#other");
    const res = await postAtpVerify({ did, jwt });
    expect(res.status).toBe(401);
  });

  it("rejects a serviceAuth JWT signed by a different DID's key", async () => {
    const a = await makeIdentity();
    const b = await makeIdentity();
    const jwt = await a.mintServiceAuth("did:web:example.com#delta_git");
    // Claim B's DID but present A's signature — iss check fails first.
    const res = await postAtpVerify({ did: b.did, jwt });
    expect(res.status).toBe(401);
  });

  it("rejects replay of the same serviceAuth JWT", async () => {
    const { did, mintServiceAuth } = await makeIdentity();
    const jwt = await mintServiceAuth("did:web:example.com#delta_git");
    expect((await postAtpVerify({ did, jwt })).status).toBe(200);
    expect((await postAtpVerify({ did, jwt })).status).toBe(401);
  });

  it("bound sessions reject cookie-only requests and accept DPoP proofs", async () => {
    const { did, mintServiceAuth } = await makeIdentity();
    const signer = await makeDpopSigner();
    const jwt = await mintServiceAuth("did:web:example.com#delta_git");
    const verify = await postAtpVerify({ did, jwt, dpop_jwk: signer.jwk });
    expect(verify.status).toBe(200);
    const cookie = verify.cookie.split(";")[0];

    // Cookie alone → rejected (the session is bound; no proof presented).
    const bare = await workerExports.default.fetch("https://example.com/api/v1/user", {
      headers: { Cookie: cookie },
    });
    expect(bare.status).toBe(401);

    // Cookie + valid proof for this exact request → authenticated.
    const proof = await signer.proof("GET", "https://example.com/api/v1/user");
    const authed = await workerExports.default.fetch("https://example.com/api/v1/user", {
      headers: { Cookie: cookie, DPoP: proof },
    });
    expect(authed.status).toBe(200);

    // Replaying the same proof (jti already consumed) → rejected.
    const replay = await workerExports.default.fetch("https://example.com/api/v1/user", {
      headers: { Cookie: cookie, DPoP: proof },
    });
    expect(replay.status).toBe(401);
  });

  it("a proof from an unbound key does not satisfy a bound session", async () => {
    const { did, mintServiceAuth } = await makeIdentity();
    const bound = await makeDpopSigner();
    const other = await makeDpopSigner();
    const jwt = await mintServiceAuth("did:web:example.com#delta_git");
    const verify = await postAtpVerify({ did, jwt, dpop_jwk: bound.jwk });
    const cookie = verify.cookie.split(";")[0];

    const foreignProof = await other.proof("GET", "https://example.com/api/v1/user");
    const res = await workerExports.default.fetch("https://example.com/api/v1/user", {
      headers: { Cookie: cookie, DPoP: foreignProof },
    });
    expect(res.status).toBe(401);
  });
});
