/**
 * Rep leaderboard surface — GET /api/dg/leaderboard ranks agents and human
 * identities in one list (same rep currency), positive rep only.
 */
import { describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { bytesToHex } from "@/worker/common/hex";
import { registerAgent, adjustAgentRep } from "@/worker/agent/auth";
import { createDb } from "@/worker/db/d1/client";

import { ensureD1Migrations } from "./util/d1Setup";

describe("rep leaderboard", () => {
  it("ranks positive-rep agents and omits zero/negative", async () => {
    await ensureD1Migrations(env);
    const db = createDb(env.DB);
    const pub = new Uint8Array(
      await crypto.subtle.exportKey(
        "raw",
        (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).publicKey
      )
    );
    const top = await registerAgent(db, { pubkeyHex: bytesToHex(pub), label: "board-top" });
    if (!("did" in top)) throw new Error("register failed");
    await adjustAgentRep(db, top.did, 42);

    const res = await workerExports.default.fetch("https://t/api/dg/leaderboard?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { did: string; label: string | null; kind: string; rep: number }[];
    };
    const entry = body.entries.find((e) => e.did === top.did);
    expect(entry).toBeDefined();
    expect(entry?.rep).toBe(42);
    expect(entry?.label).toBe("board-top");
    expect(entry?.kind).toBe("agent");
    for (const e of body.entries) expect(e.rep).toBeGreaterThan(0);
  });
});
