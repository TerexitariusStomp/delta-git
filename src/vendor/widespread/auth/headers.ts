/**
 * Security headers — applied to all responses.
 *
 * Consolidates the duplicate security header implementations from worker and gateway.
 * Both use the same set of headers for defense-in-depth.
 */
import type { Context, Next } from "hono";

/**
 * Apply standard security headers to all responses.
 * Call as: app.use('*', securityHeaders)
 */
export async function securityHeaders(c: Context, next: Next): Promise<void> {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  // CSP — strict policy for API origins. No scripts should execute from these origins.
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  // Prevent caching of API responses — protects against sensitive data caching.
  if (!c.res.headers.get("Cache-Control")) {
    c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  }
}
