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

  it("GET /api/arena returns the cross-repo match feed", async () => {
    const { status, body } = await get("/api/arena");
    expect(status).toBe(200);
    expect(Array.isArray((body as { matches: unknown[] }).matches)).toBe(true);
  });

  it("blame resolves the repo; unknown surfaces 404 via the catch-all", async () => {
    // Blame is real now — a nonexistent repo 404s instead of stubbing.
    const { status } = await get("/api/v1/repos/x/y/+/blame/f.ts");
    expect(status).toBe(404);
    const weird = await get("/api/v1/gitspaces/whatever");
    expect(weird.status).toBe(404);
    expect((weird.body as { message: string }).message).toMatch(/not implemented/i);
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

// Write paths: seeded repo gets a real commit via `seedMinimalRepo` so
// branch/commit/pullreq endpoints have objects to act on. All writes carry
// the seeded owner's session cookie — namespace membership is the gate.
describe("gitness /api/v1 write paths", () => {
  let w: SetupRepoForTestsResult;
  let ref: string;

  async function post(path: string, body: unknown, cookie?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    const res = await workerExports.default.fetch(`https://example.com${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  }
  async function patch(path: string, body: unknown, cookie?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    const res = await workerExports.default.fetch(`https://example.com${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  }

  beforeAll(async () => {
    w = await setupRepoForTests(env, uniq("gw-ns"), "gwrepo");
    ref = `${w.namespaceSlug}/gwrepo/+`;
    const id = env.REPO_DO.idFromName(w.doName);
    await env.REPO_DO.get(id).seedMinimalRepo();
  });

  it("writes without a session are rejected", async () => {
    const res = await post(`/api/v1/repos/${ref}/branches`, { name: "x", target: "main" });
    expect([401, 403]).toContain(res.status);
  });

  it("POST /repos creates a repository in the space", async () => {
    const res = await post(
      "/api/v1/repos",
      {
        identifier: uniq("gvcreated"),
        description: "created via facade",
        is_public: true,
        parent_ref: w.namespaceSlug,
      },
      w.cookieHeader
    );
    expect(res.status).toBe(200);
    const repo = res.body as { identifier: string; path: string };
    expect(repo.path).toBe(`${w.namespaceSlug}/${repo.identifier}`);
  });

  it("branch create → commit-files → PR create → close round-trips", async () => {
    // Branch create.
    const br = await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "feature", target: "main" },
      w.cookieHeader
    );
    expect(br.status).toBe(200);
    expect((br.body as { name: string }).name).toBe("feature");
    const dup = await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "feature", target: "main" },
      w.cookieHeader
    );
    expect(dup.status).toBe(409);

    // Commit a file onto the feature branch (gitness commit-files).
    const cm = await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "feature",
        message: "add hello.txt",
        actions: [
          { action: "CREATE", path: "hello.txt", encoding: "text", payload: "hello world\n" },
        ],
      },
      w.cookieHeader
    );
    expect(cm.status).toBe(200);
    const commitId = (cm.body as { commit_id: string }).commit_id;
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);

    // The file is readable on the feature branch through the content API.
    const content = await get(`/api/v1/repos/${ref}/content/hello.txt?git_ref=feature`);
    expect(content.status).toBe(200);
    expect((content.body as { type: string }).type).toBe("file");

    // PR create: feature → main mints an open intent.
    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      {
        source_branch: "feature",
        target_branch: "main",
        title: "Add hello.txt",
        description: "created via the facade",
      },
      w.cookieHeader
    );
    expect(pr.status).toBe(200);
    const prOut = pr.body as { number: number; title: string; state: string };
    expect(prOut.title).toBe("Add hello.txt");
    expect(prOut.state).toBe("open");

    // PATCH retitles it.
    const upd = await patch(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}`,
      { title: "Add hello.txt (v2)" },
      w.cookieHeader
    );
    expect(upd.status).toBe(200);
    expect((upd.body as { title: string }).title).toBe("Add hello.txt (v2)");

    // Comment lands on the activity feed.
    const comment = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/comments`,
      { text: "looks good" },
      w.cookieHeader
    );
    expect(comment.status).toBe(200);
    const acts = await get(`/api/v1/repos/${ref}/pullreq/${prOut.number}/activities`);
    const texts = (acts.body as { text: string }[]).map((a) => a.text);
    expect(texts).toContain("looks good");

    // Close → intent rejected → gitness "closed".
    const closed = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/state`,
      { state: "closed" },
      w.cookieHeader
    );
    expect(closed.status).toBe(200);
    expect((closed.body as { state: string }).state).toBe("closed");
  });

  it("tag create + delete", async () => {
    const tag = await post(
      `/api/v1/repos/${ref}/tags`,
      { name: "v0.1", target: "main" },
      w.cookieHeader
    );
    expect(tag.status).toBe(200);
    const del = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ref}/tags/v0.1`,
      { method: "DELETE", headers: { Cookie: w.cookieHeader } }
    );
    expect(del.status).toBe(200);
  });
});
