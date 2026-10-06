import { describe, expect, it } from "vitest";

import { nextCronFire, parseCron } from "@/worker/tasks/cronmatch";

const T0 = Date.UTC(2025, 0, 6, 10, 30, 0); // Mon Jan 6 2025 10:30 UTC

describe("cronmatch", () => {
  it("parses the supported field forms", () => {
    expect(parseCron("* * * * *")).toBeTruthy();
    expect(parseCron("*/5 * * * *")).toBeTruthy();
    expect(parseCron("0 2 * * *")).toBeTruthy();
    expect(parseCron("0,30 9-17 * * mon-fri")).toBeTruthy();
    expect(parseCron("15 3 1 * *")).toBeTruthy();
  });

  it("rejects malformed and out-of-range expressions", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * * * nonsense")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("5-2 * * * *")).toBeNull();
  });

  it("fires every 5 minutes for */5", () => {
    // 10:30 → next is 10:35.
    expect(nextCronFire("*/5 * * * *", T0)).toBe(Date.UTC(2025, 0, 6, 10, 35));
    // 10:35 exactly → next occurrence, not same-minute refire.
    expect(nextCronFire("*/5 * * * *", Date.UTC(2025, 0, 6, 10, 35))).toBe(
      Date.UTC(2025, 0, 6, 10, 40)
    );
  });

  it("fires daily at a fixed time across hour jumps", () => {
    // 10:30 → next 02:00 is tomorrow.
    expect(nextCronFire("0 2 * * *", T0)).toBe(Date.UTC(2025, 0, 7, 2, 0));
  });

  it("honors comma lists and ranges with steps", () => {
    expect(nextCronFire("0,30 9-17 * * *", T0)).toBe(Date.UTC(2025, 0, 6, 10, 30) + 30 * 60000);
    expect(nextCronFire("0,30 9-17 * * *", Date.UTC(2025, 0, 6, 18, 0))).toBe(
      Date.UTC(2025, 0, 7, 9, 0)
    );
  });

  it("honors day-of-week filters (names and 7=Sunday)", () => {
    // Jan 6 2025 is a Monday — `* * * * sat` jumps to Jan 11.
    expect(nextCronFire("0 12 * * sat", T0)).toBe(Date.UTC(2025, 0, 11, 12, 0));
    // Jan 12 2025 is Sunday — both 0 and 7 match.
    expect(nextCronFire("0 12 * * 7", Date.UTC(2025, 0, 11, 13, 0))).toBe(
      Date.UTC(2025, 0, 12, 12, 0)
    );
  });

  it("honors day-of-month constraints with month skipping", () => {
    expect(nextCronFire("0 0 1 * *", T0)).toBe(Date.UTC(2025, 1, 1, 0, 0));
  });

  it("minute-walk stays correct within an hour", () => {
    expect(nextCronFire("45 * * * *", T0)).toBe(Date.UTC(2025, 0, 6, 10, 45));
  });
});
