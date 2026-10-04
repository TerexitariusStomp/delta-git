// P3: Lane 2 — curated dynamic WordPress via php-wasm inside the Worker,
// D1 as durable SQLite. Needs Workers Paid CPU (render ~200–600ms > 10ms free cap).
// Feasibility is gated: plugin compat whitelist only.
import type { Env } from "./env";

const WHITELIST = new Set(["contact-form-7", "wpforms-lite", "wordpress-seo", "akismet"]);

export async function serveLane2(req: Request, env: Env, site: { id: string }): Promise<Response> {
  // Lazy-load php-wasm only on Lane-2 traffic (keeps free-tier bundle small)
  const { bootWordPress } = await import(/* @vite-ignore */ "php-wasm-cdn" as any).catch(() => ({ bootWordPress: null })) as any;
  if (!bootWordPress) return new Response("lane2 unavailable: wasm runtime not provisioned", { status: 501 });
  // Sketch: boot wp-in-wasm, mount site docroot from R2 (immutable manifest),
  // SQLite on D1 via sql.js adapter — the P0 spike this design hinges on.
  return new Response("lane2: wasm wp render (feasibility pending)", { status: 501 });
}
