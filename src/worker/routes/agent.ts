import type { AppContext, AppRouter } from "./hono";
import { workerExecutionContext } from "./hono";
import type { RepositoryRoute } from "@/worker/repositories/route";
import type { AgentRow } from "@/worker/db/d1/schema";
import type {
  MatchEntryRow,
  MatchRow,
  MergeIntentRow,
  WorkspaceRow,
} from "@/worker/do/repo/db/schema";

import { z } from "zod";

import { getRepoStub, newPrefixedId } from "@/worker/common";
import { resolveRepositoryRoute } from "@/worker/repositories/route";
import { isValidOwnerRepo } from "@/shared/web";
import { authenticateGitRequest } from "@/worker/auth/gitAuth";
import { hasOAuthScope, OAUTH_SCOPES } from "@/worker/auth/oauth";
import {
  adjustAgentRep,
  getAgent,
  registerAgent,
  updateAgentMeta,
  verifyAgentRequest,
} from "@/worker/agent/auth";
import {
  bumpArenaMatchEntryCount,
  insertArenaMatchIndex,
  listArenaMatchIndex,
} from "@/worker/db/d1/dal/arena";
import { adjustRep, findRepTarget } from "@/worker/db/d1/dal/reputation";
import { applyUnifiedPatch } from "@/worker/agent/patch";
import { scanTextForSecrets } from "@/worker/agent/secretscan";
import { attemptMerge, mergeDryRun } from "@/worker/merge/engine";
import { evaluateDeliveryGates } from "@/worker/api/gitness/delivery";
import { writeServerPack } from "@/worker/merge/packWriter";
import { doPrefix, packIndexKey, r2PackKey } from "@/worker/keys";
import { encryptRepoSecret } from "@/worker/agent/secrets";
import {
  appendRepoExecutionLogs,
  readRepoExecutionLogs,
  readRepoExecutions,
  readRepoPipelines,
  readSecuritySettings,
  updateRepoExecution,
} from "@/worker/api/gitness/stores";
import { listScanRunsForRepo, upsertScanRun } from "@/worker/db/d1/dal/scanRuns";
import {
  findArtifact,
  findDelegate,
  listArtifactsForRepo,
  updateDelegate,
  upsertArtifact,
} from "@/worker/db/d1/dal/modules";
import { findRepositoryByDoName } from "@/worker/db/d1/dal/repositories";
import { deliverWebhookEvent } from "@/worker/agent/webhooks";
import { ensureArtifactsPushSubscription } from "@/worker/tasks/artifactsSubscriptions";
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

// Request-body schemas — zod replaces `JSON.parse(...) as {...}` casts so
// malformed JSON and wrong-shaped fields fail instead of trusting the
// cast. Fields stay optional here because each route has its own
// "x required" check + error message; schemas just guarantee the shape.
const agentMetaBody = z.object({
  label: z.string().optional(),
  family: z.string().optional(),
  model: z.string().optional(),
});
const mergeVoteBody = z.object({
  resolution: z
    .object({
      files: z.record(
        z.string(),
        z.object({ content_b64: z.string().optional(), delete: z.boolean().optional() })
      ),
      base_oid: z.string().optional(),
    })
    .optional(),
  rationale: z.string().optional(),
});
const statusBody = z.object({
  sha: z.string().optional(),
  state: z.string().optional(),
  context: z.string().optional(),
  description: z.string().optional(),
  target_url: z.string().optional(),
});
const webhookBody = z.object({
  url: z.string().optional(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional(),
});
const secretValueBody = z.object({ value: z.string().optional() });
const tokenMintBody = z.object({ scope: z.string().optional(), ttl: z.number().optional() });
const patchBody = z.object({
  base_ref: z.string().optional(),
  patch: z.string().optional(),
  message: z.string().optional(),
  author: z.string().optional(),
});
const dryRunBody = z.object({ ref: z.string().optional(), delta_oid: z.string().optional() });
const importBody = z.object({ url: z.string().optional(), branch: z.string().optional() });
const workIntentBody = z.object({ title: z.string().optional(), body: z.string().optional() });
const ideaBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  source_uri: z.string().optional(),
});
const ideaImportBody = z.object({ url: z.string().optional(), title: z.string().optional() });
const ideaVerifyBody = z.object({
  resolution_digest: z.string().optional(),
  rationale: z.string().optional(),
});
const overnightBody = z.object({ work_intent_id: z.string().optional() });
const siteBuildBody = z.object({
  description: z.string().optional(),
  title: z.string().optional(),
});
const workspaceBody = z.object({ work_intent_id: z.string().optional() });
const matchCreateBody = z.object({
  title: z.string().optional(),
  spec: z.string().optional(),
  window_minutes: z.number().optional(),
  judge_minutes: z.number().optional(),
  max_entrants: z.number().optional(),
  prize_rep: z.number().optional(),
});
const matchVoteBody = z.object({ entry_id: z.string().optional(), stake: z.number().optional() });

