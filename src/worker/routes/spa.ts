import type { AppContext, AppRouter } from "./hono";

// Gitness SPA serving + client-route fallback.
//
// The SPA build (frontend/canary/apps/gitness/dist) is copied into
// `dist/client/app/` by `scripts/copy-spa.mjs`, so the ASSETS binding serves
// its files at `/app/*`. Anything under `/app/` that isn't a real asset is a
// client-side route — hand it `/app/index.html` and let react-router take it.
// Mounted under a dedicated prefix so it can't shadow SSR routes during the
// migration; at cutover the basename flips to `/` and this replaces the UI
// route table wholesale.

const SPA_PREFIX = "/app";
const SPA_INDEX = `${SPA_PREFIX}/index.html`;

async function spaIndex(c: AppContext) {
  const indexUrl = new URL(SPA_INDEX, c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(indexUrl.toString(), c.req.raw));
  if (!res.ok) return c.notFound();
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Entry html is unhashed — revalidate; hashed assets use the binding's
      // own immutable caching.
      "Cache-Control": "no-cache",
    },
  });
}

export function registerSpaRoutes(router: AppRouter) {
  router.get(SPA_PREFIX, spaIndex);
  router.get(`${SPA_PREFIX}/*`, async (c) => {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return asset;
    return spaIndex(c);
  });
}
