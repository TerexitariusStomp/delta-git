import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Discussions coverage: DO-backed threads exposed on /api/v1 (session SPA)
// and /api/v3 (PAT/anonymous agent clients). The seed repo is public so
// anonymous v3 reads are allowed.

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

interface DiscussionJson {
  number: number;
  title: string;
  body: string | null;
  category: string;
  user: { login: string };
  comments: number;
  answer_comment_id: string | null;
  html_url?: string;
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
  seeded = await setupRepoForTests(env, uniq("dsc-ns"), "dscrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/dscrepo/+`;
});

describe("discussions: /api/v1 session facade", () => {
  it("creates a discussion with a category", async () => {
    const { status, body } = await call("POST", `${base}/discussions`, {
      cookie: seeded.cookieHeader,
      body: { title: "Welcome thread", body: "say hi", category: "general" },
    });
    expect(status).toBe(201);
    const d = body as DiscussionJson;
    expect(d.number).toBe(1);
    expect(d.category).toBe("general");
    expect(d.title).toBe("Welcome thread");
    expect(d.answer_comment_id).toBeNull();
  });

  it("creates a Q&A discussion and rejects unknown categories", async () => {
    const qa = await call("POST", `${base}/discussions`, {
      cookie: seeded.cookieHeader,
      body: { title: "How do packs work?", category: "q-a" },
    });
    expect(qa.status).toBe(201);
    expect((qa.body as DiscussionJson).category).toBe("q-a");

    const bad = await call("POST", `${base}/discussions`, {
      cookie: seeded.cookieHeader,
      body: { title: "nope", category: "not-a-category" },
    });
    expect(bad.status).toBe(422);
  });

  it("rejects anonymous writes", async () => {
    const { status } = await call("POST", `${base}/discussions`, {
      body: { title: "nope" },
    });
    expect(status).toBe(401);
  });

  it("lists discussions and filters by category", async () => {
    const all = await call("GET", `${base}/discussions`, { cookie: seeded.cookieHeader });
    expect(all.status).toBe(200);
    expect((all.body as DiscussionJson[]).length).toBe(2);

    const qa = await call("GET", `${base}/discussions?category=q-a`, {
      cookie: seeded.cookieHeader,
    });
    const list = qa.body as DiscussionJson[];
    expect(list.length).toBe(1);
    expect(list[0].category).toBe("q-a");
  });

  it("supports comments and marks an accepted answer", async () => {
    const first = await call("POST", `${base}/discussions/2/comments`, {
      cookie: seeded.cookieHeader,
      body: { body: "wrong guess" },
    });
    expect(first.status).toBe(201);
    const second = await call("POST", `${base}/discussions/2/comments`, {
      cookie: seeded.cookieHeader,
      body: { body: "they are content-addressed deltas" },
    });
    const answer = second.body as CommentJson;

    const marked = await call("PUT", `${base}/discussions/2/answer`, {
      cookie: seeded.cookieHeader,
      body: { comment_id: answer.id },
    });
    expect(marked.status).toBe(200);
    expect((marked.body as DiscussionJson).answer_comment_id).toBe(answer.id);

    // A comment from another discussion can't be marked.
    const crossPost = await call("POST", `${base}/discussions/1/comments`, {
      cookie: seeded.cookieHeader,
      body: { body: "hi from thread 1" },
    });
    const foreign = crossPost.body as CommentJson;
    const foreignMark = await call("PUT", `${base}/discussions/2/answer`, {
      cookie: seeded.cookieHeader,
      body: { comment_id: foreign.id },
    });
    expect(foreignMark.status).toBe(422);

    // Deleting the accepted answer clears the marker.
    const del = await call("DELETE", `${base}/discussions/comments/${answer.id}`, {
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(200);
    const after = (await call("GET", `${base}/discussions/2`, { cookie: seeded.cookieHeader }))
      .body as DiscussionJson;
    expect(after.answer_comment_id).toBeNull();
  });

  it("tracks reactions per-discussion", async () => {
    const put = await call("PUT", `${base}/discussions/1/reactions/heart`, {
      cookie: seeded.cookieHeader,
    });
    expect(put.status).toBe(200);

    const got = await call("GET", `${base}/discussions/1/reactions`, {
      cookie: seeded.cookieHeader,
    });
    expect((got.body as Record<string, number>).heart).toBe(1);

    const del = await call("DELETE", `${base}/discussions/1/reactions/heart`, {
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(200);
    const after = (
      await call("GET", `${base}/discussions/1/reactions`, { cookie: seeded.cookieHeader })
    ).body as Record<string, number>;
    expect(after.heart ?? 0).toBe(0);
  });

  it("updates a discussion via PATCH", async () => {
    const patched = await call("PATCH", `${base}/discussions/1`, {
      cookie: seeded.cookieHeader,
      body: { title: "Welcome thread v2", category: "announcements" },
    });
    expect(patched.status).toBe(200);
    const d = patched.body as DiscussionJson;
    expect(d.title).toBe("Welcome thread v2");
    expect(d.category).toBe("announcements");
  });

  it("returns 404 for missing discussions/comments", async () => {
    const missing = await call("GET", `${base}/discussions/9999`, {
      cookie: seeded.cookieHeader,
    });
    expect(missing.status).toBe(404);
    const missingComment = await call("DELETE", `${base}/discussions/comments/nope`, {
      cookie: seeded.cookieHeader,
    });
    expect(missingComment.status).toBe(404);
  });
});

describe("discussions: /api/v3 agent surface", () => {
  it("allows anonymous reads on a public repo", async () => {
    const { status, body } = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/dscrepo/discussions`
    );
    expect(status).toBe(200);
    const list = body as DiscussionJson[];
    expect(list.some((d) => d.number === 1)).toBe(true);
    expect(list[0].html_url).toContain("/discussions/");
  });

  it("rejects anonymous creates", async () => {
    const { status } = await call(
      "POST",
      `/api/v3/repos/${seeded.namespaceSlug}/dscrepo/discussions`,
      { body: { title: "anon" } }
    );
    expect(status).toBe(401);
  });

  it("returns 404 for unknown repos without leaking existence", async () => {
    const { status } = await call("GET", `/api/v3/repos/${seeded.namespaceSlug}/nope/discussions`);
    expect(status).toBe(404);
  });
});
