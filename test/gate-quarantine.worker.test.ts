// Delivery gates → quarantine, not rejection.
//
// A push denied by a freeze window or an enforce-mode policy must still
// land: the objects are staged, holdable heads commands rewrite to delta
// refs, and merge intents hold them until the gate closes. Unexpired
// overrides exempt their subject (freeze/policy, by id or identifier).

import { describe, it, expect, beforeAll } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";

import { ensureD1Migrations } from "./util/d1Setup";
import { setupRepoForTests, lookupPushAuth, type SetupRepoForTestsResult } from "./util/repoSeed";
import { uniqueRepoId } from "./util/test-helpers";
import { seedPackFirstRepo } from "./util/pack-first";
import { buildStreamingReceiveBody, decodeReportStatus } from "./util/streaming-helpers";
import { getRepoStub } from "@/worker/common";

let seeded: SetupRepoForTestsResult;
let owner: string;
let repo: string;
let mainHead: string;

async function req(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await workerExports.default.fetch(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", Cookie: seeded.cookieHeader },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function pushMain(nextText: string) {
  const built = await buildStreamingReceiveBody({
    parentOid: mainHead,
    nextText,
    commitMessage: `gate test ${nextText}`,
    capabilities: "report-status ofs-delta agent=test",
  });
  const auth = lookupPushAuth(owner, repo);
  const res = await workerExports.default.fetch(
    `https://example.com/${owner}/${repo}/git-receive-pack`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        Authorization: auth ?? "",
      },
      body: built.body,
    } as never
  );
  const statuses = decodeReportStatus(new Uint8Array(await res.arrayBuffer()));
  return { res, statuses, commitOid: built.commit.oid };
}

async function refsNow(): Promise<Map<string, string>> {
  const stub = getRepoStub(env, `${owner}/${repo}`);
  const { refs } = await stub.getHeadAndRefs();
  return new Map(refs.map((r) => [r.name, r.oid]));
}

beforeAll(async () => {
  await ensureD1Migrations(env);
  owner = `gate-${Math.random().toString(36).slice(2, 8)}`;
  repo = uniqueRepoId("gaterepo");
  seeded = await setupRepoForTests(env, owner, repo);
  const seededRepo = await seedPackFirstRepo(`${owner}/${repo}`);
  mainHead = seededRepo.nextCommit.oid;
});

describe("delivery gates quarantine pushes", () => {
  it("ungated push advances main normally", async () => {
    const { res, statuses, commitOid } = await pushMain("ungated-one\n");
    expect(res.status).toBe(200);
    expect(statuses).toContain("ok refs/heads/main");
    const refs = await refsNow();
    expect(refs.get("refs/heads/main")).toBe(commitOid);
    mainHead = commitOid;
  });

  it("an active freeze window quarantines the push into a merge intent", async () => {
    const create = await req(`/api/v1/spaces/${owner}/freezewindows`, {
      method: "POST",
      body: { identifier: "always-on", schedule: "su-sa", applies_to: "push" },
    });
    expect(create.status).toBe(201);

    const { res, statuses, commitOid } = await pushMain("frozen-two\n");
    // The push is NOT rejected — it lands on a delta ref.
    expect(res.status).toBe(200);
    expect(statuses).toContain("ok refs/heads/main");

    const refs = await refsNow();
    // Canonical branch unmoved; the pushed commit sits on a delta ref.
    expect(refs.get("refs/heads/main")).toBe(mainHead);
    const deltaRefs = [...refs.keys()].filter((r) => r.startsWith("refs/delta/"));
    expect(deltaRefs.length).toBe(1);
    expect(refs.get(deltaRefs[0])).toBe(commitOid);

    // The merge intent is open, holding the quarantined update.
    const intents = await req(`/api/${owner}/${repo}/dg/intents`, {});
    const open = (intents.body as { intents?: { status: string; delta_oid: string }[] }).intents;
    expect(open?.some((i) => i.delta_oid === commitOid && i.status === "open")).toBe(true);
  });

  it("an override on the freeze window lets the push through", async () => {
    const create = await req(`/api/v1/spaces/${owner}/overrides`, {
      method: "POST",
      body: { subject: "freeze:always-on", reason: "test exemption" },
    });
    expect(create.status).toBe(201);

    const { res, statuses, commitOid } = await pushMain("exempted-three\n");
    expect(res.status).toBe(200);
    expect(statuses).toContain("ok refs/heads/main");
    const refs = await refsNow();
    expect(refs.get("refs/heads/main")).toBe(commitOid);
    // No new delta refs — the push applied directly.
    expect([...refs.keys()].filter((r) => r.startsWith("refs/delta/")).length).toBe(1);
    mainHead = commitOid;
  });

  it("an enforce-mode policy quarantines and a warn policy does not", async () => {
    // Enforce deny on main pushes.
    const enforce = await req(`/api/v1/spaces/${owner}/policies`, {
      method: "POST",
      body: {
        identifier: "no-main-push",
        applies_to: "push",
        enforcement: "enforce",
        document: [
          {
            when: { field: "branch", op: "eq", value: "main" },
            action: "deny",
            message: "no main pushes",
          },
        ],
      },
    });
    expect(enforce.status).toBe(201);
    // The freeze override doesn't cover the policy — push quarantines again.
    const { res, statuses } = await pushMain("policy-four\n");
    expect(res.status).toBe(200);
    expect(statuses).toContain("ok refs/heads/main");
    const refs = await refsNow();
    expect(refs.get("refs/heads/main")).toBe(mainHead);
    expect([...refs.keys()].filter((r) => r.startsWith("refs/delta/")).length).toBe(2);

    // A policy override exempts it — next push lands directly.
    const ovr = await req(`/api/v1/spaces/${owner}/overrides`, {
      method: "POST",
      body: { subject: "policy:no-main-push", reason: "hotfix" },
    });
    expect(ovr.status).toBe(201);
    const second = await pushMain("policy-five\n");
    expect(second.statuses).toContain("ok refs/heads/main");
    const after = await refsNow();
    expect(after.get("refs/heads/main")).toBe(second.commitOid);
  });
});
