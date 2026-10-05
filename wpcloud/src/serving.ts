import type { Env } from "./env";
import { contentType } from "./mime";
import { serveLane2 } from "./lane2";

interface SiteRow { id: string; lane: number; status: string; manifest_sha: string | null; lease_expires_at: number | null; earn_enabled?: number }

// Host-based serving: preview-{id}.{suffix} or customer custom domain →
// site → lane dispatch (1=R2 artifacts, 2=wasm, 3=container DO).
export async function serveSite(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  // visitor-node script is servable from any site host so the earn card works
  // on preview hosts and custom domains alike
  if (url.pathname === "/visitor-node.js" && env.ASSETS)
    return env.ASSETS.fetch(new Request(`${url.origin}/visitor-node.js`, req));

  // Path-based preview: /preview/{id}/rest — used on the app host where
  // preview-{id}.{suffix} subdomains can't be routed (e.g. workers.dev).
  const pv = url.pathname.match(/^\/preview\/([a-z0-9]+)(\/.*)?$/i);
  let site: SiteRow | null;
  if (pv) {
    site = await siteById(env, pv[1]);
    url.pathname = pv[2] ?? "/";
  } else {
    site = await resolveSite(env, url.hostname);
  }
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

const SITE_COLS = "id, lane, status, manifest_sha, lease_expires_at, earn_enabled";

function siteById(env: Env, id: string): Promise<SiteRow | null> {
  return env.DB.prepare(`SELECT ${SITE_COLS} FROM sites WHERE id=?`).bind(id).first<SiteRow>();
}

async function resolveSite(env: Env, host: string): Promise<SiteRow | null> {
  const m = host.match(/^preview-([a-z0-9]+)\./i);
  if (m) return siteById(env, m[1]);
  return env.DB.prepare(`SELECT ${SITE_COLS} FROM sites WHERE custom_domain=?`)
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
  // earn card: opt-in visitor-compute script injected into HTML at serving time
  if (site.earn_enabled && contentType(path).includes("text/html"))
    res = await injectEarn(res, site.id, env);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function injectEarn(res: Response, siteId: string, env: Env): Promise<Response> {
  const html = await res.text();
  const coord = (env.COORDINATOR_URL ?? "").replace(/^http/, "ws");
  if (!coord) return new Response(html, res); // no coordinator configured → no card
  const tag = `<script src="/visitor-node.js" data-site="${siteId}" data-coordinator="${coord}" defer></script>`;
  const out = html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html + tag;
  const h = new Headers(res.headers);
  h.delete("content-length");
  return new Response(out, { status: res.status, headers: h });
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
