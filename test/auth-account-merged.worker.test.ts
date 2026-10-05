import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __test as oidcTest } from "@/worker/auth/oidc";

import { fakeProvider } from "./util/oidcFake";
import { readAppD1Migrations } from "./util/d1Migrations";
import {
  extractSessionToken,
  oidcTransactionCookieHeader,
  sessionCookieHeader,
} from "./util/authCookies";

beforeAll(async () => {
  await applyD1Migrations(env.DB, readAppD1Migrations());
});

beforeEach(() => {
  oidcTest.setProviderForTesting(
    {
      issuer: env.TESSERA_OIDC_ISSUER,
      clientId: env.TESSERA_OIDC_CLIENT_ID,
      clientSecret: env.TESSERA_OIDC_CLIENT_SECRET,
    },
    fakeProvider({
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      jwksUri: "https://auth.example.com/.well-known/jwks.json",
    })
  );
});

afterEach(() => {
  oidcTest.clearProviderCache();
  oidcTest.setAuthorizationCodeGrantImpl(null);
});

async function signIn(sub: string, preferredUsername?: string): Promise<string> {
  const state = `state-${sub}`;
  const cookie = await oidcTransactionCookieHeader(env.TESSERA_OIDC_CLIENT_SECRET, {
    state,
    nonce: "n",
    codeVerifier: "v",
    redirectUri: "https://example.com/auth/callback",
    createdAt: Date.now(),
  });
  oidcTest.setAuthorizationCodeGrantImpl(async () => {
    const claims = preferredUsername ? { sub, preferred_username: preferredUsername } : { sub };
    return {
      access_token: "fake",
      token_type: "Bearer",
      claims: () => claims,
    } as unknown as Awaited<ReturnType<typeof import("openid-client").authorizationCodeGrant>>;
  });
  const url = new URL("https://example.com/auth/callback");
  url.searchParams.set("code", "x");
  url.searchParams.set("state", state);
  const res = await workerExports.default.fetch(url.toString(), {
    redirect: "manual",
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(302);
  const token = extractSessionToken(res.headers.get("set-cookie"));
  expect(token).toBeTruthy();
  return token!;
}

describe("/auth/account post-cutover", () => {
  it("redirects a signed-in viewer to the SPA profile settings", async () => {
    const token = await signIn("sub-merged-1", "merged-rachel");
    const res = await workerExports.default.fetch("https://example.com/auth/account", {
      headers: { Cookie: sessionCookieHeader(token) },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/profile-settings/general");
  });

  it("redirects anonymous viewers to /auth", async () => {
    const res = await workerExports.default.fetch("https://example.com/auth/account", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth");
  });

  it("exposes the signed-in identity through /api/v1/user for the SPA", async () => {
    const token = await signIn("sub-merged-api", "merged-api-rachel");
    const res = await workerExports.default.fetch("https://example.com/api/v1/user", {
      headers: { Cookie: sessionCookieHeader(token) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { display_name?: string };
    expect(body.display_name).toBe("merged-api-rachel");
  });

  it("/auth/tokens stays a 404 inside the reserved auth namespace", async () => {
    const token = await signIn("sub-tokens-route-gone", "route-gone");
    const res = await workerExports.default.fetch("https://example.com/auth/tokens", {
      headers: { Cookie: sessionCookieHeader(token) },
      redirect: "manual",
    });
    // `/auth/*` is a non-SPA namespace — the SPA fallback must not serve
    // index.html here, and no SSR tokens page exists anymore.
    expect(res.status).toBe(404);
  });
});
