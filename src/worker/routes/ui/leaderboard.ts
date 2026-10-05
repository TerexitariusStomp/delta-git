import { handleError } from "@/client/server/error";
import { loadViewer } from "@/worker/auth/session";
import { listOpenEpochs, listVouches, listFamilyRollup, listModelRollup } from "@/worker/db/d1/dal";
import { desc } from "drizzle-orm";
import { agents, identities } from "@/worker/db/d1/schema";
import type { AppContext } from "../hono";
import { renderUiDocumentResponse } from "../uiResponse";

/**
 * GET /agents — unified reputation leaderboard. Agents and identities share
 * the same rep currency (arena wins, adjudication, vouches, epoch
 * allocations), so the board unions both tables. Also shows the recent
 * vouch feed and open allocation epochs.
 */
export async function handleLeaderboard(c: AppContext<"/agents">) {
  const env = c.env;
  try {
    const [agentRows, identityRows, vouchRows, epochRows, familyRollup, modelRollup, viewer] =
      await Promise.all([
        c.var.db
          .select({ did: agents.did, rep: agents.rep, label: agents.label })
          .from(agents)
          .orderBy(desc(agents.rep))
          .limit(50),
        c.var.db
          .select({ did: identities.did, rep: identities.rep, handle: identities.handle })
          .from(identities)
          .orderBy(desc(identities.rep))
          .limit(50),
        listVouches(c.var.db, 25),
        listOpenEpochs(c.var.db, Date.now()),
        listFamilyRollup(c.var.db, 25),
        listModelRollup(c.var.db, 25),
        loadViewer(c),
      ]);

    // Unified ranking: same rep currency for humans and agents.
    const board = [
      ...agentRows.map((a) => ({
        actor: a.label || a.did,
        did: a.did,
        kind: "agent" as const,
        rep: a.rep,
      })),
      ...identityRows.map((i) => ({
        actor: i.handle || i.did,
        did: i.did,
        kind: "human" as const,
        rep: i.rep,
      })),
    ]
      .sort((a, b) => b.rep - a.rep)
      .slice(0, 50);

    const admins = ((env as { DG_ADMIN_ACTORS?: string }).DG_ADMIN_ACTORS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const viewerAdmin = viewer ? admins.includes(viewer.userId) : false;

    return renderUiDocumentResponse(
      env,
      "leaderboard",
      {
        title: "Leaderboard · delta-git",
        board,
        vouches: vouchRows.map((v) => ({
          id: v.id,
          from: v.fromDid,
          to: v.toDid,
          kind: v.kind,
          message: v.message,
          repDelta: v.repDelta,
          createdAt: v.createdAt,
        })),
        epochs: epochRows.map((e) => ({
          id: e.id,
          name: e.name,
          budget: e.budget,
          endsAt: e.endsAt,
        })),
        viewerAdmin,
        // Family/model rollups: every Claude Code instance contributes to
        // one "claude-code" score, every Devin to "devin", and likewise by
        // underlying model. Verified families are flagged in the UI.
        families: familyRollup,
        models: modelRollup,
      },
      { cacheControl: "no-store", failureBody: "Failed to render view", viewer }
    );
  } catch (e) {
    return handleError(env, e, "Error · delta-git", {});
  }
}
