import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, type SetupRepoForTestsResult } from "./util/repoSeed";

// Insights: pulse/activity/contributors — computed on demand, so even a
// zero-commit repo must return well-formed empty shapes.

async function call(
  method: string,
  path: string,
  opts: { cookie?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method,
    headers,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

let seeded: SetupRepoForTestsResult;
let base: string;

beforeAll(async () => {
  await ensureD1Migrations(env);
  seeded = await setupRepoForTests(env, uniq("ins-ns"), "insrepo");
  base = `/api/v1/repos/${seeded.namespaceSlug}/insrepo/+`;
});

describe("insights: /api/v1", () => {
  it("returns a pulse rollup", async () => {
    const { status, body } = await call("GET", `${base}/insights/pulse`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    const pulse = body as {
      commits_7d: number;
      commits_30d: number;
      open_issues: number;
      open_pull_requests: number;
      history_truncated: boolean;
    };
    expect(pulse.commits_7d).toBeGreaterThanOrEqual(0);
    expect(pulse.open_issues).toBe(0);
    expect(pulse.history_truncated).toBe(false);
  });

  it("returns a 52-week activity series", async () => {
    const { status, body } = await call("GET", `${base}/insights/activity`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    const activity = body as { total_walked: number; weeks: { week: number; commits: number }[] };
    expect(activity.weeks.length).toBe(52);
    expect(activity.weeks.every((w) => w.commits >= 0)).toBe(true);
  });

  it("returns contributor rollups", async () => {
    const { status, body } = await call("GET", `${base}/insights/contributors`, {
      cookie: seeded.cookieHeader,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("allows anonymous reads on a public repo", async () => {
    const { status } = await call("GET", `${base}/insights/pulse`);
    expect(status).toBe(200);
  });
});
