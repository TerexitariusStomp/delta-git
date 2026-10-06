// OAuth 2.1 provider tests — delta-git as its own authorization server via
// @cloudflare/workers-oauth-provider. Covers discovery, DCR, the consent API
// (info/decision), code exchange, bearer auth on the git surface (including
// scope + namespace ACL gates), and the DPoP sender constraint on API paths.
import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests } from "./util/repoSeed";

const ORIGIN = "https://example.com";
const REDIRECT_URI = "https://client.example/cb";

function request(path: string, init?: RequestInit): Promise<Response> {
  return workerExports.default.fetch(`${ORIGIN}${path}`, init);
}

const te = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256b64url(input: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(input))));
}

/** Cookie header: the session cookie plus any Set-Cookie crumbs a prior
 *  response emitted (the consent binding cookie comes back on /info). */
function withSetCookies(base: string, res: Response): string {
  const extra = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean);
  return [base, ...extra].join("; ");
}

interface DpopKey {
  pair: CryptoKeyPair;
  jwk: { kty?: string; crv?: string; x?: string; y?: string };
}

async function makeDpopKey(): Promise<DpopKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as DpopKey["jwk"];
  return { pair, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function dpopProof(key: DpopKey, htm: string, htu: string): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };
  const input = `${b64url(te.encode(JSON.stringify(header)))}.${b64url(
    te.encode(JSON.stringify(payload))
  )}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.pair.privateKey,
    te.encode(input)
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function registerClient(): Promise<string> {
  const res = await request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test-agent",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json()) as { client_id?: string; error?: string };
  expect(res.status, `register failed: ${JSON.stringify(body)}`).toBe(201);
  expect(body.client_id).toBeTruthy();
  return body.client_id!;
}

interface GrantResult {
  accessToken: string;
  refreshToken?: string;
}

/** Full consent round-trip: /oauth/authorize/info → /decision → /token. */
async function runGrantFlow(
  cookie: string,
  clientId: string,
  scope = "repo:read repo:write offline_access",
  dpop?: DpopKey
): Promise<GrantResult> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256b64url(verifier);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: ORIGIN,
  });
  const info = await request(`/oauth/authorize/info?${q}`, {
    headers: { Cookie: cookie },
  });
  const infoBody = (await info.json()) as {
    handle?: string;
    error?: string;
    client?: { name: string };
  };
  expect(info.status, `info failed: ${JSON.stringify(infoBody)}`).toBe(200);
  expect(infoBody.handle).toBeTruthy();

  const decision = await request("/oauth/authorize/decision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: withSetCookies(cookie, info),
    },
    body: JSON.stringify({ handle: infoBody.handle, approve: true }),
  });
  const decisionBody = (await decision.json()) as { redirect?: string; error?: string };
  expect(decision.status, `decision failed: ${JSON.stringify(decisionBody)}`).toBe(200);
  const redirect = new URL(decisionBody.redirect!);
  expect(redirect.searchParams.get("state")).toBe("test-state");
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (dpop) tokenHeaders.DPoP = await dpopProof(dpop, "POST", `${ORIGIN}/oauth/token`);
  const token = await request("/oauth/token", {
    method: "POST",
    headers: tokenHeaders,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  const tokenBody = (await token.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  expect(
    token.status,
    `token failed: ${JSON.stringify(tokenBody)}`
  ).toBe(200);
  return { accessToken: tokenBody.access_token!, refreshToken: tokenBody.refresh_token };
}

function infoRefs(ns: string, repo: string): string {
  return `/${ns}/${repo}/info/refs?service=git-upload-pack`;
}

describe("oauth provider", () => {
  beforeAll(async () => {
    await ensureD1Migrations(env);
  });

  it("serves RFC 8414 + RFC 9728 metadata", async () => {
    const meta = await request("/.well-known/oauth-authorization-server");
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);

    const resource = await request("/.well-known/oauth-protected-resource");
    expect(resource.status).toBe(200);
    const rbody = (await resource.json()) as Record<string, unknown>;
    expect(rbody.resource).toBe(ORIGIN);
  });

  it("authorize/info rejects unauthenticated callers", async () => {
    const res = await request(
      `/oauth/authorize/info?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    );
    expect(res.status).toBe(401);
  });

  it("completes consent → code → token and accepts bearer on a private repo", async () => {
    const seeded = await setupRepoForTests(
      env,
      `oauth-ns-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const clientId = await registerClient();
    const { accessToken } = await runGrantFlow(seeded.cookieHeader, clientId);

    // Bearer with repo:read scope + membership → private repo fetch works.
    const res = await request(infoRefs(seeded.namespaceSlug, seeded.repoSlug), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects bearer on a private repo in a foreign namespace (403)", async () => {
    const mine = await setupRepoForTests(
      env,
      `oauth-own-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const foreign = await setupRepoForTests(
      env,
      `oauth-foreign-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const clientId = await registerClient();
    const { accessToken } = await runGrantFlow(mine.cookieHeader, clientId);

    const res = await request(infoRefs(foreign.namespaceSlug, foreign.repoSlug), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // Proven identity + no membership → 403, same as PAT grant-missing.
    expect(res.status).toBe(403);
  });

  it("denies receive-pack when the grant lacks repo:write", async () => {
    const seeded = await setupRepoForTests(
      env,
      `oauth-ro-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const clientId = await registerClient();
    const { accessToken } = await runGrantFlow(
      seeded.cookieHeader,
      clientId,
      "repo:read offline_access"
    );

    // Reads pass, pushes don't.
    const read = await request(infoRefs(seeded.namespaceSlug, seeded.repoSlug), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(read.status).toBe(200);
    const push = await request(
      `/${seeded.namespaceSlug}/${seeded.repoSlug}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: `Bearer ${accessToken}`,
        },
        body: "",
      }
    );
    expect([401, 403]).toContain(push.status);
  });

  it("DPoP-bound tokens need a proof on API surfaces but not on git", async () => {
    const seeded = await setupRepoForTests(
      env,
      `oauth-dpop-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const clientId = await registerClient();
    const key = await makeDpopKey();
    const { accessToken } = await runGrantFlow(seeded.cookieHeader, clientId, undefined, key);

    // Git transport: bare bearer works (can't mint per-request proofs).
    const gitRead = await request(infoRefs(seeded.namespaceSlug, seeded.repoSlug), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(gitRead.status).toBe(200);

    // API surface: bound token without a proof is rejected.
    const apiNoProof = await request(
      `/api/v3/repos/${seeded.namespaceSlug}/${seeded.repoSlug}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    expect(apiNoProof.status).toBe(401);

    // With a valid proof it passes.
    const apiProof = await request(
      `/api/v3/repos/${seeded.namespaceSlug}/${seeded.repoSlug}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          DPoP: await dpopProof(
            key,
            "GET",
            `${ORIGIN}/api/v3/repos/${seeded.namespaceSlug}/${seeded.repoSlug}`
          ),
        },
      }
    );
    expect(apiProof.status).toBe(200);
  });

  it("deny decision returns an error redirect", async () => {
    const seeded = await setupRepoForTests(
      env,
      `oauth-deny-${Math.random().toString(36).slice(2, 8)}`,
      "site"
    );
    const clientId = await registerClient();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "repo:read",
      state: "st",
      code_challenge: await sha256b64url("v"),
      code_challenge_method: "S256",
    });
    const info = await request(`/oauth/authorize/info?${q}`, {
      headers: { Cookie: seeded.cookieHeader },
    });
    const infoBody = (await info.json()) as { handle?: string };
    const decision = await request("/oauth/authorize/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: withSetCookies(seeded.cookieHeader, info),
      },
      body: JSON.stringify({ handle: infoBody.handle, approve: false }),
    });
    expect(decision.status).toBe(200);
    const body = (await decision.json()) as { redirect?: string };
    const redirect = new URL(body.redirect!);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects an invalid bearer token", async () => {
    const seeded = await setupRepoForTests(
      env,
      `oauth-bad-${Math.random().toString(36).slice(2, 8)}`,
      "site",
      { visibility: "private" }
    );
    const res = await request(infoRefs(seeded.namespaceSlug, seeded.repoSlug), {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect([401, 404]).toContain(res.status);
  });
});
