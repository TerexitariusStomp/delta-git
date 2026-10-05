import type { HeadInfo, Ref } from "@/worker/git";
import { readPath } from "@/worker/git";
import { classifyRef, formatRefOption, shortRefName } from "@/shared/git/ref-display";
import { isValidOwnerRepo, bytesToText } from "@/shared/web";
import { buildCacheKeyFrom, cacheOrLoadJSONForRequest } from "@/worker/cache";
import { findNamespaceByOwnerDid, findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { findIdentityByHandle } from "@/worker/db/d1/dal/identities";
import {
  findRepositoryByDoName,
  listRepositoriesForNamespace,
} from "@/worker/db/d1/dal/repositories";
import { getRepoStub } from "@/worker/common/stub";
import { loadViewer } from "@/worker/auth/session";
import {
  badRequest,
  loadHeadAndRefsCached,
  loadUiRepoActivity,
  notFound,
  resolveUiRepoAccess,
} from "./helpers";
import type { AppContext } from "../hono";
import { renderUiDocumentResponse } from "../uiResponse";
import {
  resolveRef,
  readCommitInfo,
  isTreeMode,
  isSymlinkMode,
  listPathsLastChange,
} from "@/worker/git";
import { getFileIconName } from "@/shared/web";
import type { FileRow } from "@/client/components/file-table";

export async function handleOwnerOverview(c: AppContext<"/:owner">) {
  const env = c.env;
  const owner = c.req.param("owner");
  if (!isValidOwnerRepo(owner)) {
    return badRequest(env, "Invalid owner", "Owner contains invalid characters or length");
  }
  const db = c.var.db;
  let namespace = await findNamespaceBySlug(db, owner);
  if (!namespace && owner.includes(".")) {
    // Handle URLs: /alice.bsky.social resolves through the DID identity's
    // claimed namespace and redirects to the canonical slug URL.
    const identity = await findIdentityByHandle(db, owner.toLowerCase());
    if (identity) {
      namespace = await findNamespaceByOwnerDid(db, identity.did);
      if (namespace) {
        return c.redirect(`/${namespace.slug}`, 302);
      }
    }
  }
  if (!namespace) {
    // Namespace rows are the owner-listing authority.
    return await notFound(c);
  }
  const viewer = await loadViewer(c);
  const repos = await listRepositoriesForNamespace(db, namespace.id, viewer?.userId ?? null);
  const includesPrivate = repos.some((row) => row.visibility === "private");
  return renderUiDocumentResponse(
    env,
    "owner",
    {
      title: `${owner} · Repositories`,
      owner,
      repos: repos.map((row) => ({
        slug: row.slug,
        visibility: row.visibility,
        description: row.description ?? undefined,
      })),
    },
    {
      // Public-only listings cache briefly per-colo. As soon as a private
      // row enters the response, we must not cache (membership-derived).
      cacheControl: includesPrivate ? "no-store" : "public, max-age=60",
      failureBody: "Failed to render view",
      viewer,
    }
  );
}

type MirrorTarget = { name: string; url: string };

export function parseMirrorTargets(raw: string | null): MirrorTarget[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is MirrorTarget => typeof m?.name === "string" && typeof m?.url === "string"
    );
  } catch {
    return [];
  }
}

/** `rad:<rid>` → browsable Radicle gateway URL; other URLs pass through. */
export function radicleGatewayUrl(url: string): string {
  if (url.startsWith("rad:")) {
    return `https://app.radicle.xyz/nodes/seed.radicle.xyz/${url}`;
  }
  return url;
}

