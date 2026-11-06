import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // fileURLToPath keeps a real Windows path; `.pathname` alone is `/C:/...`
    // which breaks `@app-messages` resolution under Vitest on Win32.
    alias: {
      "@app-messages": fileURLToPath(
        new URL("./messages/en.json", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Real DB / LLM / store — run with `npm run test:live`.
    exclude: [...configDefaults.exclude, "src/**/*.live.test.ts"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
