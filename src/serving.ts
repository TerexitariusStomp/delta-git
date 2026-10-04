import type { Env } from "./env";
import { contentType } from "./mime";

// Host-based serving: preview-{id}.{suffix} or customer domain → site →
// manifest → R2 artifact. Edge-cached via Cache API keyed on manifest sha.
export async function serveSite(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const host = url.hostname;
  const m = host.match(/^preview-([a-z0-9]+)\./i);
  const siteId = m?.[1];
  if (!siteId) return new Response("not a site host", { status: 404 });

  const site = await env.DB.prepare(
    "SELECT id, status, manifest_sha, lease_expires_at FROM sites WHERE id = ?"
  ).bind(siteId).first<{ id: string; status: string; manifest_sha: string | null; lease_expires_at: number | null }>();

  if (!site) return new Response("site not found", { status: 404 });
  if (site.status !== "active") return topUpPage();
  if (site.lease_expires_at && site.lease_expires_at < Date.now() / 1000) return reclaimPage();
  if (!site.manifest_sha) return new Response("site not published yet", { status: 404 });

  let path = decodeURIComponent(url.pathname);
  if (path === "/" || path.endsWith("/")) path += "index.html";
  const key = `sites/${site.id}/artifacts/${site.manifest_sha}${path}`;

  const cacheKey = new Request(new URL(key, "https://artifacts.internal").toString());
  const cache = (caches as unknown as { default: Cache }).default;
  let res = await cache.match(cacheKey);
  if (res) return res;

  const obj = await env.ARTIFACTS.get(key);
  if (!obj) {
    // SPA-ish fallback only for extensionless paths
    if (!path.includes(".")) {
      const idx = await env.ARTIFACTS.get(`sites/${site.id}/artifacts/${site.manifest_sha}/index.html`);
      if (idx) return artifactResponse(idx, "index.html");
    }
    return new Response("404", { status: 404 });
  }
  res = artifactResponse(obj, path);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function artifactResponse(obj: R2ObjectBody, path: string): Response {
  const h = new Headers({ "content-type": contentType(path), "cache-control": "public, max-age=3600, stale-while-revalidate=86400" });
  if (obj.httpEtag) h.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers: h });
}

function topUpPage() {
  return new Response(`<h1>Site suspended</h1><p>Top up USDC to reactivate.</p>`, { status: 402, headers: { "content-type": "text/html" } });
}
function reclaimPage() {
  return new Response(`<h1>Preview expired</h1><p>Claim a domain to keep this site live.</p>`, { status: 410, headers: { "content-type": "text/html" } });
}
