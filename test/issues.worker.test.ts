import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { concatChunks, flushPkt, pktLine } from "@/worker/git/core";
import { encodeGitObject } from "@/worker/git/core/objects";
import { buildPack } from "./util/git-pack";
import { buildTreePayload } from "./util/packed-repo";
import { ensureD1Migrations } from "./util/d1Setup";
import { toRequestBody } from "./util/test-helpers";
import { lookupPushAuth, setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

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

describe("issues: qualifier search (q=)", () => {
  const search = async (q: string) => {
    const { status, body } = await call("GET", `${base}/issues?q=${encodeURIComponent(q)}`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    return body as IssueJson[];
  };

  it("filters by is:, label:, and free text", async () => {
    expect((await search("is:open")).some((i) => i.number === 1)).toBe(true);
    expect((await search("is:closed")).some((i) => i.number === 1)).toBe(false);
    expect((await search("label:bug")).some((i) => i.number === 1)).toBe(true);
    expect((await search("label:no-such-label")).length).toBe(0);
    // Free text matches title and body.
    expect((await search("world")).some((i) => i.number === 1)).toBe(true);
    expect((await search("unmatched-gibberish")).length).toBe(0);
  });

  it("filters by author: and milestone:/no:milestone", async () => {
    const all = await call("GET", `${base}/issues`, { cookie: seeded.cookieHeader });
    const login = (all.body as IssueJson[]).find((i) => i.number === 1)!.user.login;
    expect((await search(`author:${login}`)).some((i) => i.number === 1)).toBe(true);
    expect((await search("author:nobody")).length).toBe(0);
    expect((await search("milestone:v1")).some((i) => i.number === 1)).toBe(true);
    expect((await search("no:milestone")).some((i) => i.number === 1)).toBe(false);
  });

  it("exposes the REST filter params and /search/issues on v3", async () => {
    const byLabel = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/issrepo/issues?labels=bug&state=all`
    );
    expect(byLabel.status).toBe(200);
    expect((byLabel.body as IssueJson[]).some((i) => i.number === 1)).toBe(true);

    const byWrongLabel = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/issrepo/issues?labels=nope&state=all`
    );
    expect((byWrongLabel.body as IssueJson[]).length).toBe(0);

    const found = await call(
      "GET",
      `/api/v3/search/issues?q=${encodeURIComponent(`repo:${seeded.namespaceSlug}/issrepo is:open`)}`
    );
    expect(found.status).toBe(200);
    const result = found.body as { total_count: number; items: IssueJson[] };
    expect(result.items.some((i) => i.number === 1)).toBe(true);

    const noRepo = await call("GET", `/api/v3/search/issues?q=${encodeURIComponent("is:open")}`);
    expect(noRepo.status).toBe(422);
  });
});

describe("issues: .github issue templates", () => {
  it("lists templates from .github/ISSUE_TEMPLATE with front matter", async () => {
    const templatesRepo = uniq("iss-tpl-ns");
    const seededTpl = await setupRepoForTests(env, templatesRepo, "issrepo");
    const tplBase = `/api/v1/repos/${seededTpl.namespaceSlug}/issrepo/+`;

    // Push a commit carrying .github/ISSUE_TEMPLATE/bug.md — nested trees,
    // create-push onto a fresh main.
    const templateSource = [
      "---",
      "name: Bug report",
      "about: Something broke",
      'title: "[Bug]: "',
      'labels: ["bug", "triage"]',
      "---",
      "",
      "Describe what happened.",
      "",
    ].join("\n");
    const tplBlobPayload = new TextEncoder().encode(templateSource);
    const readmeBlobPayload = new TextEncoder().encode("# repo\n");
    const tplBlob = await encodeGitObject("blob", tplBlobPayload);
    const readmeBlob = await encodeGitObject("blob", readmeBlobPayload);
    const templateDirTreePayload = buildTreePayload([
      { mode: "100644", name: "bug.md", oid: tplBlob.oid },
    ]);
    const templateDirTree = await encodeGitObject("tree", templateDirTreePayload);
    const dotGithubTreePayload = buildTreePayload([
      { mode: "40000", name: "ISSUE_TEMPLATE", oid: templateDirTree.oid },
    ]);
    const dotGithubTree = await encodeGitObject("tree", dotGithubTreePayload);
    const rootTreePayload = buildTreePayload([
      { mode: "40000", name: ".github", oid: dotGithubTree.oid },
      { mode: "100644", name: "README.md", oid: readmeBlob.oid },
    ]);
    const rootTree = await encodeGitObject("tree", rootTreePayload);
    const author = "You <you@example.com> 0 +0000";
    const commitPayload = new TextEncoder().encode(
      `tree ${rootTree.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\n` +
        `add issue templates\n`
    );
    const commit = await encodeGitObject("commit", commitPayload);
    const pack = await buildPack([
      { type: "blob", payload: tplBlobPayload },
      { type: "blob", payload: readmeBlobPayload },
      { type: "tree", payload: templateDirTreePayload },
      { type: "tree", payload: dotGithubTreePayload },
      { type: "tree", payload: rootTreePayload },
      { type: "commit", payload: commitPayload },
    ]);

    const push = await workerExports.default.fetch(
      `https://example.com/${seededTpl.namespaceSlug}/issrepo/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: lookupPushAuth(seededTpl.namespaceSlug, "issrepo")!,
        },
        body: toRequestBody(
          concatChunks([
            pktLine(
              `${"0".repeat(40)} ${commit.oid} refs/heads/main\0 report-status ofs-delta agent=test\n`
            ),
            flushPkt(),
            pack,
          ])
        ),
      } as any
    );
    expect(push.status).toBe(200);

    const { status, body } = await call("GET", `${tplBase}/issue-templates`, {
      cookie: seededTpl.cookieHeader,
    });
    expect(status).toBe(200);
    const templates = body as {
      file: string;
      name: string;
      about: string;
      title: string;
      labels: string[];
      body: string;
    }[];
    expect(templates.length).toBe(1);
    expect(templates[0]).toMatchObject({
      file: "bug.md",
      name: "Bug report",
      about: "Something broke",
      title: "[Bug]: ",
      labels: ["bug", "triage"],
    });
    expect(templates[0].body).toContain("Describe what happened.");

    // CODEOWNERS endpoint on the same repo — second commit adds the file.
    const coSource = ["* @all-hands", "*.ts @ts-guild", ".github/ @meta-owners", ""].join(
      "\n"
    );
    const coBlobPayload = new TextEncoder().encode(coSource);
    const coBlob = await encodeGitObject("blob", coBlobPayload);
    const coDirPayload = buildTreePayload([
      { mode: "40000", name: "ISSUE_TEMPLATE", oid: templateDirTree.oid },
      { mode: "100644", name: "CODEOWNERS", oid: coBlob.oid },
    ]);
    const coDir = await encodeGitObject("tree", coDirPayload);
    const coRootPayload = buildTreePayload([
      { mode: "40000", name: ".github", oid: coDir.oid },
      { mode: "100644", name: "README.md", oid: readmeBlob.oid },
    ]);
    const coRoot = await encodeGitObject("tree", coRootPayload);
    const coCommitPayload = new TextEncoder().encode(
      `tree ${coRoot.oid}\n` +
        `parent ${commit.oid}\n` +
        `author ${author}\n` +
        `committer ${author}\n\n` +
        `add codeowners\n`
    );
    const coCommit = await encodeGitObject("commit", coCommitPayload);
    const coPack = await buildPack([
      { type: "blob", payload: coBlobPayload },
      { type: "tree", payload: coDirPayload },
      { type: "tree", payload: coRootPayload },
      { type: "commit", payload: coCommitPayload },
    ]);
    const coPush = await workerExports.default.fetch(
      `https://example.com/${seededTpl.namespaceSlug}/issrepo/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-receive-pack-request",
          Authorization: lookupPushAuth(seededTpl.namespaceSlug, "issrepo")!,
        },
        body: toRequestBody(
          concatChunks([
            pktLine(
              `${commit.oid} ${coCommit.oid} refs/heads/main\0 report-status ofs-delta agent=test\n`
            ),
            flushPkt(),
            coPack,
          ])
        ),
      } as any
    );
    expect(coPush.status).toBe(200);

    const owners = await call(
      "GET",
      `${tplBase}/codeowners/owners?paths=${encodeURIComponent("src/app.ts,README.md,.github/CODEOWNERS")}`,
      { cookie: seededTpl.cookieHeader }
    );
    expect(owners.status).toBe(200);
    const resolved = (owners.body as { owners: Record<string, string[]> }).owners;
    expect(resolved["src/app.ts"]).toEqual(["@ts-guild"]);
    expect(resolved["README.md"]).toEqual(["@all-hands"]);
    expect(resolved[".github/CODEOWNERS"]).toEqual(["@meta-owners"]);
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
