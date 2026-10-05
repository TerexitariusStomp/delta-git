import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";

// Code-search coverage: the gitness `POST /api/v1/search` contract (line
// fragments, case/lang/regex flags, space fan-out), the `+/semantic/search`
// fallback path (miniflare has no real AI/Vectorize → keyword lane), and the
// `/+/ask` RAG endpoint's availability handling.

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function post(
  path: string,
  body: unknown,
  cookie?: string
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON stays a string */
  }
  return { status: res.status, body: parsed };
}

let seeded: SetupRepoForTestsResult;
let ref: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  const ns = uniq("search-ns");
  seeded = await setupRepoForTests(env, ns, "searchrepo");
  ref = `${seeded.namespaceSlug}/${seeded.repoSlug}`;
  await seedPackFirstRepo(`${seeded.namespaceSlug}/${seeded.repoSlug}`);
});

describe("POST /api/v1/search", () => {
  it("returns gitness-shaped file_matches with line fragments", async () => {
    const { status, body } = await post(
      "/api/v1/search",
      {
        repo_paths: [ref],
        query: "( version ) case:no",
        max_result_count: 50,
      },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    const data = body as {
      file_matches: {
        file_name: string;
        repo_path: string;
        matches: { line_num: number; fragments: { match: string }[] }[];
      }[];
      stats: { total_files: number; total_matches: number };
    };
    expect(data.file_matches.length).toBeGreaterThan(0);
    const readme = data.file_matches.find((f) => f.file_name === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.repo_path).toBe(ref);
    expect(readme!.matches[0].line_num).toBe(1);
    expect(readme!.matches[0].fragments[0].match.toLowerCase()).toBe("version");
    expect(data.stats.total_matches).toBeGreaterThan(0);
  });

  it("honors case:yes", async () => {
    const { status, body } = await post(
      "/api/v1/search",
      {
        repo_paths: [ref],
        query: "( Version ) case:yes",
        max_result_count: 50,
      },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    expect((body as { file_matches: unknown[] }).file_matches).toEqual([]);
  });

  it("honors enable_regex", async () => {
    const { status, body } = await post(
      "/api/v1/search",
      {
        repo_paths: [ref],
        query: "( vers[a-z]+n )",
        enable_regex: true,
        max_result_count: 50,
      },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    expect(
      (body as { file_matches: { file_name: string }[] }).file_matches.some(
        (f) => f.file_name === "README.md"
      )
    ).toBe(true);
  });

  it("fans out across space_paths", async () => {
    const { status, body } = await post(
      "/api/v1/search",
      {
        space_paths: [seeded.namespaceSlug],
        query: "( version ) case:no",
        max_result_count: 50,
      },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    expect(
      (body as { file_matches: { repo_path: string }[] }).file_matches.some(
        (f) => f.repo_path === ref
      )
    ).toBe(true);
  });

  it("returns empty results for a nonsense term", async () => {
    const { status, body } = await post(
      "/api/v1/search",
      {
        repo_paths: [ref],
        query: "( zzznopezzznothing ) case:no",
      },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    expect((body as { file_matches: unknown[] }).file_matches).toEqual([]);
  });
});

describe("POST /api/v1/repos/{ref}/+/semantic/search", () => {
  it("returns file windows (keyword fallback when embeddings unavailable)", async () => {
    const { status, body } = await post(
      `/api/v1/repos/${ref}/+/semantic/search`,
      { query: "version" },
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    const items = body as {
      file_path: string;
      file_name: string;
      start_line: number;
      lines: string[];
      commit: string;
    }[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].file_path).toBe("README.md");
    expect(items[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("POST /api/v1/repos/{ref}/+/ask", () => {
  it("answers or degrades cleanly when the AI backend is unavailable", async () => {
    const { status, body } = await post(
      `/api/v1/repos/${ref}/+/ask`,
      { query: "what does this repo contain" },
      seeded.cookieHeader
    );
    // miniflare's AI binding is a stub — production returns 200 with an
    // answer + citations; the test env asserts the graceful 503 contract.
    expect([200, 503]).toContain(status);
    if (status === 200) {
      const data = body as { answer: string; citations: { path: string }[] };
      expect(typeof data.answer).toBe("string");
      expect(Array.isArray(data.citations)).toBe(true);
    }
  });

  it("requires a query", async () => {
    const { status } = await post(`/api/v1/repos/${ref}/+/ask`, {}, seeded.cookieHeader);
    expect(status).toBe(400);
  });
});
