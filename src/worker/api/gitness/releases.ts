import type { AppRouter } from "@/worker/routes/hono";
import type { ReleaseAssetRow, ReleaseRow } from "@/worker/do/repo/db/schema";

import { createLogger } from "@/worker/common/logger";
import { getRepoStub } from "@/worker/common";
import { resolveRef } from "@/worker/git/operations/read";
import {
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

const assetKey = (doName: string, name: string) =>
  `release-asset/${doName}/${crypto.randomUUID()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

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
    const result = await stub.createRelease({
      tagName: body.tag_name,
      name: body.name,
      body: body.body ?? null,
      draft: body.draft,
      prerelease: body.prerelease,
      targetOid,
      actor: gate.actor,
    });
    if (result.status === "exists") return c.json(releaseJson(result.release), 200);
    if (result.status === "invalid") return gErr(c, 422, result.reason);
    return c.json(releaseJson(result.release), 201);
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
