import { Hono } from "hono";
import { registerGitRoutes } from "./routes/git";
import { registerAdminRoutes } from "./routes/admin";
import { registerAgentRoutes } from "./routes/agent";
import { registerReputationRoutes } from "./routes/reputation";
import { registerApiV3Routes } from "./routes/apiv3";
import { registerPagesRoutes } from "./routes/pages";
import { registerArchiveRoutes } from "./routes/archive";
import { registerMcpRoutes } from "./routes/mcp";
import { registerHermesRoutes, ISOLATION_HEADERS } from "./routes/hermes";
import { registerGitnessApi } from "./api/gitness";
import { registerUiRoutes } from "./routes/ui";
import { registerSpaRoutes } from "./routes/spa";
import { registerAuthRoutes } from "./routes/auth";
import { registerAtpAuthRoutes } from "./routes/atpauth";
import { registerXrpcRoutes } from "./routes/xrpc";
import { requestServicesMiddleware, type AppBindings, type AppContext } from "./routes/hono";
import { renderUiDocumentResponse } from "./routes/uiResponse";
import { loadViewer } from "./auth/session";
import { json } from "./common";
import { handleRepoTaskQueue } from "./tasks/queue";

const app = new Hono<AppBindings>({ strict: false });
app.use("*", requestServicesMiddleware);
// Cross-origin isolation on all HTML pages: required so embedded
// Hermes mounts (SharedArrayBuffer/Atomics) work inline rather than
// degrading to a popup. credentialless keeps cross-origin subresources
// working while still granting isolation on supporting browsers.
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) c.res.headers.set(k, v);
  }
});
// Register Git protocol routes (info/refs, upload-pack, receive-pack)
registerGitRoutes(app);
// Register Admin routes
registerAdminRoutes(app);
// Register Auth routes BEFORE UI to avoid /:owner shadowing /auth
registerAuthRoutes(app);
// atproto DID sign-in (/auth/did/*) + DID-session repo APIs (/api/repos)
registerAtpAuthRoutes(app);
// delta-git agent API under /api/* — registered before UI for the same reason
registerAgentRoutes(app);
registerReputationRoutes(app);
registerApiV3Routes(app);
registerXrpcRoutes(app);
registerMcpRoutes(app);
registerHermesRoutes(app);
// Gitness /api/v1 facade — before UI so /api/v1/* never reaches /:owner.
registerGitnessApi(app);
// Static site serving from repo refs
registerPagesRoutes(app);
// POSIX tar export of a repo tree — consumed by wp-cloud deploy-git, CI, mirrors
registerArchiveRoutes(app);

app.get("/", async (c) => {
  const viewer = await loadViewer(c);
  return renderUiDocumentResponse(
    c.env,
    "home",
    { origin: new URL(c.req.url).origin },
    { failureBody: "Failed to render page\n", viewer }
  );
});

// Gitness SPA under /app/* — after all /api + auth routes; its own prefix
// so it cannot shadow SSR routes during the migration.
registerSpaRoutes(app);
// Register UI routes AFTER static/auth so that /:owner doesn't shadow them
registerUiRoutes(app);

async function renderNotFound(c: AppContext): Promise<Response> {
  const viewer = await loadViewer(c);
  return renderUiDocumentResponse(
    c.env,
    "404",
    {},
    {
      status: 404,
      failureBody: "Not found\n",
      failureStatus: 404,
      viewer,
    }
  );
}

app.notFound((c) => renderNotFound(c));

function errorStatus(error: Error): number {
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  return 500;
}

app.onError((error) => {
  // The previous router converted uncaught handler failures into JSON. Most
  // routes catch expected failures themselves, but keep this last-resort shape
  // stable for truly unexpected errors.
  const status = errorStatus(error);
  return json({ error: error.message || "Internal Server Error" }, status, {
    "Content-Type": "application/json; charset=utf-8",
  });
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    return await handleRepoTaskQueue(batch, env, ctx);
  },
};

export { RepoDurableObject } from "./do/repo/repoDO";
export { AdjudicatorAgent, RepoAgent, FirehoseAgent } from "./agent/runtime";
