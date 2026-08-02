import { describe, expect, it, vi } from "vitest";
import { checkApplicationReadiness } from "@/src/services/runtime-readiness-service";

function client(input?: {
  selectError?: unknown;
  schema?: {
    agentHarnessReady: boolean;
    repositoryKnowledgeReady: boolean;
    embeddingIndexReady: boolean;
    activeEmbeddingProvider: string | null;
  };
}) {
  const schema = input?.schema ?? {
    agentHarnessReady: true,
    repositoryKnowledgeReady: true,
    embeddingIndexReady: true,
    activeEmbeddingProvider: "bedrock",
  };
  return {
    projectFact: {
      findFirst: vi.fn().mockImplementation(async () => {
        if (input?.selectError) throw input.selectError;
        return null;
      }),
    },
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([schema])
      .mockResolvedValue([{
        provider: schema.activeEmbeddingProvider,
        status: "active",
        dimensions: 512,
        isActive: true,
      }]),
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
    // Both independent readiness probes start together on the healthy path;
    // the runtime-contract failure remains the classified result.
    expect(database.$queryRaw).toHaveBeenCalledOnce();
  });

  it("detects pending repository migrations", async () => {
    const database = client({
      schema: {
        agentHarnessReady: true,
        repositoryKnowledgeReady: false,
        embeddingIndexReady: true,
        activeEmbeddingProvider: "bedrock",
      },
    });
    await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
      ready: false,
      reason: "database_schema_out_of_date",
      retryable: false,
    });
  });

  it("detects a missing versioned embedding index migration", async () => {
    const database = client({
      schema: {
        agentHarnessReady: true,
        repositoryKnowledgeReady: true,
        embeddingIndexReady: false,
        activeEmbeddingProvider: null,
      },
    });
    await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
      ready: false,
      reason: "database_schema_out_of_date",
      retryable: false,
    });
  });

  it("requires an OpenRouter key only when the active index uses OpenRouter", async () => {
    const prior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const database = client({
      schema: {
        agentHarnessReady: true,
        repositoryKnowledgeReady: true,
        embeddingIndexReady: true,
        activeEmbeddingProvider: "openrouter",
      },
    });
    try {
      await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
        ready: false,
        reason: "runtime_configuration_missing",
        retryable: false,
      });
    } finally {
      if (prior === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prior;
    }
  });

  it("requires credentials for a write-enabled OpenRouter build target", async () => {
    const prior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const database = client();
    database.$queryRaw.mockReset()
      .mockResolvedValueOnce([{
        agentHarnessReady: true,
        repositoryKnowledgeReady: true,
        embeddingIndexReady: true,
      }])
      .mockResolvedValueOnce([
        {
          provider: "bedrock",
          status: "active",
          dimensions: 512,
          isActive: true,
        },
        {
          provider: "openrouter",
          status: "building",
          dimensions: 512,
          isActive: false,
        },
      ]);
    try {
      await expect(checkApplicationReadiness(database)).resolves.toMatchObject({
        ready: false,
        reason: "runtime_configuration_missing",
      });
    } finally {
      if (prior === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prior;
    }
  });
});
