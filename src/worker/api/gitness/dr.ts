// Disaster recovery — portable bundle exports, integrity drills, downloads.
//
// Export writes a standard git bundle v3 (same bytes the bundle-uri route
// serves — a full-clone pack + ref header) to R2 under do/<id>/dr/, plus a
// JSON manifest with the ref snapshot. Restore is deliberately standard:
// `git clone <bundle>` or `git bundle unbundle` works anywhere, no custom
// replay tooling to trust in a crisis.
//
// Drill verifies recoverability without mutating state: it reads the stored
// bundle back, checks the v3 header + ref set against live DO refs, parses
// the PACK header object count, and verifies the pack's SHA-1 trailer.

import type { AppRouter } from "@/worker/routes/hono";
import { getRepoStub } from "@/worker/common";
import { getHeadAndRefs } from "@/worker/git/operations/read";
import { buildBundleStream } from "@/worker/git/operations/bundle";
import { ingestPackIntoRepo } from "@/worker/agent/importer";
import { doPrefix } from "@/worker/keys";
import {
  gErr,
  gNotFound,
  requireWriter,
  resolveGitnessRepo,
  type GitnessContext,
  type RepoAccessOk,
} from "./shared";

const BUNDLE_MAGIC = "GIT BUNDLE V3\n";
const PACK_MAGIC = "PACK";
// Drill reads the bundle into memory to hash it; beyond this we still check
// header + refs (the cheap half) but skip the SHA trailer verification.
const MAX_DRILL_BYTES = 256 * 1024 * 1024;
// R2 put requires known-length bodies, so the export buffers the bundle;
// the cap keeps a pathological repo from OOMing the export request. Larger
// repos still export via the /bundle route — this caps the *stored* path.
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

interface DrManifest {
  format: "git-bundle-v3";
  exportedAt: number;
  exportedBy: string;
  bundleKey: string;
  bundleBytes: number;
  refs: { name: string; oid: string }[];
  head: { target: string; oid?: string } | null;
}

function drPrefix(doId: string): string {
  return `${doPrefix(doId)}/dr`;
}

function doId(c: GitnessContext, access: RepoAccessOk): string {
  return getRepoStub(c.env, access.route.doName).id.toString();
}

/** Drain a stream into one buffer, aborting past `cap` total bytes. */
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  prefix: Uint8Array,
  cap: number
): Promise<Uint8Array | "too_big"> {
  const parts: Uint8Array[] = [prefix];
  let total = prefix.length;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) return "too_big";
      parts.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function readManifest(
  env: Env,
  doIdStr: string
): Promise<(DrManifest & { manifestKey: string }) | null> {
  const listed = await env.REPO_BUCKET.list({ prefix: `${drPrefix(doIdStr)}/manifest-` });
  const latest = listed.objects.sort((a, b) => b.key.localeCompare(a.key))[0];
  if (!latest) return null;
  const obj = await env.REPO_BUCKET.get(latest.key);
  if (!obj) return null;
  const manifest = (await obj.json()) as DrManifest;
  return { ...manifest, manifestKey: latest.key };
}

