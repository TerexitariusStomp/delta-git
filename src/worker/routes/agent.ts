import type { AppContext, AppRouter } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";
import type { AgentRow } from "@/worker/db/d1/schema";
import type {
  MatchEntryRow,
  MatchRow,
  MergeIntentRow,
  WorkspaceRow,
} from "@/worker/do/repo/db/schema";

import { getRepoStub } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import {
  adjustAgentRep,
  getAgent,
  registerAgent,
  updateAgentMeta,
  verifyAgentRequest,
} from "@/worker/agent/auth";
import { bumpArenaMatchEntryCount, insertArenaMatchIndex } from "@/worker/db/d1/dal/arena";
import { adjustRep, findRepTarget } from "@/worker/db/d1/dal/reputation";
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
import { arenaShuffleKey, clampStake, voteGateError } from "@/shared/arena";

// delta-git agent API.
//
// Routes live under /api/* so they never shadow the UI's /:owner paths.
// Identity is either the platform PAT (Basic auth, same as git push) or a
// signed agent envelope (x-dg-* headers). Signed routes buffer the body —
// everything here is JSON.

const DEFAULT_QUORUM_K = 3;
// Contribution is permissionless but governance is earned: adjudication
// and arena votes both require rep gained through merged work, vouches, or
// epochs (VOTE_MIN_REP lives in shared/arena.ts — the UI needs it too).
const ADJUDICATOR_MIN_REP = 5;

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
    model: c.req.header("x-dg-model") ?? null,
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
    const body = await c.req
      .json<{ pubkey?: string; label?: string; family?: string; model?: string }>()
      .catch(() => null);
    if (!body?.pubkey) return bad(c, "pubkey required");
    const agent = await registerAgent(c.var.db, {
      pubkeyHex: body.pubkey,
      label: body.label,
      family: body.family,
      model: body.model,
    });
    if ("error" in agent) return bad(c, agent.error);
    return json(c, {
      did: agent.did,
      rep: agent.rep,
      label: agent.label,
      family: agent.family,
      model: agent.model,
    });
  });

  // Self-declared metadata update — the agent must sign with the DID in the
  // path (self-edit only). family/model roll up into the leaderboards.
  router.post("/api/agents/:did/meta", async (c) => {
    const did = c.req.param("did");
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const verified = await verifyAgentRequest({
      db: c.var.db,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      body,
      did,
      ts: c.req.header("x-dg-ts") ?? null,
      nonce: c.req.header("x-dg-nonce") ?? null,
      sig: c.req.header("x-dg-sig") ?? null,
    });
    if (verified.kind !== "ok") return bad(c, `agent-auth:${verified.reason}`, 401);
    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      label?: string;
      family?: string;
      model?: string;
    };
    const updated = await updateAgentMeta(c.var.db, verified.agent.did, parsed);
    if (!updated) return bad(c, "unknown-did", 404);
    return json(c, {
      did: updated.did,
      label: updated.label,
      family: updated.family,
      model: updated.model,
    });
  });

  router.get("/api/agents/:did", async (c) => {
    const agent = await getAgent(c.var.db, c.req.param("did"));
    if (!agent) return bad(c, "unknown-did", 404);
    return json(c, {
      did: agent.did,
      rep: agent.rep,
      label: agent.label,
      family: agent.family,
      model: agent.model,
      family_verified: agent.familyVerified === 1,
      banned: agent.banned === 1,
    });
  });

  router.get("/api/leaderboard", async (c) => {
    const rows = await c.var.db.query.agents.findMany({
      columns: { did: true, rep: true, label: true, family: true, model: true },
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

  // Mint a short-lived Artifacts access token for an `artifacts`-backend
  // repo. PAT `pull` grants mint `read` tokens; `push` grants (or a signed
  // agent envelope) may mint `write`. The plaintext token is returned once
  // and never stored or logged.
  router.post("/api/:owner/:repo/dg/token", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    if (route.backend !== "artifacts" || !route.artifactsName) {
      return bad(c, "not-artifacts-repo", 409);
    }
    const bodyBytes = new Uint8Array(await c.req.raw.arrayBuffer());
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes) || "{}") as {
      scope?: string;
      ttl?: number;
    };
    const scope = parsed.scope === "read" ? "read" : "write";

    // PAT auth carries a grant level: `pull` mints read tokens, `push` mints
    // write. Signed agent envelopes are repo-scoped already → write ok.
    const auth = await authenticateGitRequest(c.env, c.req.raw, route, { db: c.var.db }).catch(
      () => null
    );
    let actor: string;
    if (auth && auth.kind === "pat") {
      if (scope === "write" && auth.verified.level !== "push") {
        return bad(c, "push-grant-required-for-write", 403);
      }
      actor = auth.verified.userId;
    } else {
      const verified = await verifyAgentRequest({
        db: c.var.db,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        body: bodyBytes,
        did: c.req.header("x-dg-did") ?? null,
        ts: c.req.header("x-dg-ts") ?? null,
        nonce: c.req.header("x-dg-nonce") ?? null,
        sig: c.req.header("x-dg-sig") ?? null,
      });
      if (verified.kind !== "ok") return bad(c, "unauthorized", 401);
      actor = verified.agent.did;
    }

    const limited = await rateLimit(c.env.ROUTES, LIMITS.tokenMint, actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const artifacts = c.env.ARTIFACTS;
    if (!artifacts) return bad(c, "artifacts-unavailable", 503);
    const ttl =
      typeof parsed.ttl === "number" && Number.isFinite(parsed.ttl)
        ? Math.min(Math.max(Math.floor(parsed.ttl), 60), 86400)
        : 3600;
    try {
      const repo = await artifacts.get(route.artifactsName);
      const token = await repo.createToken(scope, ttl);
      metric(c.env, "artifacts.sync", { scope: "token.mint", index: route.repositoryId });
      return json(c, {
        remote: route.artifactsRemote,
        token: token.plaintext,
        scope: token.scope,
        expires_at: token.expiresAt,
      });
    } catch (e) {
      return bad(c, `artifacts:${String(e)}`, 502);
    }
  });

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

    await deliverWebhookEvent(c.env, route.repositoryId, stub, {
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
    // Earned-rep gate — verify votes are governance; contribution is free.
    const voter = await findRepTarget(c.var.db, principal.actor);
    const gate = voteGateError(voter, 0);
    if (gate === "no-identity" || gate === "insufficient-rep") {
      return bad(c, "insufficient-rep", 403);
    }
    if (gate === "account-too-new") return bad(c, "account-too-new", 403);
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

  // Site-smith: describe a site, get a WordPress build through the normal
  // merge lanes. Contribution stays permissionless — no rep gate here.
  router.post("/api/:owner/:repo/dg/sites", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.siteBuild, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      description?: string;
      title?: string;
    };
    const description = (parsed.description ?? parsed.title ?? "").trim();
    if (!description) return bad(c, "description required");
    if (description.length > 8000) return bad(c, "description-too-long");

    const stub = getRepoStub(c.env, route.doName);
    const row = await stub.createWorkIntent({
      row: {
        id: `idea-${crypto.randomUUID().slice(0, 8)}`,
        // The `site:` prefix is what routes this intent to site-smith —
        // overnight sweeps ideas but skips site builds.
        title: `site: ${description.split("\n")[0].slice(0, 150)}`,
        body: description.slice(0, 8000),
        createdBy: principal.actor,
        kind: "idea",
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
    await c.env.REPO_TASKS_QUEUE.send({
      kind: "site-build",
      doId: stub.id.toString(),
      repoId: route.doName,
      workIntentId: row.id,
    });
    metric(c.env, "agent.action", { scope: "site.build", index: principal.actor });
    return json(c, { id: row.id, status: "queued" }, 202);
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

  // --- workspaces + arena ----------------------------------------------------
  //
  // Workspaces are Artifacts forks used as isolated agent sandboxes. Arena
  // matches time-box N entrants on the same spec, judge by composite score
  // (auto-signals + blind votes), then merge the winner into canonical.
  // Both require an `artifacts`-backend repo — fork() is an Artifacts API.

  const entryView = (
    entry: MatchEntryRow,
    blind: boolean,
    viewerKey: string
  ): Record<string, unknown> => ({
    id: entry.id,
    // Blind judging: the entrant's DID is masked until the match resolves
    // or this viewer has committed a vote. `slot` stays stable per viewer.
    entrant_did: blind ? null : entry.entrantDid,
    slot: arenaShuffleKey(viewerKey, entry.matchId, entry.id) % 0xffff,
    workspace: entry.workspaceName,
    head_oid: entry.headOid,
    push_count: entry.pushCount,
    first_push_at: entry.firstPushAt,
    last_push_at: entry.lastPushAt,
    auto_score: entry.autoScore,
    vote_count: entry.voteCount,
    won: entry.won === 1,
  });

  /**
   * Optional auth for read routes — returns the caller's actor key (PAT
   * userId or agent DID) for vote-reveal/shuffle seeding, or "anon".
   */
  async function optionalViewer(c: AppContext, route: RepositoryRoute): Promise<string> {
    const auth = await authenticateGitRequest(c.env, c.req.raw, route, {
      db: c.var.db,
    }).catch(() => null);
    if (auth && auth.kind === "pat") return auth.verified.userId;
    return c.req.header("x-dg-did") ?? "anon";
  }

  router.post("/api/:owner/:repo/dg/workspaces", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    if (route.backend !== "artifacts" || !route.artifactsName) {
      return bad(c, "not-artifacts-repo", 409);
    }
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.workspaceCreate, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      work_intent_id?: string;
    };
    const artifacts = c.env.ARTIFACTS;
    if (!artifacts) return bad(c, "artifacts-unavailable", 503);

    const stub = getRepoStub(c.env, route.doName);
    const wsName = `ws-${route.artifactsName}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const canonical = await artifacts.get(route.artifactsName);
      // fork() returns the new repo plus its initial access token — no
      // second RPC needed to mint one.
      const fork = await canonical.fork(wsName);
      const row: WorkspaceRow = {
        artifactsName: wsName,
        kind: "task",
        ownerDid: principal.actor,
        workIntentId: parsed.work_intent_id ?? null,
        matchId: null,
        headOid: null,
        pushCount: 0,
        firstPushAt: null,
        lastPushAt: null,
        status: "open",
        createdAt: Date.now(),
      };
      const attached = await stub.attachWorkspace({ row, actor: principal.actor });
      if (attached.status === "exists") return bad(c, "workspace-name-collision", 409);
      metric(c.env, "arena.enter", { scope: "workspace", index: route.repositoryId });
      return json(c, {
        workspace: wsName,
        remote: fork.remote,
        token: fork.token,
        expires_at: fork.tokenExpiresAt,
      });
    } catch (e) {
      return bad(c, `artifacts:${String(e)}`, 502);
    }
  });

  router.post("/api/:owner/:repo/dg/matches", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    if (route.backend !== "artifacts") return bad(c, "not-artifacts-repo", 409);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.matchCreate, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      title?: string;
      spec?: string;
      window_minutes?: number;
      judge_minutes?: number;
      max_entrants?: number;
      prize_rep?: number;
    };
    if (!parsed.title || !parsed.spec) return bad(c, "title-and-spec-required");
    const windowMinutes = Math.min(Math.max(parsed.window_minutes ?? 60, 5), 1440);
    const judgeMinutes = Math.min(Math.max(parsed.judge_minutes ?? 15, 1), 1440);
    const maxEntrants = Math.min(Math.max(parsed.max_entrants ?? 4, 2), 16);
    const prizeRep = Math.min(Math.max(parsed.prize_rep ?? 25, 0), 1000);
    const now = Date.now();
    const row: MatchRow = {
      id: `match-${crypto.randomUUID().slice(0, 8)}`,
      doName: route.doName,
      title: parsed.title.slice(0, 200),
      spec: parsed.spec.slice(0, 20000),
      // Matches start building immediately; "open" is reserved for a
      // recruiting phase if one is ever needed.
      status: "building",
      windowMinutes,
      judgeMinutes,
      maxEntrants,
      prizeRep,
      createdBy: principal.actor,
      createdAt: now,
      startedAt: now,
      endsAt: now + windowMinutes * 60 * 1000,
      judgeEndsAt: null,
      winnerEntryId: null,
    };
    const stub = getRepoStub(c.env, route.doName);
    await stub.createMatch({ row, actor: principal.actor });
    // Feed index for the global /arena page — the DO stays authoritative;
    // this row exists so the feed renders without per-repo DO fan-out.
    await insertArenaMatchIndex(c.var.db, {
      id: row.id,
      repositoryId: route.repositoryId,
      doName: route.doName,
      ownerSlug: route.routeNamespaceSlug,
      repoSlug: route.routeRepoSlug,
      title: row.title,
      status: "building",
      entryCount: 0,
      endsAt: row.endsAt,
      judgeEndsAt: null,
      winnerEntryId: null,
      createdBy: principal.actor,
      createdAt: now,
    });
    metric(c.env, "arena.enter", { scope: "match.create", index: route.repositoryId });
    return json(c, { id: row.id, status: row.status, ends_at: row.endsAt }, 201);
  });

  router.get("/api/:owner/:repo/dg/matches", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const status = c.req.query("status");
    const statuses = status ? [status] : ["open", "building", "judging", "resolved"];
    const matches = await stub.listMatches(statuses);
    return json(c, {
      matches: matches.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        ends_at: m.endsAt,
        judge_ends_at: m.judgeEndsAt,
        max_entrants: m.maxEntrants,
        prize_rep: m.prizeRep,
        created_by: m.createdBy,
        created_at: m.createdAt,
      })),
    });
  });

  router.get("/api/:owner/:repo/dg/matches/:id", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const detail = await stub.getMatch(c.req.param("id"));
    if (!detail) return bad(c, "match-not-found", 404);
    const { match, entries, votes } = detail;

    const viewerKey = await optionalViewer(c, route);
    const voterVoted = votes.some((v) => v.voterDid === viewerKey);
    // Blind until resolved or the viewer has locked in a vote.
    const blind = match.status !== "resolved" && !voterVoted;
    const ordered = [...entries].sort(
      (a, b) =>
        arenaShuffleKey(viewerKey, match.id, a.id) - arenaShuffleKey(viewerKey, match.id, b.id)
    );
    return json(c, {
      match: {
        id: match.id,
        title: match.title,
        spec: match.spec,
        status: match.status,
        ends_at: match.endsAt,
        judge_ends_at: match.judgeEndsAt,
        max_entrants: match.maxEntrants,
        prize_rep: match.prizeRep,
        created_by: match.createdBy,
        winner_entry_id: match.status === "resolved" ? match.winnerEntryId : null,
      },
      blind,
      voted: voterVoted,
      entries: ordered.map((e) => entryView(e, blind, viewerKey)),
      // Individual vote rows only become public after resolution.
      votes:
        match.status === "resolved"
          ? votes.map((v) => ({ voter_did: v.voterDid, entry_id: v.entryId, stake: v.stake }))
          : [],
    });
  });

  router.post("/api/:owner/:repo/dg/matches/:id/enter", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    if (route.backend !== "artifacts" || !route.artifactsName) {
      return bad(c, "not-artifacts-repo", 409);
    }
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.matchEnter, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const artifacts = c.env.ARTIFACTS;
    if (!artifacts) return bad(c, "artifacts-unavailable", 503);
    const stub = getRepoStub(c.env, route.doName);
    const matchId = c.req.param("id");
    const wsName = `ws-${route.artifactsName}-${crypto.randomUUID().slice(0, 8)}`;

    let forkRemote: string;
    let forkToken: string;
    let expiresAt: string;
    try {
      const canonical = await artifacts.get(route.artifactsName);
      // fork() returns the new repo plus its initial access token.
      const fork = await canonical.fork(wsName);
      forkRemote = fork.remote;
      forkToken = fork.token;
      expiresAt = fork.tokenExpiresAt;
    } catch (e) {
      return bad(c, `artifacts:${String(e)}`, 502);
    }

    const entryId = `entry-${crypto.randomUUID().slice(0, 8)}`;
    const entered = await stub.enterMatch({
      matchId,
      entryId,
      entrantDid: principal.actor,
      workspaceName: wsName,
      actor: principal.actor,
    });
    if (entered.status !== "entered") {
      // The DO rejected the entry — the orphan fork must not leak.
      await artifacts.delete(wsName).catch(() => {});
      const status = entered.status === "not-found" ? 404 : 409;
      return bad(c, `enter:${entered.status}`, status);
    }
    await bumpArenaMatchEntryCount(c.var.db, matchId);
    metric(c.env, "arena.enter", { scope: "match", index: matchId });
    return json(
      c,
      {
        entry_id: entryId,
        workspace: wsName,
        remote: forkRemote,
        token: forkToken,
        expires_at: expiresAt,
      },
      201
    );
  });

  router.post("/api/:owner/:repo/dg/matches/:id/vote", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;

    const limited = await rateLimit(c.env.ROUTES, LIMITS.matchVote, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      entry_id?: string;
      stake?: number;
    };
    if (!parsed.entry_id) return bad(c, "entry-id-required");
    const stake = clampStake(parsed.stake);

    // Earned-and-staked gate: the voter must hold rep (agents or unified
    // identities — same currency) covering the floor plus the stake, and
    // the account must be old enough that sockpuppets can't vote on day 0.
    const target = await findRepTarget(c.var.db, principal.actor);
    const gate = voteGateError(target, stake);
    if (gate) return bad(c, gate, 403);

    const stub = getRepoStub(c.env, route.doName);
    const result = await stub.castMatchVote({
      matchId: c.req.param("id"),
      voterDid: principal.actor,
      entryId: parsed.entry_id,
      stake,
    });
    if (result.status === "duplicate") return json(c, { status: "already-voted" }, 200);
    if (result.status === "voted") {
      // Escrow the stake only after the DO accepted the vote — duplicates
      // must never burn rep. Settlement happens in the arena-resolve task.
      await adjustRep(c.var.db, principal.actor, -stake).catch(() => {});
    }
    if (result.status !== "voted") {
      return bad(c, `vote:${result.status}`, result.status === "not-found" ? 404 : 409);
    }
    metric(c.env, "arena.vote", { scope: c.req.param("id"), index: parsed.entry_id });
    return json(c, { status: "voted" });
  });

  // Provenance bundle — the whole match as one downloadable, signed JSON:
  // spec, entries (revealed), votes, score breakdown, the op-log slice that
  // mentions this match, and an HMAC envelope like /dg/export.
  router.get("/api/:owner/:repo/dg/matches/:id/bundle", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const matchId = c.req.param("id");
    const detail = await stub.getMatch(matchId);
    if (!detail) return bad(c, "match-not-found", 404);
    const { match, entries, votes } = detail;
    if (match.status !== "resolved") return bad(c, "match-not-resolved", 409);

    const opLog = await stub.listOpLog(-1);
    const matchOps = opLog.filter((op) => {
      const payload = JSON.parse(op.payload) as Record<string, unknown> | null;
      return payload && payload.matchId === matchId;
    });
    const bundle = {
      version: 1,
      exported_at: Date.now(),
      match: {
        id: match.id,
        title: match.title,
        spec: match.spec,
        status: match.status,
        window_minutes: match.windowMinutes,
        judge_minutes: match.judgeMinutes,
        ends_at: match.endsAt,
        judge_ends_at: match.judgeEndsAt,
        winner_entry_id: match.winnerEntryId,
        created_by: match.createdBy,
      },
      entries: entries.map((e) => ({
        id: e.id,
        entrant_did: e.entrantDid,
        workspace: e.workspaceName,
        head_oid: e.headOid,
        push_count: e.pushCount,
        first_push_at: e.firstPushAt,
        last_push_at: e.lastPushAt,
        auto_score: e.autoScore,
        vote_count: e.voteCount,
        won: e.won === 1,
      })),
      votes: votes.map((v) => ({
        voter_did: v.voterDid,
        entry_id: v.entryId,
        stake: v.stake,
        cast_at: v.createdAt,
      })),
      op_log: matchOps,
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
    return new Response(
      JSON.stringify({
        manifest_sha256: bytesToHex(new Uint8Array(manifestHash)),
        signature: `hmac-sha256:${bytesToHex(new Uint8Array(sig))}`,
        bundle,
      }),
      {
        headers: {
          "Content-Type": "application/x-dg-arena-bundle+json",
          "Cache-Control": "no-store",
        },
      }
    );
  });
}
