// Shared Cloudflare v4 API client for platform-account effects (D1
// provisioning, worker deploys, artifacts subscriptions). Credentials come
// from the CF_ACCOUNT_ID var + CF_API_TOKEN secret — the same lane the
// deploy task uses. A missing/placeholder token returns `configured:
// false` so callers can surface an honest "platform unconfigured" rather
// than burning a call that will 403.

// `.dev.vars` ships a placeholder token for local dev.
const PLACEHOLDER_TOKEN = "local-placeholder";
const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfApiResult {
  ok: boolean;
  /** HTTP status from the edge. */
  status: number;
  /** `result` payload when the envelope parses. */
  result?: unknown;
  errors: string[];
  /** False when credentials are absent — the call never left the worker. */
  configured: boolean;
}

export async function cfApi(env: Env, path: string, init?: RequestInit): Promise<CfApiResult> {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !token || token === PLACEHOLDER_TOKEN) {
    return { ok: false, status: 0, errors: ["cf-credentials-missing"], configured: false };
  }
  const res = await fetch(`${CF_API}/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  }).catch(() => null);
  if (!res) {
    return { ok: false, status: 0, errors: ["cf-api-unreachable"], configured: true };
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
    errors?: { message?: string }[];
  } | null;
  return {
    ok: res.ok && body?.success === true,
    status: res.status,
    result: body?.result,
    errors: (body?.errors ?? []).map((e) => e.message ?? "unknown"),
    configured: true,
  };
}
