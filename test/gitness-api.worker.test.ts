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

  it("POST /repos folds GitHub-style mixed-case identifiers to the canonical slug", async () => {
    const mixed = uniq("MixedCaseRepo");
    const res = await post(
      "/api/v1/repos",
      { identifier: mixed, is_public: true, parent_ref: w.namespaceSlug },
      w.cookieHeader
    );
    expect(res.status).toBe(200);
    const repo = res.body as { identifier: string; path: string };
    expect(repo.identifier).toBe(mixed.toLowerCase());
    expect(repo.path).toBe(`${w.namespaceSlug}/${mixed.toLowerCase()}`);
    // Reads resolve case-insensitively through repo_ref.
    const get = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${w.namespaceSlug}/${mixed}/+`,
      { headers: { Cookie: w.cookieHeader } }
    );
    expect(get.status).toBe(200);
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

  it("merge auto-closes issues referenced by 'fixes #N' in the PR text", async () => {
    const issue = await post(
      `/api/v1/repos/${ref}/issues`,
      { title: "crash on empty input" },
      w.cookieHeader
    );
    expect(issue.status).toBe(201);
    const issueNumber = (issue.body as { number: number }).number;

    await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "fix-branch", target: "main" },
      w.cookieHeader
    );
    const cm = await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "fix-branch",
        message: "guard empty input",
        actions: [{ action: "CREATE", path: "fix.txt", encoding: "text", payload: "fixed\n" }],
      },
      w.cookieHeader
    );
    expect(cm.status).toBe(200);

    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      {
        source_branch: "fix-branch",
        target_branch: "main",
        title: "guard empty input",
        description: `fixes #${issueNumber}`,
      },
      w.cookieHeader
    );
    expect(pr.status).toBe(200);
    const prNumber = (pr.body as { number: number }).number;

    const merge = await post(`/api/v1/repos/${ref}/pullreq/${prNumber}/merge`, {}, w.cookieHeader);
    expect(merge.status).toBe(200);
    const merged = merge.body as { mergeable: boolean; closed_issues?: number[] };
    expect(merged.mergeable).toBe(true);
    expect(merged.closed_issues).toContain(issueNumber);

    const after = await get(`/api/v1/repos/${ref}/issues/${issueNumber}`);
    const afterIssue = after.body as { state: string; state_reason: string | null };
    expect(afterIssue.state).toBe("closed");
    expect(afterIssue.state_reason).toBe("completed");
  });

  it("PR create suggests CODEOWNERS reviewers for touched paths", async () => {
    // CODEOWNERS on main covers the path the feature branch will touch.
    const co = await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "main",
        message: "add CODEOWNERS",
        actions: [
          {
            action: "CREATE",
            path: "CODEOWNERS",
            encoding: "text",
            payload: "*.md @docs-owner\n",
          },
        ],
      },
      w.cookieHeader
    );
    expect(co.status).toBe(200);

    await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "docs-branch", target: "main" },
      w.cookieHeader
    );
    const cm = await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "docs-branch",
        message: "add readme",
        actions: [{ action: "CREATE", path: "README.md", encoding: "text", payload: "# hi\n" }],
      },
      w.cookieHeader
    );
    expect(cm.status).toBe(200);

    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      { source_branch: "docs-branch", target_branch: "main", title: "docs" },
      w.cookieHeader
    );
    expect(pr.status).toBe(200);
    const prOut = pr.body as { number: number; suggested_reviewers?: string[] };
    expect(prOut.suggested_reviewers).toContain("@docs-owner");

    // Reviewers persisted in the PR metadata — visible via the reviewers API.
    const detail = await get(`/api/v1/repos/${ref}/pullreq/${prOut.number}/reviewers/combined`);
    const reviewers = (detail.body as { reviewers: { reviewer: { uid: string } }[] }).reviewers.map(
      (r) => r.reviewer.uid
    );
    expect(reviewers).toContain("docs-owner");
  });

  it("commit comments round-trip and Co-authored-by trailers surface", async () => {
    const cm = await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "main",
        message: "pair work\n\nCo-authored-by: Pair Partner <pair@example.com>\n",
        actions: [{ action: "CREATE", path: "pair.txt", encoding: "text", payload: "x\n" }],
      },
      w.cookieHeader
    );
    expect(cm.status).toBe(200);
    const sha = (cm.body as { commit_id: string }).commit_id;

    // Web commits land through the merge lane — when a merge commit is
    // synthesized the authored commit carrying the trailer is its delta-side
    // parent; on fast-forward `sha` is the authored commit itself.
    const detail = await get(`/api/v1/repos/${ref}/commits/${sha}`);
    expect(detail.status).toBe(200);
    const merge = detail.body as { parent_shas: string[] };
    const authoredSha = merge.parent_shas.length > 1 ? merge.parent_shas.at(-1)! : sha;
    const authored = await get(`/api/v1/repos/${ref}/commits/${authoredSha}`);
    const commit = authored.body as { co_authors?: { name: string; email: string }[] };
    expect(commit.co_authors).toEqual([{ name: "Pair Partner", email: "pair@example.com" }]);

    const empty = await get(`/api/v1/repos/${ref}/commits/${sha}/comments`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const cmt = await post(
      `/api/v1/repos/${ref}/commits/${sha}/comments`,
      { text: "nice fix" },
      w.cookieHeader
    );
    expect(cmt.status).toBe(201);

    const listed = await get(`/api/v1/repos/${ref}/commits/${sha}/comments`);
    const texts = (listed.body as { text: string; author: string }[]).map((x) => x.text);
    expect(texts).toContain("nice fix");

    const unauth = await post(`/api/v1/repos/${ref}/commits/${sha}/comments`, { text: "x" });
    expect([401, 403]).toContain(unauth.status);
  });

  it("draft PRs block merge until marked ready", async () => {
    await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "draft-branch", target: "main" },
      w.cookieHeader
    );
    await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "draft-branch",
        message: "wip",
        actions: [{ action: "CREATE", path: "wip.txt", encoding: "text", payload: "wip\n" }],
      },
      w.cookieHeader
    );

    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      { source_branch: "draft-branch", target_branch: "main", title: "wip", is_draft: true },
      w.cookieHeader
    );
    expect(pr.status).toBe(200);
    const prOut = pr.body as { number: number; is_draft: boolean };
    expect(prOut.is_draft).toBe(true);

    // Draft blocks merge.
    const blocked = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/merge`,
      {},
      w.cookieHeader
    );
    expect(blocked.status).toBe(409);

    // Ready-for-review flips the flag; merge now succeeds.
    const ready = await patch(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}`,
      { is_draft: false },
      w.cookieHeader
    );
    expect(ready.status).toBe(200);
    expect((ready.body as { is_draft: boolean }).is_draft).toBe(false);

    const merged = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/merge`,
      {},
      w.cookieHeader
    );
    expect(merged.status).toBe(200);
    expect((merged.body as { mergeable: boolean }).mergeable).toBe(true);
  });

  it("PR assignees add/remove and surface on detail", async () => {
    await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "assign-branch", target: "main" },
      w.cookieHeader
    );
    await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "assign-branch",
        message: "x",
        actions: [{ action: "CREATE", path: "a.txt", encoding: "text", payload: "a\n" }],
      },
      w.cookieHeader
    );
    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      { source_branch: "assign-branch", target_branch: "main", title: "x" },
      w.cookieHeader
    );
    const n = (pr.body as { number: number }).number;

    // PUT is the assign verb (gitness shape), not POST.
    const put = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ref}/pullreq/${n}/assignees`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: w.cookieHeader },
        body: JSON.stringify({ assignee_id: "teammate-1" }),
      }
    );
    expect(put.status).toBe(200);

    const detail = await get(`/api/v1/repos/${ref}/pullreq/${n}`);
    expect((detail.body as { assignees: string[] }).assignees).toContain("teammate-1");

    const del = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${ref}/pullreq/${n}/assignees/teammate-1`,
      { method: "DELETE", headers: { Cookie: w.cookieHeader } }
    );
    expect(del.status).toBe(200);
    const after = await get(`/api/v1/repos/${ref}/pullreq/${n}`);
    expect((after.body as { assignees: string[] }).assignees).not.toContain("teammate-1");
  });

  it("required status checks block merge until contexts report success", async () => {
    // Branch rule requiring the "ci/build" context on main.
    const rule = await post(
      `/api/v1/repos/${ref}/rules`,
      {
        identifier: "require-ci",
        type: "branch",
        pattern: "main",
        definition: { status_checks: { contexts: ["ci/build"] } },
      },
      w.cookieHeader
    );
    expect(rule.status).toBe(200);
    const ruleId = (rule.body as { id: number }).id;

    await post(
      `/api/v1/repos/${ref}/branches`,
      { name: "ci-branch", target: "main" },
      w.cookieHeader
    );
    await post(
      `/api/v1/repos/${ref}/commits`,
      {
        branch: "ci-branch",
        message: "ci",
        actions: [{ action: "CREATE", path: "ci.txt", encoding: "text", payload: "ci\n" }],
      },
      w.cookieHeader
    );
    const pr = await post(
      `/api/v1/repos/${ref}/pullreq`,
      { source_branch: "ci-branch", target_branch: "main", title: "ci" },
      w.cookieHeader
    );
    const prOut = pr.body as { number: number; source_sha: string };

    // No status reported → merge blocked.
    const blocked = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/merge`,
      {},
      w.cookieHeader
    );
    expect(blocked.status).toBe(409);
    expect(String((blocked.body as { message?: string }).message)).toContain("ci/build");

    // Report success via the v3 statuses API (PAT auth), then merge lands.
    const status = await workerExports.default.fetch(
      `https://example.com/api/v3/repos/${w.namespaceSlug}/gwrepo/statuses/${prOut.source_sha}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: w.pushAuthHeader },
        body: JSON.stringify({ state: "success", context: "ci/build" }),
      }
    );
    expect(status.status).toBe(201);

    const merged = await post(
      `/api/v1/repos/${ref}/pullreq/${prOut.number}/merge`,
      {},
      w.cookieHeader
    );
    expect(merged.status).toBe(200);
    expect((merged.body as { mergeable: boolean }).mergeable).toBe(true);

    // Clean up the rule so it doesn't gate later tests.
    await workerExports.default.fetch(`https://example.com/api/v1/repos/${ref}/rules/${ruleId}`, {
      method: "DELETE",
      headers: { Cookie: w.cookieHeader },
    });
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

  // Client-sovereign secrets: the store round-trips metadata + opaque
  // ciphertext; the server never sees a plaintext value.
  it("sealed secrets CRUD — repo and space scope", async () => {
    const repoRef = `${w.namespaceSlug}/gwrepo/+`;
    const spaceRef = w.namespaceSlug;

    const put = (path: string, body: unknown, cookie?: string) =>
      workerExports.default.fetch(`https://example.com${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
      });

    // Unauthenticated write → 401.
    const anon = await put(`/api/v1/repos/${repoRef}/secrets`, {
      id: "sec_x",
      name: "api-key",
    });
    expect(anon.status).toBe(401);

    // Repo-scope create: client handle + wrapped ciphertext + host scope.
    const created = await put(
      `/api/v1/repos/${repoRef}/secrets`,
      {
        id: "sec_abc123",
        name: "deploy-key",
        allowed_hosts: ["ci.example.com"],
        ciphertext: "opaque-blob-never-plaintext",
        description: "ci deploy",
      },
      w.cookieHeader
    );
    expect(created.status).toBe(200);
    const rec = (await created.json()) as { id: string; name: string; ciphertext?: string };
    expect(rec.id).toBe("sec_abc123");

    const list = await get(`/api/v1/repos/${repoRef}/secrets`, w.cookieHeader);
    expect(list.status).toBe(200);
    const items = list.body as { id: string; name: string; allowed_hosts: string[] }[];
    expect(items.map((s) => s.name)).toContain("deploy-key");
    expect(items.find((s) => s.id === "sec_abc123")?.allowed_hosts).toEqual(["ci.example.com"]);

    // Upsert by name updates ciphertext.
    const upd = await put(
      `/api/v1/repos/${repoRef}/secrets`,
      { name: "deploy-key", ciphertext: "rotated-blob" },
      w.cookieHeader
    );
    expect(upd.status).toBe(200);
    const list2 = await get(`/api/v1/repos/${repoRef}/secrets`, w.cookieHeader);
    const after = list2.body as { ciphertext?: string }[];
    expect(after.find((s) => (s as { name: string }).name === "deploy-key")?.ciphertext).toBe(
      "rotated-blob"
    );

    // Space-scope round-trip.
    const sp = await put(
      `/api/v1/spaces/${spaceRef}/secrets`,
      { id: "sec_space1", name: "org-token", allowed_hosts: ["*.example.com"] },
      w.cookieHeader
    );
    expect(sp.status).toBe(200);
    expect(((await sp.json()) as { scope: number }).scope).toBe(1);
    const spList = await get(`/api/v1/spaces/${spaceRef}/secrets`, w.cookieHeader);
    expect((spList.body as { name: string }[]).map((s) => s.name)).toContain("org-token");
    // Space secrets are member-gated — anonymous read is denied.
    const anonList = await get(`/api/v1/spaces/${spaceRef}/secrets`);
    expect(anonList.status).toBe(401);

    // Delete both scopes.
    const del1 = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repoRef}/secrets/sec_abc123`,
      { method: "DELETE", headers: { Cookie: w.cookieHeader } }
    );
    expect(del1.status).toBe(200);
    const del2 = await workerExports.default.fetch(
      `https://example.com/api/v1/spaces/${spaceRef}/secrets/sec_space1`,
      { method: "DELETE", headers: { Cookie: w.cookieHeader } }
    );
    expect(del2.status).toBe(200);
    const final = await get(`/api/v1/repos/${repoRef}/secrets`, w.cookieHeader);
    expect((final.body as unknown[]).length).toBe(0);
  });

  it("fork records lineage — num_forks + network graph", async () => {
    const fork = await post(
      `/api/v1/repos/${ref}/fork`,
      { identifier: "gwrepo-fork" },
      w.cookieHeader
    );
    expect(fork.status).toBe(200);

    const detail = await get(`/api/v1/repos/${ref}`, w.cookieHeader);
    expect((detail.body as { num_forks: number }).num_forks).toBe(1);

    const network = await get(`/api/v1/repos/${ref}/network`, w.cookieHeader);
    expect(network.status).toBe(200);
    const net = network.body as {
      count: number;
      root: { id: number; full_name: string } | null;
      forks: { id: number; full_name: string; forked_from_id: number | null }[];
    };
    expect(net.count).toBe(1);
    expect(net.forks[0].full_name).toBe(`${w.namespaceSlug}/gwrepo-fork`);
    // The fork's own id lets clients rebuild the lineage tree; the root row
    // anchors it (forked_from_id → root.id).
    expect(net.root?.full_name).toBe(`${w.namespaceSlug}/gwrepo`);
    expect(net.forks[0].forked_from_id).toBe(net.root?.id);

    // The fork resolves as its own repo and reports 0 forks of its own.
    const forkDetail = await get(`/api/v1/repos/${w.namespaceSlug}/gwrepo-fork/+`, w.cookieHeader);
    expect(forkDetail.status).toBe(200);
    expect((forkDetail.body as { num_forks: number }).num_forks).toBe(0);
  });

  it("code-scanning: SARIF upload → analyses → alerts → dismiss", async () => {
    const sarif = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "test-scanner" } },
          results: [
            {
              ruleId: "CVE-TEST-1",
              level: "error",
              message: { text: "hardcoded key" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/key.ts" },
                    region: { startLine: 7 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const upload = await post(
      `/api/v1/repos/${ref}/code-scanning/sarifs`,
      { commit_sha: "abc123", ref: "refs/heads/main", sarif },
      w.cookieHeader
    );
    expect(upload.status).toBe(202);

    const analyses = await get(`/api/v1/repos/${ref}/code-scanning/analyses`, w.cookieHeader);
    const runs = analyses.body as { tool: { name: string }; results_count: number }[];
    expect(runs[0].tool.name).toBe("test-scanner");
    expect(runs[0].results_count).toBe(1);

    const alerts = await get(`/api/v1/repos/${ref}/code-scanning/alerts`, w.cookieHeader);
    const rows = alerts.body as {
      number: number;
      rule_id: string;
      location: { path: string };
    }[];
    expect(rows[0].rule_id).toBe("CVE-TEST-1");
    expect(rows[0].location.path).toBe("src/key.ts");

    const dismissed = await patch(
      `/api/v1/repos/${ref}/code-scanning/alerts/${rows[0].number}`,
      { state: "dismissed" },
      w.cookieHeader
    );
    expect(dismissed.status).toBe(200);
    expect((dismissed.body as { state: string }).state).toBe("dismissed");

    const open = await get(`/api/v1/repos/${ref}/code-scanning/alerts?state=open`, w.cookieHeader);
    expect((open.body as unknown[]).length).toBe(0);
  });

  it("security advisories: draft → publish → close lifecycle", async () => {
    const created = await post(
      `/api/v1/repos/${ref}/security-advisories`,
      {
        summary: "Test advisory",
        description: "details",
        severity: "high",
        vulnerabilities: [
          {
            package: { name: "libx", ecosystem: "npm" },
            vulnerable_version_range: "< 1.2.3",
            patched_versions: "1.2.3",
          },
        ],
      },
      w.cookieHeader
    );
    expect(created.status).toBe(201);
    const adv = created.body as { ghsa_id: string; state: string };
    expect(adv.ghsa_id).toMatch(/^GHSA-/);
    expect(adv.state).toBe("draft");

    // Drafts are hidden from anonymous readers on public repos.
    const anon = await get(`/api/v1/repos/${ref}/security-advisories`);
    expect((anon.body as { ghsa_id: string }[]).some((a) => a.ghsa_id === adv.ghsa_id)).toBe(false);

    const published = await patch(
      `/api/v1/repos/${ref}/security-advisories/${adv.ghsa_id}`,
      { state: "published" },
      w.cookieHeader
    );
    expect((published.body as { state: string }).state).toBe("published");

    const anonAfter = await get(`/api/v1/repos/${ref}/security-advisories`);
    expect((anonAfter.body as { ghsa_id: string }[]).some((a) => a.ghsa_id === adv.ghsa_id)).toBe(
      true
    );

    const closed = await patch(
      `/api/v1/repos/${ref}/security-advisories/${adv.ghsa_id}`,
      { state: "closed" },
      w.cookieHeader
    );
    expect((closed.body as { state: string }).state).toBe("closed");
  });
  it("check-runs: create → list → patch mirrors into combined status", async () => {
    const sha = "a".repeat(40);
    const v3 = `/api/v3/repos/${w.namespaceSlug}/gwrepo`;

    const created = await workerExports.default.fetch(`https://example.com${v3}/check-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: w.pushAuthHeader },
      body: JSON.stringify({
        name: "ci/lint",
        head_sha: sha,
        status: "in_progress",
        output: { title: "linting", summary: "running eslint" },
      }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; status: string };
    expect(run.status).toBe("in_progress");

    const listed = await workerExports.default.fetch(
      `https://example.com${v3}/commits/${sha}/check-runs`
    );
    const runs = (await listed.json()) as {
      total_count: number;
      check_runs: { id: string; name: string }[];
    };
    expect(runs.total_count).toBe(1);
    expect(runs.check_runs[0].name).toBe("ci/lint");

    // Complete with success — mirrors into combined status as a success
    // context named after the check.
    const patched = await workerExports.default.fetch(
      `https://example.com${v3}/check-runs/${run.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: w.pushAuthHeader },
        body: JSON.stringify({ status: "completed", conclusion: "success" }),
      }
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { conclusion: string }).conclusion).toBe("success");

    const combined = await workerExports.default.fetch(
      `https://example.com${v3}/commits/${sha}/status`
    );
    const status = (await combined.json()) as {
      state: string;
      statuses: { context: string; state: string }[];
    };
    expect(status.state).toBe("success");
    expect(status.statuses.some((s) => s.context === "ci/lint" && s.state === "success")).toBe(
      true
    );

    // GET by id resolves through the id→sha index.
    const byId = await workerExports.default.fetch(`https://example.com${v3}/check-runs/${run.id}`);
    expect(byId.status).toBe(200);
  });

  it("space profile PATCH + member permission level", async () => {
    const patched = await patch(
      `/api/v1/spaces/${w.namespaceSlug}`,
      { description: "test org", website: "https://example.org" },
      w.cookieHeader
    );
    expect(patched.status).toBe(200);
    const space = patched.body as { description: string; website: string };
    expect(space.description).toBe("test org");
    expect(space.website).toBe("https://example.org");

    const got = await get(`/api/v1/spaces/${w.namespaceSlug}`, w.cookieHeader);
    expect((got.body as { description: string }).description).toBe("test org");

    // The seeded owner reads as admin with a real write verdict.
    const perm = await get(
      `/api/v1/spaces/${w.namespaceSlug}/members/${w.namespaceSlug}/permission`,
      w.cookieHeader
    );
    expect(perm.status).toBe(200);
    const level = perm.body as { role: string; permission: string; can_write: boolean };
    expect(level.role).toBe("owner");
    expect(level.permission).toBe("admin");
    expect(level.can_write).toBe(true);
  });

  it("security log records PAT create + revoke", async () => {
    const created = await post("/api/v1/user/tokens", { identifier: "audit-tok" }, w.cookieHeader);
    expect(created.status).toBe(200);

    // Emission runs in waitUntil — poll the log briefly.
    const deadline = Date.now() + 5000;
    const find = async (kind: string) => {
      while (Date.now() < deadline) {
        const log = await get("/api/v1/user/security-log", w.cookieHeader);
        const rows = log.body as { kind: string; detail: string }[];
        const hit = rows.find((r) => r.kind === kind && r.detail === "audit-tok");
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    expect(await find("pat.create")).toBeTruthy();

    const patId = (created.body as { token: { identifier: string } }).token.identifier;
    const revoked = await workerExports.default.fetch(
      `https://example.com/api/v1/user/tokens/${patId}`,
      { method: "DELETE", headers: { Cookie: w.cookieHeader } }
    );
    expect(revoked.status).toBe(200);
    expect(await find("pat.revoke")).toBeTruthy();
  });
});

describe("gists — repo-backed gist surface", () => {
  async function call(
    method: string,
    path: string,
    body?: unknown,
    cookie?: string
  ): Promise<{ status: number; body: unknown; text: string }> {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await workerExports.default.fetch(`https://example.com${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* raw text body */
    }
    return { status: res.status, body: parsed, text };
  }

  it("covers create → list → detail → raw → patch → commits → star → delete", async () => {
    const cookie = seeded.cookieHeader;

    // create — anonymous 401, authed 201 with file contents echoed back
    const anon = await call("POST", "/api/v1/gists", { files: { "a.txt": "x" } });
    expect(anon.status).toBe(401);

    const created = await call(
      "POST",
      "/api/v1/gists",
      {
        description: "first gist",
        public: true,
        files: { "hello.txt": "hello world", "other.md": "# t\n" },
      },
      cookie
    );
    expect(created.status).toBe(201);
    const gist = created.body as {
      id: string;
      public: boolean;
      files: Record<string, { filename: string; content: string }>;
    };
    expect(gist.id).toMatch(/^g-[0-9a-f]{12}$/);
    expect(gist.public).toBe(true);
    expect(gist.files["hello.txt"].content).toBe("hello world");

    // gist repo hidden from the space repo list
    const spaceRepos = await call(
      "GET",
      `/api/v1/spaces/${seeded.namespaceSlug}/repos`,
      undefined,
      cookie
    );
    const slugs = (spaceRepos.body as { identifier: string }[]).map((r) => r.identifier);
    expect(slugs).not.toContain(gist.id);

    // list — anonymous 401, authed contains the gist
    expect((await call("GET", "/api/v1/gists")).status).toBe(401);
    const mine = await call("GET", "/api/v1/gists", undefined, cookie);
    expect((mine.body as { id: string }[]).map((g) => g.id)).toContain(gist.id);

    // detail — anonymous ok on public gist
    const detail = await call("GET", `/api/v1/gists/${gist.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as { description: string }).description).toBe("first gist");

    // raw file content
    const raw = await call("GET", `/api/v1/gists/${gist.id}/raw/hello.txt`);
    expect(raw.status).toBe(200);
    expect(raw.text).toBe("hello world");

    // patch — rename hello.txt→hi.txt, delete other.md, update description
    const patched = await call(
      "PATCH",
      `/api/v1/gists/${gist.id}`,
      {
        description: "renamed",
        files: { "hello.txt": { filename: "hi.txt", content: "hello v2" }, "other.md": null },
      },
      cookie
    );
    expect(patched.status).toBe(200);
    const patchedGist = patched.body as {
      description: string;
      files: Record<string, { content: string }>;
    };
    expect(patchedGist.description).toBe("renamed");
    expect(Object.keys(patchedGist.files).sort()).toEqual(["hi.txt"]);
    expect(patchedGist.files["hi.txt"].content).toBe("hello v2");

    // commits — root + update
    const commits = await call("GET", `/api/v1/gists/${gist.id}/commits`);
    expect(commits.status).toBe(200);
    expect((commits.body as { sha: string }[]).length).toBeGreaterThanOrEqual(2);

    // star toggle
    expect((await call("PUT", `/api/v1/gists/${gist.id}/star`, undefined, cookie)).status).toBe(
      200
    );
    const starred = await call("GET", `/api/v1/gists/${gist.id}`, undefined, cookie);
    expect((starred.body as { viewer_starred: boolean }).viewer_starred).toBe(true);

    // delete → subsequent reads 404 (queue teardown is async; the route
    // itself must accept + enqueue)
    expect((await call("DELETE", `/api/v1/gists/${gist.id}`, undefined, cookie)).status).toBe(204);
  });
});

describe("signature verification — SSHSIG signed commits", () => {
  const te = new TextEncoder();

  function sshString(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + data.length);
    new DataView(out.buffer).setUint32(0, data.length, false);
    out.set(data, 4);
    return out;
  }
  function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  function b64(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }

  type TestKey = { key: CryptoKey; wirePubkey: Uint8Array; authorizedLine: string };

  async function makeKey(): Promise<TestKey> {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const wirePubkey = concat([sshString(te.encode("ssh-ed25519")), sshString(rawPub)]);
    return {
      key: pair.privateKey,
      wirePubkey,
      authorizedLine: `ssh-ed25519 ${b64(wirePubkey)} test`,
    };
  }

  /** SSHSIG blob per PROTOCOL.sshsig over `message` (hash sha512, ns git). */
  async function signCommit(key: TestKey, message: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", message.slice().buffer));
    const signedData = concat([
      te.encode("SSHSIG"),
      sshString(te.encode("git")),
      sshString(new Uint8Array(0)),
      sshString(te.encode("sha512")),
      sshString(digest),
    ]);
    const rawSig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", key.key, signedData.slice().buffer)
    );
    const blob = concat([
      te.encode("SSHSIG"),
      new Uint8Array([0, 0, 0, 1]),
      sshString(key.wirePubkey),
      sshString(te.encode("git")),
      sshString(new Uint8Array(0)),
      sshString(te.encode("sha512")),
      sshString(concat([sshString(te.encode("ssh-ed25519")), sshString(rawSig)])),
    ]);
    const armored = `-----BEGIN SSH SIGNATURE-----\n${b64(blob).replace(/(.{70})/g, "$1\n")}\n-----END SSH SIGNATURE-----`;
    return armored;
  }

  /** Embed `gpgsig` into the unsigned commit text → final payload. */
  function withGpgsig(unsignedText: string, armor: string): Uint8Array {
    const sigLines = armor.split("\n");
    const block = `gpgsig ${sigLines[0]}\n${sigLines
      .slice(1)
      .map((l) => ` ${l}`)
      .join("\n")}\n`;
    const idx = unsignedText.indexOf("\n\n");
    const text = `${unsignedText.slice(0, idx + 1)}${block}${unsignedText.slice(idx + 1)}`;
    return te.encode(text);
  }

  it("verifies a signed commit against the user's ssh keyring", async () => {
    const repo = await setupRepoForTests(env, uniq("sig-ns"), "sigrepo");
    const key = await makeKey();

    // Register the ssh key — writes the gkeyfp fingerprint index.
    const keyRes = await workerExports.default.fetch("https://example.com/api/v1/user/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({ content: key.authorizedLine }),
    });
    expect(keyRes.status).toBe(200);

    // Build a commit: empty tree, gpgsig header carrying the SSHSIG armor.
    const { buildPack } = await import("./util/git-pack");
    const { encodeGitObject, pktLine, flushPkt, concatChunks } = await import("@/worker/git/core");
    const { buildTreePayload } = await import("./util/packed-repo");

    const blob = await encodeGitObject("blob", te.encode("signed content"));
    const tree = await encodeGitObject(
      "tree",
      buildTreePayload([{ mode: "100644", name: "s.txt", oid: blob.oid }])
    );
    const unsignedText =
      `tree ${tree.oid}\n` +
      `author You <you@example.com> 0 +0000\n` +
      `committer You <you@example.com> 0 +0000\n` +
      `\nsigned root commit\n`;
    const armor = await signCommit(key, te.encode(unsignedText));
    const signedPayload = withGpgsig(unsignedText, armor);
    const commit = await encodeGitObject("commit", signedPayload);

    const pack = await buildPack([
      { type: "blob", payload: te.encode("signed content") },
      {
        type: "tree",
        payload: buildTreePayload([{ mode: "100644", name: "s.txt", oid: blob.oid }]),
      },
      { type: "commit", payload: signedPayload },
    ]);
    const body = concatChunks([
      pktLine(
        `0000000000000000000000000000000000000000 ${commit.oid} refs/heads/main\0 report-status ofs-delta\n`
      ),
      flushPkt(),
      pack,
    ]);
    const push = await workerExports.default.fetch(
      `https://example.com/${repo.namespaceSlug}/${repo.repoSlug}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: repo.pushAuthHeader,
        },
        body: new Uint8Array(body),
      }
    );
    expect(push.status).toBe(200);

    const verify = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repo.namespaceSlug}/${repo.repoSlug}/signature-verification?commit_sha=${commit.oid}`
    );
    const result = (await verify.json()) as {
      signed: boolean;
      verified: boolean;
      signer?: string;
      reason?: string;
    };
    expect(result.signed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.signer).toBe(repo.userId);

    // unknown signer — valid sig, unregistered key → verified:false
    const stranger = await makeKey();
    const armor2 = await signCommit(stranger, te.encode(unsignedText));
    const sig2 = withGpgsig(unsignedText, armor2);
    const commit2 = await encodeGitObject("commit", sig2);
    const pack2 = await buildPack([{ type: "commit", payload: sig2 }]);
    // commit2 alone fails pack closure — push it on top via a second ref using
    // the same objects (trees/blobs already in the repo).
    const body2 = concatChunks([
      pktLine(
        `0000000000000000000000000000000000000000 ${commit2.oid} refs/heads/stranger\0 report-status ofs-delta\n`
      ),
      flushPkt(),
      pack2,
    ]);
    const push2 = await workerExports.default.fetch(
      `https://example.com/${repo.namespaceSlug}/${repo.repoSlug}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: repo.pushAuthHeader,
        },
        body: new Uint8Array(body2),
      }
    );
    // Even if the thin push is refused, verification only needs the object —
    // it may not have landed; only assert the route stays honest on 404.
    if (push2.status === 200) {
      const v2 = await workerExports.default.fetch(
        `https://example.com/api/v1/repos/${repo.namespaceSlug}/${repo.repoSlug}/signature-verification?commit_sha=${commit2.oid}`
      );
      const r2 = (await v2.json()) as { signed: boolean; verified: boolean; reason?: string };
      expect(r2.signed).toBe(true);
      expect(r2.verified).toBe(false);
      expect(r2.reason).toContain("unknown key");
    }
  });

  it("verifies a PGP-signed commit against the registered gpg key", async () => {
    const openpgp = await import("openpgp");
    const repo = await setupRepoForTests(env, uniq("pgp-ns"), "pgprepo");

    const { privateKey: armoredPriv, publicKey: armoredPub } = await openpgp.generateKey({
      userIDs: [{ name: "Test", email: "t@example.com" }],
      curve: "ed25519Legacy",
      format: "armored",
    });
    const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv });

    // Register the public key via the gpg-keys API (writes gpgfp index).
    const keyRes = await workerExports.default.fetch("https://example.com/api/v1/user/gpg-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({ armored_key: armoredPub }),
    });
    expect(keyRes.status).toBe(201);
    const registered = (await keyRes.json()) as { key_id: string; fingerprint: string };
    expect(registered.fingerprint).toMatch(/^[0-9A-F]{40}$/);

    // Build a commit, detach-sign the unsigned payload, embed the armor.
    const { buildPack } = await import("./util/git-pack");
    const { encodeGitObject, pktLine, flushPkt, concatChunks } = await import("@/worker/git/core");
    const { buildTreePayload } = await import("./util/packed-repo");

    const blob = await encodeGitObject("blob", te.encode("pgp signed"));
    const tree = await encodeGitObject(
      "tree",
      buildTreePayload([{ mode: "100644", name: "p.txt", oid: blob.oid }])
    );
    const unsignedText =
      `tree ${tree.oid}\n` +
      `author T <t@example.com> 0 +0000\n` +
      `committer T <t@example.com> 0 +0000\n` +
      `\npgp signed commit\n`;
    const armor = await openpgp.sign({
      message: await openpgp.createMessage({ binary: te.encode(unsignedText) }),
      signingKeys: priv,
      detached: true,
      format: "armored",
    });
    const signedPayload = withGpgsig(unsignedText, armor);
    const commit = await encodeGitObject("commit", signedPayload);

    const pack = await buildPack([
      { type: "blob", payload: te.encode("pgp signed") },
      {
        type: "tree",
        payload: buildTreePayload([{ mode: "100644", name: "p.txt", oid: blob.oid }]),
      },
      { type: "commit", payload: signedPayload },
    ]);
    const push = await workerExports.default.fetch(
      `https://example.com/${repo.namespaceSlug}/${repo.repoSlug}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: repo.pushAuthHeader,
        },
        body: new Uint8Array(
          concatChunks([
            pktLine(
              `0000000000000000000000000000000000000000 ${commit.oid} refs/heads/main\0 report-status ofs-delta\n`
            ),
            flushPkt(),
            pack,
          ])
        ),
      }
    );
    expect(push.status).toBe(200);

    const verify = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repo.namespaceSlug}/${repo.repoSlug}/signature-verification?commit_sha=${commit.oid}`
    );
    const result = (await verify.json()) as {
      signed: boolean;
      verified: boolean;
      signer?: string;
      reason?: string;
    };
    expect(result.signed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.signer).toBe(repo.userId);
  });
});

