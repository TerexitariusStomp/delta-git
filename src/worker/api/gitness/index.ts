// Gitness `/api/v1` facade — registration.
//
// Route-order contract: `:repo_ref{.+}` and `:space_ref{.+}` are greedy, so
// every bare `/{ref}` GET must register after all of its `/{ref}/<tail>`
// siblings. `registerGitnessRepos` owns the bare repo-detail GET and is
// therefore called last, after gitdata/pullreqs have claimed their tails.
// The trailing `all("/api/v1/*")` stub is what makes the contract honest:
// anything the facade has not implemented gets a UsererrorError 501 rather
// than an ambiguous 404.

import type { AppRouter } from "@/worker/routes/hono";
import { loadViewer } from "@/worker/auth/session";
import { listPatsForUser } from "@/worker/db/d1/dal/tokens";
import { numericId, gErr, gStub } from "./shared";
import { registerGitnessSpaces } from "./spaces";
import { registerGitnessGitdata } from "./gitdata";
import { registerGitnessPullreqs } from "./pullreqs";
import { registerGitnessRepos } from "./repos";

const GITIGNORE_PRESETS = ["Node", "Python", "Go", "Rust", "Java", "C++"];
const LICENSE_PRESETS = ["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "ISC"];

export function registerGitnessApi(router: AppRouter) {
  registerGitnessSpaces(router);
  registerGitnessGitdata(router);
  registerGitnessPullreqs(router);
  // Repo meta + the greedy bare-repo GET — keep last.
  registerGitnessRepos(router);

  // PATs surface as gitness "tokens" (read-only listing — creation stays on
  // the /auth account page for now).
  router.get("/api/v1/user/tokens", async (c) => {
    const viewer = await loadViewer(c);
    if (!viewer) return gErr(c, 401, "unauthorized");
    const pats = await listPatsForUser(c.var.db, viewer.userId);
    return c.json(
      pats.map((p) => ({
        identifier: p.name,
        type: "pat",
        principal_id: numericId(viewer.userId),
        created_by: numericId(viewer.userId),
        issued_at: p.createdAt,
        expires_at: p.expiresAt ?? null,
      }))
    );
  });
  router.post("/api/v1/user/tokens", async (c) => gStub(c, "token creation"));
  router.delete("/api/v1/user/tokens/:id", async (c) => gStub(c, "token delete"));

  // Template pickers in the create-repo dialog.
  router.get("/api/v1/resources/gitignore", async (c) => c.json(GITIGNORE_PRESETS));
  router.get("/api/v1/resources/license", async (c) => c.json(LICENSE_PRESETS));

  // Admin user management is out of scope for this facade.
  for (const [method, path] of [
    ["get", "/api/v1/admin/users"],
    ["post", "/api/v1/admin/users"],
    ["patch", "/api/v1/admin/users/:uid"],
    ["patch", "/api/v1/admin/users/:uid/admin"],
    ["delete", "/api/v1/admin/users/:uid"],
    ["get", "/api/v1/admin/users/:uid"],
  ] as const) {
    router[method](path, async (c) => gStub(c, "admin user management"));
  }

  // Catch-all: every remaining /api/v1 route gets an explicit 501.
  router.all("/api/v1/*", async (c) => gStub(c, `endpoint ${c.req.method} ${c.req.path}`));
}
