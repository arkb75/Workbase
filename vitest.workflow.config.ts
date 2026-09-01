import { resolve } from "node:path";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.workflow.test.ts"],
    testTimeout: 60_000,
    env: {
      WORKBASE_LLM_PROVIDER: "mock",
      WORKBASE_SEMANTIC_PLANNER_MODE: "deterministic",
      WORKBASE_REPOSITORY_SYNTHESIS_MODE: "deterministic",
      VITEST: "true",
    },
  },
});
