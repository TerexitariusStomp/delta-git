import { describe, it, expect } from "vitest";

import {
  isAllowlistedSecret,
  isDeltaGitRemote,
  isFalsePositivePath,
  parsePrePushStdin,
  parseRemoteInfo,
  planRanges,
} from "../cli/scan";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

describe("parsePrePushStdin", () => {
  it("parses hook stdin lines and drops ref deletions", () => {
    const updates = parsePrePushStdin(
      `refs/heads/main ${A} refs/heads/main ${B}\n` + `refs/heads/gone ${Z} refs/heads/gone ${B}\n`
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ localSha: A, remoteSha: B });
  });
});

describe("planRanges", () => {
  it("dedupes refs pointing at the same range", () => {
    const updates = [
      { localRef: "a", localSha: A, remoteRef: "a", remoteSha: B },
      { localRef: "b", localSha: A, remoteRef: "b", remoteSha: B },
      { localRef: "c", localSha: B, remoteRef: "c", remoteSha: Z },
    ];
    const plan = planRanges(updates);
    expect(plan).toHaveLength(2);
  });
});

describe("false-positive filtering", () => {
  it("flags vendored/fixture paths", () => {
    expect(isFalsePositivePath("vendor/lib/x.ts")).toBe(true);
    expect(isFalsePositivePath("src/foo.test.ts")).toBe(true);
    expect(isFalsePositivePath("src/secrets.ts")).toBe(false);
  });

  it("allowlists well-known public keys", () => {
    expect(
      isAllowlistedSecret("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    ).toBe(true);
    expect(
      isAllowlistedSecret("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    ).toBe(true);
    expect(isAllowlistedSecret("real-secret-value")).toBe(false);
  });
});

describe("remote detection", () => {
  it("recognizes delta-git hosts", () => {
    expect(isDeltaGitRemote("https://delta-git.workers.dev/o/r.git")).toBe(true);
    expect(isDeltaGitRemote("https://github.com/o/r.git")).toBe(false);
    expect(isDeltaGitRemote("https://dg.example.com/o/r", "https://dg.example.com")).toBe(true);
  });

  it("parses remote info", () => {
    expect(parseRemoteInfo("https://delta-git.workers.dev/alice/demo.git")).toEqual({
      host: "https://delta-git.workers.dev",
      owner: "alice",
      repo: "demo",
    });
    expect(parseRemoteInfo("git@github.com:a/b.git")).toBeNull();
  });
});
