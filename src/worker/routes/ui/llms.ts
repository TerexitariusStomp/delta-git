// llms.txt / llms-full.txt — agent-facing repo manifests at the repo's
// canonical path (the llms.txt convention is a root-level document, not an
// API resource, so it lives here beside /raw rather than under /api/v1).
// Same access + encrypted-repo rules as the KB endpoints: read-gated by
// resolveUiRepoAccess; E2E-encrypted repos have no server-side plaintext.

import { refreshRepoKnowledge, llmsTxt, llmsFullTxt } from "@/worker/knowledge";
import { isRequestPrivate, resolveUiRepoAccess, loadHeadAndRefsCached } from "./helpers";
import type { AppContext } from "../hono";

export async function handleLlmsTxt(c: AppContext<"/:owner/:repo/llms.txt">) {
  const { owner, repo } = c.req.param();
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  const { route, cacheCtx } = access;
  if (route.encrypted) return new Response("Not found\n", { status: 404 });
  const refs = await loadHeadAndRefsCached(c.env, cacheCtx, route.doName);
  const kb = await refreshRepoKnowledge(
    c.env,
    route.doName,
    refs?.head?.oid ?? null,
    cacheCtx
  ).catch(() => null);
  if (!kb) return new Response("Not found\n", { status: 404 });
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  if (isRequestPrivate(cacheCtx)) headers.set("Cache-Control", "no-store");
  return new Response(llmsTxt(kb, owner, repo), { headers });
}

export async function handleLlmsFullTxt(c: AppContext<"/:owner/:repo/llms-full.txt">) {
  const { owner, repo } = c.req.param();
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response") return access.response;
  const { route, cacheCtx } = access;
  if (route.encrypted) return new Response("Not found\n", { status: 404 });
  const refs = await loadHeadAndRefsCached(c.env, cacheCtx, route.doName);
  const kb = await refreshRepoKnowledge(
    c.env,
    route.doName,
    refs?.head?.oid ?? null,
    cacheCtx
  ).catch(() => null);
  if (!kb) return new Response("Not found\n", { status: 404 });
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  if (isRequestPrivate(cacheCtx)) headers.set("Cache-Control", "no-store");
  return new Response(llmsFullTxt(kb, owner, repo), { headers });
}
