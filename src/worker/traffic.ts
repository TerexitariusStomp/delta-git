// Clone traffic accounting — shared by the git protocol routes (which
// count clones) and the gitness insights facade (which reports them).
// Kept out of api/gitness/stores.ts so the protocol layer never imports
// the API facade.
//
// Every authorized upload-pack POST and bundle GET counts one clone —
// the same rollup GitHub uses (fetches count toward clone traffic).
// Per-day KV keys give the endpoint a daily series; keys expire after
// 40 days (GitHub shows 14 — headroom costs nothing).

const TRAFFIC_TTL_SEC = 40 * 24 * 60 * 60;
const TRAFFIC_DAYS = 14;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function trafficCloneKey(doName: string, day: string): string {
  return `gtraffic:${doName}:clones:${day}`;
}

/** Fire-and-forget clone counter — call inside waitUntil after auth. */
export async function recordClone(env: Env, doName: string): Promise<void> {
  const key = trafficCloneKey(doName, dayKey(Date.now()));
  const raw = await env.ROUTES.get(key);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  await env.ROUTES.put(key, String(count), { expirationTtl: TRAFFIC_TTL_SEC });
}

export interface CloneDay {
  timestamp: string;
  count: number;
}

/** Last `days` days of clone counts, oldest first (GitHub's chart order). */
export async function readCloneTraffic(
  env: Env,
  doName: string,
  days = TRAFFIC_DAYS
): Promise<CloneDay[]> {
  const today = Date.now();
  const window: { day: string; key: string }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(today - i * 24 * 60 * 60 * 1000);
    window.push({ day, key: trafficCloneKey(doName, day) });
  }
  const values = await Promise.all(window.map((d) => env.ROUTES.get(d.key)));
  return window.map((d, i) => ({
    timestamp: `${d.day}T00:00:00Z`,
    count: values[i] ? parseInt(values[i]!, 10) || 0 : 0,
  }));
}
