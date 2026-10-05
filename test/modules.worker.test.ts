import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { createDb } from "@/worker/db/d1/client";
import { insertNotification } from "@/worker/db/d1/dal/modules";
import { newPrefixedId } from "@/worker/common";
import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";

let seeded: SetupRepoForTestsResult;
let owner: string;
let repo: string;

async function req(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; basic?: string } = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.basic) headers.Authorization = opts.basic;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, res, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = `mods-${Math.random().toString(36).slice(2, 8)}`;
  repo = uniqueRepoId("modrepo");
  seeded = await setupRepoForTests(env, owner, repo);
});

describe("notifications", () => {
  it("lists, marks read, and read-alls the viewer's inbox", async () => {
    const db = createDb(env.DB);
    await insertNotification(db, {
      id: newPrefixedId("ntf"),
      userId: seeded.userId,
      kind: "push",
      title: "test push",
      body: "unit",
      link: null,
      createdAt: Date.now(),
      readAt: null,
    });

    const list = await req("/api/v1/notifications", { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    const inbox = list.body as { notifications: { id: string; read: boolean }[]; unread: number };
    expect(inbox.unread).toBeGreaterThan(0);
    const n = inbox.notifications.find((x) => x.title === undefined) ?? inbox.notifications[0]!;

    const mark = await req(`/api/v1/notifications/${n.id}`, {
      method: "PATCH",
      body: { read: true },
      cookie: seeded.cookieHeader,
    });
    expect(mark.status).toBe(200);

    const all = await req("/api/v1/notifications/read-all", {
      method: "PATCH",
      body: {},
      cookie: seeded.cookieHeader,
    });
    expect(all.status).toBe(200);
    const after = await req("/api/v1/notifications", { cookie: seeded.cookieHeader });
    expect((after.body as { unread: number }).unread).toBe(0);
  });
});

describe("environments", () => {
  it("CRUDs space environments with membership gating", async () => {
    const create = await req(`/api/v1/spaces/${owner}/environments`, {
      method: "POST",
      body: { identifier: "production", type: "production", description: "prod env" },
      cookie: seeded.cookieHeader,
    });
    expect(create.status).toBe(201);

    const list = await req(`/api/v1/spaces/${owner}/environments`, {
      cookie: seeded.cookieHeader,
    });
    expect(list.status).toBe(200);
    expect((list.body as { identifier: string }[]).some((e) => e.identifier === "production")).toBe(
      true
    );

    const patch = await req(`/api/v1/spaces/${owner}/environments/production`, {
      method: "PATCH",
      body: { description: "renamed" },
      cookie: seeded.cookieHeader,
    });
    expect(patch.status).toBe(200);

    const del = await req(`/api/v1/spaces/${owner}/environments/production`, {
      method: "DELETE",
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(204);

    // Anonymous hits 401; a non-member path 404s the space.
    const anon = await req(`/api/v1/spaces/${owner}/environments`);
    expect(anon.status).toBe(401);
  });
});

describe("artifacts", () => {
  it("publishes, lists, and downloads artifacts via the push PAT", async () => {
    const content = new TextEncoder().encode("artifact-bytes-v1");
    const put = await workerExports.default.fetch(
      `https://example.com/api/${owner}/${repo}/dg/artifacts/cli/1.0.0/dgit-linux-x64`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: seeded.pushAuthHeader,
        },
        body: content,
      }
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { sha256: string; size: number };
    expect(putBody.size).toBe(content.byteLength);
    expect(putBody.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await req(`/api/${owner}/${repo}/dg/artifacts`);
    expect(list.status).toBe(200);
    expect(
      (list.body as { artifacts: { name: string; version: string }[] }).artifacts.some(
        (a) => a.name === "cli" && a.version === "1.0.0"
      )
    ).toBe(true);

    const dl = await workerExports.default.fetch(
      `https://example.com/api/${owner}/${repo}/dg/artifacts/cli/1.0.0/dgit-linux-x64`
    );
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(content);
    expect(dl.headers.get("x-artifact-sha256")).toBe(putBody.sha256);

    // Space listing rolls the artifact up for the UI.
    const space = await req(`/api/v1/spaces/${owner}/artifacts`, {
      cookie: seeded.cookieHeader,
    });
    expect(space.status).toBe(200);
    expect(
      (space.body as { name: string; repo: string }[]).some(
        (a) => a.name === "cli" && a.repo === repo
      )
    ).toBe(true);
  });
});
