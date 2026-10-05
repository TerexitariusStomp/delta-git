// File-manifest validation for codegen seats. Models emit
// { files: [{path, content}] } — far more reliable than raw diff hunks —
// and we validate paths/extensions/sizes here, then `applyManifest` in
// patch.ts turns the file set into a commit through the same
// acceptPatchCommit + merge-intent lane as everything else.

export const MANIFEST_MAX_FILES = 24;
export const MANIFEST_MAX_FILE_BYTES = 64 * 1024;
export const MANIFEST_MAX_TOTAL_BYTES = 512 * 1024;

const ALLOWED_EXT = new Set([
  "html",
  "css",
  "js",
  "json",
  "md",
  "txt",
  "svg",
  "xml",
  "wxr",
  "php",
  "htaccess",
]);

export interface ManifestFile {
  path: string;
  content: string;
}

export interface SiteManifest {
  summary: string;
  files: ManifestFile[];
}

/** Tolerant manifest extraction: fenced ```json, bare object, or trailing
 * prose around the JSON — pick the widest balanced {...} span. */
export function extractFileManifest(text: string): SiteManifest | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      summary?: unknown;
      files?: { path?: unknown; content?: unknown }[];
    };
    if (!Array.isArray(parsed.files)) return undefined;
    const files: ManifestFile[] = [];
    for (const f of parsed.files) {
      if (typeof f?.path === "string" && typeof f?.content === "string") {
        files.push({ path: f.path, content: f.content });
      }
    }
    if (files.length === 0) return undefined;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 400) : "",
      files,
    };
  } catch {
    return undefined;
  }
}

/** Path/extension/size policy. Returns null when the file is acceptable. */
export function manifestFileError(file: ManifestFile): string | null {
  const p = file.path;
  if (!p || p.length > 200) return "bad-path";
  if (p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p)) return "absolute-path";
  const parts = p.split("/");
  if (parts.some((seg) => !seg || seg === "." || seg === "..")) return "traversal";
  if (!/^[\x20-\x7e]+$/.test(p)) return "non-ascii-path";
  const leaf = parts[parts.length - 1];
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return "no-extension";
  const ext = leaf.slice(dot + 1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return `ext:${ext}`;
  const bytes = new TextEncoder().encode(file.content).length;
  if (bytes > MANIFEST_MAX_FILE_BYTES) return "file-too-large";
  return null;
}

export function validateManifest(
  manifest: SiteManifest
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.files.length > MANIFEST_MAX_FILES) reasons.push("too-many-files");
  let total = 0;
  for (const f of manifest.files) {
    const err = manifestFileError(f);
    if (err) reasons.push(`${f.path}:${err}`);
    total += new TextEncoder().encode(f.content).length;
  }
  if (total > MANIFEST_MAX_TOTAL_BYTES) reasons.push("manifest-too-large");
  if (!manifest.files.some((f) => f.path === "blueprint.json")) reasons.push("missing-blueprint");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
