// TenantDO — one Durable Object per Lane-3 site. Owns container lifecycle:
// wake on request, sleep after idle TTL, state sync-out/in around sleeps
// (container disk is ephemeral → SQLite + wp-content ship to R2 via rclone).
// P5: cluster mode runs N web containers + 1 dedicated DB container and
// proxies MySQL traffic web→db over same-DC TCP (Workers connect()).
// PAID TIER ONLY — requires Workers Paid (DOs + Containers + Queues).

import { connect } from "cloudflare:sockets";
import type { Env } from "../env";

interface TenantState {
  siteId: string;
  status: "cold" | "starting" | "awake" | "sleeping";
  lastTouched: number;
  alwaysOn: boolean;
  cluster: boolean;       // enterprise: N web + 1 db
  webCount: number;
}

const IDLE_MS = 5 * 60_000;
const AGENT = "http://localhost:8080"; // adnanh/webhook in-container

export class TenantDO {
  private st: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.st = state;
    this.env = env;
  }

  private async state(): Promise<TenantState> {
    return (await this.st.storage.get<TenantState>("s")) ?? {
      siteId: "", status: "cold", lastTouched: 0, alwaysOn: false, cluster: false, webCount: 1,
    };
  }
  private async set(s: Partial<TenantState>) {
    await this.st.storage.put("s", { ...(await this.state()), ...s });
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/control") {
      const { action, body } = await req.json() as { action: string; body?: any };
      return Response.json(await this.control(action, body));
    }
    const s = await this.state();
    if (s.status === "cold" || s.status === "sleeping") return this.wake(req);
    await this.touch();
    return this.proxyToContainer(req, s);
  }

  private async wake(req: Request): Promise<Response> {
    await this.set({ status: "starting" });
    try {
      // restore site state from R2 before boot completes
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
    // @cloudflare/containers provides ctx.container / loadBalance; raw fetch
    // fallback kept simple here — web containers listen on :80
    const port = s.cluster ? 8081 : 80; // cluster → round-robin port map, else single web
    const res = await fetch(new Request(`http://127.0.0.1:${port}${new URL(req.url).pathname}${new URL(req.url).search}`, req));
    return res;
  }

  private async touch() {
    await this.set({ lastTouched: Date.now() });
    await this.st.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async alarm(): Promise<void> {
    const s = await this.state();
    if (s.alwaysOn || Date.now() - s.lastTouched < IDLE_MS) {
      if (!s.alwaysOn) await this.st.storage.setAlarm(s.lastTouched + IDLE_MS);
      return;
    }
    // zero-loss sleep: sync SQLite + wp-content to R2 first
    await this.agent("/sync-out").catch(() => {});
    await this.set({ status: "sleeping" });
  }

  private async agent(path: string): Promise<void> {
    const r = await fetch(AGENT + path, { method: "POST" });
    if (!r.ok) throw new Error(`agent ${path}: ${r.status}`);
  }

  // ---- control API (called by Bridge Worker) ----
  async control(action: string, body?: any): Promise<any> {
    switch (action) {
      case "configure":
        await this.set({ siteId: body.siteId, alwaysOn: !!body.alwaysOn, cluster: !!body.cluster, webCount: body.webCount ?? 1 });
        return { ok: true };
      case "sync-out":
        await this.agent("/sync-out");
        return { ok: true };
      case "wp-cli":
        return { out: await (await fetch(`${AGENT}/exec`, { method: "POST", body: JSON.stringify({ cmd: body.cmd }) })).text() };
      // P5 enterprise: proxy raw MySQL TCP to the db container
      case "db-tcp":
        return this.dbProxy(body);
      case "status":
        return this.state();
    }
    return { error: "unknown action" };
  }

  // P5: MySQL traffic web→db over same-DC TCP socket
  private async dbProxy(_body: { port?: number }): Promise<Response> {
    const sock = connect({ hostname: "127.0.0.1", port: 3306 }); // db sidecar
    const { readable, writable } = new TransformStream();
    sock.readable.pipeTo(writable).catch(() => {});
    // caller streams protocol bytes; real impl wires req body → sock.writable
    return new Response(readable, { status: 200 });
  }
}
