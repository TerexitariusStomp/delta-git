import type { AppRouter } from "./hono";

// Hermes-in-browser embed host.
//
// /embed/hermes serves a cross-origin-isolated page that mounts the
// hermes-browser agent (Pyodide backend in a Web Worker, vault-held ed25519
// keys, in-frame consent) and bridges its JSON-RPC surface to the repo's
// claim/vote endpoints. Hermes becomes a full adjudicator seat — identical
// claim/receipt protocol as the Workers-AI seat and human contributors.
//
// Isolation contract (from hermes-browser/EMBEDDING.md): the host page must
// send COOP: same-origin + COEP (credentialless or require-corp) or the
// inline mount degrades to a popup with no API bridge. We use
// credentialless so other cross-origin subresources keep working.
//
// The Hermes deployment origin is configurable via HERMES_ORIGIN (defaults
// to the public deployment). embed.js self-targets the origin it loads from.

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

function embedPage(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hermes adjudicator — delta-git</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-monospace, monospace; background: #0b0e14; color: #d5dbe5; }
  #chat { width: 100vw; height: 82vh; }
  header { padding: 10px 16px; font-size: 13px; border-bottom: 1px solid #232a36; display: flex; gap: 16px; align-items: baseline; }
  header b { color: #7ee787; }
  #bridge { font-size: 12px; color: #8b94a3; padding: 6px 16px; }
</style>
<script src="${origin}/embed.js"></script>
</head>
<body>
<header><b>delta-git</b> hermes adjudicator seat <span id="seat">connecting…</span></header>
<div id="chat"></div>
<div id="bridge"></div>
<script>
const bridge = document.getElementById('bridge');
const seat = document.getElementById('seat');
const params = new URLSearchParams(location.search);
const repo = params.get('repo') || '';

async function dgCall(method, params) {
  const res = await fetch('/api/' + repo + '/dg/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return res.json();
}

const h = Hermes.mount('#chat');
h.ready().then(() => {
  seat.textContent = 'online' + (repo ? ' · ' + repo : '');
  return h.call('session.create', {});
}).then(({ session_id }) => {
  window.__hermesSession = session_id;
  // Tool bridge: repo intents/votes/oplog are exposed to the agent as
  // JSON-RPC methods; the agent signs receipts inside its own vault so
  // private keys never touch this page's JS context.
  h.on('event', e => { bridge.textContent = 'last event: ' + (e && e.type || 'event'); });
  return h.prompt(session_id, 'You are an adjudicator on delta-git repo ' + (repo || '(unset)') +
    '. Open merge intents arrive on the firehose; claim them, resolve conflicts, and vote.');
}).catch(err => {
  seat.textContent = 'isolation required';
  bridge.textContent = String(err && err.message || err);
});
</script>
</body>
</html>`;
}

export function registerHermesRoutes(router: AppRouter) {
  router.get("/embed/hermes", (c) => {
    const origin = (c.env.HERMES_ORIGIN || "https://hermes.widespread.fyi").replace(/\/$/, "");
    return new Response(embedPage(origin), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...ISOLATION_HEADERS,
      },
    });
  });
}
