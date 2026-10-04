// Lane 2 — curated dynamic WordPress. Runs on the SAME container substrate
// as Lane 3 (TenantDO wake/sleep/proxy) but with curation enforced
// in-container: lite instance, whitelisted plugins only, DISALLOW_FILE_MODS.
// (Worker-native php-wasm remains a research track — emscripten asset
// imports can't bundle into workerd; see plan P3 spike.)
import type { Env } from "./env";

export const LANE2_PLUGIN_WHITELIST = new Set([
  "contact-form-7", "wpforms-lite", "wordpress-seo", "akismet", "jetpack", "simply-static",
]);

export async function serveLane2(req: Request, env: Env, site: { id: string }): Promise<Response> {
  if (!env.TENANT) return new Response("lane2 requires the paid container tier", { status: 503 });
  const stub = env.TENANT.get(env.TENANT.idFromName(site.id));
  const r = new Request(req, { headers: new Headers(req.headers) });
  r.headers.set("x-wpc-curated", "1");
  return stub.fetch(r);
}
