// Chimera visitor node — turns an opt-in site visitor into a paid AI job node.
// CONSENT-FIRST: nothing computes before an explicit "Start earning" click.
// Speaks the coordinator wire protocol (REGISTER / HEARTBEAT / JOB_DISPATCH /
// JOB_RESULT) directly — no SDK dependency needed for infer job types.
// Loaded by the chimera-earn WP plugin or any site embed:
//   <script src="/visitor-node.js" data-site="SITE_ID"
//           data-coordinator="wss://coordinator.example.com" defer></script>
(() => {
  const cfg = document.currentScript?.dataset ?? {};
  const SITE = cfg.site || "";
  const COORD = cfg.coordinator || "";
  const LABEL = cfg.label || "Earn while you browse";
  const OPTOUT_KEY = `chimera-optout:${SITE}`;
  const ID_KEY = `chimera-id:${SITE}`;
  if (!SITE || !COORD || localStorage.getItem(OPTOUT_KEY)) return;

  // ---------- capability guards ----------
  const hasWebGPU = "gpu" in navigator;
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  let batteryLow = false;
  navigator.getBattery?.().then((b) => {
    batteryLow = !b.charging && b.level < 0.25;
    b.onlevelchange = () => (batteryLow = !b.charging && b.level < 0.25);
  });

  // ---------- consent UI ----------
  const card = document.createElement("div");
  card.id = "chimera-earn";
  card.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:99999;background:#141926;color:#e6e9ef;" +
    "border:1px solid #2a3550;border-radius:10px;padding:10px 14px;font:13px system-ui;" +
    "box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:280px";
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <strong>${LABEL}</strong>
      <button id="ce-close" style="background:none;border:0;color:#666;cursor:pointer;font-size:14px">✕</button>
    </div>
    <div id="ce-state" style="color:#9aa4b8;margin:6px 0">Your spare compute runs small AI jobs for this site — and pays you.</div>
    <div id="ce-stats" style="color:#7dd3fc;font:12px ui-monospace,monospace"></div>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button id="ce-start" style="background:#3b82f6;border:0;border-radius:6px;color:#fff;padding:5px 12px;cursor:pointer;font:inherit">Start earning</button>
      <button id="ce-never" style="background:#232838;border:0;border-radius:6px;color:#9aa4b8;padding:5px 10px;cursor:pointer;font:inherit">No thanks</button>
    </div>`;
  document.body.appendChild(card);

  const setState = (t) => (card.querySelector("#ce-state").textContent = t);
  const setStats = (t) => (card.querySelector("#ce-stats").textContent = t);
  card.querySelector("#ce-close").onclick = () => card.remove();
  card.querySelector("#ce-never").onclick = () => { localStorage.setItem(OPTOUT_KEY, "1"); card.remove(); };

  // ---------- node lifecycle ----------
  let ws = null, running = false, volunteerId = localStorage.getItem(ID_KEY) || crypto.randomUUID();
  localStorage.setItem(ID_KEY, volunteerId);
  let jobsDone = 0, earningsPoll = null, heartbeat = null;

  // transformers.js lazily loaded on first infer job — CPU/WASM path always
  // works; WebGPU path via web-llm can replace this later for bigger models.
  let pipe = null;
  async function infer(payload) {
    if (!pipe) {
      const { pipeline, env: tenv } = await import("https://esm.sh/@huggingface/transformers@3");
      // Model host is configurable — deployments can serve weights from R2 or
      // a CDN mirror (HF is unreachable in some regions and per-visitor egress
      // is better served from your own edge anyway).
      if (cfg.host) { tenv.remoteHost = cfg.host; tenv.allowRemoteModels = true; }
      if (cfg.local) { tenv.allowLocalModels = true; tenv.localModelPath = cfg.local; }
      pipe = await pipeline("text-generation", cfg.model || "Xenova/Qwen2.5-0.5B-Instruct");
    }
    const prompt = JSON.parse(payload).prompt ?? payload;
    const out = await pipe(prompt, { max_new_tokens: 256 });
    return out[0]?.generated_text?.slice(prompt.length) ?? "";
  }

  function canRun() {
    return running && !document.hidden && !batteryLow;
  }

  async function onJob(msg) {
    if (!canRun()) return send({ type: "JOB_REJECTED", jobId: msg.jobId, reason: "visitor-busy-or-offscreen" });
    try {
      const result = msg.taskType >= 100 ? await infer(msg.requestHash) : "";
      jobsDone++;
      setStats(`${jobsDone} jobs · checking earnings…`);
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
      const usd = (Number(BigInt(e.totalWei || "0")) / 1e18).toFixed(4);
      setStats(`${jobsDone} jobs · earned ≈ $${usd}`);
    } catch {}
  }

  function connect() {
    // VOLUNTEER_TOKEN is a public handshake marker, not a secret — override
    // via data-token if the coordinator ever rotates it.
    ws = new WebSocket(`${COORD}?token=${encodeURIComponent(cfg.token || "widespread-volunteer")}`);
    ws.onopen = () => {
      send({
        type: "REGISTER", volunteerId, site: SITE,
        taskTypes: [0, 100, 101, 102, 103],          // inference + wp-cloud job types
        capabilities: { hasWebGPU, cpuCores: cores, ramGb: mem },
      });
      setState("Earning — jobs run only while this tab is visible");
      heartbeat = setInterval(() => send({ type: "HEARTBEAT" }), 25_000);
      earningsPoll = setInterval(refreshEarnings, 120_000);
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

  card.querySelector("#ce-start").onclick = () => {
    running = true;
    card.querySelector("#ce-start").textContent = "Stop";
    card.querySelector("#ce-start").onclick = stop;
    connect();
  };
  function stop() {
    running = false;
    clearInterval(heartbeat); clearInterval(earningsPoll);
    ws?.close();
    setState("Stopped — you earned while you browsed");
    card.querySelector("#ce-start").textContent = "Start earning";
    card.querySelector("#ce-start").onclick = () => { running = true; connect(); };
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running) setState("Paused — tab hidden (compute only runs onscreen)");
    else if (running) setState("Earning — jobs run only while this tab is visible");
  });
})();
