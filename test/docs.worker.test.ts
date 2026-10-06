import { beforeAll, describe, expect, it } from "vitest";
import { exports as workerExports } from "cloudflare:workers";

// The docs renderer bundles this repo's own docs/ tree at build time and
// serves it rendered — anonymous, no fixtures needed.

beforeAll(async () => {
  // The first fetch in a file triggers cold isolate startup — the docs
  // module's eager markdown glob makes it slow enough to exceed the 5s
  // default per-test timeout, so warm the isolate outside test timing.
  await workerExports.default.fetch("https://example.com/healthz");
}, 30000);

describe("docs: /docs self-hosted renderer", () => {
  it("indexes docs and renders a page as HTML", async () => {
    const index = await workerExports.default.fetch("https://example.com/docs");
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain("/docs/security");

    const page = await workerExports.default.fetch("https://example.com/docs/security");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1");
    expect(page.headers.get("content-type")).toContain("text/html");
  });

  it("404s unknown pages and serves dgs specs", async () => {
    const missing = await workerExports.default.fetch("https://example.com/docs/nope-not-real");
    expect(missing.status).toBe(404);

    const spec = await workerExports.default.fetch(
      "https://example.com/docs/dgs/DGS-01-signed-requests"
    );
    expect(spec.status).toBe(200);
    expect(await spec.text()).toContain("RFC 9421");
  });
});
