import { it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { advanceMatchPhasesState } from "@/worker/do/repo/catalog/arena";
import type { MatchRow } from "@/worker/do/repo/db/schema";
import { createDb } from "@/worker/db/d1/client";
import { registerAgent } from "@/worker/agent/auth";
import { ensureIdentity } from "@/worker/db/d1/dal/identities";
import {
  adjustRep,
  closeEpoch,
  countRecentVouches,
  findRepTarget,
  insertEpoch,
  insertVouch,
  listFamilyRollup,
  listModelRollup,
  upsertEpochAllocation,
} from "@/worker/db/d1/dal/reputation";
import { applyManifest } from "@/worker/agent/patch";
import { runDOWithRetry } from "./util/test-helpers";
import { readAppD1Migrations } from "./util/d1Migrations";

function makeRepoId(suffix: string) {
  return `arena/${suffix}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeMatchRow(repoId: string, overrides: Partial<MatchRow> = {}): MatchRow {
  const now = Date.now();
  return {
    id: `match-${Math.random().toString(36).slice(2, 10)}`,
    doName: repoId,
    title: "Test match",
    spec: "Build the thing",
    status: "building",
    windowMinutes: 60,
    judgeMinutes: 30,
    maxEntrants: 4,
    prizeRep: 25,
    createdBy: "did:key:zCreator",
    createdAt: now,
    startedAt: now,
    endsAt: now + 60_000,
    judgeEndsAt: null,
    winnerEntryId: null,
    ...overrides,
  };
}

it("match lifecycle: enter → judging → blind votes → resolve", async () => {
  const repoId = makeRepoId("lifecycle");
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);
  const match = makeMatchRow(repoId);

  await runDOWithRetry(getStub, async (instance) => {
    await instance.createMatch({ row: match, actor: "did:key:zCreator" });
  });

  // Two entrants join; a second entry from the same DID is a duplicate.
  await runDOWithRetry(getStub, async (instance) => {
    const r1 = await instance.enterMatch({
      matchId: match.id,
      entryId: "entry-a",
      entrantDid: "did:key:zAlice",
      workspaceName: "ws-dg-aaaa",
      actor: "did:key:zAlice",
    });
    const r2 = await instance.enterMatch({
      matchId: match.id,
      entryId: "entry-b",
      entrantDid: "did:key:zBob",
      workspaceName: "ws-dg-bbbb",
      actor: "did:key:zBob",
    });
    const dup = await instance.enterMatch({
      matchId: match.id,
      entryId: "entry-a2",
      entrantDid: "did:key:zAlice",
      workspaceName: "ws-dg-aaaa2",
      actor: "did:key:zAlice",
    });
    expect(r1.status).toBe("entered");
    expect(r2.status).toBe("entered");
    expect(dup.status).toBe("duplicate");

    // Workspace rows were created for each entry.
    const ws = await instance.getWorkspace("ws-dg-aaaa");
    expect(ws?.kind).toBe("arena");
    expect(ws?.matchId).toBe(match.id);
  });

  // Votes are rejected while the match is still building.
  await runDOWithRetry(getStub, async (instance) => {
    const early = await instance.castMatchVote({
      matchId: match.id,
      voterDid: "did:key:zVoter1",
      entryId: "entry-a",
    });
    expect(early.status).toBe("not-judging");
  });

  // Advance phases past the deadline — same call the DO alarm makes.
  await runDOWithRetry(getStub, async (_instance, state) => {
    const advanced = await advanceMatchPhasesState(state, match.endsAt! + 1);
    expect(advanced.judged).toContain(match.id);
    expect(advanced.resolveNeeded.length).toBe(0);
  });

  // Now votes land; the same voter can't vote twice. Stakes ride along.
  await runDOWithRetry(getStub, async (instance) => {
    const v1 = await instance.castMatchVote({
      matchId: match.id,
      voterDid: "did:key:zVoter1",
      entryId: "entry-a",
      stake: 10,
    });
    const v2 = await instance.castMatchVote({
      matchId: match.id,
      voterDid: "did:key:zVoter2",
      entryId: "entry-b",
      stake: 5,
    });
    const dup = await instance.castMatchVote({
      matchId: match.id,
      voterDid: "did:key:zVoter1",
      entryId: "entry-b",
    });
    expect(v1.status).toBe("voted");
    expect(v2.status).toBe("voted");
    expect(dup.status).toBe("duplicate");
  });

  // Queue-side scoring resolves the match transactionally.
  await runDOWithRetry(getStub, async (instance) => {
    const resolved = await instance.resolveMatch({
      matchId: match.id,
      winnerEntryId: "entry-a",
      scores: [
        { entryId: "entry-a", autoScore: 900, voteCount: 1, voteWeight: 15 },
        { entryId: "entry-b", autoScore: 800, voteCount: 1, voteWeight: 5 },
      ],
      settlement: {
        pool: 7,
        forfeits: 2,
        winnerPrize: 20,
        voterPoolSeed: 5,
        payouts: { "did:key:zVoter1": 17, "did:key:zVoter2": 3 },
      },
      actor: "arena-resolve",
    });
    expect(resolved.status).toBe("resolved");
    // Idempotent: a retried arena-resolve delivery reports already-resolved.
    const again = await instance.resolveMatch({
      matchId: match.id,
      winnerEntryId: "entry-b",
      scores: [],
      actor: "arena-resolve",
    });
    expect(again.status).toBe("already-resolved");

    const detail = await instance.getMatch(match.id);
    expect(detail?.match.status).toBe("resolved");
    expect(detail?.match.winnerEntryId).toBe("entry-a");
    const winner = detail?.entries.find((e) => e.id === "entry-a");
    expect(winner?.won).toBe(1);
    expect(winner?.autoScore).toBe(900);
    expect(detail?.votes.length).toBe(2);
    expect(detail?.votes.find((v) => v.voterDid === "did:key:zVoter1")?.stake).toBe(10);

    // The settlement lands in the op-log as part of the auditable record.
    const ops = await instance.listOpLog(-1);
    const resolveOp = ops.find((o) => o.kind === "arena.resolve");
    const payload = JSON.parse(resolveOp!.payload) as {
      settlement?: { pool: number; payouts: Record<string, number> };
    };
    expect(payload.settlement?.pool).toBe(7);
    expect(payload.settlement?.payouts["did:key:zVoter1"]).toBe(17);
  });
});

it("judging matches past judge_ends_at request an arena-resolve", async () => {
  const repoId = makeRepoId("resolve-needed");
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);
  const match = makeMatchRow(repoId);

  await runDOWithRetry(getStub, async (instance) => {
    await instance.createMatch({ row: match, actor: "did:key:zCreator" });
  });

  // Advance past both deadlines in two sweeps: building → judging → resolve-needed.
  const judgeEnds = await runDOWithRetry(getStub, async (instance, state) => {
    const first = await advanceMatchPhasesState(state, match.endsAt! + 1);
    expect(first.judged).toContain(match.id);
    const after = await instance.getMatch(match.id);
    return after!.match.judgeEndsAt!;
  });
  await runDOWithRetry(getStub, async (_instance, state) => {
    const second = await advanceMatchPhasesState(state, judgeEnds + 1);
    expect(second.resolveNeeded).toEqual([{ matchId: match.id, doName: repoId }]);
  });
});

it("arena entry rejects entries after ends_at and over capacity", async () => {
  const repoId = makeRepoId("closed-full");
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);
  const match = makeMatchRow(repoId, { maxEntrants: 1 });

  await runDOWithRetry(getStub, async (instance) => {
    await instance.createMatch({ row: match, actor: "did:key:zCreator" });
    const r1 = await instance.enterMatch({
      matchId: match.id,
      entryId: "entry-1",
      entrantDid: "did:key:zAlice",
      workspaceName: "ws-dg-cap1",
      actor: "did:key:zAlice",
    });
    const r2 = await instance.enterMatch({
      matchId: match.id,
      entryId: "entry-2",
      entrantDid: "did:key:zBob",
      workspaceName: "ws-dg-cap2",
      actor: "did:key:zBob",
    });
    expect(r1.status).toBe("entered");
    expect(r2.status).toBe("full");
  });

  const expired = makeMatchRow(repoId, { endsAt: Date.now() - 1000 });
  await runDOWithRetry(getStub, async (instance) => {
    await instance.createMatch({ row: expired, actor: "did:key:zCreator" });
    const late = await instance.enterMatch({
      matchId: expired.id,
      entryId: "entry-late",
      entrantDid: "did:key:zCarol",
      workspaceName: "ws-dg-late",
      actor: "did:key:zCarol",
    });
    expect(late.status).toBe("closed");
  });
});

it("processed event ids dedup at-least-once queue deliveries", async () => {
  const repoId = makeRepoId("dedup");
  const id = env.REPO_DO.idFromName(repoId);
  const getStub = () => env.REPO_DO.get(id);

  await runDOWithRetry(getStub, async (instance) => {
    const first = await instance.recordProcessedEvent("cf.artifacts.evt-1");
    const repeat = await instance.recordProcessedEvent("cf.artifacts.evt-1");
    const other = await instance.recordProcessedEvent("cf.artifacts.evt-2");
    expect(first).toBe(true);
    expect(repeat).toBe(false);
    expect(other).toBe(true);
  });
});

it("reputation: unified adjustRep, vouch rate check, epoch allocate + close", async () => {
  await applyD1Migrations(env.DB, readAppD1Migrations());
  const db = createDb(env.DB);
  const now = Date.now();

  // One rep currency across agents and human identities.
  const agent = await registerAgent(db, {
    pubkeyHex: "a".repeat(64),
    label: "rep-agent",
  });
  expect("did" in agent).toBe(true);
  if (!("did" in agent)) return;
  const identity = await ensureIdentity(db, { did: "did:key:zHuman" });

  expect(await adjustRep(db, agent.did, 50)).toBe(true);
  expect(await adjustRep(db, identity.did, 30)).toBe(true);
  expect(await adjustRep(db, "did:key:zNobody", 10)).toBe(false);
  // rep floors at zero.
  expect(await adjustRep(db, agent.did, -9999)).toBe(true);

  // Sybil brake: one praise per (from,to) per day.
  await insertVouch(db, {
    id: "vouch-1",
    fromDid: agent.did,
    toDid: identity.did,
    kind: "praise",
    message: "good merge",
    signature: null,
    repDelta: 5,
    createdAt: now,
  });
  expect(await countRecentVouches(db, agent.did, identity.did, now - 86_400_000)).toBe(1);
  expect(await countRecentVouches(db, identity.did, agent.did, now - 86_400_000)).toBe(0);

  // Epoch: allocate within budget, over-budget rejected, close tallies rep.
  await insertEpoch(db, {
    id: "epoch-1",
    name: "week 1",
    budget: 100,
    startsAt: now - 1000,
    endsAt: now + 60_000,
    createdBy: "did:key:zAdmin",
    createdAt: now,
  });
  const alloc = await upsertEpochAllocation(db, {
    epochId: "epoch-1",
    fromDid: agent.did,
    toDid: identity.did,
    amount: 40,
    now,
  });
  expect(alloc).toEqual({ ok: true, remaining: 60 });
  const over = await upsertEpochAllocation(db, {
    epochId: "epoch-1",
    fromDid: agent.did,
    toDid: identity.did,
    amount: 200,
    now,
  });
  expect(over).toEqual({ ok: false, reason: "over-budget" });
  const self = await upsertEpochAllocation(db, {
    epochId: "epoch-1",
    fromDid: agent.did,
    toDid: agent.did,
    amount: 10,
    now,
  });
  expect(self).toEqual({ ok: false, reason: "self-allocation" });

  // Closing before ends_at is refused; after, allocations tally into rep.
  const early = await closeEpoch(db, "epoch-1", now);
  expect(early.ok).toBe(false);
  const closed = await closeEpoch(db, "epoch-1", now + 120_000);
  expect(closed.ok).toBe(true);
  if (closed.ok) expect(closed.tallies.get(identity.did)).toBe(40);
});

it("agent family/model rollups aggregate rep across instances", async () => {
  await applyD1Migrations(env.DB, readAppD1Migrations());
  const db = createDb(env.DB);

  // Two Claude Code instances + one Devin: family rollup merges the
  // Claude instances into one score; model rollup groups by LLM.
  const cc1 = await registerAgent(db, {
    pubkeyHex: "b".repeat(64),
    label: "cc-1",
    family: "Claude Code",
    model: "claude-opus-4",
  });
  const cc2 = await registerAgent(db, {
    pubkeyHex: "c".repeat(64),
    label: "cc-2",
    family: "claude-code",
    model: "claude-opus-4",
  });
  const dev = await registerAgent(db, {
    pubkeyHex: "d".repeat(64),
    label: "devin-1",
    family: "devin",
    model: "swe-2",
  });
  for (const a of [cc1, cc2, dev]) {
    if (!("did" in a)) throw new Error("register failed");
    await adjustRep(db, a.did, 10);
  }

  const families = await listFamilyRollup(db);
  const claude = families.find((f) => f.tag === "claude-code");
  expect(claude).toMatchObject({ rep: 20, instances: 2, verified: false });
  expect(families.find((f) => f.tag === "devin")).toMatchObject({ rep: 10, instances: 1 });

  const models = await listModelRollup(db);
  expect(models.find((m) => m.tag === "claude-opus-4")).toMatchObject({
    rep: 20,
    instances: 2,
  });
  expect(models.find((m) => m.tag === "swe-2")).toMatchObject({ rep: 10, instances: 1 });

  // Platform seats get verified family claims.
  const seat = await registerAgent(db, {
    pubkeyHex: "e".repeat(64),
    label: "seat",
    kind: "workers-ai",
  });
  if (!("did" in seat)) throw new Error("seat register failed");
  expect(seat.family).toBe("delta-git");
  expect(seat.familyVerified).toBe(1);

  // findRepTarget carries createdAt for the account-age vote gate, and
  // adjustRep resolves session userIds (browser votes key by userId).
  if (!("did" in cc1)) throw new Error("cc1 register failed");
  const target = await findRepTarget(db, cc1.did);
  expect(target?.kind).toBe("agent");
  expect(target?.createdAt).toBeGreaterThan(0);
  const identity = await ensureIdentity(db, { did: "did:key:zVoterHuman" });
  await adjustRep(db, identity.userId, 7);
  const byUser = await findRepTarget(db, identity.userId);
  expect(byUser).toMatchObject({ kind: "identity", rep: 7 });
});

it("applyManifest commits a file set onto an empty repo", async () => {
  const repoId = makeRepoId("manifest");
  const result = await applyManifest({
    env,
    repoId,
    files: [
      { path: "blueprint.json", content: '{"landingPage":"/"}' },
      { path: "wp-content/themes/demo/style.css", content: "/* Theme: Demo */" },
      { path: "site/index.html", content: "<html><body>hi</body></html>\n" },
    ],
    message: "site-smith: demo",
    author: "site-smith <agent@delta-git.invalid>",
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/);
  // One blob per file, intermediate trees, and the commit.
  expect(result.objects.filter((o) => o.type === "blob")).toHaveLength(3);
  expect(result.objects.some((o) => o.type === "commit")).toBe(true);
  // Empty manifests and over-long manifests fail closed.
  const empty = await applyManifest({
    env,
    repoId,
    files: [],
    message: "x",
    author: "t",
  });
  expect(empty.kind).toBe("failed");
});