/**
 * Buffer a buffered request body through a zod schema. Empty bodies decode
 * as `{}` (the old `|| "{}"` convention); malformed JSON or a shape the
 * schema rejects returns null — routes turn that into a 400.
 */
function parseJsonBody<S extends z.ZodType>(body: Uint8Array, schema: S): z.infer<S> | null {
  let raw: unknown = {};
  if (body.length > 0) {
    try {
      raw = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

/** Authenticate as PAT (Basic), OAuth Bearer, or signed agent envelope. */
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
  if (auth && auth.kind === "oauth") {
    if (auth.verified.member && hasOAuthScope(auth.verified.scopes, OAUTH_SCOPES.REPO_READ)) {
      return { actor: auth.verified.userId };
    }
    return bad(c, "insufficient-scope-or-membership", 403);
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

/** Write-gated authenticate — PATs must carry push-level grants (receive-pack
 * class); signed agent envelopes are write-capable by design. Used for
 * mutating dg endpoints (scan attestations, artifact uploads). */
async function authenticateWrite(
  c: AppContext,
  body: Uint8Array,
  route: RepositoryRoute
): Promise<Principal | Response> {
  const auth = await authenticateGitRequest(c.env, c.req.raw, route, {
    db: c.var.db,
  }).catch(() => null);
  if (auth && auth.kind === "pat") {
    if (auth.verified.level !== "push") return bad(c, "push-grant-required", 403);
    return { actor: auth.verified.userId };
  }
  if (auth && auth.kind === "oauth") {
    if (!(auth.verified.member && hasOAuthScope(auth.verified.scopes, OAUTH_SCOPES.REPO_WRITE))) {
      return bad(c, "push-grant-required", 403);
    }
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

type ArenaPhase = "building" | "judging" | "resolved";

/** Mirrors the SSR arena feed's phase derivation for the JSON surface. */
function deriveArenaPhase(match: {
  status: string;
  endsAt: number | null;
  judgeEndsAt: number | null;
  winnerEntryId: string | null;
}): ArenaPhase {
  if (match.status === "resolved" || match.status === "expired") return "resolved";
  if (match.status === "judging" || (match.endsAt ?? Infinity) <= Date.now()) {
    return "judging";
  }
  return "building";
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
    const parsed = parseJsonBody(body, agentMetaBody);
    if (!parsed) return bad(c, "invalid-body");
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

  // Cross-repo match feed — the same D1 `arena_matches` index the SSR /arena
  // page reads, exposed as JSON for the SPA's delta views.
  router.get("/api/arena", async (c) => {
    const rows = await listArenaMatchIndex(c.var.db, 50);
    return json(c, {
      matches: rows.map((row) => ({
        id: row.id,
        title: row.title,
        owner_slug: row.ownerSlug,
        repo_slug: row.repoSlug,
        phase: deriveArenaPhase(row),
        entry_count: row.entryCount,
        ends_at: row.endsAt,
        judge_ends_at: row.judgeEndsAt,
        created_by: row.createdBy,
        created_at: row.createdAt,
      })),
    });
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
    // Delivery gates apply to merges the same way they apply to pushes —
    // freeze windows and enforce-mode policies can hold a merge intent.
    const gate = await evaluateDeliveryGates(c.var.db, route.namespaceId, {
      op: "merge",
      actor: principal.actor,
    });
    for (const warning of gate.warnings) {
      c.var.logFor({ service: "Gates" }).warn("merge:policy-warn", {
        repo: route.doName,
        warning,
      });
    }
    if (!gate.ok) return bad(c, gate.deny ?? "merge denied by delivery gate", 403);
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

    const parsed = parseJsonBody(body, mergeVoteBody);
    if (!parsed?.resolution?.files) return bad(c, "resolution.files required");

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

  // GET /dg/oplog/verify — replays the hash chain and returns a signed
  // checkpoint. The checkpoint (tip hash + seq + timestamp) is HMAC'd with
  // the worker KEK so a forge-issued checkpoint is attributable to this
  // deployment; external verifiers recompute the chain themselves from
  // /dg/oplog or /dg/export and compare tip hashes.
  router.get("/api/:owner/:repo/dg/oplog/verify", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const stub = getRepoStub(c.env, route.doName);
    const rows = await stub.listOpLog(-1);

    const encoder = new TextEncoder();
    const hex = (buf: ArrayBuffer) =>
      [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

    let brokenAt: number | null = null;
    let expectedPrev = "genesis";
    for (const row of rows) {
      const canonical = JSON.stringify({
        seq: row.seq,
        kind: row.kind,
        actor: row.actor,
        payload: JSON.parse(row.payload),
        createdAt: row.createdAt,
      });
      const computed = hex(
        await crypto.subtle.digest("SHA-256", encoder.encode(expectedPrev + canonical))
      );
      if (row.prevHash !== expectedPrev || row.hash !== computed) {
        brokenAt = row.seq;
        break;
      }
      expectedPrev = row.hash;
    }

    const tip = rows.length > 0 ? rows[rows.length - 1]! : null;
    const checkpoint = {
      repo: `${route.routeNamespaceSlug}/${route.routeRepoSlug}`,
      tip_hash: tip?.hash ?? null,
      tip_seq: tip?.seq ?? -1,
      entries: rows.length,
      valid: brokenAt === null,
      checked_at: Date.now(),
    };
    const kek = (c.env as { DG_KEK?: string }).DG_KEK ?? "insecure-dev-kek";
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(kek) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(JSON.stringify(checkpoint)) as BufferSource
    );
    return json(c, {
      ...checkpoint,
      broken_at_seq: brokenAt,
      checkpoint_signature: `hmac-sha256:${hex(sig)}`,
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
    const parsed = parseJsonBody(body, statusBody);
    if (!parsed?.sha || !parsed.state || !parsed.context) {
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
    const parsed = parseJsonBody(body, webhookBody);
    if (!parsed?.url || !/^https:\/\//.test(parsed.url)) return bad(c, "https url required");
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
    const parsed = parseJsonBody(body, secretValueBody);
    if (!parsed?.value) return bad(c, "value required");
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
    const parsed = parseJsonBody(bodyBytes, tokenMintBody) ?? {};
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
    } else if (auth && auth.kind === "oauth") {
      const needed = scope === "write" ? OAUTH_SCOPES.REPO_WRITE : OAUTH_SCOPES.REPO_READ;
      if (!(auth.verified.member && hasOAuthScope(auth.verified.scopes, needed))) {
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

    const limited = await rateLimit(c.env, LIMITS.tokenMint, actor);
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
    const parsed = parseJsonBody(body, patchBody);
    if (!parsed?.patch || !parsed.message) return bad(c, "patch + message required");
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
    // Body isn't buffered for auth on this route, so parse straight off the
    // request stream — empty/malformed decodes to the same required-field 400.
    const parsedJson = await c.req.json().catch(() => null);
    const parsed = dryRunBody.safeParse(parsedJson ?? {});
    if (!parsed.success || !parsed.data.delta_oid) return bad(c, "delta_oid required");
    const targetRef = parsed.data.ref?.startsWith("refs/")
      ? parsed.data.ref
      : `refs/heads/${parsed.data.ref ?? "main"}`;
    const stub = getRepoStub(c.env, route.doName);
    const { refs } = await stub.getHeadAndRefs();
    const base = refs.find((r) => r.name === targetRef);
    if (!base) return bad(c, `unknown ref ${targetRef}`, 404);
    const result = await mergeDryRun({
      env: c.env,
      repoId: route.doName,
      targetRef,
      baseOid: base.oid,
      deltaOid: parsed.data.delta_oid,
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
    const parsed = parseJsonBody(body, importBody);
    if (!parsed?.url) return bad(c, "url required");
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
    const parsed = parseJsonBody(body, workIntentBody);
    if (!parsed?.title?.trim()) return bad(c, "title required");
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
    const limited = await rateLimit(c.env, LIMITS.ideaPost, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = parseJsonBody(body, ideaBody);
    if (!parsed || (!parsed.title?.trim() && !parsed.body?.trim()))
      return bad(c, "title-or-body required");
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
    const limited = await rateLimit(c.env, LIMITS.ideaImport, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = parseJsonBody(body, ideaImportBody);
    if (!parsed?.url) return bad(c, "url required");

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
    const limited = await rateLimit(c.env, LIMITS.vote, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    // Earned-rep gate — verify votes are governance; contribution is free.
    const voter = await findRepTarget(c.var.db, principal.actor);
    const gate = voteGateError(voter, 0);
    if (gate === "no-identity" || gate === "insufficient-rep") {
      return bad(c, "insufficient-rep", 403);
    }
    if (gate === "account-too-new") return bad(c, "account-too-new", 403);
    const parsed = parseJsonBody(body, ideaVerifyBody);
    if (!parsed?.resolution_digest) return bad(c, "resolution_digest required");
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
    const parsed = parseJsonBody(body, overnightBody) ?? {};
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
    const limited = await rateLimit(c.env, LIMITS.siteBuild, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);
    const parsed = parseJsonBody(body, siteBuildBody) ?? {};
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
    if (
      auth &&
      auth.kind === "oauth" &&
      auth.verified.member &&
      hasOAuthScope(auth.verified.scopes, OAUTH_SCOPES.REPO_READ)
    ) {
      return auth.verified.userId;
    }
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
    const limited = await rateLimit(c.env, LIMITS.workspaceCreate, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = parseJsonBody(body, workspaceBody) ?? {};
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
      // Subscribe the fork to `pushed` events so workspace pushes reach the
      // artifacts-events consumer (best-effort, deferred past the response).
      ensureArtifactsPushSubscription(workerExecutionContext(c), c.env, wsName);
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
    const limited = await rateLimit(c.env, LIMITS.matchCreate, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = parseJsonBody(body, matchCreateBody);
    if (!parsed?.title || !parsed.spec) return bad(c, "title-and-spec-required");
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
    const limited = await rateLimit(c.env, LIMITS.matchEnter, principal.actor);
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
    // Entry accepted — subscribe the entry fork so `pushed` events flow.
    ensureArtifactsPushSubscription(workerExecutionContext(c), c.env, wsName);
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

    const limited = await rateLimit(c.env, LIMITS.matchVote, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = parseJsonBody(body, matchVoteBody);
    if (!parsed?.entry_id) return bad(c, "entry-id-required");
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

  // --- delegate CI runner protocol -------------------------------------------
  //
  // Executions spawn as `pending` records (push trigger or manual run). A
  // runner on client infra claims the oldest pending exec, reports the
  // stage/step graph it resolved from the pipeline yaml, streams log lines,
  // and completes the record. The server never executes job code and never
  // sees runner secrets — consistent with the sealed-secret custody model.

  type ExecRef = { pipeline_id?: number; number?: number };

  function parseExecRef(parsed: unknown): { pipelineId: number; num: number } | null {
    const exec = (parsed as { exec?: ExecRef } | null)?.exec;
    const pipelineId = exec?.pipeline_id;
    const num = exec?.number;
    if (!Number.isInteger(pipelineId) || !Number.isInteger(num)) return null;
    return { pipelineId: pipelineId as number, num: num as number };
  }

  // Claim: atomically-ish transition oldest pending exec → running for this
  // runner. Two racing runners can both read `pending` — last write wins;
  // the loser sees its claim response's `claimed_by` differ from its name
  // and backs off (idempotent re-claim covers it).
  router.post("/api/:owner/:repo/dg/runner/claim", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = parseJsonBody(body, z.object({ runner: z.string().optional() })) ?? {};
    const runner = parsed.runner ?? principal.agent?.did ?? principal.actor;

    const execs = await readRepoExecutions(c.env, route.doName);
    const candidate = execs.find((e) => e.status === "pending");
    if (!candidate) return json(c, { execution: null });
    const updated = await updateRepoExecution(
      c.env,
      route.doName,
      candidate.pipeline_id,
      candidate.number,
      (exec) => {
        if (exec.status !== "pending") return exec;
        return { ...exec, status: "running", runner, heartbeat: Date.now(), started: Date.now() };
      }
    );
    if (!updated || updated.runner !== runner) {
      return json(c, { execution: null, reason: "claim lost" });
    }
    const pipe = (await readRepoPipelines(c.env, route.doName)).find(
      (p) => p.id === updated.pipeline_id
    );
    c.var.logFor({ service: "Runner" }).info("runner:claimed", {
      repoId: route.doName,
      number: updated.number,
      runner,
    });
    return json(c, {
      execution: updated,
      pipeline: pipe
        ? { id: pipe.id, identifier: pipe.identifier, config_path: pipe.config_path }
        : null,
      repo: {
        owner: route.routeNamespaceSlug,
        repo: route.routeRepoSlug,
        clone_url: `/${route.routeNamespaceSlug}/${route.routeRepoSlug}`,
      },
    });
  });

  // Report: the runner resolved the pipeline yaml into stages/steps.
  router.post("/api/:owner/:repo/dg/runner/report", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = parseJsonBody(
      body,
      z.object({
        exec: z.object({ pipeline_id: z.number(), number: z.number() }),
        stages: z.array(
          z.object({
            name: z.string(),
            steps: z.array(z.object({ name: z.string() })).default([]),
          })
        ),
      })
    );
    if (!parsed) return bad(c, "exec + stages required");
    const updated = await updateRepoExecution(
      c.env,
      route.doName,
      parsed.exec.pipeline_id,
      parsed.exec.number,
      (exec) => {
        if (exec.status !== "running") return exec;
        return {
          ...exec,
          heartbeat: Date.now(),
          stages: parsed.stages.map((s, i) => ({
            number: i + 1,
            name: s.name,
            status: "running" as const,
            steps: s.steps.map((st, j) => ({
              number: j + 1,
              name: st.name,
              status: "running" as const,
            })),
          })),
        };
      }
    );
    if (!updated) return bad(c, "execution not found", 404);
    return json(c, { ok: true });
  });

  // Log: append step log lines.
  router.post("/api/:owner/:repo/dg/runner/log", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = parseJsonBody(
      body,
      z.object({
        exec: z.object({ pipeline_id: z.number(), number: z.number() }),
        stage: z.number(),
        step: z.number(),
        lines: z.array(z.string()).max(500),
      })
    );
    if (!parsed) return bad(c, "exec + stage + step + lines required");
    const existing = await readRepoExecutionLogs(
      c.env,
      route.doName,
      parsed.exec.pipeline_id,
      parsed.exec.number
    );
    const base = existing.length;
    await appendRepoExecutionLogs(
      c.env,
      route.doName,
      parsed.exec.pipeline_id,
      parsed.exec.number,
      parsed.lines.map((line, i) => ({
        stage: parsed.stage,
        step: parsed.step,
        pos: base + i + 1,
        time: Date.now(),
        line,
      }))
    );
    return json(c, { ok: true });
  });

  // Heartbeat: keep a running exec alive.
  router.post("/api/:owner/:repo/dg/runner/heartbeat", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const ref = parseExecRef(
      parseJsonBody(
        body,
        z.object({ exec: z.object({ pipeline_id: z.number(), number: z.number() }) })
      )
    );
    if (!ref) return bad(c, "exec required");
    const updated = await updateRepoExecution(
      c.env,
      route.doName,
      ref.pipelineId,
      ref.num,
      (exec) => (exec.status === "running" ? { ...exec, heartbeat: Date.now() } : exec)
    );
    if (!updated) return bad(c, "execution not found", 404);
    // Registry liveness — runners that match a declared delegate in this
    // space stay `online` for the cron staleness reaper.
    if (updated.runner) {
      const delegate = await findDelegate(c.var.db, route.namespaceId, updated.runner);
      if (delegate) {
        await updateDelegate(c.var.db, delegate.id, {
          status: "online",
          lastSeenAt: Date.now(),
        });
      }
    }
    return json(c, { ok: true, status: updated.status });
  });

  // Complete: final status + per-stage/step outcomes.
  router.post("/api/:owner/:repo/dg/runner/complete", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticate(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = parseJsonBody(
      body,
      z.object({
        exec: z.object({ pipeline_id: z.number(), number: z.number() }),
        status: z.enum(["success", "failure", "error", "killed", "skipped"]),
        error: z.string().optional(),
        stages: z
          .array(
            z.object({
              number: z.number(),
              status: z.enum(["success", "failure", "error", "killed", "skipped"]),
              exit_code: z.number().optional(),
              steps: z
                .array(
                  z.object({
                    number: z.number(),
                    status: z.enum(["success", "failure", "error", "killed", "skipped"]),
                    exit_code: z.number().optional(),
                  })
                )
                .default([]),
            })
          )
          .optional(),
      })
    );
    if (!parsed) return bad(c, "exec + status required");
    const updated = await updateRepoExecution(
      c.env,
      route.doName,
      parsed.exec.pipeline_id,
      parsed.exec.number,
      (exec) => {
        if (exec.status !== "running" && exec.status !== "pending") return exec;
        const now = Date.now();
        const stages = exec.stages.map((s) => {
          const reported = parsed.stages?.find((r) => r.number === s.number);
          return {
            ...s,
            status: reported?.status ?? (parsed.status === "success" ? "success" : s.status),
            exit_code: reported?.exit_code,
            stopped: now,
            steps: s.steps.map((st) => {
              const rep = reported?.steps?.find((r) => r.number === st.number);
              return {
                ...st,
                status:
                  rep?.status ?? (parsed.status === "success" ? ("success" as const) : st.status),
                exit_code: rep?.exit_code,
                stopped: now,
              };
            }),
          };
        });
        return {
          ...exec,
          status: parsed.status,
          error: parsed.error,
          finished: now,
          stages,
        };
      }
    );
    if (!updated) return bad(c, "execution not found", 404);
    c.var.logFor({ service: "Runner" }).info("runner:completed", {
      repoId: route.doName,
      number: updated.number,
      status: updated.status,
    });
    return json(c, { ok: true, status: updated.status });
  });

  // --- push-scan attestations -------------------------------------------------
  //
  // Client-side scanning is the enforcement model: dgit/pre-push runs
  // gitleaks+trufflehog+trivy+semgrep on the pusher's machine *before* upload
  // and attests the outcome here. The server stores the attestation keyed by
  // head oid so a `require` repo policy can refuse un-attested pushes and the
  // audit trail records who claimed to scan what.

  const scanAttestBody = z.object({
    heads: z
      .array(
        z.object({
          ref: z.string().min(1),
          oid: z.string().regex(/^[0-9a-f]{40}$/i),
        })
      )
      .min(1)
      .max(64),
    status: z.enum(["pass", "warn", "fail", "skipped"]),
    tools: z
      .array(
        z.object({
          tool: z.string().max(32),
          version: z.string().max(64).optional(),
          status: z.enum(["pass", "warn", "fail", "skipped", "missing"]),
          findings: z.number().int().nonnegative().optional(),
          duration_ms: z.number().int().nonnegative().optional(),
        })
      )
      .max(16),
    duration_ms: z.number().int().nonnegative().optional(),
  });

  router.post("/api/:owner/:repo/dg/scan-attest", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateWrite(c, body, route);
    if (principal instanceof Response) return principal;
    const parsed = parseJsonBody(body, scanAttestBody);
    if (!parsed) return bad(c, "invalid-body");

    const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
    if (!repoRow) return bad(c, "repo-not-found", 404);
    const settings = await readSecuritySettings(c.env, route.doName);
    if (settings.push_scan === "off") {
      return json(c, { recorded: false, policy: "off" });
    }

    const now = Date.now();
    for (const head of parsed.heads) {
      await upsertScanRun(c.var.db, {
        id: newPrefixedId("scan"),
        repositoryId: repoRow.id,
        headOid: head.oid.toLowerCase(),
        actor: principal.actor,
        status: parsed.status,
        tools: JSON.stringify(parsed.tools),
        durationMs: parsed.duration_ms ?? null,
        ranAt: now,
      });
    }
    c.var.logFor({ service: "PushScan" }).info("scan:attested", {
      repoId: route.doName,
      actor: principal.actor,
      heads: parsed.heads.length,
      status: parsed.status,
    });
    return json(c, {
      recorded: true,
      policy: settings.push_scan === "require" ? "require" : "report",
      heads: parsed.heads.length,
    });
  });

  // The pre-push hook / dgit push reads this before scanning: which suite the
  // repo wants and whether pushes are gated on a prior attestation.
  router.get("/api/:owner/:repo/dg/scan-policy", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    const settings = await readSecuritySettings(c.env, route.doName);
    return json(c, {
      push_scan: settings.push_scan ?? "report",
      secret_scanning: settings.secret_scanning !== false,
    });
  });

  router.get("/api/:owner/:repo/dg/scans", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
    if (!repoRow) return bad(c, "repo-not-found", 404);
    const rows = await listScanRunsForRepo(c.var.db, repoRow.id, 50);
    return json(c, {
      scans: rows.map((row) => ({
        head_oid: row.headOid,
        actor: row.actor,
        status: row.status,
        tools: JSON.parse(row.tools) as unknown[],
        duration_ms: row.durationMs,
        ran_at: row.ranAt,
      })),
    });
  });

  // --- artifacts ---------------------------------------------------------------
  //
  // Pipeline outputs and published packages: binary blobs in R2 under
  // `artifacts/<doName>/<name>/<version>/<path>` with a D1 index for
  // listing/pinning. Upload auth is the repo's push PAT — CI delegates
  // publish with the same credential they push with.

  function artifactKey(doName: string, name: string, version: string, path: string) {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._/-]/g, "_");
    return `artifacts/${doName}/${safe(name)}/${safe(version)}/${safe(path)}`;
  }

  router.put("/api/:owner/:repo/dg/artifacts/:name/:version/:path{.+}", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateWrite(c, body, route);
    if (principal instanceof Response) return principal;
    const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
    if (!repoRow) return bad(c, "repo-not-found", 404);

    const name = c.req.param("name");
    const version = c.req.param("version");
    const path = c.req.param("path");
    if (!name || !version || !path) return bad(c, "invalid-artifact-ref", 400);
    if (body.byteLength > 50 * 1024 * 1024) return bad(c, "artifact-too-large", 413);

    const r2Key = artifactKey(route.doName, name, version, path);
    const digest = await crypto.subtle.digest("SHA-256", body.buffer as ArrayBuffer);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    await c.env.REPO_BUCKET.put(r2Key, body, {
      httpMetadata: { contentType },
      customMetadata: { sha256 },
    });
    const row = await upsertArtifact(c.var.db, {
      id: newPrefixedId("art"),
      repositoryId: repoRow.id,
      name,
      version,
      path,
      r2Key,
      size: body.byteLength,
      sha256,
      contentType,
      createdBy: principal.actor,
      createdAt: Date.now(),
    });
    c.var.logFor({ service: "Artifacts" }).info("artifacts:published", {
      repoId: route.doName,
      name,
      version,
      path,
      size: body.byteLength,
    });
    return json(c, {
      name: row.name,
      version: row.version,
      path: row.path,
      sha256: row.sha256,
      size: row.size,
    });
  });

  router.get("/api/:owner/:repo/dg/artifacts", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    if (route.visibility === "private") {
      const body = new Uint8Array(await c.req.raw.arrayBuffer());
      const principal = await authenticate(c, body, route);
      if (principal instanceof Response) return bad(c, "repo-not-found", 404);
    }
    const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
    if (!repoRow) return bad(c, "repo-not-found", 404);
    const rows = await listArtifactsForRepo(c.var.db, repoRow.id);
    return json(c, {
      artifacts: rows.map((row) => ({
        name: row.name,
        version: row.version,
        path: row.path,
        size: row.size,
        sha256: row.sha256,
        content_type: row.contentType,
        created_by: row.createdBy,
        created: row.createdAt,
      })),
    });
  });

  router.get("/api/:owner/:repo/dg/artifacts/:name/:version/:path{.+}", async (c) => {
    const route = await resolveRepo(c);
    if (!route) return bad(c, "repo-not-found", 404);
    if (route.visibility === "private") {
      const body = new Uint8Array(await c.req.raw.arrayBuffer());
      const principal = await authenticate(c, body, route);
      if (principal instanceof Response) return bad(c, "repo-not-found", 404);
    }
    const repoRow = await findRepositoryByDoName(c.var.db, route.doName);
    if (!repoRow) return bad(c, "repo-not-found", 404);
    const row = await findArtifact(
      c.var.db,
      repoRow.id,
      c.req.param("name"),
      c.req.param("version"),
      c.req.param("path")
    );
    if (!row) return bad(c, "artifact-not-found", 404);
    const obj = await c.env.REPO_BUCKET.get(row.r2Key);
    if (!obj) return bad(c, "artifact-object-missing", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.contentType ?? "application/octet-stream",
        "Content-Length": String(row.size),
        "X-Artifact-Sha256": row.sha256,
        "Cache-Control": "immutable",
      },
    });
  });
}
