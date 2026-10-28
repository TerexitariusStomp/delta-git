// Per-deployment branding. One worker build serves several tenants on the same
// data plane (code.widespread.fyi, vibetime-forge.delta-git.workers.dev, ...);
// the BRAND var picks which name, logo and accent stylesheet a deployment
// shows. Only presentation changes: wire identifiers, routes and APIs are the
// same everywhere.

export type Brand = {
  id: string;
  name: string;
  tagline: string;
  logo: string;
  favicon: string;
  // Accent-token overrides layered after the base theme, or null for none.
  stylesheet: string | null;
};

const BRANDS: Record<string, Brand> = {
  widespread: {
    id: "widespread",
    name: "Widespread",
    tagline: "Code forge",
    logo: "/logo-widespread.png",
    favicon: "/favicon.png",
    stylesheet: null,
  },
  vibetime: {
    id: "vibetime",
    name: "Vibetime",
    tagline: "Code forge",
    logo: "/brands/vibetime-logo.svg",
    favicon: "/brands/vibetime-logo.svg",
    stylesheet: "/brands/vibetime.css",
  },
};

export function brandFor(id: string | undefined): Brand {
  return (id && BRANDS[id]) || BRANDS.widespread;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Stamps a brand into the SPA's built index.html: tab title, favicon, the
 * accent stylesheet (after the base styles, so its tokens win), and a
 * `dg-brand` meta the SPA reads for its logo and name (see getBrand in
 * @harnessio/ui/utils). Inline <script> blocks are untouched, so the CSP
 * hashes computed from them still match.
 */
export function brandSpaHtml(html: string, brand: Brand): string {
  const meta = JSON.stringify({ name: brand.name, tagline: brand.tagline, logo: brand.logo });
  const head =
    `<meta name="dg-brand" content="${escapeHtml(meta)}">` +
    (brand.stylesheet ? `<link rel="stylesheet" href="${escapeHtml(brand.stylesheet)}">` : "");
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(brand.name)}</title>`)
    .replace(
      /<link href="[^"]*" rel="icon"[^>]*>/,
      `<link href="${escapeHtml(brand.favicon)}" rel="icon">`
    )
    .replace("</head>", `${head}</head>`);
}
