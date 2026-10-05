import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Strict-E2E private repos: wrap-pubkey registry, per-member wrapped repo
// keys, the opaque enc/ chunk plane, and smart-HTTP refusal. All payloads
// are opaque to the server — the test uses stand-in ciphertext.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function api(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
  raw?: boolean
): Promise<{ status: number; body: unknown; text?: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (raw) return { status: res.status, body: null, text };
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const FAKE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1XM_bX6pA4d0P1wJqZ7jKQ",
  y: "x_FEzRu9O8Q1xB2C3d4E5F6g7H8i9J0k1L2m3N4o5P6q",
};

describe("e2e encrypted private repos", () => {
  let w: SetupRepoForTestsResult;
  let ns: string;

  beforeAll(async () => {
    await ensureD1Migrations(env);
    w = await setupRepoForTests(env, uniq("e2e-ns"), "e2erepo");
    ns = w.namespaceSlug;
  });

  it("wrapkey registry — publish, read own, read by uid", async () => {
    const anon = await api("PUT", "/api/v1/user/wrapkey", undefined, { jwk: FAKE_JWK });
    expect(anon.status).toBe(401);

    const bad = await api("PUT", "/api/v1/user/wrapkey", w.cookieHeader, {
      jwk: { kty: "RSA" },
    });
    expect(bad.status).toBe(400);

    const put = await api("PUT", "/api/v1/user/wrapkey", w.cookieHeader, { jwk: FAKE_JWK });
    expect(put.status).toBe(200);

    const own = await api("GET", "/api/v1/user/wrapkey", w.cookieHeader);
    expect(own.status).toBe(200);
    expect((own.body as { jwk: { x: string } }).jwk.x).toBe(FAKE_JWK.x);

    // Resolvable by the member's namespace slug too.
    const bySlug = await api("GET", `/api/v1/users/${ns}/wrapkey`, w.cookieHeader);
    expect(bySlug.status).toBe(200);
    expect((bySlug.body as { jwk: { x: string } }).jwk.x).toBe(FAKE_JWK.x);
  });

  it("encrypted repo — create flag, repokey round-trip, chunks, git refusal", async () => {
    const created = await api("POST", "/api/v1/repos", w.cookieHeader, {
      identifier: "secretrepo",
      parent_ref: ns,
      is_public: false,
      encrypted: true,
    });
    expect(created.status).toBe(200);
    expect((created.body as { is_encrypted?: boolean }).is_encrypted).toBe(true);

    const ref = `${ns}/secretrepo/+`;

    // Smart-HTTP refuses — anonymous gets the privacy 404 (non-disclosure);
    // PAT-authorized users get the explicit E2E refusal (git endpoints speak
    // PAT Basic auth, not session cookies).
    const git = await api(
      "GET",
      `/${ns}/secretrepo.git/info/refs?service=git-upload-pack`,
      undefined,
      undefined,
      true
    );
    expect(git.status).toBe(404);
    const gitAuthed = await workerExports.default.fetch(
      `https://example.com/${ns}/secretrepo.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: w.pushAuthHeader } }
    );
    expect(gitAuthed.status).toBe(403);
    expect(await gitAuthed.text()).toContain("end-to-end encrypted");

    // Wrapped repo key round-trip.
    const putKey = await api("PUT", `/api/v1/repos/${ref}/keys/me`, w.cookieHeader, {
      wrapped: "opaque-wrapped-blob",
    });
    expect(putKey.status).toBe(200);

    const myKey = await api("GET", `/api/v1/repos/${ref}/keys/me`, w.cookieHeader);
    expect(myKey.status).toBe(200);
    expect((myKey.body as { wrapped: string }).wrapped).toBe("opaque-wrapped-blob");

    const listed = await api("GET", `/api/v1/repos/${ref}/keys`, w.cookieHeader);
    expect((listed.body as unknown[]).length).toBe(1);

    // Store a wrapped copy for another member (by their user id or slug).
    const grant = await api("PUT", `/api/v1/repos/${ref}/keys/${ns}`, w.cookieHeader, {
      wrapped: "member-copy",
    });
    expect(grant.status).toBe(200);
    const listed2 = await api("GET", `/api/v1/repos/${ref}/keys`, w.cookieHeader);
    // Same member (self slug) — still one slot.
    expect((listed2.body as unknown[]).length).toBe(1);

    // Opaque chunk plane.
    const putChunk = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ref}/objects/pack/test.pack`,
      {
        method: "PUT",
        headers: { Cookie: w.cookieHeader, "Content-Type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }
    );
    expect(putChunk.status).toBe(200);

    const listChunks = await api("GET", `/api/v1/repos/${ref}/objects`, w.cookieHeader);
    expect(listChunks.status).toBe(200);
    const keys = (listChunks.body as Array<{ key: string }>).map((k) => k.key);
    expect(keys).toContain("pack/test.pack");

    const getChunk = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ref}/objects/pack/test.pack`,
      { headers: { Cookie: w.cookieHeader } }
    );
    expect(getChunk.status).toBe(200);
    const bytes = new Uint8Array(await getChunk.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(getChunk.headers.get("Cache-Control")).toBe("no-store");

    const delChunk = await api(
      "DELETE",
      `/api/v1/repos/${ref}/objects/pack/test.pack`,
      w.cookieHeader
    );
    expect(delChunk.status).toBe(200);
  });

  it("non-encrypted repo refuses the enc chunk plane", async () => {
    const ref = `${ns}/e2erepo/+`;
    const res = await api("GET", `/api/v1/repos/${ref}/objects`, w.cookieHeader);
    expect(res.status).toBe(400);
    expect(String((res.body as { message?: string })?.message ?? "")).toContain("not encrypted");
  });
});
