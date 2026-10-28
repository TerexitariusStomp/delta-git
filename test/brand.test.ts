import { describe, expect, it } from "vitest";

import { brandFor, brandSpaHtml } from "@/shared/brand";

const INDEX = `<html><head><link href="/favicon.png" rel="icon" type="image/png" /><title>Widespread</title><script>boot()</script><link rel="stylesheet" href="/assets/index.css"></head><body></body></html>`;

describe("brand", () => {
  it("defaults to Widespread for unset or unknown brands", () => {
    expect(brandFor(undefined).name).toBe("Widespread");
    expect(brandFor("nope").name).toBe("Widespread");
  });

  it("leaves the default SPA index branded Widespread with no extra stylesheet", () => {
    const html = brandSpaHtml(INDEX, brandFor("widespread"));
    expect(html).toContain("<title>Widespread</title>");
    expect(html).not.toContain("/brands/");
  });

  it("rebrands the SPA index for a tenant, after the base styles", () => {
    const html = brandSpaHtml(INDEX, brandFor("vibetime"));
    expect(html).toContain("<title>Vibetime</title>");
    expect(html).toContain(`href="/brands/vibetime-logo.svg" rel="icon"`);
    expect(html.indexOf("/brands/vibetime.css")).toBeGreaterThan(html.indexOf("/assets/index.css"));
    expect(html).toContain("&quot;logo&quot;:&quot;/brands/vibetime-logo.svg&quot;");
    expect(html).toContain("<script>boot()</script>");
  });
});
