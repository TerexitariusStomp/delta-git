import type { AppRouter } from "./hono";
import type { CacheContext } from "@/worker/cache";

import { getRepoStub } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute, type RepositoryRoute } from "@/worker/repositories/route";
import { authenticateGitRequest, getBasicCredentials } from "@/worker/auth/gitAuth";
import { createTarPacker } from "modern-tar";
import { isValidOwnerRepo } from "@/shared/web";
import { isTreeMode, parseTree } from "@/worker/merge/tree";
import { parseCommitText, parseTagTarget } from "@/worker/git/core";

// Repository archive export — the seam that makes forge-hosted repos deployable
// by downstream consumers (wp-cloud sites, CI, mirrors).
//
//   GET /:owner/:repo/-/archive/<ref>.tar
//
// `<ref>` may be a branch name (slashes allowed), tag, or 40-hex commit sha.
// The response is an uncompressed POSIX/ustar stream of the commit's full
// tree, emitted lazily so memory stays flat regardless of archive size.

const td = new TextDecoder();

const MAX_FILES = 5_000;
const MAX_BYTES = 200 * 1024 * 1024;
const GIT_BASIC_REALM = 'Basic realm="git", charset="UTF-8"';

function basicChallenge(): Response {
  return new Response("Authentication required\n", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": GIT_BASIC_REALM,
      "Cache-Control": "no-store",
    },
  });
}

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---- tar ----
//
// The archive is emitted as a POSIX ustar stream via modern-tar — the
// packer handles octal/checksum fields, the ustar 155/100 prefix split for
// long paths, and PAX `linkpath` records for >100-byte symlink targets.

type TarFile = {
  /** Path relative to repo root, forward slashes, no leading slash. */
  path: string;
  /** POSIX mode bits derived from the git tree mode. */
  mode: number;
  /** Blob oid for regular files; link target text for symlinks. */
  oid?: string;
  linkname?: string;
  type: "file" | "dir" | "symlink";
};

// ---- tree walk ----

// Flatten the commit's tree into a tar file list. Tree objects are small so
// this pre-pass is bounded work (unlike blob bodies, which stream lazily).
// Returns null when the file cap is exceeded.
async function collectEntries(
  env: Env,
  doName: string,
  rootTreeOid: string,
  cacheCtx: CacheContext | undefined
): Promise<TarFile[] | null> {
  const files: TarFile[] = [];
  // DFS stack of [treeOid, pathPrefix].
  const stack: [string, string][] = [[rootTreeOid, ""]];
  while (stack.length) {
    const [treeOid, prefix] = stack.pop()!;
    const tree = await readObject(env, doName, treeOid, cacheCtx);
    if (!tree || tree.type !== "tree") continue;
    for (const entry of parseTree(tree.payload).values()) {
      const path = prefix + entry.name;
      if (isTreeMode(entry.mode)) {
        files.push({ path: `${path}/`, mode: 0o755, type: "dir" });
        stack.push([entry.oid, `${path}/`]);
      } else if (entry.mode === "120000") {
        // Symlink target is stored as the blob content.
        const blob = await readObject(env, doName, entry.oid, cacheCtx);
        if (blob?.type === "blob") {
          files.push({ path, mode: 0o777, type: "symlink", linkname: td.decode(blob.payload) });
        }
      } else if (entry.mode === "160000") {
        // Submodule — gitlink has no content in this repo; skip it rather
        // than emitting a bogus empty file.
        continue;
      } else {
        if (files.length >= MAX_FILES) return null;
        files.push({
          path,
          mode: entry.mode === "100755" ? 0o755 : 0o644,
          type: "file",
          oid: entry.oid,
        });
      }
    }
  }
  return files;
}

// ---- ref resolution ----

// ref may be "main", "feature/x", "v1.0" (tag), or a 40-hex oid. Tags peel
// through to their commit target.
async function resolveRefToCommit(
  env: Env,
  route: RepositoryRoute,
  ref: string,
  cacheCtx: CacheContext | undefined
): Promise<string | undefined> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const stub = getRepoStub(env, route.doName);
  const { refs } = await stub.getHeadAndRefs();
  let oid =
    refs.find((r) => r.name === `refs/heads/${ref}`)?.oid ??
    refs.find((r) => r.name === `refs/tags/${ref}`)?.oid ??
    // Default-branch convenience: no exact match and ref looks like a branch
    // stem → fall back to the repo's HEAD target.
    (ref === "HEAD" ? refs.find((r) => r.name === "refs/heads/main")?.oid : undefined);
  // Peel annotated tags (bounded — tag-of-tag chains are rare).
  for (let i = 0; i < 4 && oid; i++) {
    const obj = await readObject(env, route.doName, oid, cacheCtx);
    if (obj?.type !== "tag") break;
    const target = parseTagTarget(obj.payload);
    if (!target) return undefined;
    oid = target.targetOid;
  }
  return oid;
}

// ---- route ----

