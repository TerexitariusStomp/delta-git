import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { newPrefixedId } from "@/worker/common";
import { createDb } from "@/worker/db/d1/client";
import { claimNamespace, insertMembershipIfMissing, insertUserIfNew } from "@/worker/db/d1/dal";

import { ensureD1Migrations } from "./util/d1Setup";
import { mintSessionCookie, setupRepoForTests } from "./util/repoSeed";

beforeAll(async () => {
  await ensureD1Migrations(env);
});

async function makeOutsider(): Promise<string> {
  const db = createDb(env.DB);
  const userId = newPrefixedId("user");
  const namespaceId = newPrefixedId("ns");
  const slug = `out-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  await insertUserIfNew(db, { id: userId, tesseraSub: `t-${userId}`, createdAt: now });
  const claimed = await claimNamespace(db, {
    id: namespaceId,
    slug,
    createdBy: userId,
    createdAt: now,
  });
  if (!claimed) throw new Error("namespace already exists");
  await insertMembershipIfMissing(db, { namespaceId: claimed.id, userId, createdAt: now });
  return await mintSessionCookie(env, userId);
}

// The SSR repo/admin pages are gone; the same disclosure rules now live at
// the /api/v1 facade via resolveUiRepoAccess (repo reads) and requireWriter
// (member-gated writes). These tests keep that coverage on the new surface.

const repoApi = (owner: string, repo: string) =>
  `https://example.com/api/v1/repos/${owner}/${repo}/+`;

const memberGatedApi = (owner: string, repo: string) => ({
  url: `${repoApi(owner, repo)}/webhooks`,
  init: {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body: JSON.stringify({ identifier: "w", url: "https://hooks.example.com/x" }),
  },
});

describe("repo read disclosure (GET /api/v1/repos/:ref)", () => {
  it("anonymous + public repo + missing route cache -> 404", async () => {
    const owner = `dis-route-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, {
      visibility: "public",
      skipRouteCache: true,
    });
    const res = await workerExports.default.fetch(repoApi(owner, repo));
    expect(res.status).toBe(404);
  });

  it("repo JSON never carries receive-lease state, regardless of viewer", async () => {
    const owner = `dis-act-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    const seeded = await setupRepoForTests(env, owner, repo, { visibility: "public" });
    for (const headers of [{}, { Cookie: seeded.cookieHeader }]) {
      const res = await workerExports.default.fetch(repoApi(owner, repo), { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toMatch(/receiveLease|activityBanner|receiving/i);
    }
  });
});

describe("member-gated API disclosure (POST /api/v1/repos/:ref/webhooks)", () => {
  it("anonymous + private repo -> 404 (no auth oracle)", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const { url, init } = memberGatedApi(owner, repo);
    const res = await workerExports.default.fetch(url, init);
    expect(res.status).toBe(404);
  });

  it("anonymous + public repo -> 401", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "public" });
    const { url, init } = memberGatedApi(owner, repo);
    const res = await workerExports.default.fetch(url, init);
    expect(res.status).toBe(401);
  });

  it("signed-in non-member + private repo -> 404", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const outsider = await makeOutsider();
    const { url, init } = memberGatedApi(owner, repo);
    const res = await workerExports.default.fetch(url, {
      ...init,
      headers: { ...init.headers, Cookie: outsider },
    });
    expect(res.status).toBe(404);
  });

  it("signed-in non-member + public repo -> 403", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "public" });
    const outsider = await makeOutsider();
    const { url, init } = memberGatedApi(owner, repo);
    const res = await workerExports.default.fetch(url, {
      ...init,
      headers: { ...init.headers, Cookie: outsider },
    });
    expect(res.status).toBe(403);
  });

  it("member + private repo -> not gated", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    const seeded = await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const { url, init } = memberGatedApi(owner, repo);
    const res = await workerExports.default.fetch(url, {
      ...init,
      headers: { ...init.headers, Cookie: seeded.cookieHeader },
    });
    // Membership clears the gate; any 4xx here would come from validation,
    // not disclosure rules.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("member + private repo + missing route cache -> readable", async () => {
    const owner = `dis-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    const seeded = await setupRepoForTests(env, owner, repo, {
      visibility: "private",
      skipRouteCache: true,
    });
    const res = await workerExports.default.fetch(repoApi(owner, repo), {
      headers: { Cookie: seeded.cookieHeader },
    });
    expect(res.status).toBe(200);
  });
});

describe("admin JSON endpoints disclosure (GET admin/refs as a representative)", () => {
  it("anonymous + private -> 404", async () => {
    const owner = `disj-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/refs`
    );
    expect(res.status).toBe(404);
  });

  it("anonymous + public -> 401", async () => {
    const owner = `disj-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "public" });
    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/refs`
    );
    expect(res.status).toBe(401);
  });

  it("signed-in non-member + private -> 404", async () => {
    const owner = `disj-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "private" });
    const outsider = await makeOutsider();
    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/refs`,
      { headers: { Cookie: outsider } }
    );
    expect(res.status).toBe(404);
  });

  it("signed-in non-member + public -> 403", async () => {
    const owner = `disj-${Math.random().toString(36).slice(2, 8)}`;
    const repo = "site";
    await setupRepoForTests(env, owner, repo, { visibility: "public" });
    const outsider = await makeOutsider();
    const res = await workerExports.default.fetch(
      `https://example.com/${owner}/${repo}/admin/refs`,
      { headers: { Cookie: outsider } }
    );
    expect(res.status).toBe(403);
  });
});
