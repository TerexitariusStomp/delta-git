import { startPlaygroundWeb } from "https://esm.sh/@wp-playground/client@1.2.10?bundle-deps";

const $ = (id) => document.getElementById(id);
const log = (m) => ($("log").textContent += `\n${m}`);
const status = (m) => ($("status").textContent = m);

let token = localStorage.getItem("wpc_token");
let site = null;
let client = null;
let blueprint = null;

// ---------- API ----------
async function call(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
}

// ---------- Wallet auth (SIWE-lite) ----------
$("connect").onclick = async () => {
  if (!window.ethereum) return alert("No wallet found — install a browser wallet.");
  const [addr] = await ethereum.request({ method: "eth_requestAccounts" });
  const message = `wp-cloud login ${addr.toLowerCase()} ${Date.now()}`;
  const signature = await ethereum.request({ method: "personal_sign", params: [message, addr] });
  const j = await call("/api/auth/siwe", { method: "POST", body: JSON.stringify({ address: addr, message, signature }) });
  token = j.token;
  localStorage.setItem("wpc_token", token);
  log(`signed in ${j.did}`);
  refresh();
};

async function refresh() {
  if (!token) return;
  $("newSite").disabled = false;
  const { balance_micro } = await call("/api/credits");
  $("balance").textContent = `$${(balance_micro / 1e6).toFixed(2)} USDC`;
}

// ---------- Site creation ----------
$("newSite").onclick = async () => {
  site = await call("/api/sites", { method: "POST", body: "{}" });
  const url = site.preview_url ?? `https://${site.preview_host}`;
  log(`site ${site.id} → ${url}`);
  $("siteCard").innerHTML = `id <code>${site.id}</code><br>preview <a href="${url}" target="_blank">${url}</a>`;
  $("publish").disabled = false;
  $("deployGit").disabled = false;
  $("versions").disabled = false;
  $("compat").disabled = false;
  bootWp();
};

// ---------- Deploy from delta-git (forge → site, no browser upload) ----------
$("deployGit").onclick = async () => {
  if (!site) return;
  const repo = prompt("delta-git repo to deploy (owner/slug):", "rooted-finance/wpcloud-demo");
  if (!repo) return;
  const ref = prompt("branch/ref:", "main") || "main";
  status("deploying from delta-git…");
  try {
    const res = await call(`/api/sites/${site.id}/deploy-git`, {
      method: "POST",
      body: JSON.stringify({ repo, ref }),
    });
    status("live");
    log(`deployed ${repo}@${ref} → ${res.url} (${res.files} files)`);
    $("siteCard").innerHTML = `id <code>${site.id}</code><br><a href="${res.url}" target="_blank">${res.url}</a><br>source <code>${repo}@${ref}</code> — pushes redeploy automatically`;
  } catch (e) {
    status("deploy failed");
    log(`deploy-git failed: ${e.message}`);
  }
};

const BLUEPRINT = {
  landingPage: "/wp-admin/",
  preferredVersions: { php: "8.3", wp: "latest" },
  steps: [{ step: "setSiteOptions", options: { blogname: "My wp-cloud site" } }],
};

async function bootWp() {
  blueprint = { ...BLUEPRINT, steps: [...BLUEPRINT.steps] };
  status("booting WordPress…");
  client = await startPlaygroundWeb({
    iframe: $("wp"),
    remoteUrl: "https://playground.wordpress.net/remote.html",
    blueprint,
  });
  await client.isReady();
  status("WordPress ready");
  log("wp admin ready — edit, then Publish");
}

// ---------- Publish: spider → presign → PUT → commit ----------
async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toArtifactPath(pathname) {
  let p = pathname.replace(/^\/+(index\.php)?/, "/");
  if (p.endsWith("/") || p === "") return p + "index.html";
  if (!p.includes(".")) return p + "/index.html";
  return p;
}

async function* spider(client) {
  const origin = new URL(client.absoluteUrl).origin;
  const seen = new Set(["/"]);
  const queue = ["/"];
  while (queue.length) {
    const path = queue.shift();
    const res = await client.request({ url: path });
    if (res.httpStatusCode >= 400) continue;
    const bytes = new Uint8Array(res.bytes);
    const ctype = res.headers?.["content-type"]?.[0] ?? "";
    yield { path: toArtifactPath(path), bytes, ctype };
    if (!ctype.includes("text/html")) continue;
    const html = new TextDecoder().decode(bytes);
    for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      try {
        const u = new URL(m[1], origin);
        if (u.origin !== origin) continue;
        let p = u.pathname;
        if (p.startsWith("/scope:")) p = p.slice(p.indexOf("/", 7)); // strip playground scope prefix
        if (!seen.has(p) && !p.startsWith("/wp-admin") && !p.startsWith("/wp-login")) { seen.add(p); queue.push(p); }
      } catch {}
    }
  }
}

