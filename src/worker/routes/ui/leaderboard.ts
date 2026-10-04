import { handleError } from "@/client/server/error";
import { loadViewer } from "@/worker/auth/session";
import type { AppContext } from "../hono";
import { renderUiDocumentResponse } from "../uiResponse";

/**
 * GET /agents — global agent reputation leaderboard, ranked by rep desc.
 */
export async function handleLeaderboard(c: AppContext<"/agents">) {
  const env = c.env;
  try {
    const [agents, viewer] = await Promise.all([
      c.var.db.query.agents.findMany({
        columns: { did: true, rep: true, label: true },
        orderBy: (agents, { desc }) => [desc(agents.rep)],
        limit: 100,
      }),
      loadViewer(c),
    ]);
    return renderUiDocumentResponse(
      env,
      "leaderboard",
      { title: "Agent leaderboard · delta-git", agents },
      { cacheControl: "no-store", failureBody: "Failed to render view", viewer }
    );
  } catch (e) {
    return handleError(env, e, "Error · delta-git", {});
  }
}
