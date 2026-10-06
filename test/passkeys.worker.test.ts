import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { createDb } from "@/worker/db/d1/client";
import { insertPasskey, listPasskeys } from "@/worker/db/d1/dal/passkeys";
import { newPrefixedId } from "@/worker/common";
import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests } from "./util/repoSeed";

// Passkey ceremony coverage: options issuance, challenge consumption, and a
// real end-to-end login — we fabricate the authenticator (ES256 key, COSE
// pubkey, authenticatorData, DER signature) in-test so the server verifies a
// genuinely valid WebAuthn assertion.

const te = new TextEncoder();

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Minimal fixed-shape COSE_Key for ES256: {1:2 (kty EC2), 3:-7 (alg ES256),
// -1:1 (crv P-256), -2:x, -3:y}. Keys are small ints so the map encodes
// without a general CBOR writer.
function coseEc2(x: Uint8Array, y: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 2 + 2 + 2 + 3 + x.length + 3 + y.length);
  let i = 0;
  out[i++] = 0xa5; // map(5)
  out[i++] = 0x01;
  out[i++] = 0x02; // 1: 2 (kty EC2)
  out[i++] = 0x03;
  out[i++] = 0x26; // 3: -7 (ES256)
  out[i++] = 0x20;
  out[i++] = 0x01; // -1: 1 (P-256)
  out[i++] = 0x21;
  out[i++] = 0x58;
  out[i++] = 32; // -2: bstr(32)
  out.set(x, i);
  i += 32;
  out[i++] = 0x22;
  out[i++] = 0x58;
  out[i++] = 32; // -3: bstr(32)
  out.set(y, i);
  return out;
}

// WebCrypto returns IEEE-P1363 (r||s); WebAuthn needs ASN.1 DER.
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const int = (b: Uint8Array) => {
    let start = 0;
    while (start < b.length - 1 && b[start] === 0) start++;
    const v = b.slice(start);
    const der = new Uint8Array(2 + v.length + (v[0] & 0x80 ? 1 : 0));
    der[0] = 0x02;
    der[1] = v.length + (v[0] & 0x80 ? 1 : 0);
    if (v[0] & 0x80) der[2] = 0;
    der.set(v, 2 + (v[0] & 0x80 ? 1 : 0));
    return der;
  };
  const r = int(sig.slice(0, half));
  const s = int(sig.slice(half));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown; cookie: string | null }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: res.headers.get("set-cookie"),
  };
}

let userId: string;
let sessionCookie: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  const seeded = await setupRepoForTests(env, `pk-ns-${Date.now().toString(36)}`, "pkrepo");
  userId = seeded.userId;
  sessionCookie = seeded.cookieHeader;
});

describe("passkeys: webauthn ceremonies", () => {
  it("issues registration options to a signed-in user and rejects anon", async () => {
    const anon = await call("POST", "/auth/api/passkeys/register/options", { body: {} });
    expect(anon.status).toBe(401);

    const res = await call("POST", "/auth/api/passkeys/register/options", {
      cookie: sessionCookie,
      body: {},
    });
    expect(res.status).toBe(200);
    const opts = res.body as { challenge: string; rp: { id: string }; user: { name: string } };
    expect(opts.challenge.length).toBeGreaterThan(10);
    expect(opts.rp.id).toBe("example.com");
  });

  it("lists and deletes own passkeys", async () => {
    const listed = await call("GET", "/auth/api/passkeys", { cookie: sessionCookie });
    expect(listed.status).toBe(200);
    expect((listed.body as { passkeys: unknown[] }).passkeys).toHaveLength(0);

    const missing = await call("DELETE", "/auth/api/passkeys/pk_nope", {
      cookie: sessionCookie,
    });
    expect(missing.status).toBe(404);
  });

  it("signs in with a fabricated authenticator end-to-end", async () => {
    const db = createDb(env.DB);

    // Authenticator: ES256 key + credential id, stored as a passkey row.
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
    const rawPub = new Uint8Array(
      await crypto.subtle.exportKey("raw", (key as CryptoKeyPair).publicKey)
    );
    const x = rawPub.slice(1, 33);
    const y = rawPub.slice(33, 65);
    const credentialId = b64url(crypto.getRandomValues(new Uint8Array(24)));
    await insertPasskey(db, {
      id: newPrefixedId("pk"),
      userId,
      credentialId,
      publicKey: b64url(coseEc2(x, y)),
      counter: 0,
      transports: "internal",
      name: "test key",
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    expect(await listPasskeys(db, userId)).toHaveLength(1);

    // Login ceremony: options → assertion with a real signature.
    const optionsRes = await call("POST", "/auth/api/passkeys/login/options", { body: {} });
    expect(optionsRes.status).toBe(200);
    const challenge = (optionsRes.body as { challenge: string }).challenge;

    const clientData = te.encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: "https://example.com",
        crossOrigin: false,
      })
    );
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", te.encode("example.com"))
    );
    const authData = new Uint8Array(37);
    authData.set(rpIdHash, 0);
    authData[32] = 0x05; // UP | UV
    new DataView(authData.buffer).setUint32(33, 41); // signCount = 41

    const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
    const signed = new Uint8Array(authData.length + clientHash.length);
    signed.set(authData, 0);
    signed.set(clientHash, authData.length);
    const sigRaw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        (key as CryptoKeyPair).privateKey,
        signed
      )
    );

    const verify = await call("POST", "/auth/api/passkeys/login/verify", {
      body: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            clientDataJSON: b64url(clientData),
            authenticatorData: b64url(authData),
            signature: b64url(p1363ToDer(sigRaw)),
            userHandle: b64url(te.encode(userId)),
          },
          clientExtensionResults: {},
        },
      },
    });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    const ok = verify.body as { ok: boolean; session: string };
    expect(ok.ok).toBe(true);
    expect(ok.session).toContain("goc_sess_");

    // Counter advanced past the seeded 0.
    expect((await listPasskeys(db, userId))[0].counter).toBe(41);

    // Replaying the same clientData fails — the challenge was consumed.
    const replay = await call("POST", "/auth/api/passkeys/login/verify", {
      body: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: {
            clientDataJSON: b64url(clientData),
            authenticatorData: b64url(authData),
            signature: b64url(p1363ToDer(sigRaw)),
          },
          clientExtensionResults: {},
        },
      },
    });
    expect(replay.status).toBe(403);
    expect((replay.body as { error: string }).error).toBe("challenge_expired");
  });
});
