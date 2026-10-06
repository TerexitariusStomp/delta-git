import type { AppRouter } from "@/worker/routes/hono";

import { createLogger } from "@/worker/common/logger";
import { getRepoStub } from "@/worker/common";
import {
  listCommitsFirstParentRange,
  readPath,
  readTree,
  resolveRef,
} from "@/worker/git/operations/read";
import { attemptMerge } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { commitFileActions } from "./commitFiles";
import { gErr, gNotFound, requireWriter, resolveGitnessRepo } from "./shared";

// Wiki: markdown pages on a dedicated `refs/heads/wiki` branch inside the
// same repo — the same "wiki is just git" model GitHub uses for `.wiki.git`,
// except ours rides the normal object store so `git fetch origin wiki` works
// over the standard protocol. Every edit lands through the merge-intent
// lane (staged pack + acceptPatchCommit + attemptMerge), so a wiki edit is
// an auditable intent like any other web write.

const WIKI_REF = "refs/heads/wiki";
const MAX_PAGE_BYTES = 512 * 1024;

const td = new TextDecoder();

/** GitHub-style page slugs: letters/digits/space→-/_ (flat, no subdirs). */
function pageSlug(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, "-").replace(/\.md$/i, "");
  if (!name || name.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  return name;
}

const pagePath = (slug: string) => `${slug}.md`;

interface WikiPageRow {
  name: string;
  oid: string;
}

async function listWikiPages(
  env: Env,
  repoId: string,
  cacheCtx?: Parameters<typeof readTree>[3]
): Promise<WikiPageRow[]> {
  const headOid = await resolveRef(env, repoId, WIKI_REF, cacheCtx);
  if (!headOid) return [];
  const root = await readPath(env, repoId, WIKI_REF, "", cacheCtx);
  if (root.type !== "tree") return [];
  return root.entries
    .filter((e) => !e.mode.startsWith("40000") && /\.md$/i.test(e.name))
    .map((e) => ({ name: e.name.replace(/\.md$/i, ""), oid: e.oid }))
    .sort((a, b) =>
      a.name === "Home" ? -1 : b.name === "Home" ? 1 : a.name.localeCompare(b.name)
    );
}

export function registerGitnessWiki(router: AppRouter) {
  // GET /api/v1/repos/{ref}/wiki — page list
  router.get("/api/v1/repos/:repo_ref{.+}/wiki", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const pages = await listWikiPages(c.env, access.route.doName, access.cacheCtx);
    return c.json(pages);
  });

  // GET /api/v1/repos/{ref}/wiki/{page} — page content (markdown source)
  router.get("/api/v1/repos/:repo_ref{.+}/wiki/:page", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const slug = pageSlug(c.req.param("page"));
    if (!slug) return gNotFound(c, "page");
    const result = await readPath(
      c.env,
      access.route.doName,
      WIKI_REF,
      pagePath(slug),
      access.cacheCtx
    ).catch(() => null);
    if (!result || result.type !== "blob") return gNotFound(c, "page");
    return c.json({
      name: slug,
      oid: result.oid,
      content: td.decode(result.content),
    });
  });

  // GET /api/v1/repos/{ref}/wiki/history — recent changes across the wiki
  // branch (first-parent walk; per-page filtering would need a tree diff
  // per commit, so the SPA labels this "recent changes").
  router.get("/api/v1/repos/:repo_ref{.+}/wiki-history", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const commits = await listCommitsFirstParentRange(
      c.env,
      access.route.doName,
      WIKI_REF,
      0,
      50,
      access.cacheCtx
    ).catch(() => []);
    return c.json(commits);
  });

  // PUT /api/v1/repos/{ref}/wiki/{page} — create or update a page in one
  // commit on the wiki branch. GitHub has no REST wiki API; this is ours.
  router.put("/api/v1/repos/:repo_ref{.+}/wiki/:page", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const slug = pageSlug(c.req.param("page"));
    if (!slug) return gErr(c, 422, "invalid page name");
    const body = (await c.req.json().catch(() => null)) as {
      content?: string;
      message?: string;
    } | null;
    if (body?.content === undefined) return gErr(c, 422, "content required");
    if (body.content.length > MAX_PAGE_BYTES) return gErr(c, 422, "page too large");

    const log = createLogger(c.env.LOG_LEVEL, {
      service: "WikiWrite",
      repoId: gate.route.doName,
    });
    const result = await landWikiEdit(c, {
      doName: gate.route.doName,
      slug,
      actor: gate.actor,
      req: {
        actions: [{ action: "UPDATE", path: pagePath(slug), payload: body.content }],
        message: body.message ?? `Update ${slug}`,
      },
      cacheCtx: gate.cacheCtx,
    });
    if (result.kind === "error") {
      log.warn("wiki:write-failed", { slug, reason: result.reason });
      return gErr(c, 422, result.reason);
    }
    log.info("wiki:page-landed", { slug, commitOid: result.commitOid });
    return c.json({ name: slug, commit_id: result.commitOid });
  });

  // DELETE /api/v1/repos/{ref}/wiki/{page} — remove a page in one commit.
  router.delete("/api/v1/repos/:repo_ref{.+}/wiki/:page", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const slug = pageSlug(c.req.param("page"));
    if (!slug) return gErr(c, 422, "invalid page name");
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };

    const log = createLogger(c.env.LOG_LEVEL, {
      service: "WikiWrite",
      repoId: gate.route.doName,
    });
    const result = await landWikiEdit(c, {
      doName: gate.route.doName,
      slug,
      actor: gate.actor,
      req: {
        actions: [{ action: "DELETE", path: pagePath(slug) }],
        message: body.message ?? `Delete ${slug}`,
      },
      cacheCtx: gate.cacheCtx,
    });
    if (result.kind === "error") {
      log.warn("wiki:delete-failed", { slug, reason: result.reason });
      return gErr(c, 422, result.reason);
    }
    log.info("wiki:page-deleted", { slug, commitOid: result.commitOid });
    return c.json({ name: slug, commit_id: result.commitOid });
  });
}