$("publish").onclick = async () => {
  if (!client || !site) return;
  status("spidering…");
  const files = [];
  const plugins = await client.listFiles("/wordpress/wp-content/plugins").catch(() => []);
  for await (const f of spider(client)) files.push(f);
  if (!files.length) return status("nothing to publish");
  // manifest sha over sorted path:size:contentSha
  for (const f of files) f.sha = await sha256Hex(f.bytes);
  const sha = await sha256Hex(new TextEncoder().encode(files.map((f) => `${f.path}:${f.bytes.length}:${f.sha}`).sort().join("\n")));
  log(`manifest ${sha.slice(0, 12)} — ${files.length} files`);
  status("getting upload URLs…");
  // Prefer direct-to-R2 presigned PUTs when the deployment has R2 API creds;
  // fall back to streaming each file through the worker (always available).
  let urls = null;
  try {
    ({ urls } = await call(`/api/sites/${site.id}/presign`, {
      method: "POST",
      body: JSON.stringify({ sha, files: files.map((f) => ({ path: f.path })) }),
    }));
    if (Object.values(urls).some((u) => !u || !String(u).includes("X-Amz"))) urls = null;
  } catch { urls = null; }
  status("uploading…");
  if (urls) {
    await Promise.all(files.map((f) => fetch(urls[f.path], { method: "PUT", body: f.bytes })));
  } else {
    await Promise.all(files.map((f) =>
      fetch(`/api/sites/${site.id}/upload?sha=${sha}&path=${encodeURIComponent(f.path)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: f.bytes,
      }).then((r) => { if (!r.ok) throw new Error(`upload ${f.path}: ${r.status}`); })
    ));
  }
  status("committing…");
  const res = await call(`/api/sites/${site.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ sha, files: files.map((f) => ({ path: f.path, size: f.bytes.length })), plugins }),
  });
  status("live");
  log(`published → ${res.url}`);
  $("siteCard").innerHTML = `id <code>${site.id}</code><br><a href="${res.url}" target="_blank">${res.url}</a>`;
};

// ---------- Versions / rollback ----------
$("versions").onclick = async () => {
  if (!site) return;
  const { versions } = await call(`/api/sites/${site.id}`);
  log("versions: " + versions.map((v) => v.sha.slice(0, 8)).join(", "));
  const target = prompt("rollback to sha prefix? (blank = none)");
  if (target) {
    const v = versions.find((v) => v.sha.startsWith(target));
    if (v) { await call(`/api/sites/${site.id}/rollback`, { method: "POST", body: JSON.stringify({ sha: v.sha }) }); log("rolled back"); }
  }
};

// ---------- Compatibility scan ----------
$("compat").onclick = async () => {
  if (!site) return;
  status("classifying plugins…");
  const dirs = await client?.listFiles("/wordpress/wp-content/plugins").catch(() => []) ?? [];
  const plugins = dirs.filter((d) => d.isDir).map((d) => ({ slug: d.name }));
  const res = await call(`/api/sites/${site.id}/compat-scan`, { method: "POST", body: JSON.stringify({ plugins }) });
  const lines = Object.entries(res.verdicts).map(([slug, v]) => {
    const flags = [v.sapi, v.db, v.php_version !== "8.4" ? v.php_version : null, v.daemons ? "daemon" : null,
      v.tcp_ingress ? "needs-Spectrum" : null, v.multisite ? "multisite" : null, ...(v.sidecars ?? [])].filter(Boolean);
    return `  ${slug}: ${flags.length ? flags.join(", ") : "static-safe"}`;
  });
  log(`compat: variant=${res.merged.sapi}/${res.merged.php_version}/${res.merged.db_engine}` +
      `${res.merged.multisite ? " multisite" : ""}${res.merged.daemons ? ` ${res.merged.daemons} daemon(s)` : ""}` +
      ` → needs ${res.needed_plan} (${res.entitled ? "applied" : "upgrade required"})\n` + lines.join("\n"));
  status(res.entitled ? "compatible" : "upgrade required");
};

// ---------- Top up ----------
$("topup").onclick = async () => {
  const amt = +(prompt("Top up amount (USDC)?", "10") || 0);
  if (!amt) return;
  const j = await call("/api/topup", { method: "POST", body: JSON.stringify({ amount: amt }) });
  $("deposit").innerHTML = `<br>Send exactly <code>${j.amount} USDC</code> on ${j.chain} to<br><code>${j.address}</code>`;
};

refresh();
