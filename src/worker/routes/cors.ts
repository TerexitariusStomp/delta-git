// CORS handling for the Git Smart HTTP v2 surface.
//
// Browser git clients (isomorphic-git in the phone/PWA working copy, embedded
// web IDEs) cannot talk to a remote that omits CORS headers. Git clients
// authenticate via the Authorization header (Basic or PAT Bearer), which the
// Fetch spec treats as "credentials" — meaning ACAO:* is rejected and the
// request Origin must be reflected exactly, with Allow-Credentials set.
//
// This is deliberately scoped to the git protocol routes. UI and API routes
// that need CORS set their own headers at the handler level.

const GIT_CORS_HEADERS = "Authorization, Content-Type, Git-Protocol";

function allowedOrigin(req: Request): string {
  // Reflect the caller's Origin; credentialed CORS forbids the `*` wildcard.
  // Git CLI/Desktop clients do not send Origin and ignore these headers.
  return req.headers.get("Origin") ?? "null";
}

export function gitCorsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": GIT_CORS_HEADERS,
    // Expose everything a JS git client may want to read.
    "Access-Control-Expose-Headers": "Git-Protocol, WWW-Authenticate, Retry-After",
    Vary: "Origin",
  };
}

export function withGitCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(gitCorsHeaders(req))) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export function gitCorsPreflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...gitCorsHeaders(req),
      "Access-Control-Max-Age": "86400",
    },
  });
}
