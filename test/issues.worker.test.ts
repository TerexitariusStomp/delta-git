import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Issues surface coverage: the DO-backed tracker exposed twice —
// session-authed /api/v1 (SPA) and PAT/anonymous /api/v3 (gh/agent clients).
// The happy path runs on a public repo so anonymous v3 reads are allowed.

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

interface IssueJson {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: string | null;
  user: { login: string };
  labels: { name: string; color: string }[];
  assignees: { login: string }[];
  comments: number;
  work_intent_id?: string | null;
  html_url?: string;
  closed_at: string | null;
}

interface CommentJson {
  id: string;
  body: string;
  user: { login: string };
}

let seeded: SetupRepoForTestsResult;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("iss-ns"), "issrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/issrepo/+`;
});

describe("issues: /api/v1 session facade", () => {
  it("creates an issue with a work_intent materialized", async () => {
    const { status, body } = await call("POST", `${base}/issues`, {
      cookie: seeded.cookieHeader,
      body: { title: "First issue", body: "hello **world**", labels: ["bug"] },
    });
    expect(status).toBe(201);
    const issue = body as IssueJson;
    expect(issue.number).toBe(1);
    expect(issue.state).toBe("open");
    expect(issue.title).toBe("First issue");
    expect(issue.work_intent_id).toBeTruthy();
    expect(issue.labels.map((l) => l.name)).toContain("bug");
  });

  it("rejects anonymous writes", async () => {
    const { status } = await call("POST", `${base}/issues`, {
      body: { title: "nope" },
    });
    expect(status).toBe(401);
  });

  it("lists open issues and filters by state", async () => {
    const open = await call("GET", `${base}/issues?state=open`, {
      cookie: seeded.cookieHeader,
    });
    expect(open.status).toBe(200);
    const list = open.body as IssueJson[];
    expect(list.some((i) => i.number === 1)).toBe(true);

    const closed = await call("GET", `${base}/issues?state=closed`, {
      cookie: seeded.cookieHeader,
    });
    expect((closed.body as IssueJson[]).some((i) => i.number === 1)).toBe(false);
  });

  it("closes with state_reason and reopens", async () => {
    const closed = await call("PATCH", `${base}/issues/1`, {
      cookie: seeded.cookieHeader,
      body: { state: "closed", state_reason: "completed" },
    });
    expect(closed.status).toBe(200);
    const closedIssue = closed.body as IssueJson;
    expect(closedIssue.state).toBe("closed");
    expect(closedIssue.state_reason).toBe("completed");
    expect(closedIssue.closed_at).toBeTruthy();

    const reopened = await call("PATCH", `${base}/issues/1`, {
      cookie: seeded.cookieHeader,
      body: { state: "open" },
    });
    expect((reopened.body as IssueJson).state).toBe("open");
  });

  it("supports the comment lifecycle", async () => {
    const created = await call("POST", `${base}/issues/1/comments`, {
      cookie: seeded.cookieHeader,
      body: { body: "first comment" },
    });
    expect(created.status).toBe(201);
    const comment = created.body as CommentJson;
    expect(comment.body).toBe("first comment");

    const listed = await call("GET", `${base}/issues/1/comments`, {
      cookie: seeded.cookieHeader,
    });
    expect((listed.body as CommentJson[]).length).toBe(1);

    const edited = await call("PATCH", `${base}/issues/comments/${comment.id}`, {
      cookie: seeded.cookieHeader,
      body: { body: "edited comment" },
    });
    expect(edited.status).toBe(200);

    const relisted = await call("GET", `${base}/issues/1/comments`, {
      cookie: seeded.cookieHeader,
    });
    expect((relisted.body as CommentJson[])[0].body).toBe("edited comment");

    const issue = (await call("GET", `${base}/issues/1`, { cookie: seeded.cookieHeader }))
      .body as IssueJson;
    expect(issue.comments).toBe(1);

    const deleted = await call("DELETE", `${base}/issues/comments/${comment.id}`, {
      cookie: seeded.cookieHeader,
    });
    expect(deleted.status).toBe(200);
  });

  it("tracks reactions per-issue", async () => {
    const put = await call("PUT", `${base}/issues/1/reactions/%2B1`, {
      cookie: seeded.cookieHeader,
    });
    expect(put.status).toBe(200);
    const heart = await call("PUT", `${base}/issues/1/reactions/heart`, {
      cookie: seeded.cookieHeader,
    });
    expect(heart.status).toBe(200);

    const got = await call("GET", `${base}/issues/1/reactions`, {
      cookie: seeded.cookieHeader,
    });
    const reactions = got.body as Record<string, number>;
    expect(reactions["+1"]).toBe(1);
    expect(reactions.heart).toBe(1);

    const del = await call("DELETE", `${base}/issues/1/reactions/heart`, {
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(200);
    const after = (await call("GET", `${base}/issues/1/reactions`, { cookie: seeded.cookieHeader }))
      .body as Record<string, number>;
    expect(after.heart ?? 0).toBe(0);
  });

  it("supports labels and milestones, and links milestones to issues", async () => {
    const label = await call("POST", `${base}/labels`, {
      cookie: seeded.cookieHeader,
      body: { name: "enhancement", color: "a2eeef", description: "new feature" },
    });
    expect(label.status).toBe(201);
    const labels = await call("GET", `${base}/labels`, { cookie: seeded.cookieHeader });
    expect((labels.body as { name: string }[]).map((l) => l.name)).toContain("enhancement");

    const ms = await call("POST", `${base}/milestones`, {
      cookie: seeded.cookieHeader,
      body: { title: "v1", description: "first cut" },
    });
    expect(ms.status).toBe(201);
    const milestone = ms.body as { number: number; title: string; state: string };
    expect(milestone.number).toBe(1);

    const assigned = await call("PATCH", `${base}/issues/1`, {
      cookie: seeded.cookieHeader,
      body: { milestone: milestone.number },
    });
    expect(assigned.status).toBe(200);
    expect((assigned.body as { milestone: { title: string } | null }).milestone?.title).toBe("v1");
  });

  it("returns 404 for missing issues/comments", async () => {
    const missing = await call("GET", `${base}/issues/9999`, { cookie: seeded.cookieHeader });
    expect(missing.status).toBe(404);
    const missingComment = await call("DELETE", `${base}/issues/comments/nope`, {
      cookie: seeded.cookieHeader,
    });
    expect(missingComment.status).toBe(404);
  });
});

describe("issues: /api/v3 github-compat surface", () => {
  it("allows anonymous reads on a public repo", async () => {
    const { status, body } = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/issrepo/issues?state=all`
    );
    expect(status).toBe(200);
    const issues = body as IssueJson[];
    expect(issues.some((i) => i.number === 1)).toBe(true);
    expect(issues[0].html_url).toContain(`/issues/`);
  });

  it("rejects anonymous issue creation", async () => {
    const { status } = await call("POST", `/api/v3/repos/${seeded.namespaceSlug}/issrepo/issues`, {
      body: { title: "anon" },
    });
    expect(status).toBe(401);
  });

  it("returns 404 for unknown repos without leaking existence", async () => {
    const { status } = await call("GET", `/api/v3/repos/${seeded.namespaceSlug}/nope/issues`);
    expect(status).toBe(404);
  });
});
