import type { AppRouter } from "@/worker/routes/hono";

import { findMembership, findNamespaceBySlug } from "@/worker/db/d1/dal/namespaces";
import { loadViewer } from "@/worker/auth/session";
import { gErr, gNotFound, resolveGitnessRepo, type GitnessContext } from "./shared";
import {
  MAX_ABUSE_REPORTS,
  readAbuseReports,
  readNamespaceBlocks,
  writeAbuseReports,
  writeNamespaceBlocks,
  type AbuseReport,
} from "./stores";

// Trust & safety surface: content reports filed by any signed-in viewer,
// an admin triage list gated on DG_ADMIN_ACTORS, and namespace-scoped user
// blocks enforced inside requireWriter/viewerCanWrite.

function adminActors(env: Env): Set<string> {
  const raw = (env as { DG_ADMIN_ACTORS?: string }).DG_ADMIN_ACTORS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function requireNamespaceOwner(c: GitnessContext) {
  const viewer = await loadViewer(c);
  if (!viewer) return { error: gErr(c, 401, "unauthorized") };
  const ns = await findNamespaceBySlug(c.var.db, c.req.param("space") ?? "");
  if (!ns) return { error: gNotFound(c, "space") };
  const membership = await findMembership(c.var.db, ns.id, viewer.userId);
  if (membership?.role !== "owner" && ns.createdBy !== viewer.userId) {
    return { error: gErr(c, 403, "owner role required") };
  }
  return { viewer, ns };
}

export function registerGitnessModeration(router: AppRouter) {
  // --- abuse reports -------------------------------------------------------

  // Any signed-in viewer may report repo content; the target is a free-form
  // kind/id pair so issues, PRs, comments, and the repo itself share one
  // endpoint. Reports are append-only for users; admins triage via PATCH.
  router.post("/api/v1/repos/:repo_ref{.+}/reports", async (c) => {
    const access = await resolveGitnessRepo(c, c.req.param("repo_ref"));
    if (access.kind !== "ok") return access.response;
    if (!access.viewer) return gErr(c, 401, "unauthorized");
    const body = (await c.req.json().catch(() => ({}))) as {
      target_kind?: string;
      target_id?: string | number;
      reason?: string;
    };
    const targetKind = body.target_kind;
    if (
      targetKind !== "issue" &&
      targetKind !== "comment" &&
      targetKind !== "pullreq" &&
      targetKind !== "repo"
    ) {
      return gErr(c, 400, "target_kind must be issue, comment, pullreq, or repo");
    }
    const reason = String(body.reason ?? "").trim();
    if (!reason) return gErr(c, 400, "reason required");
    const reports = await readAbuseReports(c.env);
    const report: AbuseReport = {
      id: `rpt-${crypto.randomUUID()}`,
      reporterUserId: access.viewer.userId,
      doName: access.route.doName,
      targetKind,
      targetId: String(body.target_id ?? ""),
      reason: reason.slice(0, 2000),
      state: "open",
      createdAt: Date.now(),
    };
    reports.unshift(report);
    if (reports.length > MAX_ABUSE_REPORTS) reports.length = MAX_ABUSE_REPORTS;
    await writeAbuseReports(c.env, reports);
    return c.json(report, 201);
  });

  // Admin triage — DG_ADMIN_ACTORS matches the viewer's userId or their
  // primary namespace slug (the same identity surface admin routes use).
  const requireAdmin = async (c: GitnessContext) => {
    const viewer = await loadViewer(c);
    if (!viewer) return { error: gErr(c, 401, "unauthorized") };
    const admins = adminActors(c.env);
    if (!admins.has(viewer.userId) && !admins.has(viewer.primaryNamespaceSlug ?? "")) {
      return { error: gErr(c, 403, "admin-required") };
    }
    return { viewer };
  };

  router.get("/api/v1/admin/reports", async (c) => {
    const gate = await requireAdmin(c);
    if ("error" in gate) return gate.error;
    const state = c.req.query("state") ?? "open";
    const reports = await readAbuseReports(c.env);
    return c.json(reports.filter((r) => state === "all" || r.state === state));
  });

  router.patch("/api/v1/admin/reports/:id", async (c) => {
    const gate = await requireAdmin(c);
    if ("error" in gate) return gate.error;
    const body = (await c.req.json().catch(() => ({}))) as { state?: string };
    if (body.state !== "open" && body.state !== "resolved") {
      return gErr(c, 400, "state must be open or resolved");
    }
    const reports = await readAbuseReports(c.env);
    const report = reports.find((r) => r.id === c.req.param("id"));
    if (!report) return gNotFound(c, "report");
    report.state = body.state;
    await writeAbuseReports(c.env, reports);
    return c.json(report);
  });

  // --- namespace user blocks ------------------------------------------------

  // Owner-gated write ban: blocked members keep read access but every write
  // path rejects them (enforced inside requireWriter/viewerCanWrite).
  router.get("/api/v1/spaces/:space/+/blocks", async (c) => {
    const gate = await requireNamespaceOwner(c);
    if ("error" in gate) return gate.error;
    return c.json({ blocked: await readNamespaceBlocks(c.env, gate.ns.id) });
  });

  router.put("/api/v1/spaces/:space/+/blocks/:uid", async (c) => {
    const gate = await requireNamespaceOwner(c);
    if ("error" in gate) return gate.error;
    const uid = c.req.param("uid");
    const blocked = await readNamespaceBlocks(c.env, gate.ns.id);
    if (!blocked.includes(uid)) blocked.push(uid);
    await writeNamespaceBlocks(c.env, gate.ns.id, blocked);
    return c.json({ blocked });
  });

  router.delete("/api/v1/spaces/:space/+/blocks/:uid", async (c) => {
    const gate = await requireNamespaceOwner(c);
    if ("error" in gate) return gate.error;
    const uid = c.req.param("uid");
    const blocked = (await readNamespaceBlocks(c.env, gate.ns.id)).filter((id) => id !== uid);
    await writeNamespaceBlocks(c.env, gate.ns.id, blocked);
    return c.json({ blocked });
  });
}
