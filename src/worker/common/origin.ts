/**
 * Public request origin behind a fronting proxy.
 *
 * The code.widespread.fyi router stamps `X-Forwarded-Host`/`-Proto` with
 * the public host; the header is honored only when it matches the
 * `PUBLIC_ORIGIN` host — an unvalidated forwarded host would turn every
 * emitted URL (redirects, clone hints, OAuth issuer metadata, DPoP htu
 * comparisons) into an open-redirect / auth-binding primitive.
 *
 * Direct hits (workers.dev, localhost dev) carry no forwarded header and
 * resolve to the request's own origin, so both surfaces keep working.
 */
export function requestOrigin(
  env: { PUBLIC_ORIGIN?: string },
  url: string | URL,
  headers?: Headers
): string {
  const reqUrl = typeof url === "string" ? new URL(url) : url;
  const forwarded = headers?.get("x-forwarded-host");
  if (forwarded && env.PUBLIC_ORIGIN && forwarded === new URL(env.PUBLIC_ORIGIN).host) {
    const proto = headers!.get("x-forwarded-proto") ?? reqUrl.protocol.replace(/:$/, "");
    return `${proto}://${forwarded}`;
  }
  return reqUrl.origin;
}
