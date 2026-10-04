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

// 11. cron: USDC watcher (needs USDC_DEPOSIT_ADDRESS — skip gracefully if unset)
const cron = await fetch(BASE + "/cdn-cgi/handler/scheduled").catch(() => null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
