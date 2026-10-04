import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";
import type { AgentRow } from "@/worker/db/d1/schema";
import type { MergeIntentRow } from "@/worker/do/repo/db/schema";

import { getRepoStub } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { adjustAgentRep, getAgent, registerAgent, verifyAgentRequest } from "@/worker/agent/auth";
import { applyUnifiedPatch } from "@/worker/agent/patch";
import { scanTextForSecrets } from "@/worker/agent/secretscan";
import { attemptMerge, mergeDryRun } from "@/worker/merge/engine";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { encryptRepoSecret } from "@/worker/agent/secrets";
import { deliverWebhookEvent } from "@/worker/agent/webhooks";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  getStorageUsed,
  LIMITS,
  metric,
  rateLimit,
} from "@/worker/agent/abuse";
import { bytesToHex } from "@/worker/common/hex";

// delta-git agent API.
//
// Routes live under /api/* so they never shadow the UI's /:owner paths.
// Identity is either the platform PAT (Basic auth, same as git push) or a
// signed agent envelope (x-dg-* headers). Signed routes buffer the body —
// everything here is JSON.

const DEFAULT_QUORUM_K = 3;
/** Rep required to cast merge-adjudication votes (sybil gate). */
const ADJUDICATOR_MIN_REP = 0;

function json(c: AppContext, body: unknown, status = 200): Response {
  return c.json(body as never, status as never);
}

function bad(c: AppContext, reason: string, status = 400): Response {
  return json(c, { error: reason }, status);
}

async function resolveRepo(c: AppContext): Promise<RepositoryRoute | null> {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !isValidOwnerRepo(owner) || !isValidOwnerRepo(repo)) return null;
  return await resolveRepositoryRoute(c.env, owner, repo, {
    mode: "route-cache-only",
    db: c.var.db,
    log: c.var.logFor({ service: "AgentRoutes" }),
  });
}

type Principal = { actor: string; agent?: AgentRow };

/** Authenticate as PAT (Basic) or signed agent envelope. */
async function authenticate(
  c: AppContext,
  body: Uint8Array,
  route: RepositoryRoute
): Promise<Principal | Response> {
  const auth = await authenticateGitRequest(c.env, c.req.raw, route, {
    db: c.var.db,
  }).catch(() => null);
  if (auth && auth.kind === "pat") {
    return { actor: auth.verified.userId };
  }

  const verified = await verifyAgentRequest({
    db: c.var.db,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    body,
    did: c.req.header("x-dg-did") ?? null,
    ts: c.req.header("x-dg-ts") ?? null,
    nonce: c.req.header("x-dg-nonce") ?? null,
    sig: c.req.header("x-dg-sig") ?? null,
  });
  if (verified.kind !== "ok") return bad(c, `agent-auth:${verified.reason}`, 401);
  return { actor: verified.agent.did, agent: verified.agent };
}

function intentView(intent: MergeIntentRow) {
  return {
    id: intent.id,
    target_ref: intent.targetRef,
    base_oid: intent.baseOid,
    delta_ref: intent.deltaRef,
    delta_oid: intent.deltaOid,
    actor: intent.actor,
    status: intent.status,
    conflicts: intent.conflicts ? JSON.parse(intent.conflicts) : [],
    result_oid: intent.resultOid,
    created_at: intent.createdAt,
    expires_at: intent.expiresAt,
    resolved_at: intent.resolvedAt,
  };
}

