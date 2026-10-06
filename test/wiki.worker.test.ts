import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Wiki coverage: pages are markdown blobs on refs/heads/wiki. The first
// write exercises the root-commit + ""-CAS ref-creation path; later writes
// ride the normal merge-intent lane.

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

interface PageListRow {
  name: string;
  oid: string;
}

interface PageContent {
  name: string;
  oid: string;
  content: string;
}

let seeded: SetupRepoForTestsResult;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("wiki-ns"), "wikirepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/wikirepo/+`;
});

describe("wiki: /api/v1 facade over refs/heads/wiki", () => {
  it("starts empty", async () => {
    const { status, body } = await call("GET", `${base}/wiki`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("creates the first page, materializing the wiki branch", async () => {
    const { status, body } = await call("PUT", `${base}/wiki/Home`, {
      cookie: seeded.cookieHeader,
      body: { content: "# Welcome\n\nfirst page", message: "Create Home" },
    });
    expect(status).toBe(200);
    expect((body as { name: string }).name).toBe("Home");
    expect((body as { commit_id: string }).commit_id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads the page back and lists it", async () => {
    const page = await call("GET", `${base}/wiki/Home`, { cookie: seeded.cookieHeader });
    expect(page.status).toBe(200);
    expect((page.body as PageContent).content).toBe("# Welcome\n\nfirst page");

    const list = await call("GET", `${base}/wiki`, { cookie: seeded.cookieHeader });
    const pages = list.body as PageListRow[];
    expect(pages.length).toBe(1);
    expect(pages[0].name).toBe("Home");
  });

  it("adds a second page through the merge-intent lane", async () => {
    const { status } = await call("PUT", `${base}/wiki/How-To-Deploy`, {
      cookie: seeded.cookieHeader,
      body: { content: "steps here" },
    });
    expect(status).toBe(200);

    const list = await call("GET", `${base}/wiki`, { cookie: seeded.cookieHeader });
    const names = (list.body as PageListRow[]).map((p) => p.name);
    // Home sorts first, then alphabetical.
    expect(names).toEqual(["Home", "How-To-Deploy"]);
  });

  it("updates a page in place", async () => {
    const { status } = await call("PUT", `${base}/wiki/Home`, {
      cookie: seeded.cookieHeader,
      body: { content: "# Welcome v2" },
    });
    expect(status).toBe(200);
    const page = await call("GET", `${base}/wiki/Home`, { cookie: seeded.cookieHeader });
    expect((page.body as PageContent).content).toBe("# Welcome v2");
  });

  it("rejects invalid page names and anonymous writes", async () => {
    const bad = await call("PUT", `${base}/wiki/not%20allowed%2Fname`, {
      cookie: seeded.cookieHeader,
      body: { content: "x" },
    });
    expect(bad.status).toBe(422);

    const anon = await call("PUT", `${base}/wiki/Anon`, { body: { content: "x" } });
    expect(anon.status).toBe(401);
  });

  it("exposes recent changes history", async () => {
    const { status, body } = await call("GET", `${base}/wiki-history`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    const commits = body as { oid: string; message: string }[];
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits.some((cm) => cm.message.includes("Create Home"))).toBe(true);
  });

  it("allows anonymous reads on a public repo", async () => {
    const list = await call("GET", `${base}/wiki`);
    expect(list.status).toBe(200);
    expect((list.body as PageListRow[]).length).toBe(2);

    const page = await call("GET", `${base}/wiki/Home`);
    expect(page.status).toBe(200);
  });

  it("deletes a page in one commit", async () => {
    const { status } = await call("DELETE", `${base}/wiki/How-To-Deploy`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);

    const list = await call("GET", `${base}/wiki`, { cookie: seeded.cookieHeader });
    expect((list.body as PageListRow[]).map((p) => p.name)).toEqual(["Home"]);

    const gone = await call("GET", `${base}/wiki/How-To-Deploy`, {
      cookie: seeded.cookieHeader,
    });
    expect(gone.status).toBe(404);
  });

  it("404s on missing pages", async () => {
    const { status } = await call("GET", `${base}/wiki/Nope`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(404);
  });
});
