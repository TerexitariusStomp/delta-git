import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Projects coverage: DO-backed boards → columns → cards over issues, on the
// session /api/v1 facade.

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
  const buf = await res.arrayBuffer();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

interface ProjectCardJson {
  id: string;
  kind: "issue" | "note";
  issue_number: number | null;
  note: string | null;
}

interface ProjectColumnJson {
  id: string;
  name: string;
  position: number;
  cards: ProjectCardJson[];
}

interface ProjectJson {
  number: number;
  name: string;
  state: string;
  columns?: ProjectColumnJson[];
}

let seeded: SetupRepoForTestsResult;
let base: string;
let issueNumber = 0;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("prj-ns"), "prjrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/prjrepo/+`;
  const issue = await call("POST", `${base}/issues`, {
    cookie: seeded.cookieHeader,
    body: { title: "Card target issue" },
  });
  expect(issue.status).toBe(201);
  issueNumber = (issue.body as { number: number }).number;
});

describe("projects: /api/v1 session facade", () => {
  it("creates a board with the three starter columns", async () => {
    const { status, body } = await call("POST", `${base}/projects`, {
      cookie: seeded.cookieHeader,
      body: { name: "Sprint 1", body: "board notes" },
    });
    expect(status).toBe(201);
    const p = body as ProjectJson;
    expect(p.name).toBe("Sprint 1");
    expect(p.columns!.map((c) => c.name)).toEqual(["To do", "In progress", "Done"]);
  });

  it("rejects anonymous creates", async () => {
    const { status } = await call("POST", `${base}/projects`, { body: { name: "nope" } });
    expect(status).toBe(401);
  });

  it("lists boards and fetches one by number", async () => {
    const list = await call("GET", `${base}/projects`, { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    const rows = list.body as ProjectJson[];
    expect(rows.length).toBe(1);
    expect(rows[0].number).toBe(1);

    const detail = await call("GET", `${base}/projects/1`, { cookie: seeded.cookieHeader });
    expect(detail.status).toBe(200);
    expect((detail.body as ProjectJson).name).toBe("Sprint 1");
  });

  it("adds a custom column", async () => {
    const { status, body } = await call("POST", `${base}/projects/1/columns`, {
      cookie: seeded.cookieHeader,
      body: { name: "Review" },
    });
    expect(status).toBe(201);
    expect((body as { name: string }).name).toBe("Review");
  });

  it("adds an issue card and a note card, then moves the issue card", async () => {
    const detail = (await call("GET", `${base}/projects/1`, { cookie: seeded.cookieHeader }))
      .body as ProjectJson;
    const todo = detail.columns!.find((c) => c.name === "To do")!;
    const done = detail.columns!.find((c) => c.name === "Done")!;

    const issueCard = await call("POST", `${base}/projects/1/cards`, {
      cookie: seeded.cookieHeader,
      body: { column_id: todo.id, issue: issueNumber },
    });
    expect(issueCard.status).toBe(201);
    expect((issueCard.body as ProjectCardJson).issue_number).toBe(issueNumber);

    const noteCard = await call("POST", `${base}/projects/1/cards`, {
      cookie: seeded.cookieHeader,
      body: { column_id: todo.id, note: "follow up with design" },
    });
    expect(noteCard.status).toBe(201);
    expect((noteCard.body as ProjectCardJson).note).toBe("follow up with design");

    const moved = await call(
      "PATCH",
      `${base}/projects/1/cards/${(issueCard.body as ProjectCardJson).id}`,
      { cookie: seeded.cookieHeader, body: { column_id: done.id } }
    );
    expect(moved.status).toBe(200);

    const after = (await call("GET", `${base}/projects/1`, { cookie: seeded.cookieHeader }))
      .body as ProjectJson;
    const doneCol = after.columns!.find((c) => c.name === "Done")!;
    expect(doneCol.cards.length).toBe(1);
    expect(doneCol.cards[0].issue_number).toBe(issueNumber);
  });

  it("rejects an issue card for a nonexistent issue", async () => {
    const detail = (await call("GET", `${base}/projects/1`, { cookie: seeded.cookieHeader }))
      .body as ProjectJson;
    const todo = detail.columns!.find((c) => c.name === "To do")!;
    const { status } = await call("POST", `${base}/projects/1/cards`, {
      cookie: seeded.cookieHeader,
      body: { column_id: todo.id, issue: 9999 },
    });
    expect(status).toBe(422);
  });

  it("rejects moving a card into another project's column", async () => {
    const other = (
      await call("POST", `${base}/projects`, {
        cookie: seeded.cookieHeader,
        body: { name: "Other board" },
      })
    ).body as ProjectJson;
    const board1 = (await call("GET", `${base}/projects/1`, { cookie: seeded.cookieHeader }))
      .body as ProjectJson;
    const todo = board1.columns!.find((c) => c.name === "To do")!;
    const card = todo.cards.find((c) => c.kind === "note")!;
    const otherCol = other.columns![0];
    const { status } = await call("PATCH", `${base}/projects/1/cards/${card.id}`, {
      cookie: seeded.cookieHeader,
      body: { column_id: otherCol.id },
    });
    expect(status).toBe(422);
  });

  it("closes a board via patch", async () => {
    const { status, body } = await call("PATCH", `${base}/projects/1`, {
      cookie: seeded.cookieHeader,
      body: { state: "closed" },
    });
    expect(status).toBe(200);
    expect((body as ProjectJson).state).toBe("closed");

    const open = await call("GET", `${base}/projects?state=open`, {
      cookie: seeded.cookieHeader,
    });
    const names = (open.body as ProjectJson[]).map((p) => p.name);
    expect(names).not.toContain("Sprint 1");
    expect(names).toContain("Other board");
  });
});
