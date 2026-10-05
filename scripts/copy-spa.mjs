// Copies the gitness SPA build output into the worker's assets dir as
// `dist/client/app/`, so the single ASSETS binding serves it at `/app/*`.
// `app/monacoeditorwork/` lands correctly because the app's vite base is
// `/app/` and the monaco plugin emits under that prefix.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve("frontend/canary/apps/gitness/dist");
const dest = resolve("dist/client/app");

if (!existsSync(src)) {
  console.error("copy-spa: no gitness dist — run the canary build first");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
// The vite `/app/` base emits a second-tier `dist/app/` subtree (monaco
// workers) whose URL path is `/app/...` — the same prefix as the flat
// assets, so it must merge upward, not nest.
const nested = resolve(dest, "app");
if (existsSync(nested)) {
  cpSync(nested, dest, { recursive: true });
  rmSync(nested, { recursive: true, force: true });
}
console.log(`copy-spa: ${src} -> ${dest}`);
