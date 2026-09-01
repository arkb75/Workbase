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
    include: ["src/**/*.test.ts", "components/**/*.test.tsx"],
    env: {
      WORKBASE_LLM_PROVIDER: "mock",
      WORKBASE_SEMANTIC_PLANNER_MODE: "deterministic",
      WORKBASE_REPOSITORY_SYNTHESIS_MODE: "deterministic",
      VITEST: "true",
    },
    coverage: {
      provider: "v8",
    },
  },
});