export function registerAgentRoutes(router: AppRouter): void {
  // --- agent registry -----------------------------------------------------

  router.post("/api/agents", async (c) => {
    const body = await c.req.json<{ pubkey?: string; label?: string }>().catch(() => null);
    if (!body?.pubkey) return bad(c, "pubkey required");
    const agent = await registerAgent(c.var.db, { pubkeyHex: body.pubkey, label: body.label });
    if ("error" in agent) return bad(c, agent.error);
    return json(c, { did: agent.did, rep: agent.rep, label: agent.label });
  });

  router.get("/api/agents/:did", async (c) => {
    const agent = await getAgent(c.var.db, c.req.param("did"));
    if (!agent) return bad(c, "unknown-did", 404);
    return json(c, {
      did: agent.did,
      rep: agent.rep,
      label: agent.label,
      banned: agent.banned === 1,
    });
  });

  router.get("/api/leaderboard", async (c) => {
    const rows = await c.var.db.query.agents.findMany({
      columns: { did: true, rep: true, label: true },
      orderBy: (agents, { desc }) => [desc(agents.rep)],
      limit: 50,
    });
    return json(c, { agents: rows });
  });

  // --- merge intents --------------------------------------------------------

  router.get("/api/:owner/:repo/dg/intents", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const statuses = (c.req.query("status") ?? "open,merging,adjudicating,conflict").split(",");
    const intents = await stub.listMergeIntents(statuses);
    return json(c, { intents: intents.map(intentView) });
  });

  router.get("/api/:owner/:repo/dg/intents/:id", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const intent = await stub.getMergeIntent(c.req.param("id"));
    if (!intent) return bad(c, "not-found", 404);
    const votes = await stub.listMergeVotes(intent.id);
    return json(c, {
      intent: intentView(intent),
      votes: votes.map((v) => ({
        seat: v.seat,
        voter_did: v.voterDid,
        resolution_digest: v.resolutionDigest,
        rationale: v.rationale,
        created_at: v.createdAt,
      })),
    });
  });

  router.post("/api/:owner/:repo/dg/intents/:id/run", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const stub = getRepoStub(c.env, route.doName);
    const result = await attemptMerge({
      env: c.env,
      repoId: route.doName,
      stub,
      intentId: c.req.param("id"),
      actor: principal.actor,
      cacheCtx: c.var.cacheCtx,
    });
    return json(c, result as never, result.kind === "not_found" ? 404 : 200);
  });

  router.post("/api/:owner/:repo/dg/intents/:id/vote", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    if (!principal.agent) return bad(c, "agent-signature-required", 401);
    if (principal.agent.rep < ADJUDICATOR_MIN_REP) return bad(c, "insufficient-rep", 403);

    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      resolution?: {
        files: Record<string, { content_b64?: string; delete?: boolean }>;
        base_oid?: string;
      };
      rationale?: string;
    };
    if (!parsed.resolution?.files) return bad(c, "resolution.files required");

    const canonical = JSON.stringify(parsed.resolution);
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical) as BufferSource
    );
    const digest = [...new Uint8Array(digestBytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const stub = getRepoStub(c.env, route.doName);
    const intentId = c.req.param("id");
    const resolutionKey = `${doPrefix(stub.id.toString())}/resolutions/${intentId}/${digest}.json`;
    await c.env.REPO_BUCKET.put(resolutionKey, canonical);

    const outcome = await stub.castMergeVote({
      intentId,
      voterDid: principal.agent.did,
      resolutionDigest: digest,
      rationale: parsed.rationale,
      signature: c.req.header("x-dg-sig") ?? "",
      quorumK: DEFAULT_QUORUM_K,
    });
    if (outcome.status !== "accepted") {
      return bad(c, `vote:${outcome.reason}`, 409);
    }

    // Quorum reached: reward winners, slash minority voters.
    if (outcome.resolved && outcome.winningDigest) {
      const votes = await stub.listMergeVotes(intentId);
      for (const vote of votes) {
        const delta = vote.resolutionDigest === outcome.winningDigest ? 5 : -3;
        await adjustAgentRep(c.var.db, vote.voterDid, delta);
      }
      // Apply the winning resolution on the repo's merge lane.
      const winner = await c.env.REPO_BUCKET.get(
        `${doPrefix(stub.id.toString())}/resolutions/${intentId}/${outcome.winningDigest}.json`
      );
      if (winner) {
        const { applyResolution } = await import("@/worker/merge/resolution");
        await applyResolution({
          env: c.env,
          repoId: route.doName,
          stub,
          intentId,
          resolutionJson: await winner.text(),
          expectedBaseOid: (await stub.getMergeIntent(intentId))?.baseOid ?? "",
          actor: principal.actor,
          cacheCtx: c.var.cacheCtx,
        });
      }
    }

    return json(c, { seat: outcome.seat, tallies: outcome.tallies, resolved: outcome.resolved });
  });

  // --- op log + firehose ----------------------------------------------------

  router.get("/api/:owner/:repo/dg/oplog", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const since = Number(c.req.query("since") ?? "-1");
    const rows = await stub.listOpLog(Number.isFinite(since) ? since : -1);
    return json(c, {
      entries: rows.map((row) => ({
        seq: row.seq,
        hash: row.hash,
        prev_hash: row.prevHash,
        kind: row.kind,
        actor: row.actor,
        payload: JSON.parse(row.payload),
        created_at: row.createdAt,
      })),
    });
  });

  router.get("/api/:owner/:repo/dg/events", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const encoder = new TextEncoder();
    let cursor = Number(c.req.query("since") ?? "-1");

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + 50_000; // reconnect-friendly window
        const write = (data: string) => controller.enqueue(encoder.encode(data));
        write(`: connected\n\n`);
        while (Date.now() < deadline) {
          const rows = await stub.listOpLog(cursor);
          for (const row of rows) {
            cursor = row.seq;
            write(
              `event: ${row.kind}\nid: ${row.seq}\ndata: ${JSON.stringify({
                seq: row.seq,
                hash: row.hash,
                kind: row.kind,
                actor: row.actor,
                payload: JSON.parse(row.payload),
                created_at: row.createdAt,
              })}\n\n`
            );
          }
          write(`: tick ${Date.now()}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  // --- commit statuses ------------------------------------------------------

  router.post("/api/:owner/:repo/dg/status", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      sha?: string;
      state?: string;
      context?: string;
      description?: string;
      target_url?: string;
    };
    if (!parsed.sha || !parsed.state || !parsed.context) {
      return bad(c, "sha, state, context required");
    }
    if (!["pending", "success", "failure", "error"].includes(parsed.state)) {
      return bad(c, "invalid state");
    }
    const stub = getRepoStub(c.env, route.doName);
    await stub.setCommitStatus({
      row: {
        sha: parsed.sha,
        context: parsed.context.slice(0, 128),
        state: parsed.state,
        description: parsed.description?.slice(0, 512) ?? null,
        targetUrl: parsed.target_url ?? null,
        createdBy: principal.actor,
        createdAt: Date.now(),
      },
      actor: principal.actor,
    });
    return json(c, { ok: true });
  });

  router.get("/api/:owner/:repo/dg/status/:sha", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.getCommitStatuses(c.req.param("sha"));
    return json(c, {
      sha: c.req.param("sha"),
      statuses: rows.map((r) => ({
        context: r.context,
        state: r.state,
        description: r.description,
        target_url: r.targetUrl,
        created_by: r.createdBy,
        created_at: r.createdAt,
      })),
    });
  });

  // --- webhooks ---------------------------------------------------------------

  router.post("/api/:owner/:repo/dg/webhooks", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      url?: string;
      events?: string[];
      secret?: string;
    };
    if (!parsed.url || !/^https:\/\//.test(parsed.url)) return bad(c, "https url required");
    const stub = getRepoStub(c.env, route.doName);
    const id = `wh-${crypto.randomUUID().slice(0, 8)}`;
    await stub.addWebhookSub({
      row: {
        id,
        url: parsed.url,
        events: (parsed.events ?? ["push"]).join(","),
        secret: parsed.secret ?? null,
        createdBy: principal.actor,
        active: 1,
        createdAt: Date.now(),
      },
      actor: principal.actor,
    });
    return json(c, { id });
  });

  router.get("/api/:owner/:repo/dg/webhooks", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const subs = await stub.listWebhookSubs();
    return json(c, {
      webhooks: subs.map((s) => ({ id: s.id, url: s.url, events: s.events.split(",") })),
    });
  });

  // --- repo secrets (write-only, Cloudflare `wrangler secret` contract) ---------

  router.put("/api/:owner/:repo/dg/secrets/:name", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { value?: string };
    if (!parsed.value) return bad(c, "value required");
    const name = c.req.param("name").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return bad(c, "invalid secret name");
    const ciphertext = await encryptRepoSecret(c.env, parsed.value);
    const stub = getRepoStub(c.env, route.doName);
    await stub.putRepoSecret({ name, ciphertext, actor: principal.actor });
    return json(c, { ok: true, name });
  });

  router.get("/api/:owner/:repo/dg/secrets", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.listRepoSecretMeta();
    return json(c, {
      secrets: rows.map((r) => ({
        name: r.name,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
    });
  });

  // --- /patch: agent commits without a clone ------------------------------------

  router.post("/api/:owner/:repo/dg/patch", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      base_ref?: string;
      patch?: string;
      message?: string;
      author?: string;
    };
    if (!parsed.patch || !parsed.message) return bad(c, "patch + message required");
    const secretFindings = scanTextForSecrets(parsed.patch);
    if (secretFindings.length > 0) {
      return bad(c, `push-protection: ${secretFindings.map((f) => f.name).join(", ")}`, 422);
    }
    const targetRef = parsed.base_ref?.startsWith("refs/")
      ? parsed.base_ref
      : `refs/heads/${parsed.base_ref ?? "main"}`;

    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const base = refs.find((r) => r.name === targetRef);
    if (!base) return bad(c, `unknown base ref ${targetRef}`, 404);

    const applied = await applyUnifiedPatch({
      env: c.env,
      repoId: route.doName,
      baseCommitOid: base.oid,
      patchText: parsed.patch,
      message: parsed.message,
      author: parsed.author ?? `${principal.actor} <agent@delta-git.invalid>`,
      cacheCtx: c.var.cacheCtx,
    });
    if (applied.kind === "failed") return bad(c, `patch:${applied.reason}`, 422);

    const pack = await writeServerPack(applied.objects);
    const packKey = r2PackKey(
      doPrefix(stub.id.toString()),
      `pack-patch-${applied.commitOid.slice(0, 12)}.pack`
    );
    await c.env.REPO_BUCKET.put(packKey, pack.packBytes);
    await c.env.REPO_BUCKET.put(packIndexKey(packKey), pack.idxBytes);

    const accepted = await stub.acceptPatchCommit({
      targetRef,
      newOid: applied.commitOid,
      actor: principal.actor,
      kind: "push.patch",
      stagedPack: {
        packKey,
        packBytes: pack.packBytes.length,
        idxBytes: pack.idxBytes.length,
        objectCount: pack.objectCount,
      },
    });
    // applyUnifiedPatch memoized the pack catalog before the patch pack was
    // registered; drop it so the merge attempt sees the new objects.
    if (c.var.cacheCtx?.memo) {
      c.var.cacheCtx.memo.packCatalog = undefined;
      c.var.cacheCtx.memo.packCatalogPromise = undefined;
    }
    // Auto-attempt merge — most patches merge cleanly and land immediately.
    const merge = await attemptMerge({
      env: c.env,
      repoId: route.doName,
      stub,
      intentId: accepted.intent.id,
      actor: principal.actor,
      cacheCtx: c.var.cacheCtx,
    });

    await deliverWebhookEvent(c.env, route, stub, {
      kind: "push.patch",
      payload: { intent_id: accepted.intent.id, commit_oid: applied.commitOid },
    });

    return json(c, { commit_oid: applied.commitOid, intent: intentView(accepted.intent), merge });
  });

  // --- merge dry-run: predict conflicts without mutating state ---------------

  router.post("/api/:owner/:repo/dg/merge/dryrun", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const parsed = await c.req.json<{ ref?: string; delta_oid?: string }>().catch(() => null);
    if (!parsed?.delta_oid) return bad(c, "delta_oid required");
    const targetRef = parsed.ref?.startsWith("refs/")
      ? parsed.ref
      : `refs/heads/${parsed.ref ?? "main"}`;
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const base = refs.find((r) => r.name === targetRef);
    if (!base) return bad(c, `unknown ref ${targetRef}`, 404);
    const result = await mergeDryRun({
      env: c.env,
      repoId: route.doName,
      targetRef,
      baseOid: base.oid,
      deltaOid: parsed.delta_oid,
      cacheCtx: c.var.cacheCtx,
    });
    if ("error" in result) return bad(c, result.error, 422);
    return json(c, result);
  });

  // --- context/provenance: what produced this commit -------------------------

  router.get("/api/:owner/:repo/dg/context/:sha", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const sha = c.req.param("sha").toLowerCase();
    const stub = getRepoStub(c.env, route.doName);
    const [open, adjudicated] = await Promise.all([
      stub.listMergeIntents(["open", "merging", "adjudicating", "conflict"]),
      stub.listMergeIntents(["merged", "rejected", "expired"]),
    ]);
    const related = [...open, ...adjudicated].filter(
      (i) =>
        i.deltaOid.toLowerCase() === sha ||
        i.baseOid.toLowerCase() === sha ||
        i.resultOid?.toLowerCase() === sha
    );
    const votes: Record<string, unknown[]> = {};
    for (const intent of related) {
      votes[intent.id] = (await stub.listMergeVotes(intent.id)).map((v) => ({
        seat: v.seat,
        voter_did: v.voterDid,
        digest: v.resolutionDigest,
        rationale: v.rationale,
      }));
    }
    const opEntries = (await stub.listOpLog(-1))
      .filter((row) => JSON.stringify(row).includes(sha))
      .map((row) => ({ seq: row.seq, kind: row.kind, hash: row.hash, created_at: row.createdAt }));
    return json(c, {
      sha,
      intents: related.map(intentView),
      votes,
      op_log: opEntries,
    });
  });

  // --- repo importer (git clone for agents) -------------------------------------

  router.post("/api/:owner/:repo/dg/import", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      url?: string;
      branch?: string;
    };
    if (!parsed.url) return bad(c, "url required");
    const stub = getRepoStub(c.env, route.doName);
    const { importRemoteRepo } = await import("@/worker/agent/importer");
    const outcome = await importRemoteRepo({
      env: c.env,
      repoId: route.doName,
      stub,
      url: parsed.url,
      branch: parsed.branch,
      actor: principal.actor,
      cacheCtx: c.var.cacheCtx,
    });
    if (outcome.kind === "not_empty") {
      return bad(c, `repo-not-empty:${outcome.refs}`, 409);
    }
    if (outcome.kind === "failed") return bad(c, outcome.reason, 502);
    return json(c, outcome);
  });

  // --- work intents (claimable work items) ------------------------------------

  router.get("/api/:owner/:repo/dg/work", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.listWorkIntents();
    return json(c, {
      work: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        created_by: row.createdBy,
        status: row.status,
        claimed_by: row.claimedBy,
        claim_expires_at: row.claimExpiresAt,
        created_at: row.createdAt,
      })),
    });
  });

  router.post("/api/:owner/:repo/dg/work", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      title?: string;
      body?: string;
    };
    if (!parsed.title?.trim()) return bad(c, "title required");
    const stub = getRepoStub(c.env, route.doName);
    const row = await stub.createWorkIntent({
      row: {
        id: `work-${crypto.randomUUID().slice(0, 8)}`,
        title: parsed.title.slice(0, 200),
        body: parsed.body?.slice(0, 8000) ?? null,
        createdBy: principal.actor,
        kind: "work",
        sourceUri: null,
        result: null,
        status: "open",
        claimedBy: null,
        claimExpiresAt: null,
        createdAt: Date.now(),
        closedAt: null,
      },
      actor: principal.actor,
    });
    return json(c, { id: row.id, status: row.status });
  });

  router.post("/api/:owner/:repo/dg/work/:id/claim", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const stub = getRepoStub(c.env, route.doName);
    const outcome = await stub.claimWorkIntent({
      id: c.req.param("id"),
      actor: principal.actor,
    });
    if (outcome.status !== "claimed") return bad(c, "work-unavailable", 409);
    return json(c, { claimed: true, expires_at: outcome.row.claimExpiresAt });
  });

  router.post("/api/:owner/:repo/dg/work/:id/close", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const stub = getRepoStub(c.env, route.doName);
    const outcome = await stub.closeWorkIntent({
      id: c.req.param("id"),
      actor: principal.actor,
    });
    if (outcome.status !== "closed") return bad(c, "work-unavailable", 409);
    return json(c, { closed: true });
  });

  // --- ideas: free-text proposals that agents turn into work -------------------
  // `kind="idea"` work intents. Humans post ideas (DID session, PAT, or
  // signed agent); the overnight agent claims them and drives
  // idea→spec→patch→merge; humans verify via quorum votes.

  router.get("/api/:owner/:repo/dg/ideas", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const ideas = await stub.listWorkIntentsByKind("idea");
    const votes = await Promise.all(ideas.map((i) => stub.listWorkVotes(i.id)));
    return json(c, {
      ideas: ideas.map((row, i) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        source_uri: row.sourceUri,
        created_by: row.createdBy,
        status: row.status,
        claimed_by: row.claimedBy,
        result: row.result,
        votes: votes[i].map((v) => ({
          seat: v.seat,
          voter_did: v.voterDid,
          digest: v.resolutionDigest,
        })),
        created_at: row.createdAt,
      })),
    });
  });

  router.post("/api/:owner/:repo/dg/ideas", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.ideaPost, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      title?: string;
      body?: string;
      source_uri?: string;
    };
    if (!parsed.title?.trim() && !parsed.body?.trim()) return bad(c, "title-or-body required");
    const stub = getRepoStub(c.env, route.doName);
    const row = await stub.createWorkIntent({
      row: {
        id: `idea-${crypto.randomUUID().slice(0, 8)}`,
        title: (parsed.title ?? parsed.body ?? "").slice(0, 200) || "untitled idea",
        body: parsed.body?.slice(0, 8000) ?? null,
        createdBy: principal.actor,
        kind: "idea",
        sourceUri: parsed.source_uri?.slice(0, 500) ?? null,
        result: null,
        status: "open",
        claimedBy: null,
        claimExpiresAt: null,
        createdAt: Date.now(),
        closedAt: null,
      },
      actor: principal.actor,
    });
    metric(c.env, "agent.action", { scope: "idea.post", index: principal.actor });
    return json(c, { id: row.id, status: row.status });
  });

  // Import an idea from an at:// URI or social post URL. The provenance is
  // kept verbatim in source_uri — fetching is best-effort (bsky public API).
  router.post("/api/:owner/:repo/dg/ideas/import", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.ideaImport, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      url?: string;
      title?: string;
    };
    if (!parsed.url) return bad(c, "url required");

    let title = parsed.title?.trim() ?? "";
    let text = "";
    const uri = parsed.url.trim();
    if (uri.startsWith("at://")) {
      // at://did/collection/rkey → fetch the record via public bsky API.
      const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
      if (m && m[2] === "app.bsky.feed.post") {
        const api = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`;
        const res = await fetch(api).catch(() => undefined);
        if (res?.ok) {
          const data = (await res.json().catch(() => undefined)) as
            | { posts?: { record?: { text?: string } }[] }
            | undefined;
          text = data?.posts?.[0]?.record?.text?.slice(0, 8000) ?? "";
        }
      }
    }
    if (!title) title = text.split("\n")[0].slice(0, 200) || uri.slice(0, 80);
    if (!text) text = `Imported idea source: ${uri}`;

    const stub = getRepoStub(c.env, route.doName);
    const row = await stub.createWorkIntent({
      row: {
        id: `idea-${crypto.randomUUID().slice(0, 8)}`,
        title,
        body: text,
        createdBy: principal.actor,
        kind: "idea",
        sourceUri: uri.slice(0, 500),
        result: null,
        status: "open",
        claimedBy: null,
        claimExpiresAt: null,
        createdAt: Date.now(),
        closedAt: null,
      },
      actor: principal.actor,
    });
    metric(c.env, "agent.action", { scope: "idea.import", index: principal.actor });
    return json(c, { id: row.id, status: row.status });
  });

  // Verify-by-quorum: agents/humans cast signed votes toward a shared
  // resolution digest (e.g. "verified:<sha256>"). Majority closes the idea.
  router.post("/api/:owner/:repo/dg/ideas/:id/verify", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.vote, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      resolution_digest?: string;
      rationale?: string;
    };
    if (!parsed.resolution_digest) return bad(c, "resolution_digest required");
    const stub = getRepoStub(c.env, route.doName);
    const digest = parsed.resolution_digest.slice(0, 200);
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${principal.actor}:${digest}`)
    );
    const outcome = await stub.castWorkVote({
      workIntentId: c.req.param("id"),
      voterDid: principal.actor,
      resolutionDigest: digest,
      rationale: parsed.rationale?.slice(0, 500),
      signature: bytesToHex(new Uint8Array(digestBytes)),
      quorumK: DEFAULT_QUORUM_K,
    });
    if (outcome.status !== "accepted") return bad(c, `vote:${outcome.reason}`, 409);
    return json(c, outcome);
  });

  router.get("/api/:owner/:repo/dg/ideas/:id/votes", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const votes = await stub.listWorkVotes(c.req.param("id"));
    return json(c, {
      votes: votes.map((v) => ({
        seat: v.seat,
        voter_did: v.voterDid,
        digest: v.resolutionDigest,
        rationale: v.rationale,
        created_at: v.createdAt,
      })),
    });
  });

  // Kick an overnight self-improvement pass for this repo (agent lane).
  router.post("/api/:owner/:repo/dg/overnight", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const stub = getRepoStub(c.env, route.doName);
    const parsed =
      body.length > 0
        ? (JSON.parse(new TextDecoder().decode(body)) as { work_intent_id?: string })
        : {};
    await c.env.REPO_TASKS_QUEUE.send({
      kind: "overnight",
      doId: stub.id.toString(),
      repoId: route.doName,
      workIntentId: parsed.work_intent_id,
    });
    return json(c, { queued: true });
  });

  // --- provenance export ------------------------------------------------------
  // GET /dg/export → signed, tamper-evident bundle: op-log, intents, votes,
  // attestations, refs, repo metadata. The manifest is HMAC'd with the
  // worker KEK so a forge-issued export is attributable.

  router.get("/api/:owner/:repo/dg/export", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const [refsData, opLog, intents, ideas] = await Promise.all([
      stub.getHeadAndRefs(),
      stub.listOpLog(-1),
      stub.listMergeIntents([
        "open",
        "merging",
        "adjudicating",
        "conflict",
        "merged",
        "rejected",
        "expired",
      ]),
      stub.listWorkIntentsByKind("idea"),
    ]);
    const votes: Record<string, unknown[]> = {};
    for (const intent of intents) {
      votes[intent.id] = (await stub.listMergeVotes(intent.id)).map((v) => ({
        seat: v.seat,
        voter_did: v.voterDid,
        digest: v.resolutionDigest,
        rationale: v.rationale,
        signature: v.signature,
      }));
    }
    // Embed DSSE envelopes for merged commits where they exist.
    const doId = stub.id.toString();
    const attestations: Record<string, unknown> = {};
    for (const intent of intents) {
      if (!intent.resultOid) continue;
      const key = `${doPrefix(doId)}/attestations/${intent.resultOid.toLowerCase()}.dsse.json`;
      const obj = await c.env.REPO_BUCKET.get(key);
      if (obj) attestations[intent.resultOid] = JSON.parse(await obj.text());
    }
    const bundle = {
      version: 1,
      exported_at: Date.now(),
      repo: { owner: route.routeNamespaceSlug, repo: route.routeRepoSlug },
      refs: refsData,
      op_log: opLog,
      merge_intents: intents,
      merge_votes: votes,
      work_intents: ideas,
      attestations,
    };
    const bundleJson = JSON.stringify(bundle);
    const manifestHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(bundleJson)
    );
    const kek = (c.env as { DG_KEK?: string }).DG_KEK ?? "insecure-dev-kek";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(kek) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(bundleJson) as BufferSource
    );
    const envelope = {
      manifest_sha256: bytesToHex(new Uint8Array(manifestHash)),
      signature: `hmac-sha256:${bytesToHex(new Uint8Array(sig))}`,
      tip_op_log_hash: opLog.length > 0 ? opLog[opLog.length - 1].hash : null,
      bundle,
    };
    return new Response(JSON.stringify(envelope), {
      headers: {
        "Content-Type": "application/x-dg-provenance+json",
        "Cache-Control": "no-store",
      },
    });
  });

  // --- ops stats: storage quota usage for this namespace ------------------------

  router.get("/api/:owner/:repo/dg/stats", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const used = await getStorageUsed(c.env.ROUTES, route.namespaceId);
    return json(c, {
      namespace_id: route.namespaceId,
      storage_used_bytes: used,
      storage_quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
    });
  });

  // --- merge attestations (in-toto / DSSE envelopes) ---------------------------

  router.get("/api/:owner/:repo/dg/attest/:sha", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const doId = c.env.REPO_DO.idFromName(route.doName).toString();
    const key = `${doPrefix(doId)}/attestations/${c.req.param("sha").toLowerCase()}.dsse.json`;
    const obj = await c.env.REPO_BUCKET.get(key);
    if (!obj) return bad(c, "attestation-not-found", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/vnd.dsse-envelope+json",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
}
