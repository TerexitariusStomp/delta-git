import { parse as parseYaml } from "yaml";

import type { AppRouter } from "@/worker/routes/hono";

import { readPath } from "@/worker/git/operations/read/tree";
import { resolveGitnessRepo } from "./shared";

// Sponsors — GitHub's FUNDING.yml convention. GitHub checks `.github/`, the
// repo root, and `docs/` on the default branch, then renders a Sponsor
// button linking to the declared platforms. We surface the same parsed
// shape over `/api/v1` so the SPA header can render it.

export type FundingLink = {
  // FUNDING.yml key (github | patreon | ... | custom).
  platform: string;
  // Raw value as written (handle, project slug, or URL for `custom`).
  value: string;
  // Resolved outbound URL the Sponsor menu links to.
  url: string;
};

const FUNDING_PATHS = [".github/FUNDING.yml", "FUNDING.yml", "docs/FUNDING.yml"];

// Platform key → profile/project URL builder, matching GitHub's expansion
// rules. Unknown keys are ignored rather than surfaced as broken links.
const PLATFORM_URLS: Record<string, (value: string) => string> = {
  github: (v) => `https://github.com/sponsors/${v}`,
  patreon: (v) => `https://www.patreon.com/${v}`,
  open_collective: (v) => `https://opencollective.com/${v}`,
  ko_fi: (v) => `https://ko-fi.com/${v}`,
  tidelift: (v) => `https://tidelift.com/funding/github/${v}`,
  community_bridge: (v) => `https://funding.communitybridge.org/projects/${v}`,
  liberapay: (v) => `https://liberapay.com/${v}`,
  issuehunt: (v) => `https://issuehunt.io/r/${v}`,
  otechie: (v) => `https://otechie.com/${v}`,
  lfx_crowdfunding: (v) => `https://crowdfunding.lfx.linuxfoundation.org/projects/${v}`,
  polar: (v) => `https://polar.sh/${v}`,
  buy_me_a_coffee: (v) => `https://www.buymeacoffee.com/${v}`,
  thanks_dev: (v) => `https://thanks.dev/${v}`,
};

// Values under a platform key may be a scalar or a list; `custom` is the
// free-form URL list (GitHub caps it at 4 — mirrored here).
const MAX_CUSTOM_LINKS = 4;

export function parseFunding(source: string): FundingLink[] {
  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(source) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    doc = parsed;
  } catch {
    // Malformed YAML renders no Sponsor button — same as GitHub.
    return [];
  }

  const links: FundingLink[] = [];
  for (const [platform, raw] of Object.entries(doc)) {
    const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim()).filter(Boolean);
    if (platform === "custom") {
      for (const url of values.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_CUSTOM_LINKS)) {
        links.push({ platform, value: url, url });
      }
      continue;
    }
    const build = PLATFORM_URLS[platform];
    if (!build) continue;
    for (const value of values) {
      links.push({ platform, value, url: build(value) });
    }
  }
  return links;
}

export function registerGitnessFunding(router: AppRouter) {
  // GET /api/v1/repos/{ref}/funding — parsed FUNDING.yml links.
  router.get("/api/v1/repos/:repo_ref{.+}/funding", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const source = await loadFundingSource(c.env, access);
    return c.json({ links: source === null ? [] : parseFunding(source) });
  });
}

async function loadFundingSource(
  env: Env,
  access: { route: { doName: string }; cacheCtx?: Parameters<typeof readPath>[4] }
): Promise<string | null> {
  for (const path of FUNDING_PATHS) {
    const result = await readPath(env, access.route.doName, "HEAD", path, access.cacheCtx).catch(
      () => null
    );
    if (!result || result.type !== "blob" || result.tooLarge) continue;
    return new TextDecoder().decode(result.content);
  }
  return null;
}
