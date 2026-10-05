import type { AppContext, AppRouter } from "./hono";
import type { VouchKind } from "@/worker/db/d1/schema";

import { verifyAgentRequest } from "@/worker/agent/auth";
import { loadViewer } from "@/worker/auth/session";
import { sameOriginViolation } from "@/worker/auth/origin";
import { metric, rateLimit, LIMITS } from "@/worker/agent/abuse";
import {
  adjustRep,
  closeEpoch,
  countRecentVouches,
  findIdentityByUserId,
  findRepTarget,
  insertEpoch,
  insertVouch,
  listEpochAllocations,
  listOpenEpochs,
  listVouches,
  upsertEpochAllocation,
} from "@/worker/db/d1/dal";

// Global reputation layer — vouches (praise/vouch/flag peer attestations)
// and Coordinape-style allocation epochs. Not repo-scoped: these are the
// cross-repo trust signals that feed the unified leaderboard.
//
// Identity for mutations is either a signed agent envelope (x-dg-*) or the
// browser session (dg_session → user → identity DID).

type RepActor = { actor: string; did: string | null; signature: string | null };

/** Rep delta per vouch kind. Flags burn; vouch > praise. */
const VOUCH_REP: Record<VouchKind, number> = { praise: 1, vouch: 5, flag: -10 };
/** One vouch per (voucher, target) per day — sybil brake. */
const VOUCH_DEDUP_MS = 24 * 60 * 60 * 1000;
/** A voucher must hold this much rep to confer it — otherwise a ring of
 * fresh sockpuppets could vouch each other straight past the vote gate.
 * Flags are exempt: anyone may burn a bad actor, it costs the flagger
 * nothing and hurts only the target. */
