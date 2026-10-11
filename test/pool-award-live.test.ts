// Live bridge round-trip: poolAward + poolAwardStatus against a real
// localchimera coordinator (COORDINATOR_URL + DISPATCH token env).
import { describe, expect, it } from "vitest";
import { poolAward, poolAwardStatus } from "@/worker/compute/pool";

// Opt-in integration test — needs a running coordinator:
//   COORDINATOR_URL=http://localhost:8788 DISPATCH_AUTH_TOKEN=… \
//   npx vitest run --config vitest.unit.config.ts test/pool-award-live.test.ts
const live = process.env.COORDINATOR_URL ? describe : describe.skip;
const base = process.env.COORDINATOR_URL ?? "http://localhost:8788";
const token = process.env.DISPATCH_AUTH_TOKEN ?? "";
const env = {
  COMPUTE_COORDINATOR: base,
  COMPUTE_DISPATCH_TOKEN: token,
  COMPUTE_ENABLED: "1",
  LOG_LEVEL: "debug",
} as unknown as Env;

live("poolAward live round-trip", () => {
  const uniq = Date.now().toString(36);
  const ref = `match:live-${uniq}`;

  it("posts a split award that the coordinator credits", async () => {
    const res = await poolAward(env, {
      project: `dg:live-${uniq}/repo`,
      ref,
      split: [
        { did: "did:key:zWinner", score: 835 },
        { did: "did:key:zSecond", score: 830 },
      ],
      amountWei: "1000000",
      reason: "arena-winner",
    });
    // Unfunded pool → null (402 path) — for the live test we fund first
    // via /patronage from the script wrapper, or accept pending/credited.
    if (res === null) {
      // fund then retry once
      await fetch(`${base}/patronage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project: `dg:live-${uniq}/repo`,
          amountWei: "2000000",
          fund: "award",
          patron: "did:key:zTest",
        }),
      });
      const retry = await poolAward(env, {
        project: `dg:live-${uniq}/repo`,
        ref,
        split: [
          { did: "did:key:zWinner", score: 835 },
          { did: "did:key:zSecond", score: 830 },
        ],
        amountWei: "1000000",
        reason: "arena-winner",
      });
      expect(retry?.status).toMatch(/credited|pending/);
      expect(retry?.recipients?.reduce((t, r) => t + BigInt(r.amountWei), 0n)).toBe(1000000n);
      return;
    }
    expect(res.status).toMatch(/credited|pending/);
  });

  it("reads the award back by ref", async () => {
    const award = await poolAwardStatus(env, ref);
    expect(award?.ref).toBe(ref);
    expect(award?.recipients?.length).toBe(2);
  });

  it("unfunded ref returns null (404/402 path)", async () => {
    const miss = await poolAwardStatus(env, `match:nope-${uniq}`);
    expect(miss).toBeNull();
  });
});
