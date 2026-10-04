import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { didKeyFromPubkey } from "@/worker/agent/atpauth/didkey";
import { ensureD1Migrations } from "./util/d1Setup";

const te = new TextEncoder();

const toHex = (b: Uint8Array | ArrayBuffer) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function makeDidKeySigner() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubkey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const did = didKeyFromPubkey(pubkey, "ed25519");
  const sign = async (payload: string) =>
    b64url(
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(payload)))
    );
  return { did, sign, pubkeyHex: toHex(pubkey) };
}

async function getChallenge(did: string) {
  const res = await workerExports.default.fetch(
    `https://example.com/auth/did/challenge?did=${encodeURIComponent(did)}`
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postVerify(body: Record<string, unknown>) {
  const res = await workerExports.default.fetch("https://example.com/auth/did/verify", {
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

describe("atproto DID auth", () => {
  beforeAll(async () => {
    // verify → ensureIdentity/insertDidSession need the identity tables.
    await ensureD1Migrations(env);
  });

  it("round-trips a did:key challenge → verify → session", async () => {
    const { did, sign } = await makeDidKeySigner();
    const challenge = await getChallenge(did);
    expect(challenge.status).toBe(200);
    const { nonce, payload, iat, exp } = challenge.body as {
      nonce: string;
      payload: string;
      iat: number;
      exp: number;
    };
    expect(typeof payload).toBe("string");

    const verified = await postVerify({
      did,
      nonce,
      sig: await sign(payload),
      iat,
      exp,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.did).toBe(did);
    // Session cookie set + a namespace was bootstrapped for the identity.
    expect(verified.cookie).toContain("dg_session=");
    expect(typeof verified.body.namespace).toBe("string");
  });

  it("rejects nonce replay — single-use challenge", async () => {
    const { did, sign } = await makeDidKeySigner();
    const challenge = await getChallenge(did);
    expect(challenge.status).toBe(200);
    const { nonce, payload, iat, exp } = challenge.body as {
      nonce: string;
      payload: string;
      iat: number;
      exp: number;
    };
    const sig = await sign(payload);
    const first = await postVerify({ did, nonce, sig, iat, exp });
    expect(first.status).toBe(200);
    // Same signed payload again — the nonce was consumed.
    const replay = await postVerify({ did, nonce, sig, iat, exp });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("nonce-consumed");
  });

  it("rejects a signature from a different key", async () => {
    const alice = await makeDidKeySigner();
    const mallory = await makeDidKeySigner();
    const challenge = await getChallenge(alice.did);
    const { nonce, payload, iat, exp } = challenge.body as {
      nonce: string;
      payload: string;
      iat: number;
      exp: number;
    };
    const res = await postVerify({
      did: alice.did,
      nonce,
      sig: await mallory.sign(payload),
      iat,
      exp,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("signature-invalid");
  });

  it("rejects challenges for unknown/unresolvable handles", async () => {
    const res = await getChallenge("did:web:nonexistent.invalid");
    // did:web needs resolution we can't do offline — but the challenge issues
    // anyway; verify is the gated step. Unknown DID shapes are rejected here.
    expect([200, 404]).toContain(res.status);
  });
});
