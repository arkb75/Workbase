import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGenerationRun: vi.fn(),
  createGenerationRunIdempotently: vi.fn(),
  findSuccessfulGenerationRunReplay: vi.fn(),
  generateStructured: vi.fn(),
}));

vi.mock("@/src/lib/generation-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/generation-runs")>()),
  createGenerationRun: mocks.createGenerationRun,
  createGenerationRunIdempotently: mocks.createGenerationRunIdempotently,
  findSuccessfulGenerationRunReplay: mocks.findSuccessfulGenerationRunReplay,
}));

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "openrouter",
  resolveActiveTextModelIdentity: () => ({
    provider: "openrouter",
    modelId: "openai/gpt-5.4-mini",
  }),
}));

vi.mock("@/src/services/bedrock-runtime", () => ({
  getStructuredLlmClient: () => ({
    generateStructured: mocks.generateStructured,
  }),
}));

import { highlightGenerationService } from "@/src/services/highlight-generation-service";

const workItem = {
  id: "work-item-1",
  userId: "user-1",
  title: "Manual evidence project",
  type: "project" as const,
  description: "Manual evidence Highlight replay fixture.",
  startDate: null,
  endDate: null,
};

const evidenceItem = {
  id: "evidence-1",
  sourceId: "source-1",
  label: "Manual accomplishment",
  type: "manual_note" as const,
  evidenceType: "manual_note_excerpt" as const,
  searchText: "Designed a retry-safe import workflow.",
  parentKind: "work_item",
  parentKey: "manual-source-1",
  body: "Designed a retry-safe import workflow.",
  excerpts: ["Designed a retry-safe import workflow."],
  metadata: null,
  tags: [],
};

function generatedOutput(text = "Designed a retry-safe import workflow for repository evidence.") {
  return {
    highlights: [{
      text,
      category: "architecture",
      confidence: "high" as const,
      ownershipClarity: "clear" as const,
      summary: "The manual evidence directly describes the retry-safe workflow design.",
      rationaleSummary: "The supplied note directly supports the implementation and ownership.",
      risksSummary: null,
      missingInfo: null,
      sourceRefs: [{ evidenceItemId: "evidence-1" }],
    }],
  };
}

function persistedRun(input: {
  id: string;
  parsedOutput: unknown;
  idempotencyKey?: string;
}) {
  return {
    id: input.id,
    workItemId: workItem.id,
    kind: "highlight_generation",
    status: "success",
    idempotencyKey: input.idempotencyKey ?? null,
    provider: "openrouter",
    modelId: "openai/gpt-5.4-mini",
    inputSummary: {},
    rawOutput: JSON.stringify(input.parsedOutput),
    parsedOutput: input.parsedOutput,
    validationErrors: null,
    resultRefs: { agentRunId: "agent-1" },
    tokenUsage: null,
    estimatedCostUsd: null,
  };
}

