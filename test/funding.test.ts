import { describe, expect, it } from "vitest";
import { parseFunding } from "@/worker/api/gitness/funding";

describe("FUNDING.yml parsing", () => {
  it("expands known platforms to their profile URLs", () => {
    const links = parseFunding(["github: octocat", "patreon: octocat", "ko_fi: octo"].join("\n"));
    expect(links).toEqual([
      { platform: "github", value: "octocat", url: "https://github.com/sponsors/octocat" },
      { platform: "patreon", value: "octocat", url: "https://www.patreon.com/octocat" },
      { platform: "ko_fi", value: "octo", url: "https://ko-fi.com/octo" },
    ]);
  });

  it("expands list values per platform", () => {
    const links = parseFunding("github: [octocat, hubot]");
    expect(links.map((l) => l.value)).toEqual(["octocat", "hubot"]);
    expect(links[1].url).toBe("https://github.com/sponsors/hubot");
  });

  it("passes custom URLs through with the https check and the 4-link cap", () => {
    const links = parseFunding(
      [
        "custom:",
        "  - https://example.com/tip",
        "  - http://example.com/ok",
        "  - javascript:alert(1)",
        "  - https://a.example.com",
        "  - https://b.example.com",
        "  - https://c.example.com",
        "  - https://d.example.com",
      ].join("\n")
    );
    // javascript: is dropped; the cap keeps the first 4 valid URLs.
    expect(links.map((l) => l.url)).toEqual([
      "https://example.com/tip",
      "http://example.com/ok",
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(links.every((l) => l.platform === "custom")).toBe(true);
  });

  it("ignores unknown platform keys", () => {
    const links = parseFunding("github: octocat\nmade_up_platform: nobody");
    expect(links).toHaveLength(1);
    expect(links[0].platform).toBe("github");
  });

  it("returns [] on malformed yaml and non-map docs", () => {
    expect(parseFunding("not yaml: [unclosed")).toEqual([]);
    expect(parseFunding("- just\n- a\n- list")).toEqual([]);
    expect(parseFunding("")).toEqual([]);
  });
});
