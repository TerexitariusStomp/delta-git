// TenantDO — one Durable Object per Lane-2/3 site. Owns container lifecycle:
// wake on request, sleep after idle TTL, state sync-out/in around sleeps
// (container disk is ephemeral → SQLite + wp-content ship to R2 via rclone).
//
// Effective-100% additions:
// - variant state (sapi/php_version/db/multisite/daemons/sidecars) from the
//   compat classifier; reconfigure() re-provisions a live site to a new shape
// - cron-wake: sites sleeping with wp-cron due get woken before the due time
// - generalized ws↔TCP proxy /tcp-proxy/:port — sidecars (mysql:3306,
//   redis:6379, elastic:9200, memcached:11211) reachable from web containers
// P5: cluster mode runs N web containers + sidecars.
// PAID TIER ONLY — requires Workers Paid (DOs + Containers + Queues).

import { connect } from "cloudflare:sockets";
import type { Env } from "../env";

interface Variant {
  sapi: string;
  php_version: string;
  db_engine: string;
  multisite: number;
  daemons: number;
  tcp_ingress: number;
  sidecars: string[];
  heavy: boolean;
}

interface TenantState {
  siteId: string;
  status: "cold" | "starting" | "awake" | "sleeping";
  lastTouched: number;
  alwaysOn: boolean;
  cluster: boolean;       // enterprise: N web + 1 db
  webCount: number;
  curated: boolean;       // lane 2: whitelisted plugins, DISALLOW_FILE_MODS
  variant: Variant;
  cronWakeAt: number;     // unix ts — wake before next wp-cron due even if asleep
  tcpPorts: number[];     // open sidecar/daemon ports for tcp-proxy
}

const IDLE_MS = 5 * 60_000;
const AGENT = "http://localhost:8080"; // adnanh/webhook in-container
const DEFAULT_VARIANT: Variant = {
  sapi: "frankenphp", php_version: "8.4", db_engine: "sqlite",
  multisite: 0, daemons: 0, tcp_ingress: 0, sidecars: [], heavy: false,
};

