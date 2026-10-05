// P3: site importer — WXR path (browser→blueprint) and full-restore path (Lane 3)
import { Router } from "itty-router";
import type { Env } from "./env";
import { whoami } from "./auth";

export const importer = Router();
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

// WXR → Playground blueprint: the client posts its exported XML; we mint a
// blueprint whose steps import it in-browser (Lane 1/2 path).
importer.post("/api/import/wxr", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const wxr = await req.text();
  if (!wxr.includes("<rss") && !wxr.includes("<wxr")) return json({ error: "not a WXR file" }, 400);
  const key = `imports/${did.slice(-12)}/${Date.now()}.wxr`;
  await env.ARTIFACTS.put(key, wxr, { httpMetadata: { contentType: "application/xml" } });
  return json({
    blueprint: {
      preferredVersions: { php: "8.3", wp: "latest" },
      steps: [
        { step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug: "wordpress-importer" } },
        { step: "importWxr", file: { resource: "url", url: `/api/import/file?key=${encodeURIComponent(key)}` } },
      ],
    },
  });
});

importer.get("/api/import/file", async (req, env: Env) => {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  const obj = await env.ARTIFACTS.get(key);
  return obj ? new Response(obj.body) : new Response("gone", { status: 404 });
});

// Full-fidelity path (Lane 3): DB dump + wp-content tarball → container restore
importer.post("/api/import/full", async (req, env: Env) => {
  const did = await whoami(env, req);
  if (!did) return json({ error: "unauthorized" }, 401);
  const { site_id } = await req.json() as { site_id: string };
  const ns = (env as any).TENANT as DurableObjectNamespace | undefined;
  const stub = ns?.get(ns.idFromName(site_id));
  if (!stub) return json({ error: "lane3 required for full import" }, 422);
  await stub.fetch("https://tenant.internal/control", { method: "POST", body: JSON.stringify({ action: "wp-cli", body: { cmd: "db import /state/dump.sql" } }) });
  return json({ ok: true, note: "upload dump.sql + wp-content via rclone first" });
});
