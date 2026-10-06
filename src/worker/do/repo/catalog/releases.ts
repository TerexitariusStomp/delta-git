import type { ReleaseAssetRow, ReleaseRow } from "../db/schema";

import { newPrefixedId } from "@/worker/common";
import { getDb } from "../db";
import {
  bumpAssetDownloadCount,
  deleteRelease,
  deleteReleaseAsset,
  getReleaseAsset,
  getReleaseById,
  getReleaseByTag,
  insertRelease,
  insertReleaseAsset,
  latestRelease,
  listReleaseAssets,
  listReleases,
  updateRelease,
} from "../db";
import { appendOpLogEntry } from "./oplog";

// Release state — metadata only. Asset bytes live in R2 under
// `release/{doName}/{assetId}` keys written and deleted Worker-side (the
// DO never touches R2 directly); the rows here are the index.

const MAX_TAG_LEN = 256;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

function validTag(tag: string | undefined): string | null {
  const t = tag?.trim();
  if (!t || t.length > MAX_TAG_LEN) return null;
  // Reject anything that couldn't be a ref tail or contains traversal.
  if (/[\s~^:?*[\]\\]|\.\./.test(t)) return null;
  return t;
}

export async function createReleaseState(args: {
  ctx: DurableObjectState;
  tagName: string;
  name?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  targetOid?: string | null;
  actor: string;
}): Promise<
  | { status: "created"; release: ReleaseRow }
  | { status: "exists"; release: ReleaseRow }
  | { status: "invalid"; reason: string }
> {
  const tag = validTag(args.tagName);
  if (!tag) return { status: "invalid", reason: "invalid tag name" };
  const db = getDb(args.ctx.storage);
  const existing = await getReleaseByTag(db, tag);
  if (existing) return { status: "exists", release: existing };
  const now = Date.now();
  const row: ReleaseRow = {
    id: newPrefixedId("rel"),
    tagName: tag,
    targetOid: args.targetOid ?? null,
    name: args.name?.trim() || tag,
    body: args.body ?? null,
    draft: args.draft ? 1 : 0,
    prerelease: args.prerelease ? 1 : 0,
    author: args.actor,
    createdAt: now,
    updatedAt: now,
  };
  await insertRelease(db, row);
  await appendOpLogEntry(
    db,
    {
      kind: "release.create",
      actor: args.actor,
      payload: { id: row.id, tag: row.tagName, draft: row.draft },
    },
    now
  );
  return { status: "created", release: row };
}

export async function listReleasesState(
  ctx: DurableObjectState,
  args: { includeDrafts?: boolean; limit?: number } = {}
): Promise<ReleaseRow[]> {
  const db = getDb(ctx.storage);
  return await listReleases(db, args);
}

export async function getReleaseState(
  ctx: DurableObjectState,
  id: string
): Promise<
  { status: "ok"; release: ReleaseRow; assets: ReleaseAssetRow[] } | { status: "not-found" }
> {
  const db = getDb(ctx.storage);
  const release = await getReleaseById(db, id);
  if (!release) return { status: "not-found" };
  return { status: "ok", release, assets: await listReleaseAssets(db, release.id) };
}

export async function getReleaseByTagState(
  ctx: DurableObjectState,
  tag: string
): Promise<
  { status: "ok"; release: ReleaseRow; assets: ReleaseAssetRow[] } | { status: "not-found" }
> {
  const db = getDb(ctx.storage);
  const release = await getReleaseByTag(db, tag);
  if (!release) return { status: "not-found" };
  return { status: "ok", release, assets: await listReleaseAssets(db, release.id) };
}

export async function latestReleaseState(
  ctx: DurableObjectState
): Promise<
  { status: "ok"; release: ReleaseRow; assets: ReleaseAssetRow[] } | { status: "not-found" }
> {
  const db = getDb(ctx.storage);
  const release = await latestRelease(db);
  if (!release) return { status: "not-found" };
  return { status: "ok", release, assets: await listReleaseAssets(db, release.id) };
}

export async function updateReleaseState(args: {
  ctx: DurableObjectState;
  id: string;
  patch: {
    tagName?: string;
    name?: string;
    body?: string | null;
    draft?: boolean;
    prerelease?: boolean;
    targetOid?: string | null;
  };
  actor: string;
}): Promise<
  | { status: "updated"; release: ReleaseRow }
  | { status: "not-found" }
  | { status: "invalid"; reason: string }
  | { status: "tag-taken" }
