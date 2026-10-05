import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Gitness `/api/v1` facade smoke coverage: session mapping, space/repo
// resolution, refs/commits/content, pullreq listing, and the 501 contract for
// unimplemented endpoints. Data-heavy paths (diff, merge-check) get coverage
// through the merge engine's own tests.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function get(path: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    headers,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text/plain bodies stay strings */
  }
  return { status: res.status, body };
}

let seeded: SetupRepoForTestsResult;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("gv-ns"), "gvrepo");
});

describe("gitness /api/v1 facade", () => {
  it("GET /api/v1/user → 401 anonymous, 200 with session", async () => {
    const anon = await get("/api/v1/user");
    expect(anon.status).toBe(401);
    const authed = await get("/api/v1/user", seeded.cookieHeader);
    expect(authed.status).toBe(200);
    const user = authed.body as { uid: string; display_name: string };
    expect(user.uid).toBe(seeded.namespaceSlug);
  });

  it("GET /api/v1/spaces/{ns} resolves the namespace as a space", async () => {
    const { status, body } = await get(`/api/v1/spaces/${seeded.namespaceSlug}`);
    expect(status).toBe(200);
    expect((body as { identifier: string }).identifier).toBe(seeded.namespaceSlug);
    expect((body as { path: string }).path).toBe(seeded.namespaceSlug);
  });

  it("GET /api/v1/spaces/{ns}/repos lists the repo with gitness fields", async () => {
    const { status, body } = await get(
      `/api/v1/spaces/${seeded.namespaceSlug}/repos`,
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    const repos = body as Array<{ identifier: string; path: string; default_branch: string }>;
    const hit = repos.find((r) => r.identifier === "gvrepo");
    expect(hit).toBeDefined();
    expect(hit!.path).toBe(`${seeded.namespaceSlug}/gvrepo`);
    expect(hit!.default_branch).toBe("main");
  });

  it("GET /api/v1/repos/{ref}/+ resolves repo_ref with trailing +", async () => {
    const { status, body } = await get(`/api/v1/repos/${seeded.namespaceSlug}/gvrepo/+`);
    expect(status).toBe(200);
    const repo = body as { identifier: string; is_empty?: boolean; git_url: string };
    expect(repo.identifier).toBe("gvrepo");
    expect(repo.is_empty).toBe(true);
    expect(repo.git_url.endsWith(`/${seeded.namespaceSlug}/gvrepo.git`)).toBe(true);
  });

  it("git-data endpoints on an empty repo return empty-but-200", async () => {
    const ref = `${seeded.namespaceSlug}/gvrepo/+`;
    const branches = await get(`/api/v1/repos/${ref}/branches`);
    expect(branches.status).toBe(200);
    expect(branches.body).toEqual([]);
    const commits = await get(`/api/v1/repos/${ref}/commits`);
    expect(commits.status).toBe(200);
    expect((commits.body as { commits: unknown[] }).commits).toEqual([]);
    const paths = await get(`/api/v1/repos/${ref}/paths`);
    expect(paths.status).toBe(200);
    const summary = await get(`/api/v1/repos/${ref}/summary`);
    expect(summary.status).toBe(200);
    expect((summary.body as { branch_count: number }).branch_count).toBe(0);
  });

  it("GET /pullreq lists intents; empty repo has none", async () => {
    const { status, body } = await get(`/api/v1/repos/${seeded.namespaceSlug}/gvrepo/+/pullreq`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("GET /pullreq/candidates returns delta refs", async () => {
    const { status, body } = await get(
      `/api/v1/repos/${seeded.namespaceSlug}/gvrepo/+/pullreq/candidates`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("unimplemented endpoints return 501, not 404", async () => {
    const { status, body } = await get("/api/v1/repos/x/y/+/blame/f.ts");
    expect(status).toBe(501);
    expect((body as { message: string }).message).toMatch(/blame/i);
    const weird = await get("/api/v1/gitspaces/whatever");
    expect(weird.status).toBe(501);
  });

  it("POST /api/v1/login succeeds only with a live session", async () => {
    const res = await workerExports.default.fetch("https://example.com/api/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login_identifier: "x", password: "y" }),
    });
    expect(res.status).toBe(401);
    const res2 = await workerExports.default.fetch("https://example.com/api/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: seeded.cookieHeader },
      body: JSON.stringify({ login_identifier: "x", password: "y" }),
    });
    expect(res2.status).toBe(200);
  });
});
