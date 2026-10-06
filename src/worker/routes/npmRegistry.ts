// npm registry — GitHub-Packages-shaped surface at /npm/.
//
//   PUT  /npm/@scope%2Fname          publish (Bearer PAT, scope = namespace)
//   GET  /npm/@scope%2Fname          packument (full metadata doc)
//   GET  /npm/@scope%2Fname/-/file   tarball
//
// Scoping rules: package names MUST be `@scope/name` where `scope` is a
// namespace slug — the namespace IS the registry owner (GitHub Packages
// semantics), which gives publish auth for free: a `push`-level PAT grant
// on the namespace authorizes publish. Packuments live in KV
// (`gpkg:<ns>:<name>`), tarballs in R2 (`pkg/<ns>/<name>/<version>.tgz`).
//
// Integrity is computed server-side — the client's declared shasum/
// integrity is advisory input; dist entries are rewritten to our tarball
// URLs with measured sha1/sha512. Re-publishing an existing version is
// rejected (npm semantics: immutable versions).
//
// Read model: published packages are public artifacts (anonymously
// fetchable) — private package visibility is a namespace-level feature
// left out of v1.

import type { AppRouter } from "@/worker/routes/hono";
import { findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { verifyPat } from "@/worker/auth/pat";
import { normalizeIdentifier } from "@/worker/api/gitness/shared";

const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_VERSIONS_PER_PUT = 20;

interface PackumentVersion {
  name: string;
  version: string;
  dist: {
    tarball: string;
    shasum: string;
    integrity: string;
  };
  [key: string]: unknown;
}
interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
  time: Record<string, string>;
  _rev?: string;
  [key: string]: unknown;
}
interface PublishBody {
  name?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string } } & Record<string, unknown>>;
  _attachments?: Record<string, { data?: string; content_type?: string; length?: number }>;
}

function pkgKvKey(nsSlug: string, name: string): string {
  return `gpkg:${nsSlug}:${name}`;
}
function pkgR2Key(nsSlug: string, name: string, filename: string): string {
  return `pkg/${nsSlug}/${name}/${filename}`;
}

function jsonErr(c: { json: (b: unknown, s: number) => Response }, status: number, error: string) {
  return c.json({ error }, status);
}

/** `@scope/name` or the `%40scope%2Fname` npm-encoded form → parts. */
function parseScopedName(raw: string): { scope: string; name: string; full: string } | null {
  const decoded = decodeURIComponent(raw);
  const m = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(decoded);
  if (!m) return null;
  return { scope: m[1], name: m[2], full: `@${m[1]}/${m[2]}` };
}

function bearerToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const auth = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", bytes.slice().buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha512B64(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-512", bytes.slice().buffer);
  let s = "";
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return `sha512-${btoa(s)}`;
}
function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function readPackument(env: Env, nsSlug: string, name: string): Promise<Packument | null> {
  return (await env.ROUTES.get(pkgKvKey(nsSlug, name), "json").catch(
    () => null
  )) as Packument | null;
}