export async function handleRepoOverview(c: AppContext<"/:owner/:repo">) {
  const env = c.env;
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const access = await resolveUiRepoAccess(c, owner, repo);
  if (access.kind === "response" && owner.includes(".")) {
    // Handle URLs: /alice.bsky.social/repo → canonical /slug/repo.
    const identity = await findIdentityByHandle(c.var.db, owner.toLowerCase());
    const namespace = identity ? await findNamespaceByOwnerDid(c.var.db, identity.did) : undefined;
    if (namespace) {
      return c.redirect(`/${namespace.slug}/${repo}`, 302);
    }
    return access.response;
  }
  if (access.kind === "response") return access.response;
  const { route, cacheCtx, viewer } = access;
  const repoId = route.doName;

  const refsData = await loadHeadAndRefsCached(env, cacheCtx, repoId);
  const head: HeadInfo | undefined = refsData?.head;
  const refs: Ref[] = refsData?.refs || [];

  const defaultRef = head?.target || (refs[0]?.name ?? "refs/heads/main");
  const refShort = shortRefName(defaultRef);
  const refEnc = encodeURIComponent(refShort);
  const branchesData = refs
    .filter((ref) => classifyRef(ref.name) === "branch")
    .map(formatRefOption);
  const tagsData = refs.filter((ref) => classifyRef(ref.name) === "tag").map(formatRefOption);

  const readReadme = async (): Promise<{ md: string } | null> => {
    try {
      const candidates = ["README.md", "README.MD", "Readme.md", "README", "readme.md"];
      const results = await Promise.all(
        candidates.map(async (name) => {
          try {
            const res = await readPath(env, repoId, refShort, name, cacheCtx);
            if (res.type === "blob") {
              return { name, content: res.content };
            }
          } catch {}
          return null;
        })
      );
      const found = results.find((r) => r !== null) as {
        name: string;
        content: Uint8Array;
      } | null;
      if (!found) return null;
      const text = bytesToText(found.content);
      return { md: text };
    } catch {
      return null;
    }
  };

  const cacheKeyReadme = buildCacheKeyFrom(c.req.raw, "/_cache/readme", {
    repo: repoId,
    ref: refShort,
  });
  const readmeData = await cacheOrLoadJSONForRequest<{ md: string }>(
    cacheCtx,
    cacheKeyReadme,
    readReadme,
    300
  );
  const readmeMd = readmeData?.md || "";
  const progress = await loadUiRepoActivity(env, access);

  // Plain-language surface: federation identity (repo DID, rad: RID) plus the
  // newest open ideas, so non-coders see "what people are asking for" before
  // the file browser.
  const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
  const mirrors = parseMirrorTargets(repoRow?.mirrorTargets ?? null);
  const radTarget = mirrors.find((m) => m.url.startsWith("rad:") || m.name === "radicle");
  const stub = getRepoStub(env, route.doName);
  const allIdeas = await stub.listWorkIntentsByKind("idea").catch(() => []);
  const openIdeas = allIdeas.filter((row) => row.status === "open" || row.status === "claimed");
  const ideas = openIdeas
    .slice(0, 5)
    .map((row) => ({ id: row.id, title: row.title, status: row.status }));

  // Code-tab data: root tree rows with per-path last-change info, plus the
  // head commit for the table header bar. Bounded + cached per head OID.
  const rootEntries = await readPath(env, repoId, refShort, "", cacheCtx)
    .then((r) => (r.type === "tree" ? r.entries : []))
    .catch(() => []);
  const headOid = await resolveRef(env, repoId, refShort, cacheCtx).catch(() => undefined);
  const headCommitInfo = headOid
    ? await readCommitInfo(env, repoId, headOid, cacheCtx).catch(() => null)
    : null;
  const headCommit = headCommitInfo
    ? {
        oid: headCommitInfo.oid,
        subject: headCommitInfo.message.split("\n", 1)[0] ?? "",
        when: headCommitInfo.author?.when ?? headCommitInfo.committer?.when ?? 0,
        author: headCommitInfo.author?.name ?? headCommitInfo.committer?.name,
      }
    : null;
  const wanted = rootEntries.map((e) => ({
    name: e.name,
    isDir: isTreeMode(e.mode),
  }));
  const lastChange = await listPathsLastChange(env, repoId, refShort, "", wanted, cacheCtx);
  const fileRows: FileRow[] = [...rootEntries]
    .sort((a, b) => {
      const aDir = isTreeMode(a.mode);
      const bDir = isTreeMode(b.mode);
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => {
      const isDir = isTreeMode(e.mode);
      const isSymlink = isSymlinkMode(e.mode);
      return {
        name: e.name,
        href: isDir
          ? `/${owner}/${repo}/tree?ref=${refEnc}&path=${encodeURIComponent(e.name)}`
          : `/${owner}/${repo}/blob?ref=${refEnc}&path=${encodeURIComponent(e.name)}`,
        isDir,
        isSymlink,
        iconName: isSymlink ? "symlink" : isDir ? "folder" : getFileIconName(e.name),
        shortOid: e.oid ? e.oid.slice(0, 7) : "",
        lastChange: lastChange?.entries[e.name],
      };
    });
  // SPDX-style license detection matching GitHub's About sidebar chip.
  const licenseFile = rootEntries.find(
    (e) => !isTreeMode(e.mode) && /^(licen[sc]e|copying)/i.test(e.name)
  )?.name;

  return renderUiDocumentResponse(
    env,
    "overview",
    {
      title: `${owner}/${repo}`,
      owner,
      repo,
      refShort,
      refEnc,
      branches: branchesData,
      tags: tagsData,
      readmeMd,
      progress,
      repoDid: repoRow?.did ?? undefined,
      radicleUrl: radTarget ? radicleGatewayUrl(radTarget.url) : undefined,
      ideas,
      visibility: route.visibility,
      description: repoRow?.description ?? "",
      arena: route.backend === "artifacts",
      headCommit: headCommit ?? undefined,
      commitCount: lastChange?.commitCount,
      fileRows,
      cloneUrl: `${new URL(c.req.url).origin}/${owner}/${repo}`,
      licenseFile,
      counts: {
        branches: branchesData.length,
        tags: tagsData.length,
        ideas: openIdeas.length,
      },
    },
    {
      cacheControl: route.visibility === "private" ? "no-store" : undefined,
      failureBody: "Failed to render view",
      viewer,
    }
  );
}
