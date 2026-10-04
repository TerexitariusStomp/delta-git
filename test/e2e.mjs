// E2E smoke test against local wrangler dev (node --test or plain run)
// Requires `wrangler dev --port 8787 --local` + `wrangler d1 migrations apply --local`
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BASE = "http://localhost:8787";
const account = privateKeyToAccount(generatePrivateKey()); // fresh wallet per run (creator quota = 1 site)
let token, siteId, pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}`); };

const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 1. auth
const message = `wp-cloud login ${account.address.toLowerCase()} ${Date.now()}`;
const signature = await account.signMessage({ message });
const auth = await api("/api/auth/siwe", { method: "POST", body: JSON.stringify({ address: account.address, message, signature }) });
token = auth.body.token;
ok(auth.status === 200 && token, "SIWE auth issues token");

// 2. credits
const credits = await api("/api/credits");
ok(credits.status === 200 && credits.body.balance_micro === 0, "fresh balance = 0");

// 3. topup intent
const topup = await api("/api/topup", { method: "POST", body: JSON.stringify({ amount: 10 }) });
ok(topup.status === 200 && /^\d+\.\d+$/.test(String(topup.body.amount)), `topup intent salted amount=${topup.body.amount}`);

// 4. create site
const site = await api("/api/sites", { method: "POST", body: "{}" });
siteId = site.body.id;
ok(site.status === 200 && site.body.preview_host?.includes(siteId), `site created ${site.body.preview_host}`);

// 5. presign (URL format only — real R2 PUT needs deployed account)
const presign = await api(`/api/sites/${siteId}/presign`, { method: "POST", body: JSON.stringify({ sha: "test123", files: [{ path: "/index.html" }] }) });
ok(presign.status === 200 && presign.body.urls["/index.html"].includes("X-Amz-Signature"), "presigned PUT minted");

// 6. publish commit (Woo gate: clean plugin list)
const pub = await api(`/api/sites/${siteId}/publish`, { method: "POST", body: JSON.stringify({ sha: "test123", files: [{ path: "/index.html", size: 42 }], plugins: ["simply-static"] }) });
ok(pub.status === 200 && pub.body.sha === "test123", "publish commits manifest");

// 7. Woo detection gate
const woo = await api(`/api/sites/${siteId}/publish`, { method: "POST", body: JSON.stringify({ sha: "woo999", files: [{ path: "/cart/index.html", size: 9 }], plugins: ["woocommerce"] }) });
ok(woo.status === 422 && woo.body.required_lane === 3, "Woo site blocked from Lane 1");

// 8. put artifact directly into local R2, then serve
const { execSync } = await import("node:child_process");
execSync(`echo '<h1>hello wp-cloud</h1>' > /tmp/wpc-index.html`);
execSync(`cd ${process.env.HOME}/wp-cloud && npx wrangler r2 object put wpcloud-artifacts/sites/${siteId}/artifacts/test123/index.html --file /tmp/wpc-index.html --local`, { stdio: "pipe" });
const served = await fetch(`http://preview-${siteId}.localhost:8787/`).then((r) => r.text());
ok(served.includes("hello wp-cloud"), "artifact served on preview host");

// 9. versions + rollback
const v = await api(`/api/sites/${siteId}`);
ok(v.body.versions?.length === 1, "manifest listed as version");
const rb = await api(`/api/sites/${siteId}/rollback`, { method: "POST", body: JSON.stringify({ sha: "test123" }) });
ok(rb.status === 200, "rollback repoints manifest");

// 10. comments
const c = await api("/api/comments", { method: "POST", body: JSON.stringify({ site_id: siteId, post_path: "/", author: "t", body: "first!" }) });
ok(c.status === 200, "comment accepted");

// 11. quota: creator plan allows 1 site — second must 402
const q = await api("/api/sites", { method: "POST", body: "{}" });
ok(q.status === 402 && q.body.error === "site_quota", "site quota enforced");