export function registerArchiveRoutes(router: AppRouter): void {
  // Lightweight ref→commit resolution for consumers that poll (wp-cloud's
  // forge-sync cron) — archive fetch does the same resolution but streams a
  // whole tar; HEAD would still pay the tree walk.
  router.get("/:owner/:repo/-/resolve/*", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return notFound();
    const ref = decodeURIComponent(c.req.path.split(`/${owner}/${repo}/-/resolve/`)[1] ?? "");
    if (!ref) return notFound();
    const route = await resolveRepositoryRoute(c.env, owner, repo, {
      mode: getBasicCredentials(c.req.raw) ? "allow-d1-fallback" : "route-cache-only",
      db: c.var.db,
      log: c.var.logFor({ service: "Archive" }),
    });
    if (!route) return notFound();
    if (route.visibility !== "public") {
      const auth = await authenticateGitRequest(c.env, c.req.raw, route, { db: c.var.db });
      if (auth.kind !== "pat") {
        return auth.kind === "anonymous" ? notFound() : basicChallenge();
      }
    }
    const commitOid = await resolveRefToCommit(c.env, route, ref, c.var.cacheCtx);
    if (!commitOid) return notFound();
    return c.json({ commit: commitOid });
  });

  router.get("/:owner/:repo/-/archive/*", async (c) => {
    const log = c.var.logFor({ service: "Archive" });
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return notFound();

    const wildcard = c.req.path.split(`/${owner}/${repo}/-/archive/`)[1];
    if (!wildcard) return notFound();
    const ref = decodeURIComponent(wildcard.replace(/\.tar$/, ""));
    if (!ref) return notFound();

    // Credentialed callers may fall back to D1 (same rule as the git routes);
    // anonymous scans resolve only from the KV route cache.
    const route = await resolveRepositoryRoute(c.env, owner, repo, {
      mode: getBasicCredentials(c.req.raw) ? "allow-d1-fallback" : "route-cache-only",
      db: c.var.db,
      log,
    });
    if (!route) return notFound();

    // Public repos serve anonymously; private repos take the same PAT gate as
    // git read operations (401 challenge → PAT → ok, anonymous → 404 so the
    // private namespace isn't enumerable).
    if (route.visibility !== "public") {
      const auth = await authenticateGitRequest(c.env, c.req.raw, route, { db: c.var.db });
      if (auth.kind !== "pat") {
        return auth.kind === "anonymous" ? notFound() : basicChallenge();
      }
    }

    const commitOid = await resolveRefToCommit(c.env, route, ref, c.var.cacheCtx);
    if (!commitOid) return notFound();
    const commitObj = await readObject(c.env, route.doName, commitOid, c.var.cacheCtx);
    if (!commitObj || commitObj.type !== "commit") return notFound();
    const commit = parseCommitText(td.decode(commitObj.payload));

    const entries = await collectEntries(c.env, route.doName, commit.tree, c.var.cacheCtx);
    if (!entries) {
      log.warn("archive:file-cap-exceeded", { repoId: route.doName, ref, cap: MAX_FILES });
      return c.text("archive too large", 413);
    }

    const mtime = commit.committer?.when ?? commit.author?.when ?? Math.floor(Date.now() / 1000);
    const mtimeDate = new Date(mtime * 1000);
    const env = c.env;
    const cacheCtx = c.var.cacheCtx;
    let bytesOut = 0;

    // Lazily emit entries so the worker holds at most one blob payload at a
    // time. Errors mid-stream cancel the readable — a partial tar fails
    // closed on the consumer's integrity checks either way.
    const { readable, controller: tar } = createTarPacker();
    const pump = (async () => {
      for (const f of entries) {
        if (f.type === "file" && f.oid) {
          const blob = await readObject(env, route.doName, f.oid, cacheCtx);
          if (!blob || blob.type !== "blob") continue;
          const size = blob.payload.length;
          bytesOut += size;
          if (bytesOut > MAX_BYTES) {
            log.warn("archive:byte-cap-exceeded", { repoId: route.doName, ref, cap: MAX_BYTES });
            throw new Error("archive byte cap exceeded");
          }
          const body = tar.add({
            name: f.path,
            size,
            mtime: mtimeDate,
            mode: f.mode,
            type: "file",
            uid: 0,
            gid: 0,
            uname: "git",
            gname: "git",
          });
          const writer = body.getWriter();
          await writer.write(blob.payload);
          await writer.close();
        } else {
          const body = tar.add({
            name: f.path,
            size: 0,
            mtime: mtimeDate,
            mode: f.mode,
            type: f.type === "dir" ? "directory" : "symlink",
            uid: 0,
            gid: 0,
            uname: "git",
            gname: "git",
            linkname: f.type === "symlink" ? f.linkname : undefined,
          });
          await body.getWriter().close();
        }
      }
      tar.finalize();
      log.info("archive:stream-complete", { repoId: route.doName, ref, commitOid, bytesOut });
    })();
    pump.catch((err: unknown) => {
      log.warn("archive:pump-failed", {
        repoId: route.doName,
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
      void readable.cancel(err);
    });

    log.debug("archive:stream-start", {
      repoId: route.doName,
      ref,
      commitOid,
      files: entries.length,
    });
    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${route.routeRepoSlug}-${ref.replaceAll("/", "-")}.tar"`,
        "X-Archive-Commit": commitOid,
        "Cache-Control": /^[0-9a-f]{40}$/.test(commitOid)
          ? "public, max-age=31536000, immutable"
          : "no-store",
      },
    });
  });
}
