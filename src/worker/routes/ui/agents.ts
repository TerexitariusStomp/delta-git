import { getRepoStub } from "@/worker/common";
import { resolveUiRepoAccess } from "./helpers";
import { sameOriginViolation } from "@/worker/auth/origin";
import { LIMITS, rateLimit } from "@/worker/agent/abuse";
import type { AppContext } from "../hono";

/**
 * POST /:owner/:repo/ideas/site — session-authed site-builder trigger.
 * Describe a WordPress site; the site-smith seat generates it and lands the
 * result through the normal merge lanes. Contribution is permissionless —
 * no rep gate (voting is what's gated), just the rate limiter.
 *
 * The `back` target uses the legacy `/:owner/:repo/ideas` shape on purpose —
 * the SPA cutover redirects it to `/:owner/repos/:repo/ideas`.
 */
export async function handleIdeasSiteBuild(c: AppContext<"/:owner/:repo/ideas">) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const back = `/${owner}/${repo}/ideas`;
  const violation = sameOriginViolation(c);
  if (violation) return violation;
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  if (!access.viewer) {
    return c.redirect(`/auth?next=${encodeURIComponent(back)}`, 302);
  }
  const limited = await rateLimit(c.env, LIMITS.siteBuild, access.viewer.userId);
  if (!limited.ok) return c.redirect(`${back}?error=rate-limited`, 303);

  const form = await c.req.raw.formData().catch(() => null);
  const description = String(form?.get("description") ?? "").trim();
  if (!description || description.length > 8000) return c.redirect(back, 303);

  const stub = getRepoStub(c.env, access.route.doName);
  const row = await stub.createWorkIntent({
    row: {
      id: `idea-${crypto.randomUUID().slice(0, 8)}`,
      title: `site: ${description.split("\n")[0].slice(0, 150)}`,
      body: description.slice(0, 8000),
      createdBy: access.viewer.userId,
      kind: "idea",
      sourceUri: null,
      result: null,
      status: "open",
      claimedBy: null,
      claimExpiresAt: null,
      createdAt: Date.now(),
      closedAt: null,
    },
    actor: access.viewer.userId,
  });
  await c.env.REPO_TASKS_QUEUE.send({
    kind: "site-build",
    doId: stub.id.toString(),
    repoId: access.route.doName,
    workIntentId: row.id,
  });
  return c.redirect(back, 303);
}
