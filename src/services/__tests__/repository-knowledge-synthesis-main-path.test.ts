import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredGenerationBudget } from "@/src/lib/bedrock-structured-llm-client";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

const generateStructuredMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
  },
  generationRun: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveActiveTextModelIdentity: () => ({
    provider: "bedrock",
    modelId: "synthesis-model",
  }),
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getStructuredLlmClient: () => ({
    generateStructured: generateStructuredMock,
  }),
}));

import {
  repositorySynthesisBudgetLimits,
  synthesizeRepositoryKnowledge,
} from "@/src/services/repository-knowledge-synthesis-service";
import { REPOSITORY_SEMANTIC_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

const statement =
  "The charge service records an idempotency key before publishing a payment receipt.";
const path = "src/payments/charge-service.ts";

function semanticAnalysis(): RepositoryFileAnalysis {
  return {
    path,
    summary: "Idempotent payment receipt publication.",
    subsystemKeys: ["project_domain:payments"],
    responsibilities: [],
    symbols: [],
    dependencies: [],
    architectureSignals: [],
    userFacingCapabilities: [],
    unresolvedQuestions: [],
    chunksAnalyzed: 1,
    tokenUsage: [],
    analysisMode: "semantic",
    semanticStatus: "succeeded",
    semanticSource: "model",
    facts: [{
      statement,
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      lineStart: 10,
      lineEnd: 18,
      productImportance: 5,
      implementationBreadth: 3,
      technicalDifficulty: 4,
      path,
      subsystemKeys: ["project_domain:payments"],
      semanticSignals: ["domain.payment_idempotency"],
      evidenceMode: "semantic",
    }],
  };
}

function refreshRun() {
  return {
    id: "refresh-1",
    workItemId: "work-item-1",
    orchestration: {
      packages: [{ capabilityKeys: ["project_domain:payments"] }],
    },
    targetHeads: [{
      sourceId: "source-1",
      repository: "acme/ledger-platform",
      branch: "main",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: null,
      resolvedAt: new Date().toISOString(),
    }],
    workItem: { title: "Ledger Platform" },
    snapshots: [{
      sourceId: "source-1",
      commitSha: "a".repeat(40),
      files: [{
        path,
        blobSha: "blob-charge-service",
        analyzerVersion: null,
        analysis: null,
        semanticRefreshRunId: "refresh-1",
        semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
        semanticStatus: "succeeded",
        semanticAnalysis: semanticAnalysis(),
        changeType: "modified",
      }],
    }],
  };
}

function chargeBudget(budget: StructuredGenerationBudget | undefined) {
  if (!budget) return;
  budget.usage.modelCalls += 1;
  budget.usage.inputTokens += 100;
  budget.usage.outputTokens += 50;
  budget.usage.totalTokens += 150;
}

describe("repository synthesis model main path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WORKBASE_REPOSITORY_SYNTHESIS_MODE", "model");
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue(refreshRun());
    prismaMock.generationRun.upsert.mockImplementation(async (input) => ({
      id: `generation-${input.create.inputSummary.phase}`,
      provider: "bedrock",
      modelId: "synthesis-model",
      tokenUsage: null,
      resultRefs: null,
      estimatedCostUsd: null,
    }));
    prismaMock.generationRun.update.mockResolvedValue({});
    generateStructuredMock.mockImplementation(async (input) => {
      const request = input as {
        schemaName: string;
        userPrompt: string;
        budget?: StructuredGenerationBudget;
        extraValidation?: (value: never) => string[];
      };
      chargeBudget(request.budget);
      const prompt = JSON.parse(request.userPrompt) as {
        subsystems: Array<{
          subsystemKey: string;
          claims?: Array<{ claimKey: string }>;
        }>;
      };
      const data = request.schemaName === "repository_architecture_synthesis"
        ? {
            subsystems: [{
              subsystemKey: prompt.subsystems[0]!.subsystemKey,
              facts: [{
                statement,
                category: "behavior",
                confidence: "high",
                sensitivityFlag: false,
                citationIndexes: [1],
                reviewNotes: null,
                productImportance: 5,
                implementationBreadth: 3,
                technicalDifficulty: 4,
                distinctiveness: 4,
              }],
              highlights: [],
              unresolvedQuestions: [],
            }],
          }
        : {
            assessments: [{
              claimKey: prompt.subsystems[0]!.claims![0]!.claimKey,
              supported: true,
              issues: [],
            }],
          };
      expect(request.extraValidation?.(data as never) ?? []).toEqual([]);
      return {
        data,
        rawOutput: JSON.stringify(data),
        parsedOutput: data,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          requestId: `request-${request.schemaName}`,
        },
        provider: "bedrock",
        modelId: "synthesis-model",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
        requestId: `request-${request.schemaName}`,
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs and durably attests synthesis followed by its independent critic", async () => {
    const synthesis = await synthesizeRepositoryKnowledge("refresh-1");

    expect(generateStructuredMock).toHaveBeenCalledTimes(2);
    expect(generateStructuredMock.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_architecture_synthesis",
      "repository_synthesis_entailment_critic",
    ]);
    expect(generateStructuredMock.mock.calls[1]![0]).toMatchObject({
      maxTokens: 4_000,
      effort: "low",
    });
    expect(synthesis).toEqual([
      expect.objectContaining({
        subsystemKey: "project_domain:payments",
        approvalEligible: true,
        facts: [expect.objectContaining({ statement, citationIndexes: [1] })],
      }),
    ]);

    const summaries = prismaMock.generationRun.upsert.mock.calls.map(([input]) =>
      input.create.inputSummary
    );
    expect(summaries).toEqual([
      expect.objectContaining({
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: [expect.stringMatching(/^project_domain:payments#/)],
      }),
      expect.objectContaining({
        phase: "entailment_critic",
        refreshRunId: "refresh-1",
        subsystemKeys: [expect.stringMatching(/^project_domain:payments#/)],
        claimCount: 1,
      }),
    ]);
    const persisted = prismaMock.generationRun.update.mock.calls.map(([input]) =>
      input.data.parsedOutput
    );
    expect(persisted[0]).toEqual(expect.objectContaining({
      subsystems: [expect.objectContaining({ facts: [expect.objectContaining({ statement })] })],
    }));
    expect(persisted[1]).toEqual(expect.objectContaining({
      assessments: [expect.objectContaining({ supported: true })],
    }));

    const synthesisBudget = generateStructuredMock.mock.calls[0]![0].budget;
    expect(generateStructuredMock.mock.calls[1]![0].budget).toBe(synthesisBudget);
    expect(synthesisBudget).toMatchObject({
      limits: repositorySynthesisBudgetLimits(1),
      usage: {
        modelCalls: 2,
        repairPasses: 0,
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      },
    });
  });

  it("reserves synthesis and critic calls plus one repair each under one 80K cap", () => {
    expect(repositorySynthesisBudgetLimits(3)).toEqual({
      maxModelCalls: 12,
      maxRepairPasses: 6,
      maxOutputTokens: 8_000,
      maxTotalTokens: 80_000,
    });
    expect(() => repositorySynthesisBudgetLimits(-1)).toThrow(
      "Repository synthesis batch count must be a non-negative integer.",
    );
  });
});