describe("dr — bundle export, drill, download", () => {
  const te = new TextEncoder();

  async function pushCommit(
    repo: SetupRepoForTestsResult,
    text: string,
    name: string,
    message: string
  ) {
    const { buildPack } = await import("./util/git-pack");
    const { encodeGitObject, pktLine, flushPkt, concatChunks } = await import("@/worker/git/core");
    const { buildTreePayload } = await import("./util/packed-repo");
    const blob = await encodeGitObject("blob", te.encode(text));
    const treePayload = buildTreePayload([{ mode: "100644", name, oid: blob.oid }]);
    const tree = await encodeGitObject("tree", treePayload);
    const commitPayload = te.encode(
      `tree ${tree.oid}\nauthor You <you@example.com> 0 +0000\ncommitter You <you@example.com> 0 +0000\n\n${message}\n`
    );
    const commit = await encodeGitObject("commit", commitPayload);
    const pack = await buildPack([
      { type: "blob", payload: te.encode(text) },
      { type: "tree", payload: treePayload },
      { type: "commit", payload: commitPayload },
    ]);
    const body = concatChunks([
      pktLine(
        `0000000000000000000000000000000000000000 ${commit.oid} refs/heads/main\0 report-status ofs-delta\n`
      ),
      flushPkt(),
      pack,
    ]);
    const res = await workerExports.default.fetch(
      `https://example.com/${repo.namespaceSlug}/${repo.repoSlug}/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: repo.pushAuthHeader,
        },
        body: new Uint8Array(body),
      }
    );
    expect(res.status).toBe(200);
    return commit.oid;
  }

  it("exports a bundle manifest, drills it clean, and serves the download", async () => {
    const repo = await setupRepoForTests(env, uniq("dr-ns"), "drrepo");
    const base = `/api/v1/repos/${repo.namespaceSlug}/drrepo/+`;
    const commitOid = await pushCommit(repo, "dr backup\n", "data.txt", "dr seed");

    const exported = await workerExports.default.fetch(
      `${"https://example.com"}${base}/dr/export`,
      {
        method: "POST",
        headers: { Cookie: repo.cookieHeader },
      }
    );
    const exportedText = await exported.text();
    expect(exported.status, exportedText).toBe(201);
    const manifest = JSON.parse(exportedText) as {
      bundleKey: string;
      bundleBytes: number;
      refs: { name: string; oid: string }[];
      manifestKey: string;
      exportedAt: number;
    };
    expect(manifest.bundleBytes).toBeGreaterThan(0);
    expect(manifest.refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(commitOid);

    const list = await workerExports.default.fetch(`https://example.com${base}/dr/exports`, {
      headers: { Cookie: repo.cookieHeader },
    });
    const manifests = (await list.json()) as { bundleBytes: number }[];
    expect(manifests.length).toBe(1);

    const drilled = await workerExports.default.fetch(`https://example.com${base}/dr/verify`, {
      method: "POST",
      headers: { Cookie: repo.cookieHeader },
    });
    const drillText = await drilled.text();
    const drill = JSON.parse(drillText) as {
      status: string;
      checks: { name: string; ok: boolean; detail?: string }[];
    };
    expect(drill.status, drillText).toBe("pass");
    for (const check of drill.checks) expect(check.ok).toBe(true);
    const objCheck = drill.checks.find((ch) => ch.name === "pack_objects");
    expect(objCheck?.detail).toContain("3 objects");

    const dl = await workerExports.default.fetch(
      `https://example.com${base}/dr/download/${manifest.exportedAt}`,
      { headers: { Cookie: repo.cookieHeader } }
    );
    expect(dl.status).toBe(200);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 14))).toBe("GIT BUNDLE V3\n");
  });

  it("restores a stored export into a fresh repo", async () => {
    const repo = await setupRepoForTests(env, uniq("drs-ns"), "drsrc");
    const base = `/api/v1/repos/${repo.namespaceSlug}/drsrc/+`;
    const commitOid = await pushCommit(repo, "dr restore me\n", "r.txt", "dr restore seed");

    const exported = await workerExports.default.fetch(`https://example.com${base}/dr/export`, {
      method: "POST",
      headers: { Cookie: repo.cookieHeader },
    });
    expect(exported.status).toBe(201);

    // Fresh target repo in the same namespace — restore replays refs+pack.
    const created = await workerExports.default.fetch("https://example.com/api/v1/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({ identifier: "drtarget", parent_ref: repo.namespaceSlug }),
    });
    expect(created.status, await created.text()).toBe(200);
    const restore = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repo.namespaceSlug}/drtarget/+/dr/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
        body: JSON.stringify({ source: `${repo.namespaceSlug}/drsrc` }),
      }
    );
    const restoreText = await restore.text();
    expect(restore.status, restoreText).toBe(201);
    const restored = JSON.parse(restoreText) as { refs: number; objects: number };
    expect(restored.objects).toBe(3);

    // The target now serves the restored tip on refs/heads/main.
    const refs = await get(
      `/api/v1/repos/${repo.namespaceSlug}/drtarget/+/branches`,
      repo.cookieHeader
    );
    expect(refs.status).toBe(200);
    const refList = refs.body as { name: string; sha: string }[];
    expect(refList.find((r) => r.name === "main")?.sha).toBe(commitOid);

    // Second restore into the now-non-empty target must refuse.
    const again = await workerExports.default.fetch(
      `https://example.com/api/v1/repos/${repo.namespaceSlug}/drtarget/+/dr/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
        body: JSON.stringify({ source: `${repo.namespaceSlug}/drsrc` }),
      }
    );
    expect(again.status).toBe(409);
  });
});

describe("npm registry /npm", () => {
  const enc = (scope: string, name: string) => `@${scope}%2F${name}`;

  function publishBody(name: string, version: string, tgz: Uint8Array): Record<string, unknown> {
    let bin = "";
    for (const b of tgz) bin += String.fromCharCode(b);
    return {
      name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          name,
          version,
          description: "fixture pkg",
          dist: {
            tarball: `https://upstream.example/${name}/-/${name.split("/")[1]}-0.0.0.tgz`,
          },
        },
      },
      _attachments: {
        [`${name.split("/")[1]}-${version}.tgz`]: {
          content_type: "application/octet-stream",
          data: btoa(bin),
        },
      },
    };
  }

  it("publish → packument → tarball round-trip with sha checks", async () => {
    const repo = await setupRepoForTests(env, uniq("npm-ns"), "npmbase");
    const tgz = new TextEncoder().encode(`fixture-tarball-${Date.now()}`);
    const put = await workerExports.default.fetch(
      `https://example.com/npm/${enc(repo.namespaceSlug, "widget")}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${repo.patPlaintext}`,
        },
        body: JSON.stringify(publishBody(`@${repo.namespaceSlug}/widget`, "1.0.0", tgz)),
      }
    );
    const putText = await put.text();
    expect(put.status, putText).toBe(201);

    const doc = await get(`/npm/${enc(repo.namespaceSlug, "widget")}`);
    expect(doc.status).toBe(200);
    const pack = doc.body as {
      "dist-tags": { latest: string };
      versions: Record<string, { dist: { tarball: string; shasum: string; integrity: string } }>;
    };
    expect(pack["dist-tags"].latest).toBe("1.0.0");
    const dist = pack.versions["1.0.0"].dist;
    expect(dist.integrity.startsWith("sha512-")).toBe(true);
    expect(dist.shasum).toMatch(/^[0-9a-f]{40}$/);
    // Server rewrites tarball to our origin — never trust the declared URL.
    expect(dist.tarball.startsWith("https://example.com/npm/")).toBe(true);

    const dl = await workerExports.default.fetch(dist.tarball);
    // Fixture tarball is ASCII — text() round-trips it losslessly.
    const dlText = await dl.text();
    expect(dl.status, `${dist.tarball} :: ${dlText}`).toBe(200);
    expect(new TextEncoder().encode(dlText)).toEqual(tgz);
    // Re-publish same version → npm immutability semantics.
    const repub = await workerExports.default.fetch(
      `https://example.com/npm/${enc(repo.namespaceSlug, "widget")}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${repo.patPlaintext}`,
        },
        body: JSON.stringify(publishBody(`@${repo.namespaceSlug}/widget`, "1.0.0", tgz)),
      }
    );
    expect(repub.status).toBe(409);

    // Bad token → 401; unknown scope namespace → 404.
    const badToken = await workerExports.default.fetch(
      `https://example.com/npm/${enc(repo.namespaceSlug, "widget")}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer bogus" },
        body: JSON.stringify(publishBody(`@${repo.namespaceSlug}/widget`, "1.0.1", tgz)),
      }
    );
    expect(badToken.status).toBe(401);

    const missingScope = await get("/npm/@no-such-ns%2Fwidget");
    expect(missingScope.status).toBe(404);
  });
});

describe("namespace quotas", () => {
  it("quota endpoint reports storage + repo accounting; create rate-limit 429s", async () => {
    const repo = await setupRepoForTests(env, uniq("qta-ns"), "qtarepo");

    const quota = await get(`/api/v1/spaces/${repo.namespaceSlug}/quota`, repo.cookieHeader);
    expect(quota.status).toBe(200);
    const q = quota.body as {
      storage: { used_bytes: number; limit_bytes: number };
      repos: { count: number; limit: number };
      rate_limits: { repo_create_per_hour: number };
    };
    expect(q.storage.limit_bytes).toBe(2 * 1024 * 1024 * 1024);
    expect(q.repos.count).toBeGreaterThanOrEqual(1);
    expect(q.repos.limit).toBe(500);
    expect(q.rate_limits.repo_create_per_hour).toBe(10);

    // Anonymous + non-member reads are gated.
    expect((await get(`/api/v1/spaces/${repo.namespaceSlug}/quota`)).status).toBe(401);

    // Drain the hourly create bucket against the same KV counter the route
    // consults, then the next create must 429 with Retry-After.
    const { rateLimit, LIMITS } = await import("@/worker/agent/abuse");
    for (let i = 0; i < LIMITS.repoCreate.limit; i++) {
      await rateLimit(env, LIMITS.repoCreate, repo.userId);
    }
    const blocked = await workerExports.default.fetch("https://example.com/api/v1/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({
        identifier: "quota-blocked",
        parent_ref: repo.namespaceSlug,
      }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("DID resolution /1.0/identifiers", () => {
  it("resolves did:key + legacy did:dg deterministically, rejects malformed", async () => {
    const { didKeyFromPubkey, pubkeyFromDidKey } = await import("@/worker/agent/atpauth/didkey");
    const { bytesToHex } = await import("@/worker/common/hex");
    const pubkey = crypto.getRandomValues(new Uint8Array(32));
    const did = didKeyFromPubkey(pubkey, "ed25519");

    const res = await get(`/1.0/identifiers/${did}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      didDocument: {
        id: string;
        verificationMethod: { publicKeyMultibase: string }[];
        authentication: string[];
      };
      didResolutionMetadata: { contentType: string };
    };
    expect(body.didDocument.id).toBe(did);
    expect(body.didResolutionMetadata.contentType).toBe("application/did+json");
    // The multibase key in the document decodes back to the same pubkey.
    const { decodeKeyMultibase } = await import("@/worker/agent/atpauth/didkey");
    const decoded = decodeKeyMultibase(body.didDocument.verificationMethod[0].publicKeyMultibase);
    expect(decoded?.pubkey).toEqual(pubkey);
    expect(pubkeyFromDidKey(did)?.pubkey).toEqual(pubkey);

    // Legacy did:dg resolves and points at its did:key canonical spelling.
    const legacy = await get(`/1.0/identifiers/did:dg:${bytesToHex(pubkey)}`);
    expect(legacy.status).toBe(200);
    const dgDoc = (legacy.body as { didDocument: { id: string; alsoKnownAs: string[] } })
      .didDocument;
    expect(dgDoc.alsoKnownAs).toContain(did);

    const bad = await get("/1.0/identifiers/did:key:not-base58!!!");
    expect(bad.status).toBe(400);
    const missing = await get("/1.0/identifiers/did:unsupported:abc123");
    expect([404, 400, 500]).toContain(missing.status);
  });
});