type WikiLandResult = { kind: "ok"; commitOid: string } | { kind: "error"; reason: string };

/**
 * Land a wiki edit as one commit on refs/heads/wiki. Two paths:
 *   - branch exists  → normal staged-pack + intent + attemptMerge lane
 *   - first page     → root commit, then commitMerge with a "" base CAS
 *                      creates the ref and closes the intent (attemptMerge
 *                      can't read a ZERO_OID base)
 */
async function landWikiEdit(
  c: Parameters<typeof requireWriter>[0],
  args: {
    doName: string;
    slug: string;
    actor: string;
    req: Parameters<typeof commitFileActions>[0]["req"];
    cacheCtx: Parameters<typeof resolveRef>[3];
  }
): Promise<WikiLandResult> {
  const { env } = c;
  const stub = getRepoStub(env, args.doName);
  const author = `${args.actor} <web@delta-git.invalid>`;

  const wikiOid = await resolveRef(env, args.doName, WIKI_REF, args.cacheCtx);
  const built = await commitFileActions({
    env,
    repoId: args.doName,
    baseCommitOid: wikiOid ?? undefined,
    req: args.req,
    author,
    cacheCtx: args.cacheCtx,
  });
  if (built.kind === "failed") return { kind: "error", reason: built.reason };

  const pack = await writeServerPack(built.objects);
  const packKey = r2PackKey(
    doPrefix(stub.id.toString()),
    `pack-wiki-${built.commitOid.slice(0, 12)}.pack`
  );
  await env.REPO_BUCKET.put(packKey, pack.packBytes);
  await env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);
  const stagedPack = {
    packKey,
    packBytes: pack.packBytes.length,
    idxBytes: pack.idxBytes.length,
    objectCount: pack.objectCount,
  };

  const accepted = await stub.acceptPatchCommit({
    targetRef: WIKI_REF,
    newOid: built.commitOid,
    actor: args.actor,
    kind: "wiki.web",
    stagedPack,
  });
  if (args.cacheCtx?.memo) {
    args.cacheCtx.memo.packCatalog = undefined;
    args.cacheCtx.memo.packCatalogPromise = undefined;
  }

  if (!wikiOid) {
    // First wiki page: nothing to merge — CAS "" against the missing ref.
    const committed = await stub.commitMerge({
      intentId: accepted.intent.id,
      expectedBaseOid: "",
      mergeOid: built.commitOid,
      stagedPack,
      actor: args.actor,
      method: "auto",
    });
    if (committed.status === "committed") return { kind: "ok", commitOid: built.commitOid };
    if (committed.status !== "base_moved") {
      return { kind: "error", reason: `wiki land failed: ${committed.status}` };
    }
    // Someone beat us to the first page — merge ours on top instead.
  }

  const merge = await attemptMerge({
    env,
    repoId: args.doName,
    stub,
    intentId: accepted.intent.id,
    actor: args.actor,
    cacheCtx: args.cacheCtx,
  });
  if (merge.kind === "conflict") {
    return { kind: "error", reason: `commit conflicts: ${merge.conflicts.join(", ")}` };
  }
  if (merge.kind === "skipped") {
    return { kind: "error", reason: `merge skipped: ${merge.reason}` };
  }
  if (merge.kind === "not_found") {
    return { kind: "error", reason: "merge intent vanished" };
  }
  const landed = merge.kind === "merged" ? merge.mergeOid : built.commitOid;
  return { kind: "ok", commitOid: landed };
}
