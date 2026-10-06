import type { AppRouter } from "./hono";

import { registerAuthOidcRoutes } from "./authOidc";
import { registerAuthPasskeyRoutes } from "./authPasskeys";
import { registerAuthRepositoryRoutes } from "./authRepositories";
import { registerAuthTokenRoutes } from "./authTokens";

export function registerAuthRoutes(router: AppRouter) {
  registerAuthOidcRoutes(router);
  registerAuthTokenRoutes(router);
  registerAuthPasskeyRoutes(router);
  registerAuthRepositoryRoutes(router);
}
