import { handleIdeasSiteBuild } from "./ui/agents";
import { handleLlmsTxt, handleLlmsFullTxt } from "./ui/llms";
import { handleRaw, handleRawPath } from "./ui/raw";
import { handleRefsApi } from "./ui/refsApi";
import type { AppRouter } from "./hono";

/**
 * Legacy functional (non-page) endpoints from the SSR era. All HTML pages
 * moved to the Gitness SPA — registered last via registerSpaRoutes — while
 * these continue serving file content and site builds at their old paths.
 */
export function registerUiRoutes(router: AppRouter) {
  // Raw blob endpoint - streams file content without buffering
  router.get(`/:owner/:repo/raw`, handleRaw);

  // Raw blob by ref+path (used for images in Markdown)
  router.get(`/:owner/:repo/rawpath`, handleRawPath);

  // Refs listing JSON — also used by external tooling that wants the old
  // compact refs endpoint.
  router.get(`/:owner/:repo/api/refs`, handleRefsApi);

  // llms.txt convention — agent-facing repo manifests at the repo root.
  router.get(`/:owner/:repo/llms.txt`, handleLlmsTxt);
  router.get(`/:owner/:repo/llms-full.txt`, handleLlmsFullTxt);

  // Site-smith build trigger from an idea card.
  router.post(`/:owner/:repo/ideas/site`, handleIdeasSiteBuild);
}
