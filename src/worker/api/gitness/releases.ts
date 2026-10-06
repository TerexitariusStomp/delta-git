import type { AppRouter } from "@/worker/routes/hono";
import type { ReleaseAssetRow, ReleaseRow } from "@/worker/do/repo/db/schema";

import { createLogger } from "@/worker/common/logger";
import { getRepoStub } from "@/worker/common";
import { readCommitInfo, readLooseObjectRaw, resolveRef } from "@/worker/git/operations/read";
import type { CommitInfo } from "@/worker/git/operations/read/types";
import type { CacheContext } from "@/worker/cache";
import {
  emitRepoEvent,
  gErr,
  gNotFound,
  pageParams,
  paginate,
  requireWriter,
  resolveGitnessRepo,
  viewerCanWrite,
} from "./shared";

// GitHub Releases surface. Release rows live in the repo DO; asset bytes in
// R2 under `release-asset/{doName}/{uuid}` — the Worker writes/deletes R2
// directly (single hop), the DO only indexes the keys.

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
// Cap on commits scanned for auto notes — GitHub caps its generated
// changelog around a similar bound; deeper history still links the
// "Full Changelog" compare range.
const NOTES_COMMIT_CAP = 250;

const assetKey = (doName: string, name: string) =>
  `release-asset/${doName}/${crypto.randomUUID()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

// Conventional-commit prefix → section heading. `null` catches subjects
// without a parseable prefix. Order defines section order in the body.
const NOTE_SECTIONS: ReadonlyArray<{ kind: string | null; heading: string }> = [
  { kind: "breaking", heading: "Breaking Changes" },
  { kind: "feat", heading: "New Features" },
  { kind: "fix", heading: "Bug Fixes" },
  { kind: "perf", heading: "Performance" },
  { kind: "docs", heading: "Documentation" },
  { kind: "refactor", heading: "Maintenance" },
  { kind: "test", heading: "Maintenance" },
  { kind: "build", heading: "Maintenance" },
  { kind: "ci", heading: "Maintenance" },
  { kind: "chore", heading: "Maintenance" },
  { kind: null, heading: "Other Changes" },
];

function classifySubject(subject: string): { kind: string; title: string } {
  const m = subject.match(/^([a-zA-Z]+)(\([^)]*\))?(!)?:\s*(.+)$/);
  if (!m) return { kind: "other", title: subject };
  const type = m[1].toLowerCase();
  const breaking = m[3] === "!";
  if (breaking) return { kind: "breaking", title: m[4].trim() };
  const known = NOTE_SECTIONS.some((s) => s.kind === type);
  return { kind: known ? type : "other", title: m[4].trim() };
}

// GitHub generate-notes: walk first-parent from the new tag's commit back
// to the previous tag's commit (exclusive), bucket subjects by
// conventional-commit prefix, and render the "What's Changed" body.
async function generateReleaseNotesBody(
  env: Env,
  doName: string,
  tagName: string,
  previousTagName: string | undefined,
  targetCommitish: string | undefined,
  cacheCtx?: CacheContext
): Promise<{ body: string; prevTag: string | null } | undefined> {
  const headOid =
    (await resolveRef(env, doName, `refs/tags/${tagName}`, cacheCtx).catch(() => undefined)) ??
    (targetCommitish
      ? await resolveRef(env, doName, targetCommitish, cacheCtx).catch(() => undefined)
      : undefined);
  if (!headOid) return undefined;
  // A tag ref may point at an annotated-tag object — peel to the commit.
  let tip = headOid;
  const tipObj = await readLooseObjectRaw(env, doName, tip, cacheCtx).catch(() => null);
  if (tipObj?.type === "tag") {
    const m = new TextDecoder().decode(tipObj.payload).match(/^object ([0-9a-f]{40})/m);
    if (m) tip = m[1];
  } else if (!tipObj) {
    return undefined;
  }

  let prevTag: string | null = previousTagName ?? null;
  let prevOid: string | undefined;
  if (!prevTag) {
    const stub = getRepoStub(env, doName);
    const releases = await stub.listReleases({ includeDrafts: false });
    const prior = releases.find((r) => r.tagName !== tagName);
    prevTag = prior?.tagName ?? null;
  }
  if (prevTag) {
    prevOid = await resolveRef(env, doName, `refs/tags/${prevTag}`, cacheCtx).catch(
      () => undefined
    );
  }

  const buckets = new Map<string, string[]>();
  const contributors = new Set<string>();
  let oid: string | undefined = tip;
  let scanned = 0;
  while (oid && scanned < NOTES_COMMIT_CAP && oid !== prevOid) {
    const commit: CommitInfo | null = await readCommitInfo(env, doName, oid, cacheCtx).catch(
      () => null
    );
    if (!commit) break;
    scanned++;
    const subject = commit.message.split("\n", 1)[0].trim();
    if (subject && !subject.startsWith("Merge ")) {
      const { kind, title } = classifySubject(subject);
      const authorName = commit.author?.name?.trim() ?? "";
      const line = `* ${title} by @${authorName || "unknown"} in \`${oid.slice(0, 7)}\``;
      const list = buckets.get(kind) ?? [];
      list.push(line);
      buckets.set(kind, list);
      if (authorName) contributors.add(authorName);
    }
    oid = commit.parents[0];
  }

  const parts: string[] = ["## What's Changed", ""];
  for (const section of NOTE_SECTIONS) {
    const lines = section.kind === null ? buckets.get("other") : buckets.get(section.kind);
    if (!lines?.length) continue;
    parts.push(`### ${section.heading}`, ...lines, "");
  }
  if (contributors.size) {
    parts.push(`## Contributors`, ...Array.from(contributors).map((n) => `* @${n}`), "");
  }
  const base = prevOid ? prevTag : tip.slice(0, 7);
  parts.push(`**Full Changelog**: ${base}...${tagName}`);
  return { body: parts.join("\n").trimEnd() + "\n", prevTag };
}

