// Shared slug policy used by namespace and repository slugs. Browser-safe so
// the same validator runs in SSR pages and Worker validation paths.
//
// The regex enforces lowercase ASCII alphanumerics with internal dashes.
// Length is bounded at 1..40. Reserved slugs cover Worker-owned routes and
// common static paths so that creating a namespace cannot shadow existing
// surfaces.

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const SLUG_MAX_LENGTH = 40;

export const RESERVED_SLUGS: readonly string[] = [
  "auth",
  "sign-in",
  "sign-out",
  "api",
  "assets",
  "_cache",
  "_routes",
  "favicon.ico",
  "robots.txt",
  // SPA first-segment routes — a namespace with one of these slugs would be
  // unreachable because the SPA route wins. Mirrors the top-level paths in
  // frontend/canary/apps/gitness/src/routes.tsx plus `app` (the old mount).
  "app",
  "signin",
  "signup",
  "logout",
  "profile-settings",
  "admin",
  "arena",
  "agents",
  "repos",
  "import",
  "pipelines",
  "executions",
  "databases",
  "chaos",
  "artifacts",
  "secrets",
  "connectors",
  "continuous-delivery-gitops",
  "continuous-integration",
  "feature-flags",
  "notifications",
  "environments",
  "delegates",
  "file-store",
  "templates",
  "variables",
  "slo-downtime",
  "discovery",
  "monitored-services",
  "overrides",
  "certificates",
  "policies",
  "freeze-windows",
  "external-tickets",
  "infrastructure-as-code",
  "service-reliability",
  "developer",
  "code-repository",
  "supply-chain",
  "security-tests",
  "cloud-costs",
  "incidents",
  "dashboards",
  "user-groups",
  "service-accounts",
  "resource-groups",
  "roles",
  "search",
  "create",
];

const reservedSet: ReadonlySet<string> = new Set(RESERVED_SLUGS);

export function isValidSlug(input: string): boolean {
  if (typeof input !== "string") return false;
  if (input.length === 0 || input.length > SLUG_MAX_LENGTH) return false;
  if (!SLUG_PATTERN.test(input)) return false;
  if (reservedSet.has(input)) return false;
  return true;
}

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: "format" | "reserved" | "length" };

// Granular result so the route handler can decide which message to surface
// (taken vs format vs reserved) without re-checking the regex.
export function validateSlugForRoute(input: string): SlugValidation {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "length" };
  }
  if (input.length > SLUG_MAX_LENGTH) return { ok: false, reason: "length" };
  if (reservedSet.has(input)) return { ok: false, reason: "reserved" };
  if (!SLUG_PATTERN.test(input)) return { ok: false, reason: "format" };
  return { ok: true, slug: input };
}