export function registerNpmRegistryRoutes(router: AppRouter) {
  // Tarball download — anonymous read (published packages are public).
  // Emitted URLs use the decoded form /@ns/name/-/file.tgz; Hono's
  // RegExpRouter can't compile a mid-segment literal+param (`@:scope`),
  // so the `@` arrives inside the segment and is stripped here.
  router.get("/npm/:scope/:name/-/:file", async (c) => {
    const scope = normalizeIdentifier((c.req.param("scope") ?? "").replace(/^@/, ""));
    const obj = await c.env.REPO_BUCKET.get(
      pkgR2Key(scope, c.req.param("name") ?? "", c.req.param("file") ?? "")
    );
    if (!obj) return jsonErr(c, 404, "not found");
    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });

  // Packument read — anonymous; tarball URLs rewritten at publish time.
  router.get("/npm/:name{.+}", async (c) => {
    const parsed = parseScopedName(c.req.param("name"));
    if (!parsed) return jsonErr(c, 400, "packages must be scoped: @namespace/name");
    const doc = await readPackument(c.env, parsed.scope, parsed.full);
    if (!doc) return jsonErr(c, 404, "not found");
    return c.json(doc);
  });

  // Publish — npm sends the whole packument with base64 attachments.
  router.put("/npm/:name{.+}", async (c) => {
    const parsed = parseScopedName(c.req.param("name"));
    if (!parsed) return jsonErr(c, 400, "packages must be scoped: @namespace/name");
    const nsSlug = normalizeIdentifier(parsed.scope);
    const namespace = await findNamespaceBySlug(c.var.db, nsSlug);
    if (!namespace) return jsonErr(c, 404, "unknown scope namespace");

    const token = bearerToken(c);
    if (!token) return jsonErr(c, 401, "bearer token required");
    const verified = await verifyPat(c.env, {
      username: nsSlug,
      plaintext: token,
      namespaceId: namespace.id,
      db: c.var.db,
    });
    if (!verified.ok) return jsonErr(c, 401, `token rejected: ${verified.reason}`);
    if (verified.level !== "push") return jsonErr(c, 403, "publish needs a push-level token");

    const body = (await c.req.json().catch(() => null)) as PublishBody | null;
    if (!body?.name || body.name !== parsed.full) {
      return jsonErr(c, 422, `packument name must be ${parsed.full}`);
    }
    const versions = Object.entries(body.versions ?? {});
    if (versions.length === 0) return jsonErr(c, 422, "no versions to publish");
    if (versions.length > MAX_VERSIONS_PER_PUT) {
      return jsonErr(c, 422, `too many versions in one publish (max ${MAX_VERSIONS_PER_PUT})`);
    }
    const attachments = body._attachments ?? {};

    const stored = (await readPackument(c.env, nsSlug, parsed.full)) ?? {
      name: parsed.full,
      "dist-tags": {},
      versions: {},
      time: {},
    };
    const origin = new URL(c.req.url).origin;

    for (const [version, meta] of versions) {
      if (stored.versions[version]) {
        return jsonErr(c, 409, `version ${version} already published`);
      }
      // npm names the attachment `<basename>-<version>.tgz` and points each
      // version's dist.tarball at it — find the matching attachment by
      // basename of the declared URL, falling back to the sole attachment.
      const tarballPath = meta?.dist?.tarball ?? "";
      // basename() the declared path — registries emit `<base>-<ver>.tgz`
      // but a hostile/buggy client could smuggle slashes into the key.
      const declaredFile = (tarballPath.split("/-/")[1] ?? "").split("/").pop() ?? "";
      const attKey = attachments[declaredFile] ? declaredFile : Object.keys(attachments)[0];
      const att = attKey ? attachments[attKey] : undefined;
      if (!att?.data) return jsonErr(c, 422, `missing tarball for ${version}`);
      const bytes = b64decode(att.data);
      if (!bytes) return jsonErr(c, 422, `bad base64 tarball for ${version}`);
      if (bytes.length > MAX_TARBALL_BYTES) {
        return jsonErr(c, 413, `tarball exceeds ${MAX_TARBALL_BYTES / (1024 * 1024)}MiB`);
      }
      // Attachment keys are the canonical filename (`<base>-<ver>.tgz`) —
      // basename for safety, falling back to a synthesized name.
      const filename = (attKey ?? "").split("/").pop() || `${parsed.name}-${version}.tgz`;
      await c.env.REPO_BUCKET.put(pkgR2Key(nsSlug, parsed.name, filename), bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      const now = new Date().toISOString();
      stored.versions[version] = {
        ...(meta as Record<string, unknown>),
        name: parsed.full,
        version,
        dist: {
          tarball: `${origin}/npm/@${nsSlug}/${parsed.name}/-/${filename}`,
          shasum: await sha1Hex(bytes),
          integrity: await sha512B64(bytes),
        },
      } as PackumentVersion;
      stored.time[version] = now;
    }
    for (const [tag, ver] of Object.entries(body["dist-tags"] ?? {})) {
      if (stored.versions[ver]) stored["dist-tags"][tag] = ver;
    }
    stored.time.modified = new Date().toISOString();
    await c.env.ROUTES.put(pkgKvKey(nsSlug, parsed.full), JSON.stringify(stored));
    return c.json({ ok: true, name: parsed.full, versions: Object.keys(stored.versions) }, 201);
  });
}
