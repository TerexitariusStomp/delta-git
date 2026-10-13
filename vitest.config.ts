// @ts-nocheck
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "path";
import { BASE_TEST_BINDINGS } from "./test/vitest.bindings";
import { defineConfig } from "vitest/config";

/**
 * vitest-pool-workers validates wrangler.jsonc with a schema that doesn't
 * yet know the `containers` field, so tests fail config validation. Strip
 * the field (container DOs are never exercised in workerd anyway) into a
 * temp config file at load time. The stripper is string-aware so `//`
 * inside URLs and string values survives.
 */
function stripJsoncComments(source: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function writeTestWranglerConfig(): string {
  const parsed = JSON.parse(stripJsoncComments(readFileSync("./wrangler.jsonc", "utf8")));
  delete parsed.containers;
  // The container DO class can't run under workerd — drop its binding and
  // migration so the pool sees only plain DOs.
  parsed.durable_objects.bindings = parsed.durable_objects.bindings.filter(
    (binding) => binding.name !== "FORGE_SANDBOX"
  );
  parsed.migrations = parsed.migrations.map((migration) => ({
    ...migration,
    new_sqlite_classes: migration.new_sqlite_classes?.filter((name) => name !== "ForgeSandbox"),
  }));
  // The config must live at the repo root: wrangler resolves relative paths
  // (assets.directory, d1 migrations_dir, main) against the config's own
  // directory, so a /tmp location would silently break asset serving and D1.
  const configPath = path.join(__dirname, ".vitest.wrangler.json");
  writeFileSync(configPath, JSON.stringify(parsed, null, 2));
  return configPath;
}

const AUTH_TEST_FILE = "test/auth.worker.test.ts";
const INLINE_DEPS = ["@noble/hashes", "pako"];
const isAuthSuite =
  process.env.npm_lifecycle_event === "test:auth" ||
  process.argv.some((arg) => arg.includes("auth.worker.test.ts"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      wrangler: {
        configPath: writeTestWranglerConfig(),
      },

      // Windows workaround: disable isolatedStorage to avoid EBUSY teardown failures
      // Avoid filesystem persistence to prevent SQLite CANTOPEN/EBUSY on Windows
      singleWorker: true,
      isolatedStorage: false,

      // The `ai` binding has no local emulation and would force an
      // edge-preview remote proxy session; tests never call it, so keep the
      // pool fully local.
      remoteBindings: false,

      miniflare: {
        durableObjectsPersist: false,
        kvPersist: false,
        r2Persist: false,
        cachePersist: false,
        // Keep the Worker test runtime aligned with the deployed Worker.
        compatibilityDate: "2026-05-13",
        compatibilityFlags: ["nodejs_als"],
        bindings: {
          ...BASE_TEST_BINDINGS,
          PACK_INDEXER_FIXTURE: process.env.PACK_INDEXER_FIXTURE === "1" ? "1" : "",
        },
        serviceBindings: {
          // Service binding that runs in Node.js (not workerd) for reading
          // fixture files from disk. Tests call env.FIXTURE_READER.fetch()
          // with the file path as the URL pathname.
          async FIXTURE_READER(request: Request) {
            const url = new URL(request.url);
            const filePath = decodeURIComponent(url.pathname.slice(1));
            const resolved = path.resolve(__dirname, filePath);
            if (!existsSync(resolved)) {
              return new Response("not found", { status: 404 });
            }
            const data = readFileSync(resolved);
            return new Response(data, {
              headers: { "Content-Length": String(data.byteLength) },
            });
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Inline deps at the vite-node server level to avoid SSR optimizer resolution issues
  server: {
    deps: {
      inline: INLINE_DEPS,
    },
  },
  test: {
    include: isAuthSuite ? [AUTH_TEST_FILE] : ["test/**/*.worker.test.ts"],
    exclude: isAuthSuite ? [] : [AUTH_TEST_FILE],
  },
});
