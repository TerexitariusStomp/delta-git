import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { newPrefixedId } from "@/worker/common";
import { createDb } from "@/worker/db/d1/client";
import { insertUserIfNew, claimNamespace, insertMembershipIfMissing } from "@/worker/db/d1/dal";

import { ensureD1Migrations } from "./util/d1Setup";
import { mintSessionCookie, seedRepo } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";

beforeAll(async () => {
  await ensureD1Migrations(env);
});

async function makeMember(
  namespaceSlug: string
): Promise<{ userId: string; cookieHeader: string }> {
  const db = createDb(env.DB);
  const userId = newPrefixedId("user");
  const namespaceId = newPrefixedId("ns");
  const now = Date.now();
  await insertUserIfNew(db, { id: userId, tesseraSub: `t-${userId}`, createdAt: now });
  const claimed = await claimNamespace(db, {
    id: namespaceId,
    slug: namespaceSlug,
    createdBy: userId,
    createdAt: now,
  });
  if (!claimed) throw new Error(`namespace ${namespaceSlug} already exists`);
  await insertMembershipIfMissing(db, {
    namespaceId: claimed.id,
    userId,
    createdAt: now,
  });
  return { userId, cookieHeader: await mintSessionCookie(env, userId) };
}

// Post-cutover the per-file patch JSON route (`/commit/:oid/diff?path=`) is
// gone and with it the `/_cache/commit-patch` lane. The surviving invariant:
// private-repo responses are never shared-cacheable — the facade stamps
// `Cache-Control: no-store` on every response resolved through a private
// repo's access bundle.
describe("cache-policy: private repos bypass shared cache", () => {
  it("private repo facade responses carry Cache-Control: no-store", async () => {
    const ns = `cp-diff-${Math.random().toString(36).slice(2, 8)}`;
    const member = await makeMember(ns);
    const repoSlug = "site";
    await seedRepo(env, {
      namespaceSlug: ns,
      repoSlug,
      userId: member.userId,
      visibility: "private",
    });
    const repoId = `${ns}/${repoSlug}`;
    const seeded = await seedPackFirstRepo(repoId);

    const res = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ns}/${repoSlug}/+/commits/${seeded.nextCommit.oid}/diff`,
      { headers: { Cookie: member.cookieHeader } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("README.md");
  });

  it("public-then-private flip: post-flip reads are no-store and stay member-only", async () => {
    const ns = `cp-flip-${Math.random().toString(36).slice(2, 8)}`;
    const member = await makeMember(ns);
    const repoSlug = "site";
    const seedRow = await seedRepo(env, {
      namespaceSlug: ns,
      repoSlug,
      userId: member.userId,
      visibility: "public",
    });
    const repoId = `${ns}/${repoSlug}`;
    const seeded = await seedPackFirstRepo(repoId);

    const publicRes = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ns}/${repoSlug}/+/commits/${seeded.nextCommit.oid}/diff`
    );
    expect(publicRes.status).toBe(200);

    // Flip to private.
    const flipRes = await workerExports.default.fetch(
      `https://example.com/auth/api/repositories/${encodeURIComponent(seedRow.repositoryId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          Cookie: member.cookieHeader,
        },
        body: JSON.stringify({ visibility: "private" }),
      }
    );
    expect(flipRes.status).toBe(200);

    // Anonymous read after flip must not disclose the repo at all.
    const anonPrivate = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ns}/${repoSlug}/+/commits/${seeded.nextCommit.oid}/diff`,
      { redirect: "manual" }
    );
    expect(anonPrivate.status).toBe(404);

    // Member read after flip: real diff body, marked no-store.
    const privateRes = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ns}/${repoSlug}/+/commits/${seeded.nextCommit.oid}/diff`,
      { headers: { Cookie: member.cookieHeader } }
    );
    expect(privateRes.status).toBe(200);
    expect(privateRes.headers.get("Cache-Control")).toBe("no-store");
    const body = await privateRes.text();
    expect(body).toContain("README.md");
    expect(body).toContain("version two");
  });
});
