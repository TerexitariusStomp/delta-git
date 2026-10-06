import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Releases coverage: DO-backed release metadata + R2 asset bytes, on the
// session /api/v1 facade plus the /api/v3 gh-release subset.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; rawBody?: ArrayBuffer; contentType?: string } = {}
): Promise<{ status: number; body: unknown; bytes?: ArrayBuffer }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
    body:
      opts.rawBody !== undefined
        ? opts.rawBody
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
  });
  const buf = await res.arrayBuffer();
  let body: unknown = buf;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    /* binary bodies stay buffers */
  }
  return { status: res.status, body, bytes: buf };
}

interface ReleaseJson {
  id: string;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  author: { login: string };
  assets: { id: string; name: string; size: number; download_count: number }[];
}

let seeded: SetupRepoForTestsResult;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("rel-ns"), "relrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/relrepo/+`;
});

describe("releases: /api/v1 session facade", () => {
  it("creates a release bound to a tag name", async () => {
    const { status, body } = await call("POST", `${base}/releases`, {
      cookie: seeded.cookieHeader,
      body: { tag_name: "v1.0.0", name: "First release", body: "notes **here**" },
    });
    expect(status).toBe(201);
    const rel = body as ReleaseJson;
    expect(rel.tag_name).toBe("v1.0.0");
    expect(rel.name).toBe("First release");
    expect(rel.draft).toBe(false);
  });

  it("rejects anonymous creates", async () => {
    const { status } = await call("POST", `${base}/releases`, {
      body: { tag_name: "v9" },
    });
    expect(status).toBe(401);
  });

  it("returns the same release for a duplicate tag", async () => {
    const { status, body } = await call("POST", `${base}/releases`, {
      cookie: seeded.cookieHeader,
      body: { tag_name: "v1.0.0", name: "duplicate" },
    });
    expect(status).toBe(200);
    expect((body as ReleaseJson).name).toBe("First release");
  });

  it("lists releases and resolves by tag", async () => {
    const list = await call("GET", `${base}/releases`, { cookie: seeded.cookieHeader });
    expect(list.status).toBe(200);
    expect((list.body as ReleaseJson[]).length).toBe(1);

    const byTag = await call("GET", `${base}/releases/tags/v1.0.0`, {
      cookie: seeded.cookieHeader,
    });
    expect(byTag.status).toBe(200);
    expect((byTag.body as ReleaseJson).tag_name).toBe("v1.0.0");

    const latest = await call("GET", `${base}/releases/latest`, {
      cookie: seeded.cookieHeader,
    });
    expect(latest.status).toBe(200);
    expect((latest.body as ReleaseJson).tag_name).toBe("v1.0.0");
  });

  it("uploads, lists, downloads, and deletes an asset", async () => {
    const release = (
      await call("GET", `${base}/releases/tags/v1.0.0`, {
        cookie: seeded.cookieHeader,
      })
    ).body as ReleaseJson;

    const payload = new TextEncoder().encode("binary-payload-123").buffer;
    const upload = await call("POST", `${base}/releases/${release.id}/assets?name=artifact.bin`, {
      cookie: seeded.cookieHeader,
      rawBody: payload,
      contentType: "application/octet-stream",
    });
    expect(upload.status).toBe(201);
    const asset = (upload.body as { assets?: never } & ReleaseJson["assets"][0]) ?? {};
    expect(asset.name).toBe("artifact.bin");
    expect(asset.size).toBe(payload.byteLength);

    const detail = (
      await call("GET", `${base}/releases/${release.id}`, {
        cookie: seeded.cookieHeader,
      })
    ).body as ReleaseJson;
    expect(detail.assets.length).toBe(1);

    const download = await call("GET", `${base}/releases/${release.id}/assets/${asset.id}`, {
      cookie: seeded.cookieHeader,
    });
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(download.bytes)).toBe("binary-payload-123");

    const after = (
      await call("GET", `${base}/releases/${release.id}`, {
        cookie: seeded.cookieHeader,
      })
    ).body as ReleaseJson;
    expect(after.assets[0].download_count).toBe(1);

    const del = await call("DELETE", `${base}/releases/${release.id}/assets/${asset.id}`, {
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(200);
    const cleaned = (
      await call("GET", `${base}/releases/${release.id}`, {
        cookie: seeded.cookieHeader,
      })
    ).body as ReleaseJson;
    expect(cleaned.assets.length).toBe(0);
  });

  it("hides drafts from anonymous readers", async () => {
    const draft = await call("POST", `${base}/releases`, {
      cookie: seeded.cookieHeader,
      body: { tag_name: "v2.0.0-rc1", draft: true, prerelease: true },
    });
    expect(draft.status).toBe(201);
    const draftRel = draft.body as ReleaseJson;

    // Members see drafts; anonymous does not.
    const memberList = await call("GET", `${base}/releases`, { cookie: seeded.cookieHeader });
    expect((memberList.body as ReleaseJson[]).some((r) => r.id === draftRel.id)).toBe(true);

    const anonList = await call("GET", `${base}/releases`);
    expect((anonList.body as ReleaseJson[]).some((r) => r.id === draftRel.id)).toBe(false);

    const anonGet = await call("GET", `${base}/releases/${draftRel.id}`);
    expect(anonGet.status).toBe(404);
  });

  it("deletes a release", async () => {
    const del = await call("DELETE", `${base}/releases/` + "missing", {
      cookie: seeded.cookieHeader,
    });
    expect(del.status).toBe(404);
  });
});

describe("releases: /api/v3 gh surface", () => {
  it("allows anonymous reads on a public repo", async () => {
    const { status, body } = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/relrepo/releases`
    );
    expect(status).toBe(200);
    const list = body as ReleaseJson[];
    expect(list.some((r) => r.tag_name === "v1.0.0")).toBe(true);

    const latest = await call(
      "GET",
      `/api/v3/repos/${seeded.namespaceSlug}/relrepo/releases/latest`
    );
    expect(latest.status).toBe(200);
    expect((latest.body as ReleaseJson).tag_name).toBe("v1.0.0");
  });

  it("rejects anonymous creates", async () => {
    const { status } = await call(
      "POST",
      `/api/v3/repos/${seeded.namespaceSlug}/relrepo/releases`,
      { body: { tag_name: "v3" } }
    );
    expect(status).toBe(401);
  });
});
