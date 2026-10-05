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
console.log(`copy-spa: ${src} -> ${dest}`);
