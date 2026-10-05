import type { AppRouter } from "./hono";
import type { CacheContext } from "@/worker/cache";

import { getRepoStub } from "@/worker/common";
import { readObject } from "@/worker/git/object-store/store";
import { resolveRepositoryRoute, type RepositoryRoute } from "@/worker/repositories/route";
import { authenticateGitRequest, getBasicCredentials } from "@/worker/auth/gitAuth";
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

const te = new TextEncoder();
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

function octal(n: number, width: number): Uint8Array {
  const s = n.toString(8).padStart(width - 1, "0") + "\0";
  return te.encode(s);
}

function writeField(buf: Uint8Array, offset: number, bytes: Uint8Array, max: number) {
  buf.set(bytes.subarray(0, max), offset);
}

// One 512-byte ustar header. Long names/links get GNU "L"/"K" longname
// entries emitted by the caller; this writer just truncates to fit.
function tarHeader(
  name: string,
  mode: number,
  size: number,
  mtime: number,
  typeflag: string,
  linkname: string
): Uint8Array {
  const h = new Uint8Array(512);
  writeField(h, 0, te.encode(name), 100);
  h.set(octal(mode, 8), 100);
  h.set(octal(0, 8), 108); // uid
  h.set(octal(0, 8), 116); // gid
  h.set(octal(size, 12), 124);
  h.set(octal(mtime, 12), 136);
  h.set(te.encode("        "), 148); // checksum field is 8 spaces during sum
  writeField(h, 156, te.encode(typeflag), 1);
  writeField(h, 157, te.encode(linkname), 100);
  writeField(h, 257, te.encode("ustar\0"), 6);
  writeField(h, 263, te.encode("00"), 2);
  writeField(h, 265, te.encode("git"), 32);
  writeField(h, 297, te.encode("git"), 32);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(te.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

function pad512(len: number): number {
  return (512 - (len % 512)) % 512;
}

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
    const env = c.env;
    const cacheCtx = c.var.cacheCtx;
    let bytesOut = 0;

    // Lazily emit headers + blob bodies so the worker holds at most one
    // payload at a time. Errors mid-stream truncate the response — a partial
    // tar fails closed on the consumer's integrity checks either way.
    const pump = (async function* (): AsyncGenerator<Uint8Array> {
      for (const f of entries) {
        const nameBytes = te.encode(f.path);
        const linkBytes = te.encode(f.linkname ?? "");
        if (linkBytes.length > 100) {
          // GNU longlink entry then a header whose linkname is truncated.
          yield tarHeader("././@LongLink", 0, linkBytes.length, mtime, "K", "");
          yield linkBytes;
          yield new Uint8Array(pad512(linkBytes.length));
        }
        if (nameBytes.length > 100) {
          yield tarHeader("././@LongLink", 0, nameBytes.length, mtime, "L", "");
          yield nameBytes;
          yield new Uint8Array(pad512(nameBytes.length));
        }
        if (f.type === "file" && f.oid) {
          const blob = await readObject(env, route.doName, f.oid, cacheCtx);
          if (!blob || blob.type !== "blob") continue;
          const size = blob.payload.length;
          bytesOut += size;
          if (bytesOut > MAX_BYTES) {
            log.warn("archive:byte-cap-exceeded", { repoId: route.doName, ref, cap: MAX_BYTES });
            throw new Error("archive byte cap exceeded");
          }
          yield tarHeader(f.path, f.mode, size, mtime, "0", "");
          yield blob.payload;
          yield new Uint8Array(pad512(size));
        } else {
          yield tarHeader(
            f.path,
            f.mode,
            f.type === "symlink" ? 0 : 0,
            mtime,
            f.type === "dir" ? "5" : "2",
            (f.linkname ?? "").slice(0, 100)
          );
        }
      }
    })();

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await pump.next();
        if (next.done) {
          controller.enqueue(new Uint8Array(1024)); // tar end-of-archive marker
          controller.close();
          log.info("archive:stream-complete", { repoId: route.doName, ref, commitOid, bytesOut });
          return;
        }
        controller.enqueue(next.value);
      },
      cancel() {
        // Consumer disconnected — let the generator finish early.
        void pump.return(undefined);
      },
    });

    log.debug("archive:stream-start", { repoId: route.doName, ref, commitOid, files: entries.length });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${route.routeRepoSlug}-${ref.replaceAll("/", "-")}.tar"`,
        "X-Archive-Commit": commitOid,
        "Cache-Control": /^[0-9a-f]{40}$/.test(commitOid) ? "public, max-age=31536000, immutable" : "no-store",
      },
    });
  });
}
