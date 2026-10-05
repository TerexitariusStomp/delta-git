import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `cloudflare:workers` is a workerd builtin — alias to a stub so Node
      // unit tests importing pack/indexer resolve paths load cleanly.
      "cloudflare:workers": path.resolve(__dirname, "./test/stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.worker.test.ts"],
  },
});
