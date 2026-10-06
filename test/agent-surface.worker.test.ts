import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Agent-readable surface: node descriptor, llms.txt/skill.md, and
// `Accept: text/markdown` repo cards.

async function get(
  path: string,
  accept?: string
): Promise<{ status: number; body: string; contentType: string }> {
  const headers: Record<string, string> = {};
  if (accept) headers.Accept = accept;
  const res = await workerExports.default.fetch(`https://example.com${path}`, { headers });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type") ?? "",
  };
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

let seeded: SetupRepoForTestsResult;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("ags-ns"), "agsrepo");
});

describe("agent surface", () => {
  it("serves the node descriptor at /.well-known/delta-node", async () => {
    const { status, body, contentType } = await get("/.well-known/delta-node");
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
    const doc = JSON.parse(body);
    expect(doc.name).toBe("delta-git");
    expect(doc.capabilities.merge_intents).toBeTruthy();
    expect(doc.agents.skill_md).toContain("/skill.md");
  });

  it("serves llms.txt and skill.md", async () => {
    const llms = await get("/llms.txt");
    expect(llms.status).toBe(200);
    expect(llms.body).toContain("delta-git");
    expect(llms.body).toContain("/skill.md");

    const skill = await get("/skill.md");
    expect(skill.status).toBe(200);
    expect(skill.body).toContain("merge intent");
    expect(skill.body).toContain("/api/v3");
  });

  it("returns a markdown repo card on Accept: text/markdown", async () => {
    const { status, body, contentType } = await get(
      `/${seeded.namespaceSlug}/agsrepo`,
      "text/markdown"
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/markdown");
    expect(body).toContain(`# ${seeded.namespaceSlug}/agsrepo`);
    expect(body).toContain("/api/v3/repos/");
    expect(body).toContain("git clone");
  });

  it("still serves the SPA for browser Accept headers", async () => {
    const { status, contentType } = await get(`/${seeded.namespaceSlug}/agsrepo`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/html");
  });

  it("404s markdown cards for unknown repos without leaking existence", async () => {
    const { status } = await get(`/${seeded.namespaceSlug}/nope`, "text/markdown");
    expect(status).toBe(404);
  });
});