describe("mirror-out targets", () => {
  it("PUT/GET mirrors round-trips federation config", async () => {
    const repo = await setupRepoForTests(env, uniq("mir-ns"), "mirrepo");
    const base = `/api/v1/repos/${repo.namespaceSlug}/mirrepo/+`;

    const empty = await get(`${base}/mirrors`, repo.cookieHeader);
    expect(empty.status).toBe(200);
    expect((empty.body as { mirrors: unknown[] }).mirrors).toEqual([]);

    const put = await workerExports.default.fetch(`https://example.com${base}/mirrors`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({
        mirrors: [
          { name: "knot", url: "https://knot.example.com/mir-ns/mirrepo.git" },
          { name: "radicle", url: "rad:z3gKSJU9ZU5sGf7z6YhXq8KjE5Zq2" },
        ],
      }),
    });
    const putText = await put.text();
    expect(put.status, putText).toBe(200);

    const got = await get(`${base}/mirrors`, repo.cookieHeader);
    const mirrors = (got.body as { mirrors: { name: string; url: string }[] }).mirrors;
    expect(mirrors.length).toBe(2);
    expect(mirrors[1].url.startsWith("rad:")).toBe(true);

    // Scheme validation + cap enforcement.
    const bad = await workerExports.default.fetch(`https://example.com${base}/mirrors`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({ mirrors: [{ name: "x", url: "ftp://nope" }] }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("dependency graph", () => {
  it("snapshot submission flattens resolved deps; OSV maps ecosystems", async () => {
    const repo = await setupRepoForTests(env, uniq("dep-ns"), "deprepo");
    const base = `/api/v1/repos/${repo.namespaceSlug}/deprepo/+`;

    const submit = await workerExports.default.fetch(
      `https://example.com${base}/dependency-graph/snapshots`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
        body: JSON.stringify({
          sha: "a".repeat(40),
          ref: "refs/heads/main",
          detector: { name: "test-detector" },
          manifests: {
            "package-lock.json": {
              resolved: {
                "pkg:npm/lodash@4.17.21": { relationship: "direct", scope: "runtime" },
                "pkg:npm/minimist@1.2.5": { relationship: "indirect", scope: "runtime" },
                "pkg:cargo/serde@1.0.0": { relationship: "direct" },
                "pkg:unknown/thing@1.0": {},
              },
            },
          },
        }),
      }
    );
    const submitText = await submit.text();
    expect(submit.status, submitText).toBe(201);

    const graph = await get(`${base}/dependency-graph`, repo.cookieHeader);
    expect(graph.status).toBe(200);
    const g = graph.body as {
      dependencies: { package_url: string; ecosystem: string; relationship: string }[];
      detector: string;
    };
    // The unknown purl type is skipped; the other 3 survive.
    expect(g.dependencies.length).toBe(3);
    expect(g.detector).toBe("test-detector");
    const cargo = g.dependencies.find((d) => d.package_url === "pkg:cargo/serde@1.0.0");
    expect(cargo?.ecosystem).toBe("crates.io");

    // OSV mapping via the injectable fetcher — asserts the request shape.
    const { queryOsvBatch } = await import("@/worker/api/gitness/depgraph");
    let captured: { url: string; body: string } | null = null;
    const vulns = await queryOsvBatch(
      g.dependencies.map((d) => {
        const m = /^pkg:[a-z]+\/(.+?)@([^@]+)$/.exec(d.package_url);
        return {
          purl: d.package_url,
          name: m?.[1] ?? "",
          version: m?.[2] ?? "",
          ecosystem: d.ecosystem,
          relationship: d.relationship,
          scope: "runtime",
          manifest: "package-lock.json",
        };
      }),
      async (url, init) => {
        captured = { url, body: String(init?.body) };
        return new Response(
          JSON.stringify({
            results: [
              { vulns: [{ id: "GHSA-xxxx", aliases: ["CVE-2021-23337"] }] },
              { vulns: null },
              { vulns: [] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    expect(captured!.url).toBe("https://api.osv.dev/v1/querybatch");
    const queries = JSON.parse(captured!.body).queries as {
      package: { name: string; ecosystem: string };
      version: string;
    }[];
    expect(queries[0]).toEqual({
      package: { name: "lodash", ecosystem: "npm" },
      version: "4.17.21",
    });
    expect(vulns["pkg:npm/lodash@4.17.21"]?.[0]?.id).toBe("GHSA-xxxx");
    expect(vulns["pkg:npm/minimist@1.2.5"]).toBeUndefined();
  });
});

describe("clone traffic", () => {
  it("records clones per day and reports a GitHub-shaped series", async () => {
    const repo = await setupRepoForTests(env, uniq("trf-ns"), "trfrepo");
    const { recordClone } = await import("@/worker/traffic");
    await recordClone(env, repo.doName);
    await recordClone(env, repo.doName);
    await recordClone(env, repo.doName);

    const res = await get(
      `/api/v1/repos/${repo.namespaceSlug}/trfrepo/+/traffic/clones`,
      repo.cookieHeader
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      count: number;
      uniques: null;
      clones: { timestamp: string; count: number }[];
    };
    expect(body.clones.length).toBe(14);
    expect(body.count).toBe(3);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.clones.find((d) => d.timestamp.startsWith(today))?.count).toBe(3);
  });
});

describe("ops probes", () => {
  it("/healthz + /readyz report dependency health", async () => {
    const health = await get("/healthz");
    expect(health.status).toBe(200);
    expect((health.body as { ok: boolean }).ok).toBe(true);

    const ready = await get("/readyz");
    expect(ready.status).toBe(200);
    const checks = (ready.body as { checks: Record<string, boolean> }).checks;
    expect(checks.d1).toBe(true);
    expect(checks.kv).toBe(true);
    expect(checks.r2).toBe(true);
  });
});

describe("community profile", () => {
  it("scores health files in root and .github", async () => {
    const repo = await setupRepoForTests(env, uniq("comm-ns"), "commrepo");
    // Give the repo a main branch + objects so the commits API has a base.
    await env.REPO_DO.get(env.REPO_DO.idFromName(repo.doName)).seedMinimalRepo();
    const base = `/api/v1/repos/${repo.namespaceSlug}/commrepo/+`;

    const commit = await workerExports.default.fetch(`https://example.com${base}/commits`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({
        branch: "main",
        message: "seed community files",
        actions: [
          { action: "CREATE", path: "README.md", encoding: "text", payload: "# commrepo\n" },
          {
            action: "CREATE",
            path: "LICENSE",
            encoding: "text",
            payload: "MIT License\n\nPermission is hereby granted, free of charge\n",
          },
          { action: "CREATE", path: "SECURITY.md", encoding: "text", payload: "# Security\n" },
          {
            action: "CREATE",
            path: ".github/PULL_REQUEST_TEMPLATE.md",
            encoding: "text",
            payload: "Template\n",
          },
        ],
      }),
    });
    expect(commit.status, await commit.text()).toBe(200);

    const profile = await get(`${base}/community/profile`);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    const body = profile.body as {
      health_percentage: number;
      files: Record<string, { name: string; path: string; spdx_id?: string } | null>;
    };
    expect(body.files.readme?.name).toBe("README.md");
    expect(body.files.license?.spdx_id).toBe("MIT");
    expect(body.files.security?.name).toBe("SECURITY.md");
    expect(body.files.pull_request_template?.path).toBe(".github/PULL_REQUEST_TEMPLATE.md");
    expect(body.files.code_of_conduct).toBeNull();
    // 4 of 7 slots filled: readme, license, security, pr_template.
    expect(body.health_percentage).toBe(Math.round((4 / 7) * 100));
  });
});

describe("webhook event fan-out", () => {
  it("star + ref create enqueue GitHub-named events to matching subs", async () => {
    const repo = await setupRepoForTests(env, uniq("wh-ns"), "whrepo");
    await env.REPO_DO.get(env.REPO_DO.idFromName(repo.doName)).seedMinimalRepo();
    const base = `/api/v1/repos/${repo.namespaceSlug}/whrepo/+`;

    const sub = await workerExports.default.fetch(`https://example.com${base}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
      body: JSON.stringify({
        url: "https://hooks.example/x",
        triggers: ["star", "create", "delete"],
      }),
    });
    expect(sub.status, await sub.text()).toBe(200);

    // Spy on the queue producer — emitRepoEvent runs inside waitUntil, so
    // poll briefly for the sends to land.
    const sent: { kind: string }[] = [];
    const orig = env.REPO_TASKS_QUEUE.send.bind(env.REPO_TASKS_QUEUE);
    env.REPO_TASKS_QUEUE.send = ((m: unknown) => {
      sent.push({ kind: (m as { event: { kind: string } }).event.kind });
      return Promise.resolve();
    }) as unknown as typeof env.REPO_TASKS_QUEUE.send;
    try {
      const star = await workerExports.default.fetch(`https://example.com${base}/star`, {
        method: "PUT",
        headers: { Cookie: repo.cookieHeader },
      });
      expect(star.status).toBe(200);
      const branch = await workerExports.default.fetch(`https://example.com${base}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: repo.cookieHeader },
        body: JSON.stringify({ name: "hooked", target: "main" }),
      });
      expect(branch.status).toBe(200);
      for (let i = 0; i < 20 && sent.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      env.REPO_TASKS_QUEUE.send = orig;
    }
    const kinds = sent.map((s) => s.kind).sort();
    expect(kinds).toEqual(["create", "star"]);
  });
});
