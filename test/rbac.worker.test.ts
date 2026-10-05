import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { createDb } from "@/worker/db/d1/client";
import { insertUserIfNew } from "@/worker/db/d1/dal/users";
import { claimNamespace, insertMembershipIfMissing } from "@/worker/db/d1/dal/namespaces";
import { newPrefixedId } from "@/worker/common";

import { ensureD1Migrations } from "./util/d1Setup";
import {
  setupRepoForTests,
  mintSessionCookie,
  type SetupRepoForTestsResult,
} from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";

// RBAC plane coverage: user groups + member expansion, service accounts +
// PAT mint, resource groups, role listing, member-role PATCH, and real
// enforcement (a viewer member's writes are refused by casbin).

let seeded: SetupRepoForTestsResult;
let space: string;
let memberUid: string;
let memberCookie: string;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed };
}

const get = (p: string, c?: string) => req("GET", p, { cookie: c });
const post = (p: string, b: unknown, c?: string) => req("POST", p, { body: b, cookie: c });
const patch = (p: string, b: unknown, c?: string) => req("PATCH", p, { body: b, cookie: c });
const del = (p: string, c?: string) => req("DELETE", p, { cookie: c });

beforeAll(async () => {
  await ensureD1Migrations(env);
  const ns = `rbac-ns-${Math.random().toString(36).slice(2, 8)}`;
  seeded = await setupRepoForTests(env, ns, "rbacspace");
  space = seeded.namespaceSlug;
  await seedPackFirstRepo(`${seeded.namespaceSlug}/${seeded.repoSlug}`);

  // A second user with their own personal namespace — becomes a space member.
  const db = createDb(env.DB);
  memberUid = `member-${Math.random().toString(36).slice(2, 8)}`;
  const memberId = newPrefixedId("user");
  await insertUserIfNew(db, {
    id: memberId,
    tesseraSub: `seed-${memberId}`,
    createdAt: Date.now(),
  });
  await claimNamespace(db, {
    id: newPrefixedId("ns"),
    slug: memberUid,
    createdBy: memberId,
    createdAt: Date.now(),
  });
  memberCookie = await mintSessionCookie(env, memberId);
});

describe("user groups", () => {
  it("creates a group, adds a member, and confers space membership", async () => {
    const created = await post(
      `/api/v1/spaces/${space}/usergroups`,
      { identifier: "devs", role: "developer" },
      seeded.cookieHeader
    );
    expect(created.status).toBe(201);

    const added = await post(
      `/api/v1/spaces/${space}/usergroups/devs/members`,
      { user_uid: memberUid },
      seeded.cookieHeader
    );
    expect(added.status).toBe(201);

    const list = await get(`/api/v1/spaces/${space}/usergroups`, seeded.cookieHeader);
    expect(list.status).toBe(200);
    const groups = list.body as { identifier: string; role: string; users: number }[];
    expect(groups.find((g) => g.identifier === "devs")?.users).toBe(1);

    // Group membership confers space read access for the member.
    const memberView = await get(`/api/v1/spaces/${space}/members`, memberCookie);
    expect(memberView.status).toBe(200);
  });

  it("lists groups in the scoped picker endpoint", async () => {
    const scoped = await get(`/api/v1/usergroups/scoped?space_ref=${space}`, seeded.cookieHeader);
    expect(scoped.status).toBe(200);
    const groups = scoped.body as { identifier: string }[];
    expect(groups.some((g) => g.identifier === "devs")).toBe(true);
  });
});

describe("service accounts", () => {
  it("creates an account and mints a usable namespace PAT", async () => {
    const created = await post(
      `/api/v1/spaces/${space}/serviceaccounts`,
      { identifier: "ci-bot", role: "developer" },
      seeded.cookieHeader
    );
    expect(created.status).toBe(201);
    const sa = (await get(`/api/v1/spaces/${space}/serviceaccounts`, seeded.cookieHeader)).body as {
      uid: string;
      identifier: string;
    }[];
    const bot = sa.find((a) => a.identifier === "ci-bot");
    expect(bot?.uid).toBeTruthy();

    const mint = await post(
      `/api/v1/spaces/${space}/serviceaccounts/${bot!.uid}/token`,
      {},
      seeded.cookieHeader
    );
    expect(mint.status).toBe(201);
    const { token } = mint.body as { token: string; level: string };
    expect(token).toMatch(/^goc_[0-9a-f]{8}_[a-z2-7]{32}$/);

    // The PAT authenticates against the space's repo (git smart HTTP path
    // accepts Basic PAT auth — info/refs on a public repo answers 200).
    const basic = Buffer.from(`${space}:${token}`).toString("base64");
    const res = await workerExports.default.fetch(
      `https://example.com/${space}/${seeded.repoSlug}/info/refs?service=git-upload-pack`,
      { headers: { Authorization: `Basic ${basic}` } }
    );
    expect([200, 304]).toContain(res.status);
    await res.text();
  });
});

