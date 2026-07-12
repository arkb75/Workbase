import { describe, expect, it, vi } from "vitest";
import { checkApplicationReadiness } from "@/src/services/runtime-readiness-service";

function client(input?: { selectError?: unknown; schema?: { agentHarnessReady: boolean; repositoryKnowledgeReady: boolean } }) {
  return {
    projectFact: {
      findFirst: vi.fn().mockImplementation(async () => {
        if (input?.selectError) throw input.selectError;
        return null;
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([input?.schema ?? { agentHarnessReady: true, repositoryKnowledgeReady: true }]),
  };
}

describe("application runtime readiness", () => {
  it("probes every Project Fact ranking field before reporting ready", async () => {
    const database = client();
    await expect(checkApplicationReadiness(database)).resolves.toEqual({ ready: true });
    expect(database.projectFact.findFirst).toHaveBeenCalledWith({
      select: {
        id: true,
        productImportance: true,
        implementationBreadth: true,
        technicalDifficulty: true,
        distinctiveness: true,
      },
    });
  });

  it("classifies a stale generated client as a non-retryable schema mismatch", async () => {
    const database = client({ selectError: { message: "Unknown argument `productImportance`." } });
    await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
      ready: false,
      reason: "runtime_schema_mismatch",
      retryable: false,
      recovery: expect.stringContaining("restart"),
    });
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("detects pending repository migrations", async () => {
    const database = client({ schema: { agentHarnessReady: true, repositoryKnowledgeReady: false } });
    await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
      ready: false,
      reason: "database_schema_out_of_date",
      retryable: false,
    });
  });
});
