import { beforeEach, describe, expect, it, vi } from "vitest";

const readinessMock = vi.hoisted(() => vi.fn());
const textRuntimeReadinessMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/services/runtime-readiness-service", () => ({
  runtimeReadinessService: {
    check: readinessMock,
    checkTextRuntime: textRuntimeReadinessMock,
  },
}));

import { GET } from "@/app/api/health/route";

describe("health route database readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textRuntimeReadinessMock.mockReturnValue({
      ready: true,
      provider: "mock",
      profiles: { primary_answer: "mock" },
      zeroDataRetention: false,
    });
  });

  it("reports the proactive repository knowledge schema as ready", async () => {
    readinessMock.mockResolvedValue({ ready: true });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      product: "Workbase",
      database: "ready",
      schema: "repository-knowledge-v6",
      llm: {
        provider: "mock",
        profiles: { primary_answer: "mock" },
        zeroDataRetention: false,
      },
    });
  });

  it("does not report healthy when the text runtime is misconfigured", async () => {
    readinessMock.mockResolvedValue({ ready: true });
    textRuntimeReadinessMock.mockReturnValue({
      ready: false,
      reason: "llm_configuration_invalid",
      recovery: "Set OPENROUTER_API_KEY and restart the application.",
      retryable: false,
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: "llm_configuration_invalid",
      retryable: false,
    });
  });

  it("returns an actionable 503 when migrations are pending", async () => {
    readinessMock.mockResolvedValue({
      ready: false,
      reason: "database_schema_out_of_date",
      recovery: "Run npm run db:prepare, restart the application, and retry.",
      retryable: false,
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      reason: "database_schema_out_of_date",
      recovery: "Run npm run db:prepare, restart the application, and retry.",
      retryable: false,
    });
  });

  it("returns a safe 503 when the database is unavailable", async () => {
    readinessMock.mockResolvedValue({
      ready: false,
      reason: "database_unavailable",
      recovery: "Check the database connection and retry.",
      retryable: true,
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      product: "Workbase",
      reason: "database_unavailable",
      recovery: "Check the database connection and retry.",
      retryable: true,
    });
  });

  it("does not report healthy when the loaded Prisma runtime is stale", async () => {
    readinessMock.mockResolvedValue({
      ready: false,
      reason: "runtime_schema_mismatch",
      recovery: "Run npm run db:prepare, restart the application, and retry this message.",
      retryable: false,
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: "runtime_schema_mismatch",
      retryable: false,
    });
  });
});
