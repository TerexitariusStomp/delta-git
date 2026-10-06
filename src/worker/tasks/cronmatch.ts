// Minimal 5-field cron matcher for pipeline `schedule` triggers — the
// subset GitHub Actions documents: `*`, `*/n`, `n`, `a-b`, `a,b,c`, and
// `a-b/n` steps in minute/hour/dom/month/dow order. Names (JAN, MON)
// are intentionally unsupported — same as Actions, which only accepts
// POSIX numeric syntax.

type Field = { any: boolean; values: Set<number>; min: number; max: number };

function parseField(spec: string, min: number, max: number): Field | null {
  if (spec === "*" || spec === "?") return { any: true, values: new Set(), min, max };
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;
    let lo: number, hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const bounds = range.split("-");
      lo = parseInt(bounds[0], 10);
      hi = bounds.length === 2 ? parseInt(bounds[1], 10) : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
        return null;
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) return null;
  return { any: false, values, min, max };
}

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Parse a 5-field cron expression into matchable fields, or null when the
 * expression is outside the supported subset.
 */
export function parseCron(expr: string): { fields: Field[] } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 = Sunday)
  ];
  const fields: Field[] = [];
  for (let i = 0; i < 5; i++) {
    // Tolerate weekday names — cheap and common in hand-written crons.
    let spec = parts[i].toLowerCase();
    if (i === 4) DOW.forEach((d, n) => (spec = spec.replaceAll(d, String(n))));
    const field = parseField(spec, ranges[i][0], ranges[i][1]);
    if (!field) return null;
    fields.push(field);
  }
  return { fields };
}

function matches(fields: Field[], d: Date): boolean {
  const [min, hour, dom, mon, dow] = fields;
  return (
    (min.any || min.values.has(d.getUTCMinutes())) &&
    (hour.any || hour.values.has(d.getUTCHours())) &&
    (dom.any || dom.values.has(d.getUTCDate())) &&
    (mon.any || mon.values.has(d.getUTCMonth() + 1)) &&
    (dow.any || dow.values.has(d.getUTCDay()) || (d.getUTCDay() === 0 && dow.values.has(7)))
  );
}

/**
 * Next minute-aligned fire time strictly after `afterMs`, or null when no
 * fire lands within the search horizon (2 years — pathological expressions
 * like `0 0 30 2 *` simply never fire).
 */
export function nextCronFire(expr: string, afterMs: number): number | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;
  // Start at the next whole minute.
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const horizon = afterMs + 2 * 366 * 24 * 3600 * 1000;
  const fields = parsed.fields;
  while (t < horizon) {
    const d = new Date(t);
    // Skip fast: when a coarser field misses, jump to the next boundary
    // instead of walking minutes — keeps worst-case scans ~thousands of
    // iterations, not half a million.
    if (!fields[3].any && !fields[3].values.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      t = d.getTime();
      continue;
    }
    const domOk = fields[2].any || fields[2].values.has(d.getUTCDate());
    const dowOk =
      fields[4].any ||
      fields[4].values.has(d.getUTCDay()) ||
      (d.getUTCDay() === 0 && fields[4].values.has(7));
    if (!domOk || !dowOk) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      t = d.getTime();
      continue;
    }
    if (!fields[1].any && !fields[1].values.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      t = d.getTime();
      continue;
    }
    if (!fields[0].any && !fields[0].values.has(d.getUTCMinutes())) {
      t += 60000;
      continue;
    }
    if (matches(fields, d)) return t;
    t += 60000;
  }
  return null;
}
