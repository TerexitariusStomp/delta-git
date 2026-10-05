// Plugin compatibility classifier — the centerpiece of effective-100%.
// Scans plugin PHP source for runtime-requirement signatures and maps each
// plugin to the variant dimensions it needs. Every plugin either runs
// (on an auto-selected variant) or gets an explicit reason — never silent
// breakage.

export interface Verdict {
  sapi?: "apache";                    // needs real .htaccess / Apache env
  db?: "mariadb" | "mysql8";          // requires a real SQL server
  php_version?: string;               // "7.4" | "8.1" | "8.2" | "8.3" | "8.4"
  daemons?: boolean;                  // long-running PHP process → s6 + always_on
  tcp_ingress?: boolean;              // listens on a non-HTTP port → Spectrum tier
  sidecars?: string[];                // redis | elastic | memcached
  multisite?: boolean;
  cron?: boolean;                     // scheduled tasks → DO cron-wake
  heavy?: boolean;                    // memory/exec intensive → instance bump
  reason?: string;                    // human-readable, shown in admin panel
}

interface Signature {
  re: RegExp;
  apply: (v: VerdictInternal, reason: string) => void;
  reason: string;
}

interface VerdictInternal extends Verdict { _phpLt8?: boolean }

const SIGS: Signature[] = [
  { re: /mysqli_|mysql_query\(|utf8mb4_0900|->get_charset|SERVER_VERSION.*8\./i,
    apply: (v, r) => { v.db = "mysql8"; v.reason = r; },
    reason: "MySQL-8-specific API/collation" },
  { re: /CREATE\s+FULLTEXT|SPATIAL\s+INDEX|MATCH\s*\(\s*\w+\s*\)\s*AGAINST|GEOMETRY/i,
    apply: (v, r) => { if (!v.db) { v.db = "mariadb"; v.reason = r; } },
    reason: "SQL-server features (fulltext/spatial)" },
  { re: /\.htaccess|mod_rewrite|SERVER_SOFTWARE.*apache|apache_request_headers/i,
    apply: (v, r) => { v.sapi = "apache"; v.reason = r; },
    reason: "writes .htaccess or assumes Apache" },
  { re: /stream_socket_server|socket_listen|socket_bind|fsockopen\s*\([^,]*,\s*0\b/i,
    apply: (v, r) => { v.tcp_ingress = true; v.reason = r; },
    reason: "listens on a raw TCP port" },
  { re: /Ratchet|React\\Socket|Workerman|Amp\\|pcntl_fork|while\s*\(\s*true\s*\)|while\s*\(\s*1\s*\)/i,
    apply: (v, r) => { v.daemons = true; v.reason = r; },
    reason: "long-running daemon/event-loop" },
  { re: /WP_ALLOW_MULTISITE|is_multisite|SUBDOMAIN_INSTALL|get_sites\(/i,
    apply: (v, r) => { v.multisite = true; v.reason = r; },
    reason: "multisite-network features" },
  { re: /Requires\s+PHP:\s*([0-9.]+)/i,
    apply: (v, r) => { if (v._phpLt8) { v.php_version = "7.4"; v.reason = r; } },
    reason: "requires PHP < 8.0" },
  { re: /new\s+Redis|Predis|wp_using_ext_object_cache.*redis/i,
    apply: (v, r) => { (v.sidecars ??= []).push("redis"); v.reason = r; },
    reason: "Redis object cache" },
  { re: /ElasticPress|elasticsearch|Elasticsearch\\\\|\\\\Elasticsearch/i,
    apply: (v, r) => { (v.sidecars ??= []).push("elastic"); v.reason = r; },
    reason: "ElasticPress/Elasticsearch" },
  { re: /memcached|Memcached/i,
    apply: (v, r) => { (v.sidecars ??= []).push("memcached"); v.reason = r; },
    reason: "memcached" },
  { re: /ActionScheduler|wp_schedule_event|wp_next_scheduled|as_schedule_/i,
    apply: (v, r) => { v.cron = true; v.reason = r; },
    reason: "scheduled tasks need cron-wake" },
  { re: /set_time_limit\s*\(\s*0\s*\)|memory_limit.*512M|ZipArchive.*large|ini_set.*max_execution_time.*[3-9]\d\d/i,
    apply: (v, r) => { v.heavy = true; v.reason = r; },
    reason: "memory/exec-intensive" },
];

// Known-slug fast paths — curated overrides for high-install plugins so we
// don't depend on a source scan for the ones everyone uses.
const KNOWN: Record<string, Verdict> = {
  woocommerce: { db: "mariadb", cron: true, sidecars: ["redis"], reason: "Woo: MySQL engine + Action Scheduler + object cache" },
  wordfence: { sapi: "apache", heavy: true, reason: "firewall writes .htaccess/auto_prepend" },
  "ithemes-security": { sapi: "apache", reason: "writes .htaccess rules" },
  "ithemes-security-pro": { sapi: "apache", reason: "writes .htaccess rules" },
  "all-in-one-wp-migration": { heavy: true, reason: "large import/export" },
  updraftplus: { heavy: true, cron: true, reason: "backup jobs + schedule" },
  "wp-mail-smtp": { reason: "outbound SMTP ok" },
  "redis-cache": { sidecars: ["redis"], reason: "Redis object cache" },
  "elasticpress": { sidecars: ["elastic"], reason: "needs Elasticsearch" },
  "pusher-channels": { daemons: true, reason: "realtime" },
};

/** Classify one plugin. `source` = concatenated PHP of the plugin (or its header if that's all we have). */
export function classifyPlugin(slug: string, source: string): Verdict {
  const key = slug.toLowerCase();
  if (KNOWN[key]) return { ...KNOWN[key] };
  const phpReq = source.match(/Requires\s+PHP:\s*([0-9.]+)/i);
  const v: VerdictInternal = { _phpLt8: !!phpReq && parseFloat(phpReq[1]) < 8.0 };
  for (const s of SIGS) if (s.re.test(source)) s.apply(v, s.reason);
  delete v._phpLt8;
  return v;
}

/** Merge plugin verdicts into a site variant row. */
export function mergeVerdicts(verdicts: Verdict[]): {
  sapi: string; php_version: string; db_engine: string; multisite: number;
  daemons: number; tcp_ingress: number; cron: boolean; heavy: boolean; sidecars: string[];
} {
  const out = { sapi: "frankenphp", php_version: "8.4", db_engine: "sqlite", multisite: 0,
    daemons: 0, tcp_ingress: 0, cron: false, heavy: false, sidecars: [] as string[] };
  for (const v of verdicts) {
    if (v.sapi === "apache") out.sapi = "apache";
    if (v.php_version === "7.4") out.php_version = "7.4";
    if (v.db === "mysql8") out.db_engine = "mysql8";
    else if (v.db === "mariadb" && out.db_engine === "sqlite") out.db_engine = "mariadb";
    if (v.multisite) out.multisite = 1;
    if (v.daemons) out.daemons += 1;
    if (v.tcp_ingress) out.tcp_ingress = 1;
    if (v.cron) out.cron = true;
    if (v.heavy) out.heavy = true;
    if (v.sidecars) for (const s of v.sidecars) if (!out.sidecars.includes(s)) out.sidecars.push(s);
  }
  // daemons imply always-on
  return out;
}

/** Plan tier required for a merged variant — feeds the 402 entitlement gate. */
export function planForVariant(v: ReturnType<typeof mergeVerdicts>): string {
  if (v.tcp_ingress || v.sidecars.includes("elastic")) return "enterprise";
  if (v.db_engine === "mysql8" || v.daemons > 0) return "business";
  if (v.sapi === "apache" || v.php_version === "7.4" || v.sidecars.length) return "pro";
  return "pro"; // any Lane-3 site
}

const TIER: Record<string, number> = { creator: 0, micro: 1, starter: 2, pro: 3, business: 4, always_on: 4, agency: 4, enterprise: 5 };
export function tierAtLeast(plan: string, needed: string): boolean {
  return (TIER[plan] ?? 0) >= (TIER[needed] ?? 0);
}
