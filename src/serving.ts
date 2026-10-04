import type { Env } from "./env";
import { contentType } from "./mime";
import { serveLane2 } from "./lane2";

interface SiteRow { id: string; lane: number; status: string; manifest_sha: string | null; lease_expires_at: number | null }

// Host-based serving: preview-{id}.{suffix} or customer custom domain →
// site → lane dispatch (1=R2 artifacts, 2=wasm, 3=container DO).
export async function serveSite(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const site = await resolveSite(env, url.hostname);
  if (!site) return new Response("site not found", { status: 404 });
  if (site.status !== "active") return topUpPage();
  if (site.lease_expires_at && site.lease_expires_at < Date.now() / 1000) return reclaimPage();

  if (site.lane === 2) return serveLane2(req, env, site);
  if (site.lane === 3 && env.TENANT) {
    const stub = env.TENANT.get(env.TENANT.idFromName(site.id));
    return stub.fetch(req);
  }
  return serveArtifact(req, env, ctx, site, url);
}

async function resolveSite(env: Env, host: string): Promise<SiteRow | null> {
  const m = host.match(/^preview-([a-z0-9]+)\./i);
  if (m) {
    return env.DB.prepare("SELECT id, lane, status, manifest_sha, lease_expires_at FROM sites WHERE id=?")
      .bind(m[1]).first<SiteRow>();
  }
  return env.DB.prepare("SELECT id, lane, status, manifest_sha, lease_expires_at FROM sites WHERE custom_domain=?")
    .bind(host.toLowerCase()).first<SiteRow>();
}

async function serveArtifact(req: Request, env: Env, ctx: ExecutionContext, site: SiteRow, url: URL): Promise<Response> {
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
