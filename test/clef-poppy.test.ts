import { describe, expect, it } from "vitest";

import { clefProbability, clefScore } from "@/worker/agent/clef";

// Clef answer parsers — pure functions, so they run under the Node runner.
// The poppy:* scope aliases are covered in oauth-provider.worker.test.ts
// (auth/oauth.ts imports a workerd-only module transitively).

describe("clef answer parsers", () => {
  it("reads bare-number noul answers", () => {
    expect(clefProbability({ q: 0.82 }, "q")).toBeCloseTo(0.82);
  });

  it("reads structured probability shapes", () => {
    expect(clefProbability({ q: { probability: 0.7 } }, "q")).toBeCloseTo(0.7);
    expect(clefProbability({ q: { answer: true, p: 0.61 } }, "q")).toBeCloseTo(0.61);
  });

  it("abstains on missing or out-of-range answers", () => {
    expect(clefProbability({}, "q")).toBeUndefined();
    expect(clefProbability({ q: 1.4 }, "q")).toBeUndefined();
    expect(clefProbability({ q: { label: "yes" } }, "q")).toBeUndefined();
  });

  it("normalizes score answers by criteria levels", () => {
    expect(clefScore({ s: 3 }, "s", 4)).toBeCloseTo(1);
    expect(clefScore({ s: 1.5 }, "s", 4)).toBeCloseTo(0.5);
    expect(clefScore({ s: 0 }, "s", 4)).toBe(0);
  });

  it("abstains on malformed score answers", () => {
    expect(clefScore({}, "s", 4)).toBeUndefined();
    expect(clefScore({ s: -1 }, "s", 4)).toBeUndefined();
    expect(clefScore({ s: "high" }, "s", 4)).toBeUndefined();
    expect(clefScore({ s: 2 }, "s", 1)).toBeUndefined();
  });
});
