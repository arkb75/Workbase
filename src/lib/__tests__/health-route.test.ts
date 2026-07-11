import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({
  prisma: { $queryRaw: queryRawMock },
}));

import { GET } from "@/app/api/health/route";

describe("health route database readiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the repository knowledge v4 schema as ready", async () => {
    queryRawMock.mockResolvedValue([{ projectFactsReady: true, agentHarnessReady: true, repositoryKnowledgeReady: true }]);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      product: "Workbase",
      database: "ready",
      schema: "repository-knowledge-v4",
    });
  });

  it("returns an actionable 503 when migrations are pending", async () => {
    queryRawMock.mockResolvedValue([{ projectFactsReady: true, agentHarnessReady: false, repositoryKnowledgeReady: false }]);
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      reason: "database_schema_out_of_date",
      recovery: "Run npm run db:prepare and restart the application.",
    });
  });

  it("returns a safe 503 when the database is unavailable", async () => {
    queryRawMock.mockRejectedValue(new Error("connection details must not leak"));
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      product: "Workbase",
      reason: "database_unavailable",
    });
  });
});