const VOUCHER_MIN_REP = 10;
/** Epoch creation is gated to platform admins (env allowlist). */
function adminActors(env: Env): Set<string> {
  const raw = (env as { DG_ADMIN_ACTORS?: string }).DG_ADMIN_ACTORS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function json(c: AppContext, body: unknown, status = 200): Response {
  return c.json(body as never, status as never);
}

function bad(c: AppContext, reason: string, status = 400): Response {
  return json(c, { error: reason }, status);
}

/**
 * Authenticate a global (non-repo-scoped) reputation request: signed agent
 * envelope first, then browser session. Returns the actor key (agent DID or
 * session userId) plus the DID used as the reputation key when resolvable.
 */
async function authenticateActor(c: AppContext, body: Uint8Array): Promise<RepActor | Response> {
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
  if (verified.kind === "ok") {
    return {
      actor: verified.agent.did,
      did: verified.agent.did,
      signature: c.req.header("x-dg-sig") ?? null,
    };
  }

  const viewer = await loadViewer(c);
  if (!viewer) return bad(c, "unauthorized", 401);
  // CSRF: session-authed mutations are same-origin only.
  const violation = sameOriginViolation(c);
  if (violation) return violation;
  const identity = await findIdentityByUserId(c.var.db, viewer.userId);
  return { actor: viewer.userId, did: identity?.did ?? null, signature: "session" };
}

export function registerReputationRoutes(router: AppRouter): void {
  // --- vouches ---------------------------------------------------------------

  router.post("/api/dg/vouch", async (c) => {
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateActor(c, body);
    if (principal instanceof Response) return principal;
    const limited = await rateLimit(c.env.ROUTES, LIMITS.vote, principal.actor);
    if (!limited.ok) return bad(c, "rate-limited", 429);

    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      to?: string;
      kind?: string;
      message?: string;
    };
    const kind = parsed.kind as VouchKind | undefined;
    if (!parsed.to || !kind || !(kind in VOUCH_REP)) return bad(c, "to-and-kind-required");
    const fromKey = principal.did ?? principal.actor;
    if (fromKey === parsed.to) return bad(c, "self-vouch", 409);

    if (kind !== "flag") {
      const voucher = await findRepTarget(c.var.db, fromKey);
      if (!voucher || voucher.rep < VOUCHER_MIN_REP) {
        return bad(c, "voucher-insufficient-rep", 403);
      }
    }

    const target = await findRepTarget(c.var.db, parsed.to);
    if (!target) return bad(c, "unknown-target", 404);

    const now = Date.now();
    const dupes = await countRecentVouches(c.var.db, fromKey, parsed.to, now - VOUCH_DEDUP_MS);
    if (dupes > 0) return bad(c, "already-vouched-today", 429);

    const repDelta = VOUCH_REP[kind];
    await insertVouch(c.var.db, {
      id: `vouch-${crypto.randomUUID().slice(0, 12)}`,
      fromDid: fromKey,
      toDid: parsed.to,
      kind,
      message: parsed.message?.slice(0, 500) ?? null,
      signature: principal.signature,
      repDelta,
      createdAt: now,
    });
    await adjustRep(c.var.db, parsed.to, repDelta);
    metric(c.env, "arena.vote", { scope: "vouch", index: kind });
    return json(c, { ok: true, rep_delta: repDelta }, 201);
  });

  router.get("/api/dg/vouches", async (c) => {
    const rows = await listVouches(c.var.db, 50);
    return json(c, {
      vouches: rows.map((v) => ({
        id: v.id,
        from: v.fromDid,
        to: v.toDid,
        kind: v.kind,
        message: v.message,
        rep_delta: v.repDelta,
        created_at: v.createdAt,
      })),
    });
  });

  // --- epochs (Coordinape-style allocation windows) ---------------------------

  router.get("/api/dg/epochs", async (c) => {
    const open = await listOpenEpochs(c.var.db, Date.now());
    return json(c, {
      epochs: open.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        budget: e.budget,
        starts_at: e.startsAt,
        ends_at: e.endsAt,
      })),
    });
  });

  router.post("/api/dg/epochs", async (c) => {
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateActor(c, body);
    if (principal instanceof Response) return principal;
    const admins = adminActors(c.env);
    if (!admins.has(principal.actor) && !admins.has(principal.did ?? "")) {
      return bad(c, "admin-required", 403);
    }
    // Accept JSON (agents/CLI) or a browser form post from the leaderboard
    // admin card (PRG redirect back to /agents).
    const isForm = (c.req.header("content-type") ?? "").includes(
      "application/x-www-form-urlencoded"
    );
    const parsed = isForm
      ? (Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body))) as {
          name?: string;
          budget?: string;
          ends_in_hours?: string;
        })
      : (JSON.parse(new TextDecoder().decode(body) || "{}") as {
          name?: string;
          budget?: number;
          ends_at?: number;
        });
    const budget = Number(parsed.budget ?? 100);
    const endsAt =
      "ends_in_hours" in parsed && parsed.ends_in_hours
        ? Date.now() + Number(parsed.ends_in_hours) * 3600 * 1000
        : (parsed as { ends_at?: number }).ends_at;
    if (!parsed.name || !endsAt || !Number.isFinite(endsAt)) {
      return bad(c, "name-and-ends_at-required");
    }
    const id = `epoch-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await insertEpoch(c.var.db, {
      id,
      name: parsed.name.slice(0, 120),
      budget: Math.min(Math.max(budget, 1), 10000),
      startsAt: now,
      endsAt,
      createdBy: principal.actor,
      createdAt: now,
    });
    return isForm ? c.redirect("/agents", 303) : json(c, { id, status: "open" }, 201);
  });

  router.post("/api/dg/epochs/:id/allocate", async (c) => {
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateActor(c, body);
    if (principal instanceof Response) return principal;
    const parsed = JSON.parse(new TextDecoder().decode(body) || "{}") as {
      to?: string;
      amount?: number;
    };
    if (!parsed.to || typeof parsed.amount !== "number") {
      return bad(c, "to-and-amount-required");
    }
    const fromKey = principal.did ?? principal.actor;
    const result = await upsertEpochAllocation(c.var.db, {
      epochId: c.req.param("id"),
      fromDid: fromKey,
      toDid: parsed.to,
      amount: parsed.amount,
      now: Date.now(),
    });
    if (!result.ok)
      return bad(c, `allocate:${result.reason}`, result.reason === "not-found" ? 404 : 409);
    return json(c, { ok: true, remaining: result.remaining });
  });

  router.get("/api/dg/epochs/:id/allocations", async (c) => {
    const allocs = await listEpochAllocations(c.var.db, c.req.param("id"));
    return json(c, {
      allocations: allocs.map((a) => ({
        from: a.fromDid,
        to: a.toDid,
        amount: a.amount,
        created_at: a.createdAt,
      })),
    });
  });

  router.post("/api/dg/epochs/:id/close", async (c) => {
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    const principal = await authenticateActor(c, body);
    if (principal instanceof Response) return principal;
    if (!adminActors(c.env).has(principal.actor) && !adminActors(c.env).has(principal.did ?? "")) {
      return bad(c, "admin-required", 403);
    }
    const result = await closeEpoch(c.var.db, c.req.param("id"), Date.now());
    if (!result.ok) return bad(c, `close:${result.reason}`, 409);
    const isForm = (c.req.header("content-type") ?? "").includes(
      "application/x-www-form-urlencoded"
    );
    return isForm
      ? c.redirect("/agents", 303)
      : json(c, { ok: true, tallies: Object.fromEntries(result.tallies) });
  });
}
