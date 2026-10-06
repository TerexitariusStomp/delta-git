import type { AppRouter } from "./hono";

import { marked } from "marked";

// Self-hosted documentation — renders this repo's own docs/ tree at
// /docs/{page} so a deployment's docs always match the code serving them.
// Files are bundled at build time via vite ?raw glob imports; no runtime
// file access is involved (Workers has none).
//
//   GET /docs           — index of every docs page
//   GET /docs/{page}    — rendered markdown (e.g. /docs/security,
//                         /docs/dgs/DGS-01-signed-requests)
//
// Content is first-party and trusted, so marked's raw-HTML passthrough is
// acceptable here — do not reuse this renderer for tenant content.

const rawDocs = import.meta.glob("../../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Map "docs/dgs/DGS-01-signed-requests.md" → "dgs/DGS-01-signed-requests".
const pages = new Map<string, string>();
for (const [path, text] of Object.entries(rawDocs)) {
  const rel = path.replace(/^.*docs\//, "").replace(/\.md$/, "");
  pages.set(rel, text);
}

const INDEXED = Array.from(pages.keys()).sort();

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — delta-git docs</title>
<style>
:root{color-scheme:light dark}
body{max-width:820px;margin:0 auto;padding:32px 20px;
 font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:Canvas;color:CanvasText}
h1,h2,h3{line-height:1.3}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;
 background:color-mix(in srgb,CanvasText 6%,transparent);border-radius:4px}
code{padding:.1em .35em}
pre{padding:12px 14px;overflow-x:auto}
pre code{padding:0;background:none}
a{color:LinkText}
table{border-collapse:collapse}
th,td{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding:6px 10px;text-align:left}
nav{font-size:13px;margin-bottom:24px;color:color-mix(in srgb,CanvasText 60%,transparent)}
nav a{color:LinkText}
</style></head>
<body>
<nav><a href="/docs">docs</a> · <a href="/">delta-git</a></nav>
${body}
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

export function registerDocsRoutes(router: AppRouter) {
  router.get("/docs", () => {
    const links = INDEXED.map((p) => `<li><a href="/docs/${esc(p)}">${esc(p)}</a></li>`).join("\n");
    return page("delta-git docs", `<h1>delta-git docs</h1>\n<ul>\n${links}\n</ul>`);
  });

  router.get("/docs/:page{.+}", (c) => {
    const name = c.req.param("page").replace(/\/$/, "");
    const md = pages.get(name) ?? pages.get(`${name}/README`);
    if (!md) {
      return new Response("Not found\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
    const html = marked(md, { async: false });
    return page(title, html);
  });
}
