import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";
import { seedPackFirstRepo } from "./util/pack-first";

// Repo knowledge-base coverage: KB document, summary/graph/diagrams/
// glossary/tours projections, symbol xref, and the llms.txt manifests —
// all lazy-built on first read against the seeded repo's real tree.

let seeded: SetupRepoForTestsResult;
let ref: string;

async function get(
  path: string,
  cookie?: string
): Promise<{ status: number; body: unknown; text: string }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, { headers });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON stays a string */
  }
  return { status: res.status, body: parsed, text };
}

async function post(path: string, body: unknown, cookie?: string): Promise<{ status: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  await res.text();
  return { status: res.status };
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  const ns = `kb-ns-${Math.random().toString(36).slice(2, 8)}`;
  seeded = await setupRepoForTests(env, ns, "kbrepo", { visibility: "private" });
  ref = `${seeded.namespaceSlug}/${seeded.repoSlug}`;
  await seedPackFirstRepo(`${seeded.namespaceSlug}/${seeded.repoSlug}`);
  // Seed real code files so extraction has symbols + dep edges to find.
  const cm = await post(
    `/api/v1/repos/${ref}/commits`,
    {
      branch: "main",
      message: "add sources",
      actions: [
        {
          action: "CREATE",
          path: "src/index.ts",
          encoding: "text",
          payload:
            'import { greet } from "./lib/greet";\n\nexport function main(): void {\n  console.log(greet("world"));\n}\n\nmain();\n',
        },
        {
          action: "CREATE",
          path: "src/lib/greet.ts",
          encoding: "text",
          payload:
            'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n\nexport const VERSION = "1.0.0";\n',
        },
        {
          action: "CREATE",
          path: "src/util.ts",
          encoding: "text",
          payload:
            "export interface Options {\n  verbose: boolean;\n}\n\nexport class Helper {\n  run(): boolean {\n    return true;\n  }\n}\n",
        },
      ],
    },
    seeded.cookieHeader
  );
  if (cm.status !== 200) throw new Error(`seed commit failed: ${cm.status}`);
});

describe("GET /api/v1/repos/{ref}/+/knowledge", () => {
  it("builds a KB document with extracted symbols and dep edges", async () => {
    const { status, body } = await get(`/api/v1/repos/${ref}/+/knowledge`, seeded.cookieHeader);
    expect(status).toBe(200);
    const kb = body as {
      headOid: string;
      files: { path: string; symbols: { name: string }[] }[];
      edges: { from: string; to: string }[];
      entrypoints: string[];
    };
    expect(kb.headOid).toMatch(/^[0-9a-f]{40}$/);
    const paths = kb.files.map((f) => f.path);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/lib/greet.ts");
    const greetFile = kb.files.find((f) => f.path === "src/lib/greet.ts");
    expect(greetFile?.symbols.some((s) => s.name === "greet")).toBe(true);
    // The index.ts → greet.ts import yields a file-level dep edge.
    expect(kb.edges.some((e) => e.from === "src/index.ts" && e.to === "src/lib/greet.ts")).toBe(
      true
    );
    expect(kb.entrypoints.length).toBeGreaterThan(0);
  });

  it("serves summary, graph, diagrams, glossary, and tours projections", async () => {
    for (const section of ["summary", "graph", "diagrams", "glossary", "tours"]) {
      const { status } = await get(
        `/api/v1/repos/${ref}/+/knowledge/${section}`,
        seeded.cookieHeader
      );
      expect(status).toBe(200);
    }
    const { body: graph } = await get(
      `/api/v1/repos/${ref}/+/knowledge/graph`,
      seeded.cookieHeader
    );
    const g = graph as { nodes: { path: string; module: string }[]; edges: unknown[] };
    expect(g.nodes.find((n) => n.path === "src/lib/greet.ts")?.module).toBe("src");
    const { body: diagrams } = await get(
      `/api/v1/repos/${ref}/+/knowledge/diagrams`,
      seeded.cookieHeader
    );
    const d = diagrams as { diagrams: { mermaid: string }[] };
    expect(d.diagrams.length).toBeGreaterThan(0);
    expect(d.diagrams[0].mermaid).toContain("graph");
  });

  it("answers symbol cross-reference lookups", async () => {
    const { status, body } = await get(`/api/v1/repos/${ref}/+/symbols/greet`, seeded.cookieHeader);
    expect(status).toBe(200);
    const xref = body as { defs: { path: string }[]; used_in: string[] };
    expect(xref.defs.some((d) => d.path === "src/lib/greet.ts")).toBe(true);
    expect(xref.used_in).toContain("src/index.ts");
  });

  it("serves llms.txt and llms-full.txt manifests", async () => {
    const { status, text } = await get(`/api/v1/repos/${ref}/+/llms.txt`, seeded.cookieHeader);
    expect(status).toBe(200);
    expect(text).toContain("# ");
    expect(text).toContain("src");
    const full = await get(`/api/v1/repos/${ref}/+/llms-full.txt`, seeded.cookieHeader);
    expect(full.status).toBe(200);
    expect(full.text).toContain("greet");
  });

  it("serves the repo-root llms.txt convention paths", async () => {
    const { status, text } = await get(
      `/${seeded.namespaceSlug}/${seeded.repoSlug}/llms.txt`,
      seeded.cookieHeader
    );
    expect(status).toBe(200);
    expect(text).toContain("# ");
    expect(text).toContain("## Structure");
    const full = await get(
      `/${seeded.namespaceSlug}/${seeded.repoSlug}/llms-full.txt`,
      seeded.cookieHeader
    );
    expect(full.status).toBe(200);
    expect(full.text).toContain("greet");
  });

  it("refuses anonymous access to private-repo KB paths", async () => {
    // The seeded repo is private — anonymous gets the privacy-preserving 404
    // before any KB work happens.
    const { status } = await get(`/api/v1/repos/${ref}/+/knowledge`);
    expect(status).toBe(404);
    const root = await get(`/${seeded.namespaceSlug}/${seeded.repoSlug}/llms.txt`);
    expect(root.status).toBe(404);
  });
});