describe("resource groups + roles", () => {
  it("creates a resource group with items", async () => {
    expect(
      (
        await post(
          `/api/v1/spaces/${space}/resourcegroups`,
          { identifier: "prod" },
          seeded.cookieHeader
        )
      ).status
    ).toBe(201);
    expect(
      (
        await post(
          `/api/v1/spaces/${space}/resourcegroups/prod/resources`,
          { resource_type: "repo", resource_ref: `${space}/${seeded.repoSlug}` },
          seeded.cookieHeader
        )
      ).status
    ).toBe(201);
    const list = await get(`/api/v1/spaces/${space}/resourcegroups`, seeded.cookieHeader);
    const groups = list.body as { identifier: string; items: { ref: string }[] }[];
    expect(groups.find((g) => g.identifier === "prod")?.items.length).toBe(1);
  });

  it("lists built-in roles", async () => {
    const res = await get(`/api/v1/spaces/${space}/roles`, seeded.cookieHeader);
    expect(res.status).toBe(200);
    const data = res.body as { roles: { identifier: string }[] };
    for (const role of ["owner", "developer", "viewer"]) {
      expect(data.roles.some((r) => r.identifier === role)).toBe(true);
    }
  });
});

describe("member roles + enforcement", () => {
  it("adds a member at owner, demotes to viewer, and refuses their writes", async () => {
    // A third user with a direct membership only — no group-derived role.
    const db = createDb(env.DB);
    const directUid = `direct-${Math.random().toString(36).slice(2, 8)}`;
    const directId = newPrefixedId("user");
    await insertUserIfNew(db, {
      id: directId,
      tesseraSub: `seed-${directId}`,
      createdAt: Date.now(),
    });
    await claimNamespace(db, {
      id: newPrefixedId("ns"),
      slug: directUid,
      createdBy: directId,
      createdAt: Date.now(),
    });
    const directCookie = await mintSessionCookie(env, directId);
    const ns = await import("@/worker/db/d1/dal/namespaces").then((m) =>
      m.findNamespaceBySlug(db, space)
    );
    const memberUser = await import("@/worker/db/d1/dal/namespaces").then((m) =>
      m.findNamespaceBySlug(db, directUid)
    );
    await insertMembershipIfMissing(db, {
      namespaceId: ns!.id,
      userId: memberUser!.createdBy,
      role: "owner",
      createdAt: Date.now(),
    });

    // Owner can write: commit a file.
    const write = await post(
      `/api/v1/repos/${space}/${seeded.repoSlug}/commits`,
      {
        branch: "main",
        message: "owner write",
        actions: [{ action: "CREATE", path: "member.txt", encoding: "text", payload: "hi\n" }],
      },
      directCookie
    );
    expect(write.status).toBe(200);

    // Demote to viewer via the role PATCH.
    const demote = await patch(
      `/api/v1/spaces/${space}/members/${directUid}`,
      { role: "viewer" },
      seeded.cookieHeader
    );
    expect(demote.status).toBe(200);

    // Viewer still reads...
    expect(
      (await get(`/api/v1/repos/${space}/${seeded.repoSlug}/commits`, directCookie)).status
    ).toBe(200);

    // ...but writes are refused by the casbin gate.
    const denied = await post(
      `/api/v1/repos/${space}/${seeded.repoSlug}/commits`,
      {
        branch: "main",
        message: "viewer write",
        actions: [{ action: "CREATE", path: "denied.txt", encoding: "text", payload: "x\n" }],
      },
      directCookie
    );
    expect(denied.status).toBe(403);
    expect(String((denied.body as { message?: string })?.message ?? "")).toContain("role");
  });
});
