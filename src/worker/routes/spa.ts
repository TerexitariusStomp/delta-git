import type { AppContext, AppRouter } from "./hono";

// Gitness SPA serving + client-route fallback.
//
// The SPA build (frontend/canary/apps/gitness/dist) is copied into
// `dist/client/` by `scripts/copy-spa.mjs`, so the ASSETS binding serves its
// files at the site root. Any GET that reaches here — i.e. matched no API,
// git, auth, or asset path — is a client-side route: hand it `/index.html`
// and let react-router take it. Registered last in index.ts.

const SPA_INDEX = "/index.html";

const td = new TextDecoder();

/**
 * CSP for the SPA shell. `script-src` is hash-locked to the inline blocks
 * actually present in the built index.html (the Monaco worker bootstrap) —
 * computed per response so a rebuild can't drift the allowlist.
 * `worker-src blob:` covers Monaco's blob worker URLs.
 */
async function spaCsp(html: string): Promise<string> {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    hashes.push(`'sha256-${b64}'`);
  }
  return [
    `default-src 'self'`,
    // 'wasm-unsafe-eval': Monaco/sql.js compile WASM. 'unsafe-eval': a
    // vendored dep in the entry bundle calls `new Function` (template
    // compile). cloudflareinsights: the zone's Web Analytics beacon is
    // edge-injected — outside our markup — so it needs an explicit host.
    `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' https://static.cloudflareinsights.com ${hashes.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    // atproto PDS resolution + OAuth providers are first-party flows.
    `connect-src 'self' https: wss:`,
    `worker-src 'self' blob:`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join("; ");
}

const SPA_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  // The API is same-origin; HSTS applies to the whole host.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

async function spaIndex(c: AppContext) {
  const indexUrl = new URL(SPA_INDEX, c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(indexUrl.toString(), c.req.raw));
  if (!res.ok) return c.notFound();
  const html = td.decode(await res.arrayBuffer());
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Entry html is unhashed — revalidate; hashed assets use the binding's
      // own immutable caching.
      "Cache-Control": "no-cache",
      "Content-Security-Policy": await spaCsp(html),
      ...SPA_SECURITY_HEADERS,
    },
  });
}

// Pre-cutover URL scheme was `/:owner/:repo/<feature>`; the SPA uses
// `/:spaceId/repos/:repoId/<feature>`. Redirect the old bookmarrks and
// in-flight links rather than 404ing them.
const LEGACY_FEATURE_MAP: Record<string, string> = {
  tree: "files",
  blob: "files",
  admin: "settings",
};

// Path segments that are space-level SPA routes, not repo names — without
// this guard `/acme/repos` would loop through `/:owner/:repo` forever.
const SPACE_SEGMENTS = new Set([
  "repos",
  "settings",
  "pipelines",
  "search",
  "manage-repositories",
  "pulls",
]);

// Top-level SPA routes — a first-segment match means `/:owner/:repo` is a
// client route, not a legacy owner/repo URL. Without this guard,
// `/admin/roles` 301s to `/admin/repos/roles` (repo "roles" that doesn't
// exist). Keep in sync with the depth-1 children in routes.tsx.
const SPA_OWNED_FIRST_SEGMENTS = new Set([
  "explore",
  "secrets",
  "notifications",
  "environments",
  "artifacts",
  "feature-flags",
  "connectors",
  "delegates",
  "file-store",
  "templates",
  "variables",
  "freeze-windows",
  "external-tickets",
  "policies",
  "gitops",
  "iac",
  "monitored-services",
  "slo-downtime",
  "incidents",
  "certificates",
  "cloud-costs",
  "chaos",
  "service-reliability",
  "dev-portal",
  "discovery",
  "dev-environments",
  "dev-insights",
  "databases",
  "security-tests",
  "supply-chain",
  "dashboards",
  "overrides",
  "arena",
  "agents",
  "admin",
  "profile-settings",
  "import",
  "create",
  "signin",
  "signup",
  "logout",
]);

function legacyRepoRedirect(c: AppContext, feature?: string) {
  const owner = c.req.param("owner")!;
  const repo = c.req.param("repo")!;
  if (!feature) {
    return c.redirect(`/${owner}/repos/${repo}`, 301);
  }
  // `feature` may carry a suffix (e.g. `commit/<oid>/diff`) — split off the
  // first segment for mapping and re-append the rest verbatim.
  const [head, ...rest] = feature.split("/");
  const mapped = LEGACY_FEATURE_MAP[head] ?? head;
  const suffix = rest.length ? `/${rest.join("/")}` : "";
  return c.redirect(`/${owner}/repos/${repo}/${mapped}${suffix}`, 301);
}

// Namespaces that must never receive the SPA fallback — a GET that reached
// this router under one of these prefixes matched no real route, so the
// correct response is the SSR 404 (via `c.notFound()`), not index.html.
const NON_SPA_PREFIXES = [
  "/api/",
  "/auth",
  "/xrpc/",
  "/mcp",
  "/info/",
  "/objects/",
  "/.well-known/",
  // OAuth provider API surface (`/oauth/token`, `/oauth/register`, …). The
  // two SPA-owned paths (`/oauth/callback`, `/oauth/authorize`) are exact
  // routes registered below, so they never reach this check.
  "/oauth/",
  // Badge SVGs are machine-fetched resources (README embeds); an unmatched
  // `/badge/...` path should 404, not serve index.html.
  "/badge/",
];

function isNonSpaPath(pathname: string): boolean {
  return NON_SPA_PREFIXES.some((p) => pathname.startsWith(p));
}

export function registerSpaRoutes(router: AppRouter) {
  // Unhashed helper asset — the compute-pool consent script the repo page's
  // power card lazy-loads. Lives in the SPA public dir so copy-spa ships it
  // verbatim; without this route the `*` fallback would serve index.html.
  router.get("/power.js", async (c) => {
    const res = await c.env.ASSETS.fetch(new Request(new URL("/power.js", c.req.url), c.req.raw));
    if (!res.ok) return c.notFound();
    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        // Volunteers' browsers pin the file — revalidate on every load.
        "Cache-Control": "no-cache",
      },
    });
  });

  // Bookmarks from the migration window when the SPA lived under /app.
  // Registered before `/:owner/:repo` so `app` isn't parsed as an owner.
  router.get("/app", (c) => c.redirect("/", 301));
  router.get("/app/*", (c) => {
    const rest = new URL(c.req.url).pathname.slice(4);
    return c.redirect(rest || "/", 301);
  });

  // The atproto OAuth redirect_uri lands on the SPA route `/oauth/callback`
  // with ?code&state&iss params. Parsed as `/:owner/:repo` it would 301 to
  // /oauth/repos/callback — losing the query — so it must be served first.
  // Same for `/oauth/authorize` (our own provider's consent page) — the
  // JSON endpoints under it are registered earlier and take precedence.
  router.get("/oauth/callback", (c) => spaIndex(c));
  router.get("/oauth/authorize", (c) => spaIndex(c));

  // `/:owner/:repo` and `/:owner/:repo/<feature>` — the old SSR site map.
  // Skipped when `repo` is a space-level segment so SPA paths pass through.
  router.get("/:owner/:repo", (c) => {
    if (isNonSpaPath(new URL(c.req.url).pathname)) return c.notFound();
    if (SPA_OWNED_FIRST_SEGMENTS.has(c.req.param("owner")!)) return spaIndex(c);
    if (SPACE_SEGMENTS.has(c.req.param("repo")!)) return spaIndex(c);
    return legacyRepoRedirect(c);
  });
  router.get("/:owner/:repo/:feature{.+}", (c) => {
    if (isNonSpaPath(new URL(c.req.url).pathname)) return c.notFound();
    if (SPA_OWNED_FIRST_SEGMENTS.has(c.req.param("owner")!)) return spaIndex(c);
    if (SPACE_SEGMENTS.has(c.req.param("repo")!)) return spaIndex(c);
    return legacyRepoRedirect(c, c.req.param("feature"));
  });

  // Every other GET is a client-side route.
  router.get("*", (c) => {
    if (isNonSpaPath(new URL(c.req.url).pathname)) return c.notFound();
    return spaIndex(c);
  });
}
