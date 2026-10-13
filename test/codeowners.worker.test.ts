import { describe, expect, it } from "vitest";
import {
  compileCodeowners,
  globToRegExp,
  ownersForPath,
  parseCodeowners,
} from "@/worker/api/gitness/codeowners";

describe("codeowners glob matching", () => {
  it("matches basename globs at any depth", () => {
    expect(globToRegExp("*.js").test("src/deep/file.js")).toBe(true);
    expect(globToRegExp("*.js").test("src/deep/file.ts")).toBe(false);
  });

  it("matches directory patterns and nested contents", () => {
    const re = globToRegExp("docs/");
    expect(re.test("docs/guide.md")).toBe(true);
    expect(re.test("docs/a/b.md")).toBe(true);
    expect(re.test("src/docs-file.md")).toBe(false);
  });

  it("anchors leading-slash and internal-slash patterns to the root", () => {
    expect(globToRegExp("/src/**").test("src/a/b.js")).toBe(true);
    expect(globToRegExp("/src/**").test("lib/src/a.js")).toBe(false);
    expect(globToRegExp("docs/*.md").test("docs/g.md")).toBe(true);
    expect(globToRegExp("docs/*.md").test("x/docs/g.md")).toBe(false);
    expect(globToRegExp("docs/*.md").test("docs/a/g.md")).toBe(false);
  });

  it("supports ** crossing slashes and ? single chars", () => {
    expect(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("file?.txt").test("dir/file1.txt")).toBe(true);
    expect(globToRegExp("file?.txt").test("file12.txt")).toBe(false);
  });
});

describe("codeowners parsing and resolution", () => {
  const source = [
    "# comment line",
    "* @default-owner",
    "*.js @js-owner @second",
    "/docs/ @docs-team",
    "",
    "src/core/ @core-leads",
  ].join("\n");

  it("parses rules skipping comments and blanks", () => {
    const rules = parseCodeowners(source);
    expect(rules).toEqual([
      { pattern: "*", owners: ["@default-owner"] },
      { pattern: "*.js", owners: ["@js-owner", "@second"] },
      { pattern: "/docs/", owners: ["@docs-team"] },
      { pattern: "src/core/", owners: ["@core-leads"] },
    ]);
  });

  it("last matching rule wins", () => {
    const compiled = compileCodeowners(parseCodeowners(source));
    expect(ownersForPath(compiled, "app.js")).toEqual(["@js-owner", "@second"]);
    expect(ownersForPath(compiled, "docs/readme.md")).toEqual(["@docs-team"]);
    expect(ownersForPath(compiled, "src/core/x.go")).toEqual(["@core-leads"]);
    expect(ownersForPath(compiled, "misc.txt")).toEqual(["@default-owner"]);
  });
});
