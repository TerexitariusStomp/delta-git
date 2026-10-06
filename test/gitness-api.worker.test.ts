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
    const net = network.body as { count: number; forks: { full_name: string }[] };
    expect(net.count).toBe(1);
    expect(net.forks[0].full_name).toBe(`${w.namespaceSlug}/gwrepo-fork`);

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
});