// 12. suspend → serving shows top-up page (402)
await api(`/api/sites/${siteId}/status`, { method: "POST", body: JSON.stringify({ status: "suspended" }) });
const susp = await fetch(`http://preview-${siteId}.localhost:8787/`);
ok(susp.status === 402, "suspended site serves top-up page");
await api(`/api/sites/${siteId}/status`, { method: "POST", body: JSON.stringify({ status: "active" }) });

// 13. fork clones manifest into new site
const fork = await api(`/api/sites/${siteId}/fork`, { method: "POST", body: "{}" });
ok(fork.status === 402 || (fork.status === 200 && fork.body.forked_from === siteId), "fork clones site (quota-gated)");

// 14. plan upgrade without credit → 402
const plan = await api("/api/plan", { method: "POST", body: JSON.stringify({ plan: "pro" }) });
ok(plan.status === 402 && plan.body.error === "insufficient_credit", "plan upgrade needs prepaid credit");

// 15. status endpoint + rate limiter sanity
const st = await fetch(BASE + "/status").then((r) => r.json());
ok(typeof st.active_sites === "number", "status endpoint reports");

// 16. compat classifier: signature detection via /compat-scan
// fixture plugin sources covering each blocker class
const FIXTURES = [
  { slug: "woo-mysql8", source: "<?php // mysqli_real_connect(); utf8mb4_0900_ai_ci" },
  { slug: "sec-htaccess", source: "<?php // writes .htaccess rules; apache_request_headers()" },
  { slug: "chat-daemon", source: "<?php use Ratchet\\Server\\IoServer; while (true) { }" },
  { slug: "ms-network", source: "<?php if (is_multisite() && SUBDOMAIN_INSTALL) get_sites();" },
  { slug: "legacy-php", source: "<?php /* Requires PHP: 7.2 */" },
  { slug: "search-es", source: "<?php new \\Elasticsearch\\Client(); ElasticPress" },
  { slug: "game-panel", source: "<?php $s = stream_socket_server('tcp://0.0.0.0:25565');" },
  { slug: "boring-seo", source: "<?php // plain meta tags, no special runtime needs" },
];
const scan = await api(`/api/sites/${siteId}/compat-scan`, { method: "POST", body: JSON.stringify({ plugins: FIXTURES }) });
ok(scan.status === 200, "compat-scan accepts plugin set");
const verd = scan.body.verdicts ?? {};
ok(verd["woo-mysql8"]?.db === "mysql8", "classifier: mysqli/0900 → mysql8");
ok(verd["sec-htaccess"]?.sapi === "apache", "classifier: .htaccess → apache SAPI");
ok(verd["chat-daemon"]?.daemons === true, "classifier: Ratchet loop → daemon");
ok(verd["ms-network"]?.multisite === true, "classifier: multisite constants");
ok(verd["legacy-php"]?.php_version === "7.4", "classifier: Requires PHP 7.x → php74");
ok(verd["search-es"]?.sidecars?.includes("elastic"), "classifier: ElasticPress → elastic sidecar");
ok(verd["game-panel"]?.tcp_ingress === true, "classifier: socket listen → tcp_ingress");
ok(!verd["boring-seo"]?.db && !verd["boring-seo"]?.sapi, "classifier: plain plugin → no variant");
const mg = scan.body.merged ?? {};
ok(mg.db_engine === "mysql8" && mg.sapi === "apache" && mg.multisite === 1 && mg.tcp_ingress === 1,
  "merge: strongest requirements win (mysql8+apache+multisite+tcp)");
ok(scan.body.needed_plan === "enterprise", `merge: tcp_ingress forces enterprise tier (got ${scan.body.needed_plan})`);
ok(scan.body.entitled === false && scan.body.applied === false, "402 gate: creator plan can't get enterprise variant");

