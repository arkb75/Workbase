import { beforeEach, describe, expect, it, vi } from "vitest";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/llm-config")>();
  return { ...actual, resolveWorkbaseLlmProvider: () => "bedrock" };
});

vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import {
  analyzeRepositoryFile,
  createRepositorySemanticBudget,
} from "@/src/services/repository-coverage-service";

describe("repository semantic task and budget", () => {
  beforeEach(() => {
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input: { budget?: { usage: { modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number } } }) => {
      if (input.budget) {
        input.budget.usage.modelCalls += 1;
        input.budget.usage.inputTokens += 30;
        input.budget.usage.outputTokens += 10;
        input.budget.usage.totalTokens += 40;
      }
      return {
        data: {
          summary: "The file performs project-scoped retrieval.",
          subsystemKeys: ["retrieval_provenance"],
          findings: [{
            statement: "The exported operation retrieves project-scoped records.",
            kind: "data_flow",
            capabilityKeys: ["retrieval_provenance"],
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 1,
            lineEnd: 1,
          }],
          unresolvedQuestions: [],
        },
        rawOutput: "{}",
        parsedOutput: {},
        tokenUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });
  });

  it("places the complete worker objective, questions, outputs, and capability keys in the extraction prompt", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 777,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => 'project-scoped';",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: ["How is retrieval scoped?"],
        expectedOutputs: ["A supported data-flow finding"],
      },
      budget,
    });

    const request = generateStructuredMock.mock.calls[0]?.[0];
    expect(JSON.parse(request.userPrompt)).toMatchObject({
      researchTask: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: ["How is retrieval scoped?"],
        expectedOutputs: ["A supported data-flow finding"],
      },
      allowedCapabilityKeys: ["retrieval_provenance"],
    });
    expect(request.maxTokens).toBe(777);
    expect(request.budget).toBe(budget.model);
    expect(analysis.facts[0]?.subsystemKeys).toEqual(["retrieval_provenance"]);
    expect(analysis.semanticBudgetUsage).toMatchObject({ modelCalls: 1, totalTokens: 40 });
  });

  it("returns an explicit gap without calling the provider when the input-byte budget is exhausted", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 1,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "b".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => true;",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    });

    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("input-byte budget"),
    ]));
    expect(analysis.semanticBudgetUsage).toMatchObject({ inputBytes: 0, modelCalls: 0 });
  });

  it("retains a provider failure as an explicit partial-coverage gap", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("Bedrock temporarily unavailable"));
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => true;",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("Bedrock temporarily unavailable"),
    ]));
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
    ]));
  });
});
