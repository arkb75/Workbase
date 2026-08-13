import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "work-item-lifecycle.live.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: Number(
    process.env.WORKBASE_LIFECYCLE_TERMINAL_TIMEOUT_MS ?? 10 * 60_000,
  ) + 60_000,
  use: {
    baseURL: process.env.WORKBASE_APPLICATION_EVAL_BASE_URL ??
      "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
});
