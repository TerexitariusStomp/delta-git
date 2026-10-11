/**
 * Personal Agent Protocol (Poppy) — draft 0.1 discovery descriptor.
 *
 * Poppy (personalagentprotocol.org; Sierra+Meta spec, Cloudflare is a
 * design partner) defines how a personal agent acting for one user
 * discovers and works with a company. The company contract is a single
 * `/.well-known/poppy.json` document declaring auth, APIs, and surfaces.
 *
 * delta-git is already Poppy-conformant on everything the descriptor
 * advertises:
 *   auth.issuer   → our own OAuth 2.1 AS (RFC 8414 metadata live at
 *                   /.well-known/oauth-authorization-server, with
 *                   `poppy_domains` patched in by oauthProvider.ts)
 *   direct        → authorization_code + PKCE consent flow; session tokens
 *                   are DPoP-bound per spec (see /oauth/token wrapper)
 *   apis          → the stable OpenAPI surface + MCP endpoint
 *   scopes        → poppy:read/write are registered aliases of
 *                   repo:read/repo:write (see auth/oauth.ts)
 *
 * Deliberately omitted until later tiers: `agent` (no company conversational
 * endpoint yet), `web.browser_session_endpoint` (no session-join API),
 * `device`/`mediated` sign-in (did:key challenge is a candidate mapping for
 * mediated once the draft stabilizes).
 */
import type { AppRouter } from "./hono";

import { OAUTH_SCOPES } from "@/worker/auth/oauth";

export function registerPoppyRoutes(router: AppRouter): void {
  router.get("/.well-known/poppy.json", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        protocol_version: "0.1",
        organization: {
          name: "delta-git",
          domain: new URL(origin).hostname,
        },
        auth: {
          issuer: origin,
          direct: {
            scopes: [OAUTH_SCOPES.POPPY_READ, OAUTH_SCOPES.POPPY_WRITE],
          },
          custom_scopes: {
            [OAUTH_SCOPES.POPPY_READ]:
              "Read and clone repositories, merge intents, issues, and metadata the user can access",
            [OAUTH_SCOPES.POPPY_WRITE]:
              "Push, file merge intents, comment, and vote on the user's behalf",
          },
        },
        apis: [
          {
            type: "openapi",
            url: `${origin}/api/openapi.json`,
            description: "Stable agent-facing API surface",
          },
          {
            type: "mcp",
            url: `${origin}/mcp`,
            description: "Repo, merge-intent, issue, and arena tools",
          },
        ],
        // Node descriptor gives personal agents the full capability picture
        // beyond what the Poppy schema itself can express.
        extensions: {
          delta_node: `${origin}/.well-known/delta-node`,
          protected_resource: `${origin}/.well-known/oauth-protected-resource`,
        },
      },
      200,
      { "cache-control": "public, max-age=300" }
    );
  });
}
