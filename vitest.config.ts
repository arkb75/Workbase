import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    env: {
      WORKBASE_LLM_PROVIDER: "mock",
      VITEST: "true",
    },
    coverage: {
      provider: "v8",
    },
  },
});