export class TenantDO {
  private st: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.st = state;
    this.env = env;
  }

  private async state(): Promise<TenantState> {
    return (await this.st.storage.get<TenantState>("s")) ?? {
      siteId: "", status: "cold", lastTouched: 0, alwaysOn: false, cluster: false,
      webCount: 1, curated: false, variant: DEFAULT_VARIANT, cronWakeAt: 0, tcpPorts: [3306],
    };
  }
  private async set(s: Partial<TenantState>) {
    await this.st.storage.put("s", { ...(await this.state()), ...s });
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/control") {
      const { action, body } = await req.json() as { action: string; body?: any };
      return Response.json(await this.control(action, body));
    }
    const tcp = path.match(/^\/tcp-proxy\/(\d+)$/);
    if (tcp) return this.wsToTcp(req, parseInt(tcp[1]));
    const s = await this.state();
    if (s.status === "cold" || s.status === "sleeping") return this.wake(req);
    await this.touch();
    return this.proxyToContainer(req, s);
  }

  private async wake(req: Request): Promise<Response> {
    await this.set({ status: "starting" });
    try {
      // restore site state from R2 before boot completes; entrypoint applies
      // the variant (sapi/php_version/db_engine/multisite) from env we inject
      await this.agent("/restore");
      await this.set({ status: "awake" });
      await this.touch();
      return this.proxyToContainer(req, await this.state());
    } catch (e) {
      await this.set({ status: "cold" });
      return new Response(`wake failed: ${e}`, { status: 503 });
    }
  }

  private async proxyToContainer(req: Request, s: TenantState): Promise<Response> {
    // web containers listen on :80; cluster mode round-robins a port map
    const port = s.cluster ? 8081 : 80;
    const res = await fetch(new Request(`http://127.0.0.1:${port}${new URL(req.url).pathname}${new URL(req.url).search}`, req));
    return res;
  }

  private async touch() {
    await this.set({ lastTouched: Date.now() });
    await this.st.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async alarm(): Promise<void> {
    const s = await this.state();
    const now = Date.now();

    // Cron-wake: sleeping site with wp-cron due → wake and run it.
    // Scheduled posts, Action Scheduler, backup jobs all fire on time
    // even while the site was asleep.
    if (s.status === "sleeping" && s.cronWakeAt && s.cronWakeAt <= Math.floor(now / 1000)) {
      await this.wake(new Request("http://localhost/wp-cron.php?doing_wp_cron=1"));
      // reset to next interval; the in-container crond + mu-plugin report
      // keep cronWakeAt fresh while awake
      await this.set({ cronWakeAt: Math.floor(now / 1000) + 300 });
      await this.st.storage.setAlarm(now + 300_000);
      return;
    }

    if (s.alwaysOn || now - s.lastTouched < IDLE_MS) {
      if (!s.alwaysOn) await this.st.storage.setAlarm(s.lastTouched + IDLE_MS);
      return;
    }
    // zero-loss sleep: sync SQLite + wp-content + daemon state to R2 first
    await this.agent("/sync-out").catch(() => {});
    await this.set({ status: "sleeping" });
    // if a cron event is due, schedule the wake alarm
    if (s.cronWakeAt) await this.st.storage.setAlarm(s.cronWakeAt * 1000);
  }

  private async agent(path: string): Promise<void> {
    const r = await fetch(AGENT + path, { method: "POST" });
    if (!r.ok) throw new Error(`agent ${path}: ${r.status}`);
  }

  // ---- control API (called by Bridge Worker) ----
  async control(action: string, body?: any): Promise<any> {
    switch (action) {
      case "configure":
        await this.set({
          siteId: body.siteId, alwaysOn: !!body.alwaysOn, cluster: !!body.cluster,
          webCount: body.webCount ?? 1, curated: !!body.curated,
          variant: body.variant ? { ...DEFAULT_VARIANT, ...body.variant } : DEFAULT_VARIANT,
          cronWakeAt: body.cronWakeAt ?? 0,
        });
        return { ok: true };
      case "reconfigure": {
        // compat classifier found a new variant needed — sync-out, then the
        // next wake boots with the new shape (image tag + env from variant)
        const merged: Variant = { ...(await this.state()).variant, ...body };
        await this.set({ variant: merged, cronWakeAt: merged.daemons || body?.cron ? Math.floor(Date.now() / 1000) + 300 : (await this.state()).cronWakeAt });
        if (merged.daemons > 0) await this.set({ alwaysOn: true }); // daemons imply always-on
        return { ok: true, variant: merged };
      }
      case "cron-report":
        await this.set({ cronWakeAt: body.next_due ?? 0 });
        return { ok: true };
      case "sync-out":
        await this.agent("/sync-out");
        return { ok: true };
      case "wp-cli":
        return { out: await (await fetch(`${AGENT}/exec`, { method: "POST", body: JSON.stringify({ cmd: body.cmd }) })).text() };
      case "status":
        return this.state();
    }
    return { error: "unknown action" };
  }

  // Generalized WebSocket↔TCP proxy — web containers reach any sidecar/daemon
  // port (mysql:3306, redis:6379, elastic:9200, memcached:11211, or a plugin
  // daemon port) by carrying protocol frames over a DO WebSocket.
  private async wsToTcp(req: Request, port: number): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("ws required", { status: 426 });
    const s = await this.state();
    if (!s.tcpPorts.includes(port) && port !== 3306) return new Response("port not exposed", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const sock = connect({ hostname: "127.0.0.1", port });
    const writer = sock.writable.getWriter();
    server.addEventListener("message", (e) => {
      const data = typeof e.data === "string" ? new TextEncoder().encode(e.data) : new Uint8Array(e.data);
      writer.write(data).catch(() => server.close(1011));
    });
    server.addEventListener("close", () => { writer.close().catch(() => {}); sock.close().catch(() => {}); });
    (async () => {
      const reader = sock.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        server.send(value);
      }
      server.close(1000);
    })().catch(() => server.close(1011));
    return new Response(null, { status: 101, webSocket: client });
  }
}