> {
  const db = getDb(args.ctx.storage);
  const release = await getReleaseById(db, args.id);
  if (!release) return { status: "not-found" };
  const next: Partial<ReleaseRow> = { updatedAt: Date.now() };
  if (args.patch.tagName !== undefined) {
    const tag = validTag(args.patch.tagName);
    if (!tag) return { status: "invalid", reason: "invalid tag name" };
    const taken = await getReleaseByTag(db, tag);
    if (taken && taken.id !== release.id) return { status: "tag-taken" };
    next.tagName = tag;
  }
  if (args.patch.name !== undefined) {
    const name = args.patch.name.trim();
    if (!name) return { status: "invalid", reason: "name required" };
    next.name = name;
  }
  if (args.patch.body !== undefined) next.body = args.patch.body;
  if (args.patch.draft !== undefined) next.draft = args.patch.draft ? 1 : 0;
  if (args.patch.prerelease !== undefined) next.prerelease = args.patch.prerelease ? 1 : 0;
  if (args.patch.targetOid !== undefined) next.targetOid = args.patch.targetOid;
  await updateRelease(db, release.id, next);
  await appendOpLogEntry(
    db,
    {
      kind: "release.update",
      actor: args.actor,
      payload: { id: release.id, fields: Object.keys(args.patch) },
    },
    Date.now()
  );
  const updated = (await getReleaseById(db, release.id))!;
  return { status: "updated", release: updated };
}

/** Removes the release row; the caller deletes the returned R2 keys. */
export async function deleteReleaseState(args: {
  ctx: DurableObjectState;
  id: string;
  actor: string;
}): Promise<{ status: "deleted"; r2Keys: string[] } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const release = await getReleaseById(db, args.id);
  if (!release) return { status: "not-found" };
  const assets = await listReleaseAssets(db, release.id);
  await deleteRelease(db, release.id);
  await appendOpLogEntry(
    db,
    {
      kind: "release.delete",
      actor: args.actor,
      payload: { id: release.id, tag: release.tagName, assets: assets.length },
    },
    Date.now()
  );
  return { status: "deleted", r2Keys: assets.map((a) => a.r2Key) };
}

// --- assets ------------------------------------------------------------------

/** Register an asset whose bytes the Worker already wrote to `r2Key`. */
export async function addReleaseAssetState(args: {
  ctx: DurableObjectState;
  releaseId: string;
  name: string;
  contentType: string | null;
  size: number;
  r2Key: string;
  actor: string;
}): Promise<
  | { status: "created"; asset: ReleaseAssetRow }
  | { status: "not-found" }
  | { status: "exists"; asset: ReleaseAssetRow }
  | { status: "invalid"; reason: string }
> {
  const name = args.name.trim();
  if (!name || name.length > 128 || /[/\\]/.test(name)) {
    return { status: "invalid", reason: "invalid asset name" };
  }
  if (args.size < 0 || args.size > MAX_ASSET_BYTES) {
    return { status: "invalid", reason: "invalid asset size" };
  }
  const db = getDb(args.ctx.storage);
  const release = await getReleaseById(db, args.releaseId);
  if (!release) return { status: "not-found" };
  const existing = (await listReleaseAssets(db, release.id)).find((a) => a.name === name);
  if (existing) return { status: "exists", asset: existing };
  const row: ReleaseAssetRow = {
    id: newPrefixedId("ast"),
    releaseId: release.id,
    name,
    contentType: args.contentType ?? "application/octet-stream",
    size: args.size,
    r2Key: args.r2Key,
    downloadCount: 0,
    author: args.actor,
    createdAt: Date.now(),
  };
  await insertReleaseAsset(db, row);
  return { status: "created", asset: row };
}

/** Bump the download counter and hand back the asset's R2 key. */
export async function releaseAssetForDownloadState(args: {
  ctx: DurableObjectState;
  releaseId: string;
  assetId: string;
}): Promise<{ status: "ok"; asset: ReleaseAssetRow } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const release = await getReleaseById(db, args.releaseId);
  if (!release) return { status: "not-found" };
  const asset = await getReleaseAsset(db, args.assetId);
  if (!asset || asset.releaseId !== release.id) return { status: "not-found" };
  await bumpAssetDownloadCount(db, asset.id);
  return { status: "ok", asset };
}

export async function deleteReleaseAssetState(args: {
  ctx: DurableObjectState;
  releaseId: string;
  assetId: string;
  actor: string;
}): Promise<{ status: "deleted"; r2Key: string } | { status: "not-found" }> {
  const db = getDb(args.ctx.storage);
  const release = await getReleaseById(db, args.releaseId);
  if (!release) return { status: "not-found" };
  const asset = await getReleaseAsset(db, args.assetId);
  if (!asset || asset.releaseId !== release.id) return { status: "not-found" };
  await deleteReleaseAsset(db, asset.id);
  return { status: "deleted", r2Key: asset.r2Key };
}
