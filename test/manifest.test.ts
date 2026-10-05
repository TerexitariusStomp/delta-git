import { describe, expect, it } from "vitest";

import { extractFileManifest, MANIFEST_MAX_FILES, validateManifest } from "@/worker/agent/manifest";

const GOOD_FILE = { path: "blueprint.json", content: "{}" };

describe("extractFileManifest", () => {
  it("parses a bare JSON object", () => {
    const m = extractFileManifest(JSON.stringify({ summary: "a site", files: [GOOD_FILE] }));
    expect(m?.files).toHaveLength(1);
    expect(m?.summary).toBe("a site");
  });

  it("tolerates fenced output and surrounding prose", () => {
    const m = extractFileManifest(
      `Here is the manifest:\n\`\`\`json\n${JSON.stringify({ files: [GOOD_FILE] })}\n\`\`\`\nDone.`
    );
    expect(m?.files[0]?.path).toBe("blueprint.json");
  });

  it("drops non-string file entries instead of failing", () => {
    const m = extractFileManifest(
      JSON.stringify({
        files: [GOOD_FILE, { path: 42, content: "x" }, { path: "a.css" }],
      })
    );
    expect(m?.files).toHaveLength(1);
  });

  it("returns undefined for non-manifest output", () => {
    expect(extractFileManifest("no json here")).toBeUndefined();
    expect(extractFileManifest('{"summary":"no files"}')).toBeUndefined();
    expect(extractFileManifest('{"files":[]}')).toBeUndefined();
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const res = validateManifest({
      summary: "ok",
      files: [GOOD_FILE, { path: "wp-content/themes/x/style.css", content: "/* x */" }],
    });
    expect(res).toEqual({ ok: true });
  });

  it("requires blueprint.json", () => {
    const res = validateManifest({
      summary: "x",
      files: [{ path: "site/index.html", content: "<html/>" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("missing-blueprint");
  });

  it("rejects traversal, absolute paths, and non-ascii", () => {
    for (const path of [
      "../escape.css",
      "/abs/style.css",
      "a//b.css",
      "wp-content/../../../etc/passwd.css",
      "thème/style.css",
    ]) {
      const res = validateManifest({
        summary: "x",
        files: [GOOD_FILE, { path, content: "x" }],
      });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects disallowed extensions and extensionless paths", () => {
    for (const path of ["evil.exe", "x.png", "noext", ".hidden"]) {
      const res = validateManifest({
        summary: "x",
        files: [GOOD_FILE, { path, content: "x" }],
      });
      expect(res.ok).toBe(false);
    }
  });

  it("caps the file count", () => {
    const files = Array.from({ length: MANIFEST_MAX_FILES + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      content: "x",
    }));
    files[0] = GOOD_FILE;
    const res = validateManifest({ summary: "x", files });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons).toContain("too-many-files");
  });
});