describe("manual Highlight generation replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the successful per-AgentRun batch without another provider call", async () => {
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(
      persistedRun({
        id: "generation-existing",
        parsedOutput: generatedOutput(),
        idempotencyKey:
          "agent-run:agent-1:highlight-generation:manual-source-1:0",
      }),
    );

    const result = await highlightGenerationService.generate({
      workItem,
      evidenceItems: [evidenceItem],
      existingHighlights: [],
      agentRunId: "agent-1",
    });

    expect(mocks.findSuccessfulGenerationRunReplay).toHaveBeenCalledWith({
      workItemId: "work-item-1",
      idempotencyKey:
        "agent-run:agent-1:highlight-generation:manual-source-1:0",
      kind: "highlight_generation",
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
    expect(result.generationRunIds.generation).toEqual(["generation-existing"]);
    expect(result.highlights).toEqual([
      expect.objectContaining({
        text: "Designed a retry-safe import workflow for repository evidence",
        verificationStatus: "draft",
      }),
    ]);
  });

  it("persists a new manual batch under its stable key", async () => {
    const output = generatedOutput();
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(null);
    mocks.generateStructured.mockResolvedValue({
      data: output,
      parsedOutput: output,
      rawOutput: JSON.stringify(output),
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      transportMode: "json_schema",
      attempts: [],
      tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      estimatedCostUsd: 0.0001,
    });
    mocks.createGenerationRunIdempotently.mockImplementation(async (data) =>
      persistedRun({
        id: "generation-new",
        parsedOutput: data.parsedOutput,
        idempotencyKey: data.idempotencyKey,
      })
    );

    const result = await highlightGenerationService.generate({
      workItem,
      evidenceItems: [evidenceItem],
      existingHighlights: [],
      agentRunId: "agent-1",
    });

    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    expect(mocks.createGenerationRunIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          "agent-run:agent-1:highlight-generation:manual-source-1:0",
        resultRefs: expect.objectContaining({
          agentRunId: "agent-1",
          phase: "highlight_generation",
          batchKey: "manual-source-1:0",
        }),
      }),
    );
    expect(result.generationRunIds.generation).toEqual(["generation-new"]);
  });

  it("uses short scoped evidence refs and canonicalizes model whitespace drift before persistence", async () => {
    const output = generatedOutput();
    output.highlights[0]!.sourceRefs = [{ evidenceItemId: "E 1" }];
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(null);
    mocks.generateStructured.mockImplementation(async (input: {
      userPrompt: string;
      exampleOutput: {
        highlights: Array<{
          sourceRefs: Array<{ evidenceItemId: string }>;
        }>;
      };
      extraValidation: (value: typeof output) => string[];
    }) => {
      expect(input.userPrompt).toContain('"evidenceItemId": "E1"');
      expect(input.userPrompt).not.toContain(
        '"evidenceItemId": "evidence-1"',
      );
      expect(input.exampleOutput.highlights[0]!.sourceRefs).toEqual([
        { evidenceItemId: "E1" },
      ]);
      expect(input.extraValidation(output)).toEqual([]);
      const unknownRef = generatedOutput();
      unknownRef.highlights[0]!.sourceRefs = [{ evidenceItemId: "E2" }];
      expect(input.extraValidation(unknownRef)).toEqual([
        "highlights[0].sourceRefs[0] uses an unknown evidence reference.",
      ]);
      return {
        data: output,
        parsedOutput: output,
        rawOutput: JSON.stringify(output),
        provider: "openrouter",
        modelId: "openai/gpt-5.4-mini",
        transportMode: "json_schema",
        attempts: [],
        tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        estimatedCostUsd: 0.0001,
      };
    });
    mocks.createGenerationRunIdempotently.mockImplementation(async (data) => {
      expect(data.parsedOutput).toMatchObject({
        highlights: [{
          sourceRefs: [{ evidenceItemId: "evidence-1" }],
        }],
      });
      return persistedRun({
        id: "generation-scoped-ref",
        parsedOutput: data.parsedOutput,
        idempotencyKey: data.idempotencyKey,
      });
    });

    const result = await highlightGenerationService.generate({
      workItem,
      evidenceItems: [evidenceItem],
      existingHighlights: [],
      agentRunId: "agent-1",
    });

    expect(result.generationRunIds.generation).toEqual([
      "generation-scoped-ref",
    ]);
    expect(
      result.highlights[0]?.evidence.sourceRefs[0]?.evidenceItemId,
    ).toBe("evidence-1");
  });

  it("fails closed on a successful replay outside the original evidence scope", async () => {
    const output = generatedOutput();
    output.highlights[0]!.sourceRefs = [{ evidenceItemId: "evidence-other" }];
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(
      persistedRun({
        id: "generation-corrupt",
        parsedOutput: output,
        idempotencyKey:
          "agent-run:agent-1:highlight-generation:manual-source-1:0",
      }),
    );

    await expect(highlightGenerationService.generate({
      workItem,
      evidenceItems: [evidenceItem],
      existingHighlights: [],
      agentRunId: "agent-1",
    })).rejects.toMatchObject({ name: "GenerationRunReplayError" });

    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
  });

  it("preserves ordinary non-workflow calls without replay lookups", async () => {
    const output = generatedOutput();
    mocks.generateStructured.mockResolvedValue({
      data: output,
      parsedOutput: output,
      rawOutput: JSON.stringify(output),
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      transportMode: "json_schema",
      attempts: [],
      tokenUsage: null,
      estimatedCostUsd: null,
    });
    mocks.createGenerationRun.mockResolvedValue(
      persistedRun({ id: "generation-ordinary", parsedOutput: output }),
    );

    await highlightGenerationService.generate({
      workItem,
      evidenceItems: [evidenceItem],
      existingHighlights: [],
    });

    expect(mocks.findSuccessfulGenerationRunReplay).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).toHaveBeenCalledTimes(1);
  });
});
