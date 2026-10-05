// Copies the gitness SPA build output into the worker's assets dir root, so
// the ASSETS binding serves it at /* — the SPA mounts at basename "/" and
// owns all non-API routes.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve("frontend/canary/apps/gitness/dist");
const dest = resolve("dist/client");

if (!existsSync(src)) {
  console.error("copy-spa: no gitness dist — run the canary build first");
  process.exit(1);
}
cpSync(src, dest, { recursive: true });
console.log(`copy-spa: ${src} -> ${dest}`);
