// Chimera visitor node — turns an opt-in site visitor into a paid job node.
// CONSENT-FIRST: nothing computes before an explicit "Start earning" click,
// and nothing survives an opt-out. Consent persists (auto-resume on return
// visits) until revoked, which wipes all local state.
// Speaks the coordinator wire protocol (REGISTER / HEARTBEAT / JOB_DISPATCH /
// JOB_RESULT) directly — no SDK dependency needed.
// Loaded by wp-cloud's serving layer or any site embed:
//   <script src="/visitor-node.js" data-site="SITE_ID"
//           data-coordinator="wss://coordinator.example.com"
//           data-project="my-project" data-ref="VOLUNTEER_ID" defer></script>
(() => {
  const cfg = document.currentScript?.dataset ?? {};
  const SITE = cfg.site || "";
  const COORD = cfg.coordinator || "";
  const PROJECT = cfg.project || "";
  const REFERRER = cfg.ref || "";
  const LABEL = cfg.label || "Earn while you browse";
  const SCOPE = PROJECT || SITE;            // consent/identity is pool-scoped
  const OPTOUT_KEY = `chimera-optout:${SCOPE}`;
  const CONSENT_KEY = `chimera-consent:${SCOPE}`;
  const ID_KEY = `chimera-id:${SCOPE}`;
  const INTENSITY_KEY = `chimera-intensity:${SCOPE}`;
  if (!COORD || !(SITE || PROJECT) || localStorage.getItem(OPTOUT_KEY)) return;

  // ---------- capability guards ----------
  const hasWebGPU = "gpu" in navigator;
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  let batteryLow = false;
  navigator.getBattery?.().then((b) => {
    batteryLow = !b.charging && b.level < 0.25;
    b.onlevelchange = () => (batteryLow = !b.charging && b.level < 0.25);
  });

  // Model weights are tens-to-hundreds of MB — never fetch them over a
  // metered/cellular connection or with Save-Data on. Jobs that need the
  // model are rejected (and retried by the coordinator) until we're on wifi.
  const metered = () => {
    const c = navigator.connection;
    return !!(c && (c.saveData || c.type === "cellular" || /2g/.test(c.effectiveType || "")));
  };

  // ---------- consent UI ----------
  const card = document.createElement("div");
  card.id = "chimera-earn";
  card.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:99999;background:#141926;color:#e6e9ef;" +
    "border:1px solid #2a3550;border-radius:10px;padding:10px 14px;font:13px system-ui;" +
    "box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:290px";
  document.body.appendChild(card);

  let intensity = Number(localStorage.getItem(INTENSITY_KEY) || cfg.intensity || 100);

  function render(state) {
    // state: 'ask' | 'run' | 'mini' — 'mini' is the always-visible collapsed
    // pill so participation is never silently running or silently stopped.
    if (state === "mini") {
      card.style.padding = "6px 10px";
      card.innerHTML =
        `<span style="cursor:pointer;font:12px ui-monospace,monospace;color:#7dd3fc" ` +
        `id="ce-expand">⚡ ${running ? "earning" : "supporter"} — click to open</span>`;
      card.querySelector("#ce-expand").onclick = () => render("run");
      return;
    }
    card.style.padding = "10px 14px";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong>${LABEL}</strong>
        <button id="ce-close" title="minimize" style="background:none;border:0;color:#666;cursor:pointer;font-size:14px">✕</button>
      </div>
      <div id="ce-state" style="color:#9aa4b8;margin:6px 0">Your spare compute runs small jobs — and pays you.</div>
      <div id="ce-stats" style="color:#7dd3fc;font:12px ui-monospace,monospace"></div>
      <div id="ce-supporters" style="color:#5b6478;font:11px ui-monospace,monospace;margin-top:2px"></div>
      <div id="ce-intensity-row" style="display:none;margin-top:8px;align-items:center;gap:6px;color:#9aa4b8;font:11px">
        <span>load</span>
        <input id="ce-intensity" type="range" min="25" max="100" step="25" value="${intensity}" style="flex:1;accent-color:#3b82f6">
        <span id="ce-intensity-val">${intensity}%</span>
      </div>
      <div id="ce-netjobs-row" style="display:none;margin-top:6px;color:#9aa4b8;font:11px">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
          <input id="ce-netjobs" type="checkbox" ${netJobs ? "checked" : ""} style="accent-color:#3b82f6">
          also fetch &amp; pin public web content (uses my connection)
        </label>
      </div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button id="ce-start" style="background:#3b82f6;border:0;border-radius:6px;color:#fff;padding:5px 12px;cursor:pointer;font:inherit">Start earning</button>
        <button id="ce-never" style="background:#232838;border:0;border-radius:6px;color:#9aa4b8;padding:5px 10px;cursor:pointer;font:inherit">No thanks</button>
      </div>`;
    card.querySelector("#ce-close").onclick = () => render("mini");
    card.querySelector("#ce-never").onclick = optOut;
    card.querySelector("#ce-intensity").oninput = (e) => {
      intensity = Number(e.target.value);
      localStorage.setItem(INTENSITY_KEY, String(intensity));
      card.querySelector("#ce-intensity-val").textContent = `${intensity}%`;
    };
    card.querySelector("#ce-netjobs").onchange = (e) => {
      netJobs = !!e.target.checked;
      if (netJobs) localStorage.setItem(NETJOBS_KEY, "1");
      else localStorage.removeItem(NETJOBS_KEY);
      // Re-announce capabilities immediately — HEARTBEAT carries taskTypes.
      send({ type: "HEARTBEAT", taskTypes: taskTypes() });
    };
    if (running) {
      const b = card.querySelector("#ce-start");
      b.textContent = "Stop";
      b.onclick = stop;
      card.querySelector("#ce-intensity-row").style.display = "flex";
      card.querySelector("#ce-netjobs-row").style.display = "block";
      setState("Earning — jobs run only while this tab is visible");
    } else {
      card.querySelector("#ce-start").onclick = start;
    }
    refreshStats();
  }
  const setState = (t) => { const el = card.querySelector("#ce-state"); if (el) el.textContent = t; };
  const setStats = (t) => { const el = card.querySelector("#ce-stats"); if (el) el.textContent = t; };

  // ---------- node lifecycle ----------
  let ws = null, running = false;
  let volunteerId = localStorage.getItem(ID_KEY) || crypto.randomUUID();
  localStorage.setItem(ID_KEY, volunteerId);
  let jobsDone = 0, earnedWei = 0n, earningsPoll = null, heartbeat = null;

  // Job-type → handler. Canonical 0 + wp-cloud 100-103 + project 200-203 go
  // through the local models; 1 = STORAGE pin, 205 = WEB_FETCH,
  // 206 = CANARY (coordinator echo-check — answers honestly, proves the node
  // doesn't fabricate results). 1+205 are network jobs — the coordinator
  // picks the URLs — so they sit behind the net-jobs opt-in, not consent alone.
  const PIN_CACHE = "chimera-pins";
  const NETJOBS_KEY = `chimera-netjobs:${SCOPE}`;
  let netJobs = localStorage.getItem(NETJOBS_KEY) === "1" || cfg.netjobs === "1";
  const computeTypes = [0, 100, 101, 102, 103, 200, 201, 202, 203, 206];
  const netTypes = [1, 205];   // fetch/pin URLs chosen by projects → opt-in
  const taskTypes = () => computeTypes.concat(netJobs ? netTypes : []);

  // Model tier by capability — defaults sit in/around the 135–360M band;
  // data-model overrides. transformers.js lazily loads on first infer job
  // (and only when not metered).
  const defaultModel = () => {
    if (mem >= 8 && cores >= 6) return "Xenova/gpt2-medium";   // ~355M
    if (mem >= 4 && cores >= 4) return "Xenova/gpt2";          // ~124M
    return "Xenova/distilgpt2";                                // ~82M weak devices
  };
  let pipe = null, pipeLoading = null;
  async function ensureModel() {
    if (pipe) return pipe;
    if (metered()) throw new Error("model weights deferred (metered connection)");
    if (!pipeLoading) {
      pipeLoading = (async () => {
        const { pipeline, env: tenv } = await import(
        cfg.lib || "https://esm.sh/@huggingface/transformers@3");
        // Model host is configurable — deployments can serve weights from R2
        // or a CDN mirror (HF is unreachable in some regions and per-visitor
        // egress is better served from your own edge anyway).
        if (cfg.host) { tenv.remoteHost = cfg.host; tenv.allowRemoteModels = true; }
        if (cfg.local) { tenv.allowLocalModels = true; tenv.localModelPath = cfg.local; }
        pipe = await pipeline("text-generation", cfg.model || defaultModel());
        return pipe;
      })().finally(() => { pipeLoading = null; });
    }
    return pipeLoading;
  }

  async function infer(payload) {
    const p = await ensureModel();
    const prompt = JSON.parse(payload).prompt ?? payload;
    const out = await p(prompt, { max_new_tokens: 256 });
    const text = out[0]?.generated_text?.slice(prompt.length) ?? "";
    if (!text.trim()) throw new Error("empty model output");
    return text;
  }

  // REPO_INDEX (202) runs a separate feature-extraction model — embeddings,
  // not generation. ~22MB weights (all-MiniLM-L6-v2), lazily loaded only
  // when an index job actually arrives.
  let embedPipe = null, embedLoading = null;
  async function ensureEmbedder() {
    if (embedPipe) return embedPipe;
    if (metered()) throw new Error("embedder deferred (metered connection)");
    if (!embedLoading) {
      embedLoading = (async () => {
        const { pipeline, env: tenv } = await import(
          cfg.lib || "https://esm.sh/@huggingface/transformers@3");
        if (cfg.host) { tenv.remoteHost = cfg.host; tenv.allowRemoteModels = true; }
        embedPipe = await pipeline(
          "feature-extraction", cfg.embedModel || "Xenova/all-MiniLM-L6-v2");
        return embedPipe;
      })().finally(() => { embedLoading = null; });
    }
    return embedLoading;
  }

  // Project job types — each wraps model output in the coordinator's result
  // schema so submissions pass the result gate instead of landing invalid.
  async function researchJob(payload) {                    // 201 → {summary}
    const text = await infer(payload);
    return JSON.stringify({ summary: text.trim() });
  }

  async function copyJob(payload) {                        // 203 → {drafts[]}
    const text = await infer(payload);
    return JSON.stringify({ drafts: [text.trim()] });
  }

  async function indexJob(payload) {                       // 202 → {vectors[][]}
    const { texts } = JSON.parse(payload);
    const p = await ensureEmbedder();
    const vectors = [];
    for (const t of (Array.isArray(texts) ? texts : [texts]).slice(0, 16)) {
      const out = await p(String(t ?? "").slice(0, 2048), { pooling: "mean", normalize: true });
      vectors.push(Array.from(out.data));
    }
    return JSON.stringify({ vectors });
  }

  const sha256hex = async (buf) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");

  // WEB_FETCH (205): plain fetch — CORS-bound, which is a feature: failures
  // reject rather than fabricate results. https-only, ≤1MB, 10s timeout.
  async function webFetchJob(payload) {
    const { url } = JSON.parse(payload);
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("https-only");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1_048_576) throw new Error("body >1MB");
      return JSON.stringify({ bodyHash: await sha256hex(buf), bytes: buf.byteLength });
    } finally { clearTimeout(timer); }
  }

  // STORAGE pin (1): fetch content, verify its hash, park it in the Cache
  // API so the browser serves it for as long as storage pressure allows.
  async function pinJob(payload) {
    if (metered()) throw new Error("pin deferred (metered connection)");
    const { url, expectHash } = JSON.parse(payload);
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("https-only");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 8_388_608) throw new Error("pin >8MB");
    const cid = await sha256hex(buf);
    if (expectHash && expectHash !== cid) throw new Error("hash mismatch");
    const cache = await caches.open(PIN_CACHE);
    await cache.put(u.href, new Response(buf));
    return JSON.stringify({ cid, verified: true });
  }

  function canRun() {
    return running && !document.hidden && !batteryLow;
  }

  async function onJob(msg) {
    if (!canRun()) return send({ type: "JOB_REJECTED", jobId: msg.jobId, reason: "visitor-busy-or-offscreen" });
    // Intensity slider — below 100% we probabilistically pass jobs back so
    // the coordinator routes them elsewhere.
    if (intensity < 100 && Math.random() * 100 > intensity) {
      return send({ type: "JOB_REJECTED", jobId: msg.jobId, reason: "intensity-cap" });
    }
    try {
      let result;
      if (msg.taskType === 206) result = JSON.parse(msg.requestHash).nonce;  // canary echo
      else if (msg.taskType === 1) result = await pinJob(msg.requestHash);
      else if (msg.taskType === 205) result = await webFetchJob(msg.requestHash);
      else if (msg.taskType === 200) result = await infer(msg.requestHash);          // AGENT_INFER — raw text
      else if (msg.taskType === 201) result = await researchJob(msg.requestHash);    // {summary}
      else if (msg.taskType === 202) result = await indexJob(msg.requestHash);       // {vectors}
      else if (msg.taskType === 203) result = await copyJob(msg.requestHash);        // {drafts}
      else if (msg.taskType >= 100 || msg.taskType === 0) result = await infer(msg.requestHash);
      else result = "";
      jobsDone++;
      earnedWei += BigInt(msg.amount || "0");
      refreshStats();
      send({ type: "JOB_RESULT", jobId: msg.jobId, result });
      refreshEarnings();
    } catch (e) {
      send({ type: "JOB_REJECTED", jobId: msg.jobId, reason: String(e).slice(0, 120) });
    }
  }

  function send(m) { ws?.readyState === 1 && ws.send(JSON.stringify(m)); }

  async function refreshEarnings() {
    try {
      const url = COORD.replace(/^ws/, "http") + `/earnings?id=${volunteerId}`;
      const e = await fetch(url).then((r) => r.json());
      earnedWei = BigInt(e.totalWei || "0");
      refreshStats();
    } catch {}
  }

  async function refreshSupporters() {
    if (!PROJECT) return;
    try {
      const s = await fetch(COORD.replace(/^ws/, "http") + "/status").then((r) => r.json());
      const n = s.byProject?.[PROJECT] || 0;
      const el = card.querySelector("#ce-supporters");
      if (el) el.textContent = `${n} supporter${n === 1 ? "" : "s"} online`;
    } catch {}
  }

  function refreshStats() {
    const usd = (Number(earnedWei) / 1e18).toFixed(4);
    setStats(`${jobsDone} jobs · earned ≈ $${usd}`);
  }

  function connect() {
    // VOLUNTEER_TOKEN is a public handshake marker, not a secret — override
    // via data-token if the coordinator ever rotates it.
    ws = new WebSocket(`${COORD}?token=${encodeURIComponent(cfg.token || "widespread-volunteer")}`);
    ws.onopen = () => {
      send({
        type: "REGISTER", volunteerId, site: SITE || undefined,
        project: PROJECT || undefined, referrer: REFERRER || undefined,
        taskTypes: taskTypes(),
        capabilities: { hasWebGPU, cpuCores: cores, ramGb: mem, batterySaver: batteryLow },
      });
      setState("Earning — jobs run only while this tab is visible");
      heartbeat = setInterval(() => send({ type: "HEARTBEAT" }), 25_000);
      earningsPoll = setInterval(() => { refreshEarnings(); refreshSupporters(); }, 120_000);
      refreshSupporters();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "JOB_DISPATCH") onJob(msg);
      if (msg.type === "REGISTERED") volunteerId = msg.volunteerId;
    };
    ws.onclose = () => {
      clearInterval(heartbeat); clearInterval(earningsPoll);
      if (running) setTimeout(connect, 5000);       // auto-reconnect while opted in
    };
    ws.onerror = () => ws.close();
  }

  function start() {
    running = true;
    localStorage.setItem(CONSENT_KEY, "1");   // persistent consent → auto-resume
    const b = card.querySelector("#ce-start");
    b.textContent = "Stop";
    b.onclick = stop;
    card.querySelector("#ce-intensity-row").style.display = "flex";
    connect();
  }

  function sessionRecap() {
    const usd = (Number(earnedWei) / 1e18).toFixed(4);
    return `Session: ${jobsDone} job${jobsDone === 1 ? "" : "s"} · ≈ $${usd} earned`;
  }

  function stop() {
    running = false;
    clearInterval(heartbeat); clearInterval(earningsPoll);
    ws?.close();
    setState(`${sessionRecap()} — stopped; consent kept for next visit`);
    const b = card.querySelector("#ce-start");
    b.textContent = "Start earning";
    b.onclick = start;
  }

  // Revoke + wipe: clear consent and identity so nothing ties future visits
  // to this node's history. The opt-out flag itself survives (that's the
  // point of it).
  function optOut() {
    running = false;
    clearInterval(heartbeat); clearInterval(earningsPoll);
    ws?.close();
    localStorage.setItem(OPTOUT_KEY, "1");
    localStorage.removeItem(CONSENT_KEY);
    localStorage.removeItem(ID_KEY);
    localStorage.removeItem(INTENSITY_KEY);
    card.remove();
  }

  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    setState(document.hidden
      ? "Paused — tab hidden (compute only runs onscreen)"
      : "Earning — jobs run only while this tab is visible");
  });

  // Boot: stored consent = auto-resume (the card still shows state; nothing
  // is hidden). No consent = the ask card.
  render("ask");
  if (localStorage.getItem(CONSENT_KEY)) {
    running = true;
    render("run");
    connect();
  }
})();
