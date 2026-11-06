import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Live suite: real database, real AI provider, real WooCommerce store.
 * Reads secrets from .env.local at run time; nothing is committed.
 *   npm run test:live            (AI_LIVE_RUNS=1 for a cheaper single pass)
 */
function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@app-messages": fileURLToPath(
        new URL("./messages/en.json", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.live.test.ts",
      "src/lib/woocommerce/live-catalogue.test.ts",
    ],
    env: {
      ...readDotEnv(".env.local"),
      WOO_LIVE_TEST: "1",
    },
    fileParallelism: false,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
  },
});
