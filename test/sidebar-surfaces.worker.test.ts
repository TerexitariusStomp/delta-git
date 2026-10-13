// Sidebar More/Settings coverage — every destination the left-nav More and
// Settings menus link to is backed by an /api/v1 endpoint; this file exercises
// the endpoints that had no worker coverage so a 404/500 can't quietly leave a
// menu page skeleton-loading forever (same failure class as path-details).

import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

let seeded: SetupRepoForTestsResult;
let owner: string;

async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  // Session-authed mutations require a same-origin Origin header (CSRF).
  if (opts.method && opts.method !== "GET") headers.Origin = "https://example.com";
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = `sb-${Math.random().toString(36).slice(2, 8)}`;
  seeded = await setupRepoForTests(env, owner, uniqueRepoId("sbrepo"));
});

// The idea-first home page's timeline is a cross-repo feed.
describe("global idea timeline (landing page)", () => {
  it("returns posted ideas with repo attribution, newest first", async () => {
    const post = await req(`/api/${owner}/${seeded.repoSlug}/dg/ideas`, {
      method: "POST",
      cookie: seeded.cookieHeader,
      body: { title: "timeline idea", body: "from the landing test" },
    });
    expect(post.status).toBe(200);

    const res = await req("/api/dg/ideas", { cookie: seeded.cookieHeader });
    expect(res.status).toBe(200);
    const ideas = (res.body as { ideas: unknown[] }).ideas as {
      id: string;
      title: string;
      namespace: string;
      repo: string;
      status: string;
      created_at: number;
    }[];
    const mine = ideas.find((i) => i.title === "timeline idea");
    expect(mine).toBeDefined();
    expect(mine?.namespace).toBe(owner);
    expect(mine?.repo).toBe(seeded.repoSlug);
    for (let i = 1; i < ideas.length; i++) {
      expect(ideas[i - 1].created_at).toBeGreaterThanOrEqual(ideas[i].created_at);
    }
  });

  it("requires a session", async () => {
    const anon = await req("/api/dg/ideas");
    expect(anon.status).toBe(401);
  });
});

// The SpacePicker on ~30 module pages drives off this endpoint.
describe("user memberships (space picker)", () => {
  it("returns the viewer's spaces and rejects anonymous callers", async () => {
    const res = await req("/api/v1/user/memberships", { cookie: seeded.cookieHeader });
    expect(res.status).toBe(200);
    const memberships = res.body as { space: { identifier: string } }[];
    expect(Array.isArray(memberships)).toBe(true);
    expect(memberships.some((m) => m.space.identifier === owner)).toBe(true);

    const anon = await req("/api/v1/user/memberships");
    expect(anon.status).toBe(401);
  });
});