export function registerGitnessRepoDr(router: AppRouter) {
  // --- export: snapshot → R2 ------------------------------------------------
  router.post("/api/v1/repos/:repo_ref{.+}/dr/export", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const log = c.var.logFor({ service: "DrExport" });
    const id = doId(c, access);
    const built = await buildBundleStream(c.env, access.route, c.req.raw.signal, access.cacheCtx);
    if (built.kind === "empty") return gErr(c, 422, "repository has no refs to export");
    if (built.kind === "not_ready") return gErr(c, 503, `repository not ready: ${built.reason}`);
    if (built.kind === "retry") {
      return gErr(c, 503, `snapshot assembling — retry in ${built.seconds}s`);
    }

    const ts = Date.now();
    const bundleKey = `${drPrefix(id)}/export-${ts}.bundle`;
    const bytes = await collectStream(built.packStream, built.headerBytes, MAX_EXPORT_BYTES);
    if (bytes === "too_big") {
      return gErr(c, 413, `repo exceeds the ${MAX_EXPORT_BYTES / (1024 * 1024)}MiB export cap`);
    }
    await c.env.REPO_BUCKET.put(bundleKey, bytes);
    const manifest: DrManifest = {
      format: "git-bundle-v3",
      exportedAt: ts,
      exportedBy: access.actor,
      bundleKey,
      bundleBytes: bytes.length,
      refs: built.refs,
      head: built.head ?? null,
    };
    const manifestKey = `${drPrefix(id)}/manifest-${ts}.json`;
    await c.env.REPO_BUCKET.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    log.info("dr:exported", { bundleKey, bytes: manifest.bundleBytes, refs: built.refs.length });
    return c.json({ ...manifest, manifestKey }, 201);
  });

  // --- exports list ---------------------------------------------------------
  router.get("/api/v1/repos/:repo_ref{.+}/dr/exports", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const listed = await c.env.REPO_BUCKET.list({
      prefix: `${drPrefix(doId(c, access))}/manifest-`,
    });
    const out = [];
    for (const obj of listed.objects.slice(-50)) {
      const got = await c.env.REPO_BUCKET.get(obj.key);
      if (got) out.push(await got.json());
    }
    return c.json(out.sort((a, b) => (b as DrManifest).exportedAt - (a as DrManifest).exportedAt));
  });

  // --- download -----------------------------------------------------------
  // Same read gate as clone — an export of a public repo is public data.
  router.get("/api/v1/repos/:repo_ref{.+}/dr/download/:ts", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    const key = `${drPrefix(doId(c, access))}/export-${c.req.param("ts")}.bundle`;
    const obj = await c.env.REPO_BUCKET.get(key);
    if (!obj) return gNotFound(c, "export");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/x-git-bundle",
        "Content-Disposition": `attachment; filename="export-${c.req.param("ts")}.bundle"`,
      },
    });
  });

  // --- drill: verify the latest export is restorable --------------------------
  router.post("/api/v1/repos/:repo_ref{.+}/dr/verify", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const id = doId(c, access);
    const log = c.var.logFor({ service: "DrVerify" });
    const manifest = await readManifest(c.env, id);
    if (!manifest) return gErr(c, 404, "no exports to drill — run /dr/export first");
    const obj = await c.env.REPO_BUCKET.get(manifest.bundleKey);
    if (!obj) return c.json({ status: "fail", reason: "bundle missing from R2", manifest }, 200);

    const checks: { name: string; ok: boolean; detail?: string }[] = [];
    if (obj.size > MAX_DRILL_BYTES) {
      checks.push({
        name: "size",
        ok: true,
        detail: `${obj.size}B exceeds ${MAX_DRILL_BYTES}B — header checks only`,
      });
    } else {
      checks.push({ name: "size", ok: true });
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const text = new TextDecoder();

    // Bundle header: magic + `oid ref` lines up to the PACK magic.
    const magicOk = text.decode(bytes.subarray(0, BUNDLE_MAGIC.length)) === BUNDLE_MAGIC;
    checks.push({ name: "bundle_magic", ok: magicOk });

    const packStart = indexOfPack(bytes);
    const headerText = packStart > 0 ? text.decode(bytes.subarray(0, packStart)) : "";
    const bundleRefs = new Map<string, string>();
    for (const line of headerText.split("\n")) {
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (m) bundleRefs.set(m[2], m[1]);
    }

    const { refs: liveRefs, head } = await getHeadAndRefs(c.env, access.route.doName);
    const drift: string[] = [];
    for (const r of liveRefs) {
      if (!r.name.startsWith("refs/delta/") && bundleRefs.get(r.name) !== r.oid) {
        drift.push(r.name);
      }
    }
    checks.push({
      name: "ref_parity",
      ok: drift.length === 0,
      detail: drift.length
        ? `bundle refs differ on ${drift.join(", ")} (export may be stale)`
        : undefined,
    });

    if (packStart > 0) {
      const packMagicOk = text.decode(bytes.subarray(packStart, packStart + 4)) === PACK_MAGIC;
      checks.push({ name: "pack_magic", ok: packMagicOk });
      const view = new DataView(bytes.buffer, bytes.byteOffset + packStart);
      const count = view.getUint32(8, false);
      checks.push({ name: "pack_objects", ok: count > 0, detail: `${count} objects` });
      if (obj.size <= MAX_DRILL_BYTES) {
        const packBytes = bytes.subarray(packStart);
        const body = packBytes.subarray(0, packBytes.length - 20);
        const trailer = packBytes.subarray(packBytes.length - 20);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body.slice().buffer));
        const shaOk = digest.every((b, i) => b === trailer[i]);
        checks.push({ name: "pack_sha1", ok: shaOk });
      }
    } else {
      checks.push({ name: "pack_magic", ok: false, detail: "no PACK section found" });
    }

    const failed = checks.filter((ch) => !ch.ok);
    const status = failed.length === 0 ? "pass" : "fail";
    log.info("dr:drilled", { status, checks: checks.length, exportTs: manifest.exportedAt });
    return c.json({ status, checks, manifest, liveHead: head ?? null });
  });

  // --- restore: replay an export into THIS (empty) repo ---------------------
  // The disaster-recovery round trip: create a fresh repo, POST here with
  // the *source* repo ref (+ optional export timestamp). The target must
  // have no refs — `importPack` enforces that atomically in the DO.
  router.post("/api/v1/repos/:repo_ref{.+}/dr/restore", async (c) => {
    const access = await requireWriter(c);
    if (access instanceof Response) return access;
    const body = (await c.req.json().catch(() => null)) as {
      source?: string;
      exported_at?: number;
    } | null;
    if (!body?.source) return gErr(c, 400, "source repo_ref required");

    // Reading another repo's exports carries the source's clone-level read
    // gate — a private repo's backups stay member-only.
    const source = await resolveGitnessRepo(c, body.source);
    if (source.kind !== "ok") return source.response;
    const sourceId = getRepoStub(c.env, source.route.doName).id.toString();

    const manifest = await (async () => {
      if (body.exported_at !== undefined) {
        const key = `${drPrefix(sourceId)}/manifest-${body.exported_at}.json`;
        const obj = await c.env.REPO_BUCKET.get(key);
        return obj ? ((await obj.json()) as DrManifest) : null;
      }
      return readManifest(c.env, sourceId);
    })();
    if (!manifest) return gErr(c, 404, "no export found on the source repo");
    const obj = await c.env.REPO_BUCKET.get(manifest.bundleKey);
    if (!obj) return gErr(c, 404, "export bundle missing from storage");

    const bytes = new Uint8Array(await obj.arrayBuffer());
    const packStart = indexOfPack(bytes);
    if (
      new TextDecoder().decode(bytes.subarray(0, BUNDLE_MAGIC.length)) !== BUNDLE_MAGIC ||
      packStart <= 0
    ) {
      return gErr(c, 422, "stored export is not a git bundle v3");
    }
    const refs: { name: string; oid: string }[] = [];
    let headOid: string | undefined;
    for (const line of new TextDecoder()
      .decode(bytes.subarray(BUNDLE_MAGIC.length, packStart))
      .split("\n")) {
      const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!m) continue;
      if (m[2] === "HEAD") headOid = m[1];
      else refs.push({ name: m[2], oid: m[1] });
    }
    // HEAD is recorded as an oid in our export format; its target ref is
    // the branch carrying the same oid (manifest records it too).
    const headRef =
      refs.find((r) => r.name === manifest.head?.target) ??
      refs.find((r) => headOid && r.oid === headOid && r.name.startsWith("refs/heads/")) ??
      refs.find((r) => r.name.startsWith("refs/heads/")) ??
      refs[0];
    if (!headRef) return gErr(c, 422, "bundle contains no refs");

    const stub = getRepoStub(c.env, access.route.doName);
    const result = await ingestPackIntoRepo({
      env: c.env,
      repoId: access.route.doName,
      stub,
      pack: bytes.subarray(packStart),
      refs,
      head: { target: headRef.name, oid: headRef.oid },
      actor: access.actor,
      cacheCtx: access.cacheCtx,
      packLabel: "restore",
    });
    if (result.kind === "not_empty") {
      return gErr(c, 409, "target repository is not empty — restore needs a fresh repo");
    }
    if (result.kind === "failed") return gErr(c, 422, `restore failed: ${result.reason}`);
    c.var.logFor({ service: "DrRestore" }).info("dr:restored", {
      source: body.source,
      exportTs: manifest.exportedAt,
      refs: result.refs,
      objects: result.objects,
    });
    return c.json({ restored: true, ...result, source_export: manifest.exportedAt }, 201);
  });
}

/** Offset of the "PACK" magic inside a bundle buffer, -1 when absent. */
function indexOfPack(bytes: Uint8Array): number {
  const needle = [0x50, 0x41, 0x43, 0x4b]; // "PACK"
  outer: for (let i = 0; i + 4 <= bytes.length; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