function releaseJson(r: ReleaseRow, assets: ReleaseAssetRow[] = []) {
  return {
    id: r.id,
    tag_name: r.tagName,
    target_commitish: r.targetOid ?? null,
    name: r.name,
    body: r.body ?? null,
    draft: r.draft === 1,
    prerelease: r.prerelease === 1,
    author: { login: r.author },
    assets: assets.map(assetJson),
    created_at: new Date(r.createdAt).toISOString(),
    published_at: r.draft ? null : new Date(r.createdAt).toISOString(),
  };
}

function assetJson(a: ReleaseAssetRow) {
  return {
    id: a.id,
    name: a.name,
    content_type: a.contentType,
    size: a.size,
    download_count: a.downloadCount,
    uploader: { login: a.author },
    created_at: new Date(a.createdAt).toISOString(),
  };
}

export function registerGitnessReleases(router: AppRouter) {
  router.get("/api/v1/repos/:repo_ref{.+}/releases", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const canWrite = await viewerCanWrite(c, access);
    const stub = getRepoStub(c.env, access.route.doName);
    const releases = await stub.listReleases({ includeDrafts: canWrite });
    const page = pageParams(c);
    return c.json(
      paginate(
        releases.map((r) => releaseJson(r)),
        page
      )
    );
  });

  router.post("/api/v1/repos/:repo_ref{.+}/releases", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      tag_name?: string;
      target_commitish?: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      generate_release_notes?: boolean;
    } | null;
    if (!body?.tag_name?.trim()) return gErr(c, 422, "tag_name required");
    // Record the oid the tag currently points at, if the ref exists — a
    // release may predate its tag (GitHub creates it on publish).
    const targetOid = body.target_commitish
      ? ((await resolveRef(c.env, gate.route.doName, body.target_commitish, gate.cacheCtx).catch(
          () => undefined
        )) ?? null)
      : ((await resolveRef(
          c.env,
          gate.route.doName,
          `refs/tags/${body.tag_name}`,
          gate.cacheCtx
        ).catch(() => undefined)) ?? null);
    const stub = getRepoStub(c.env, gate.route.doName);
    // GitHub parity: generate_release_notes fills body when the caller
    // didn't supply one — categorized conventional-commit notes between
    // this tag and the prior release.
    let releaseBody = body.body ?? null;
    if (releaseBody === null && body.generate_release_notes) {
      const notes = await generateReleaseNotesBody(
        c.env,
        gate.route.doName,
        body.tag_name,
        undefined,
        body.target_commitish,
        gate.cacheCtx
      );
      releaseBody = notes?.body ?? null;
    }
    const result = await stub.createRelease({
      tagName: body.tag_name,
      name: body.name,
      body: releaseBody,
      draft: body.draft,
      prerelease: body.prerelease,
      targetOid,
      actor: gate.actor,
    });
    if (result.status === "exists") return c.json(releaseJson(result.release), 200);
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    emitRepoEvent(c, gate, "release", {
      action: result.release.draft === 1 ? "created" : "published",
      tag_name: body.tag_name,
      name: result.release.name,
      actor: gate.actor,
    });
    return c.json(releaseJson(result.release), 201);
  });

  // GitHub's POST /releases/generate-notes — categorized conventional-commit
  // changelog between this tag and the previous release's tag.
  router.post("/api/v1/repos/:repo_ref{.+}/releases/generate-notes", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      tag_name?: string;
      previous_tag_name?: string;
      target_commitish?: string;
    } | null;
    if (!body?.tag_name?.trim()) return gErr(c, 422, "tag_name required");
    const notes = await generateReleaseNotesBody(
      c.env,
      gate.route.doName,
      body.tag_name,
      body.previous_tag_name,
      body.target_commitish,
      gate.cacheCtx
    );
    if (!notes) return gNotFound(c, "tag");
    return c.json({ name: body.tag_name, body: notes.body });
  });

  router.get("/api/v1/repos/:repo_ref{.+}/releases/latest", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getLatestRelease();
    if (result.status !== "ok") return gNotFound(c, "release");
    return c.json(releaseJson(result.release, result.assets));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/releases/tags/:tag", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getReleaseByTag(c.req.param("tag"));
    if (result.status !== "ok") return gNotFound(c, "release");
    if (result.release.draft === 1 && !(await viewerCanWrite(c, access))) {
      return gNotFound(c, "release");
    }
    return c.json(releaseJson(result.release, result.assets));
  });

  router.get("/api/v1/repos/:repo_ref{.+}/releases/:id", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.getRelease(c.req.param("id"));
    if (result.status !== "ok") return gNotFound(c, "release");
    if (result.release.draft === 1 && !(await viewerCanWrite(c, access))) {
      return gNotFound(c, "release");
    }
    return c.json(releaseJson(result.release, result.assets));
  });

  router.patch("/api/v1/repos/:repo_ref{.+}/releases/:id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => null)) as {
      tag_name?: string;
      name?: string;
      body?: string | null;
      draft?: boolean;
      prerelease?: boolean;
    } | null;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.updateRelease({
      id: c.req.param("id"),
      patch: {
        tagName: body?.tag_name,
        name: body?.name,
        body: body?.body,
        draft: body?.draft,
        prerelease: body?.prerelease,
      },
      actor: gate.actor,
    });
    if (result.status === "not-found") return gNotFound(c, "release");
    if (result.status === "tag-taken") return gErr(c, 409, "tag already has a release");
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    // A draft→publish transition is GitHub's `released` action.
    emitRepoEvent(c, gate, "release", {
      action: body?.draft === false ? "released" : "edited",
      tag_name: result.release.tagName,
      name: result.release.name,
      actor: gate.actor,
    });
    return c.json(releaseJson(result.release));
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/releases/:id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.deleteRelease({ id: c.req.param("id"), actor: gate.actor });
    if (result.status !== "deleted") return gNotFound(c, "release");
    for (const key of result.r2Keys) {
      await c.env.REPO_BUCKET.delete(key).catch(() => {});
    }
    return c.json({ deleted: true });
  });

  // --- assets -----------------------------------------------------------------

  // POST /releases/:id/assets?name=file.zip — raw bytes → R2 → DO index row.
  router.post("/api/v1/repos/:repo_ref{.+}/releases/:id/assets", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const log = createLogger(c.env.LOG_LEVEL, {
      service: "ReleaseAsset",
      repoId: gate.route.doName,
    });
    const name = c.req.query("name") ?? "";
    const bytes = await c.req.arrayBuffer().catch(() => null);
    if (!bytes || bytes.byteLength === 0) return gErr(c, 422, "asset body required");
    if (bytes.byteLength > MAX_ASSET_BYTES) return gErr(c, 422, "asset too large");
    const r2Key = assetKey(gate.route.doName, name);
    await c.env.REPO_BUCKET.put(r2Key, bytes);
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.addReleaseAsset({
      releaseId: c.req.param("id"),
      name,
      contentType: c.req.header("content-type") ?? null,
      size: bytes.byteLength,
      r2Key,
      actor: gate.actor,
    });
    if (result.status === "not-found") {
      await c.env.REPO_BUCKET.delete(r2Key).catch(() => {});
      return gNotFound(c, "release");
    }
    if (result.status === "exists") {
      await c.env.REPO_BUCKET.delete(r2Key).catch(() => {});
      return c.json(assetJson(result.asset), 200);
    }
    if (result.status === "invalid") {
      await c.env.REPO_BUCKET.delete(r2Key).catch(() => {});
      log.warn("release:asset-rejected", { name, reason: result.reason });
      return gErr(c, 422, result.reason);
    }
    log.info("release:asset-uploaded", { name, size: bytes.byteLength });
    return c.json(assetJson(result.asset), 201);
  });

  // GET /releases/:id/assets/:asset_id — stream the R2 bytes.
  router.get("/api/v1/repos/:repo_ref{.+}/releases/:id/assets/:asset_id", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const stub = getRepoStub(c.env, access.route.doName);
    const result = await stub.releaseAssetForDownload({
      releaseId: c.req.param("id"),
      assetId: c.req.param("asset_id"),
    });
    if (result.status !== "ok") return gNotFound(c, "asset");
    const obj = await c.env.REPO_BUCKET.get(result.asset.r2Key);
    if (!obj) return gNotFound(c, "asset");
    const headers = new Headers({
      "content-type": result.asset.contentType,
      "content-length": String(result.asset.size),
      "content-disposition": `attachment; filename="${result.asset.name.replace(/"/g, "")}"`,
    });
    return new Response(obj.body, { headers });
  });

  router.delete("/api/v1/repos/:repo_ref{.+}/releases/:id/assets/:asset_id", async (c) => {
    const gate = await requireWriter(c);
    if (gate instanceof Response) return gate;
    const stub = getRepoStub(c.env, gate.route.doName);
    const result = await stub.deleteReleaseAsset({
      releaseId: c.req.param("id"),
      assetId: c.req.param("asset_id"),
      actor: gate.actor,
    });
    if (result.status !== "deleted") return gNotFound(c, "asset");
    await c.env.REPO_BUCKET.delete(result.r2Key).catch(() => {});
    return c.json({ deleted: true });
  });
}