// Settings → Templates → SpaceTemplatesPage
describe("space templates", () => {
  it("creates, lists, and deletes templates with member gating", async () => {
    const base = `/api/v1/spaces/${owner}/templates`;

    const create = await req(base, {
      method: "POST",
      body: { identifier: "service-skeleton", data: "tmpl-bytes" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(200);
    expect((create.body as { identifier: string }).identifier).toBe("service-skeleton");

    const dup = await req(base, {
      method: "POST",
      body: { identifier: "service-skeleton" },
      cookie: seeded.cookieHeader,
    });
    expect(dup.status).toBe(409);

    const list = await req(base, { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    const items = list.body as { id: number; identifier: string }[];
    const row = items.find((t) => t.identifier === "service-skeleton")!;
    expect(row).toBeTruthy();

    const del = await req(`${base}/${row.id}`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(200);
    const missing = await req(`${base}/${row.id}`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(missing.status).toBe(404);

    const anon = await req(base);
    expect(anon.status).toBe(401);
  });
});

// Settings → Variables → VariablesPage (client-sealed records, gvars: scope)
describe("space variables", () => {
  it("creates sealed variable records and enforces naming", async () => {
    const base = `/api/v1/spaces/${owner}/variables`;

    const create = await req(base, {
      method: "POST",
      body: { identifier: "deploy_region", description: "primary", ciphertext: "sealed" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);
    expect((create.body as { identifier: string }).identifier).toBe("DEPLOY_REGION");

    const bad = await req(base, {
      method: "POST",
      body: { identifier: "9bad" },
      cookie: seeded.cookieHeader,
    });
    expect(bad.status).toBe(400);

    const list = await req(base, { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    const vars = list.body as { identifier: string; description: string }[];
    const v = vars.find((x) => x.identifier === "DEPLOY_REGION")!;
    expect(v.description).toBe("primary");

    // Re-posting updates the existing record rather than duplicating it.
    const update = await req(base, {
      method: "POST",
      body: { identifier: "DEPLOY_REGION", description: "secondary" },
      cookie: seeded.cookieHeader,
    });
    expect(update.status).toBe(200);
    const relist = await req(base, { cookie: seeded.cookieHeader });
    const after = (relist.body as { identifier: string; description: string }[]).filter(
      (x) => x.identifier === "DEPLOY_REGION"
    );
    expect(after.length).toBe(1);
    expect(after[0].description).toBe("secondary");

    const del = await req(`${base}/DEPLOY_REGION`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);

    const anon = await req(base);
    expect(anon.status).toBe(401);
  });
});

// Settings → Services → ServiceReliabilityPage dashboard roll-up
describe("reliability overview", () => {
  it("rolls up monitors, SLOs, incidents, and certificates", async () => {
    const res = await req(`/api/v1/spaces/${owner}/reliability`, {
      cookie: seeded.cookieHeader,
    });
    expect(res.status).toBe(200);
    const roll = res.body as {
      monitors: { total: number; up: number; down: number };
      slos: number;
      open_incidents: number;
      expiring_certificates: number;
    };
    expect(roll.monitors).toMatchObject({ total: 0, up: 0, down: 0 });
    expect(typeof roll.open_incidents).toBe("number");

    const anon = await req(`/api/v1/spaces/${owner}/reliability`);
    expect(anon.status).toBe(401);
  });
});

// Settings → Monitored Services → MonitorsPage delete button
describe("monitor delete", () => {
  it("deletes a monitor by identifier", async () => {
    const base = `/api/v1/spaces/${owner}/monitors`;
    const create = await req(base, {
      method: "POST",
      body: { identifier: "edge-check", url: "https://example.com/health" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const del = await req(`${base}/edge-check`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);
    const again = await req(`${base}/edge-check`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(again.status).toBe(404);
  });
});

// Settings → Users → UserManagementPageContainer (adminListUsers et al.)
// There is no site-admin role — list shows the caller's namespace directory;
// record writes are self-only.
describe("admin users directory", () => {
  it("lists namespace members, creates users, and restricts writes to self", async () => {
    const list = await req("/api/v1/admin/users", { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    const users = list.body as { uid: string }[];
    expect(Array.isArray(users)).toBe(true);
    expect(users.some((u) => u.uid === owner)).toBe(true);

    const newUid = `sbuser${Math.random().toString(36).slice(2, 8)}`;
    const create = await req("/api/v1/admin/users", {
      method: "POST",
      body: { uid: newUid },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(200);
    expect((create.body as { uid: string }).uid).toBe(newUid);

    const dup = await req("/api/v1/admin/users", {
      method: "POST",
      body: { uid: newUid },
      cookie: seeded.cookieHeader,
    });
    expect(dup.status).toBe(409);

    const get = await req(`/api/v1/admin/users/${newUid}`, { cookie: seeded.cookieHeader });
    expect(get.status).toBe(200);

    // PATCH on someone else's record is forbidden; self is allowed.
    const foreign = await req(`/api/v1/admin/users/${newUid}`, {
      method: "PATCH",
      body: { display_name: "x" },
      cookie: seeded.cookieHeader,
    });
    expect(foreign.status).toBe(403);

    const self = await req(`/api/v1/admin/users/${owner}`, {
      method: "PATCH",
      body: { display_name: "owner-name" },
      cookie: seeded.cookieHeader,
    });
    expect(self.status).toBe(200);
    expect((self.body as { display_name: string }).display_name).toBe("owner-name");

    const anon = await req("/api/v1/admin/users");
    expect(anon.status).toBe(401);
  });
});