// 17. known-slug fast paths
const known = await api(`/api/sites/${siteId}/compat-scan`, { method: "POST", body: JSON.stringify({ plugins: [{ slug: "woocommerce" }, { slug: "wordfence" }] }) });
ok(known.body.verdicts?.woocommerce?.db === "mariadb", "known: woocommerce → mariadb");
ok(known.body.verdicts?.wordfence?.sapi === "apache", "known: wordfence → apache");

// 18. public verdict DB — classified slugs are now queryable
const pubWoo = await fetch(`${BASE}/api/compat/woocommerce`).then((r) => r.json());
ok(pubWoo.db === "mariadb" || pubWoo.error, "public /api/compat/:slug responds");
const pubWf = await fetch(`${BASE}/api/compat/wordfence`).then((r) => r.json());
ok(pubWf.sapi === "apache", "verdict DB caches wordfence → apache");

// 19. variant detail + override endpoints
const detail = await api(`/api/sites/${siteId}/compat`);
ok(detail.status === 200 && detail.body.site?.sapi === "frankenphp", "site compat detail readable");
const vovr = await api(`/api/sites/${siteId}/variant`, { method: "POST", body: JSON.stringify({ db_engine: "mysql8" }) });
ok(vovr.status === 402 && vovr.body.needed === "business", "mysql8 override gated to business tier");

// 20. site create carries variant defaults
const s2 = await api(`/api/sites/${siteId}`);
ok(s2.body.site?.db_engine === "sqlite" || s2.body.site?.db_engine === "mysql8", "site row has variant columns");

// 21. visitor-compute: earn toggle + endpoint shape (coordinator absent → graceful zeros)
const earnOff = await api(`/api/sites/${siteId}/earn`, { method: "POST", body: JSON.stringify({ enabled: true }) });
ok(earnOff.status === 200 && earnOff.body.earn_enabled === true, "earn card enabled on site");
const earnGet = await api(`/api/sites/${siteId}/earn`);
ok(earnGet.status === 200 && earnGet.body.ledger && typeof earnGet.body.network_nodes === "number", "earn status readable w/o coordinator");
// serving injection: enable → HTML carries visitor-node script tag.
// Publish a fresh manifest — new sha = new cache key (cached pages would
// otherwise serve the pre-enable response for their TTL).
execSync(`echo '<h1>earn page</h1>' > /tmp/wpc-earn.html`);
execSync(`cd ${process.env.HOME}/wp-cloud && npx wrangler r2 object put wpcloud-artifacts/sites/${siteId}/artifacts/earn123/index.html --file /tmp/wpc-earn.html --local`, { stdio: "pipe" });
const pub2 = await api(`/api/sites/${siteId}/publish`, { method: "POST", body: JSON.stringify({ sha: "earn123", files: [{ path: "/index.html", size: 20 }], plugins: [] }) });
ok(pub2.status === 200, "earn manifest published");
const earnHtml = await fetch(`http://preview-${siteId}.localhost:8787/`).then((r) => r.text());
if (!earnHtml.includes("visitor-node")) console.log("  [debug] served html:", earnHtml.slice(0, 200));
ok(earnHtml.includes("visitor-node.js") && earnHtml.includes(`data-site="${siteId}"`), "earn script injected into served HTML");
const vn = await fetch(`http://preview-${siteId}.localhost:8787/visitor-node.js`);
ok(vn.status === 200 && (await vn.text()).includes("JOB_DISPATCH"), "visitor-node.js served on site host");
// disable → injection stops (cache may hold TTL; check flag flip accepted)
const earnDisable = await api(`/api/sites/${siteId}/earn`, { method: "POST", body: JSON.stringify({ enabled: false }) });
ok(earnDisable.status === 200 && earnDisable.body.earn_enabled === false, "earn card disable accepted");

// 11. cron: USDC watcher (needs USDC_DEPOSIT_ADDRESS — skip gracefully if unset)
const cron = await fetch(BASE + "/cdn-cgi/handler/scheduled").catch(() => null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
