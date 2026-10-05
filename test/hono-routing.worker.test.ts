import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";

beforeAll(async () => {
  await ensureD1Migrations(env);
});

describe("SPA cutover routing", () => {
  it("serves the SPA index at the root and for client-side deep links", async () => {
    const root = await workerExports.default.fetch("https://example.com/");
    expect(root.status).toBe(200);
    expect(root.headers.get("Content-Type")).toContain("text/html");
    expect(await root.text()).toContain('id="root"');

    // Single-segment space route — client-side, SPA owns it.
    const space = await workerExports.default.fetch("https://example.com/some-space");
    expect(space.status).toBe(200);
    expect(await space.text()).toContain('id="root"');

    // Space-level SPA route under an owner prefix must not redirect-loop
    // through the legacy `/:owner/:repo` mapping.
    const repos = await workerExports.default.fetch(
      "https://example.com/some-space/repos/some-repo"
    );
    expect(repos.status).toBe(200);
    expect(await repos.text()).toContain('id="root"');
  });

  it("redirects the retired SSR repo URL scheme to SPA paths", async () => {
    const repo = await workerExports.default.fetch("https://example.com/acme/widgets", {
      redirect: "manual",
    });
    expect(repo.status).toBe(301);
    expect(repo.headers.get("location")).toBe("/acme/repos/widgets");

    const commits = await workerExports.default.fetch(
      "https://example.com/acme/widgets/commits/main",
      { redirect: "manual" }
    );
    expect(commits.status).toBe(301);
    expect(commits.headers.get("location")).toBe("/acme/repos/widgets/commits/main");
  });

  it("keeps auth precedence and the SSR 404 for non-SPA namespaces", async () => {
    const auth = await workerExports.default.fetch("https://example.com/auth/");
    expect(auth.status).toBe(200);
    expect(auth.headers.get("X-Page-Renderer")).toBe("react-ssr");

    // Unknown paths under API namespaces 404 — no index.html for API clients.
    const apiMiss = await workerExports.default.fetch("https://example.com/api/does/not/exist");
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers.get("X-Page-Renderer")).toBe("react-ssr");
  });

  it("keeps unsupported methods on the rendered 404 fallback", async () => {
    const postOwner = await workerExports.default.fetch("https://example.com/hono-routing-owner", {
      method: "POST",
    });
    expect(postOwner.status).toBe(404);
    expect(postOwner.headers.get("X-Page-Renderer")).toBe("react-ssr");
  });

  it("redirects /app/* bookmarks to the root-mounted SPA", async () => {
    const legacy = await workerExports.default.fetch("https://example.com/app/acme/repos/widgets", {
      redirect: "manual",
    });
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe("/acme/repos/widgets");
  });
});
