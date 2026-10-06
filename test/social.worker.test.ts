import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Social graph coverage — stars, topics, follows, explore. D1-backed
// (cross-repo joins), session-authed writes on /api/v1, GitHub-shaped
// mirror on /api/v3 for `gh api` callers.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON bodies stay strings */
  }
  return { status: res.status, body };
}

let seeded: SetupRepoForTestsResult;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("soc-ns"), "socrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/socrepo/+`;
});

describe("social: stars", () => {
  it("star → count → unstar round-trips", async () => {
    const before = await call("GET", `${base}/star`);
    expect(before.status).toBe(200);
    expect((before.body as { starred: boolean }).starred).toBe(false);
    expect((before.body as { stargazers_count: number }).stargazers_count).toBe(0);

    const starred = await call("PUT", `${base}/star`, { cookie: seeded.cookieHeader });
    expect(starred.status).toBe(200);
    expect((starred.body as { stargazers_count: number }).stargazers_count).toBe(1);

    // Idempotent re-star keeps the count at 1.
    const again = await call("PUT", `${base}/star`, { cookie: seeded.cookieHeader });
    expect((again.body as { stargazers_count: number }).stargazers_count).toBe(1);

    const unstarred = await call("DELETE", `${base}/star`, { cookie: seeded.cookieHeader });
    expect((unstarred.body as { stargazers_count: number }).stargazers_count).toBe(0);
  });

  it("rejects anonymous star mutations", async () => {
    expect((await call("PUT", `${base}/star`)).status).toBe(401);
    expect((await call("DELETE", `${base}/star`)).status).toBe(401);
  });

  it("lists the viewer's starred repos", async () => {
    await call("PUT", `${base}/star`, { cookie: seeded.cookieHeader });
    const { status, body } = await call("GET", "/api/v1/starred", {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    const rows = body as { full_name: string }[];
    expect(rows.some((r) => r.full_name === `${seeded.namespaceSlug}/socrepo`)).toBe(true);
  });
});

describe("social: topics + website", () => {
  it("settings/general round-trips topics and website", async () => {
    const patched = await call("PATCH", `${base}/settings/general`, {
      cookie: seeded.cookieHeader,
      body: { topics: ["Git-Forge", "agents", "cloudflare"], website: "https://delta.example.com" },
    });
    expect(patched.status).toBe(200);

    const got = await call("GET", `${base}/settings/general`, {
      cookie: seeded.cookieHeader,
    });
    const settings = got.body as { topics: string[]; website: string | null };
    expect(settings.topics).toEqual(["agents", "cloudflare", "git-forge"]);
    expect(settings.website).toBe("https://delta.example.com");

    const topicsApi = await call("GET", `${base}/topics`);
    expect((topicsApi.body as { topics: string[] }).topics).toContain("agents");
  });

  it("rejects invalid topics", async () => {
    const bad = await call("PATCH", `${base}/settings/general`, {
      cookie: seeded.cookieHeader,
      body: { topics: ["HAS SPACES", "OK_one"] },
    });
    expect(bad.status).toBe(422);
  });

  it("v3 topics surface mirrors the same data", async () => {
    const got = await call("GET", `/api/v3/repos/${seeded.namespaceSlug}/socrepo/topics`);
    expect(got.status).toBe(200);
    expect((got.body as { names: string[] }).names).toContain("git-forge");
  });
});

describe("social: follows + explore", () => {
  it("follow → status → unfollow round-trips", async () => {
    const space = `/api/v1/spaces/${seeded.namespaceSlug}/+/follow`;
    const put = await call("PUT", space, { cookie: seeded.cookieHeader });
    expect((put.body as { following: boolean }).following).toBe(true);
    const got = await call("GET", space, { cookie: seeded.cookieHeader });
    expect((got.body as { following: boolean }).following).toBe(true);
    const del = await call("DELETE", space, { cookie: seeded.cookieHeader });
    expect((del.body as { following: boolean }).following).toBe(false);
  });

  it("explore lists the seeded public repo and its topics", async () => {
    const { status, body } = await call("GET", "/api/v1/explore");
    expect(status).toBe(200);
    const result = body as {
      repos: { full_name: string; stargazers_count: number }[];
      topics: { topic: string }[];
    };
    expect(result.repos.some((r) => r.full_name === `${seeded.namespaceSlug}/socrepo`)).toBe(true);
    expect(result.topics.some((t) => t.topic === "agents")).toBe(true);

    const filtered = await call("GET", "/api/v1/explore?topic=agents");
    const filteredRepos = (filtered.body as { repos: { full_name: string }[] }).repos;
    expect(filteredRepos.some((r) => r.full_name === `${seeded.namespaceSlug}/socrepo`)).toBe(true);
  });
});

describe("social: /api/v3", () => {
  it("repo view carries stargazers_count and topics", async () => {
    const { status, body } = await call("GET", `/api/v3/repos/${seeded.namespaceSlug}/socrepo`);
    expect(status).toBe(200);
    const repo = body as { stargazers_count: number; topics: string[]; homepage: string | null };
    expect(repo.stargazers_count).toBe(1);
    expect(repo.topics).toContain("agents");
    expect(repo.homepage).toBe("https://delta.example.com");
  });

  it("rejects anonymous v3 star mutations", async () => {
    const res = await call("PUT", `/api/v3/user/starred/${seeded.namespaceSlug}/socrepo`);
    expect(res.status).toBe(401);
  });
});
