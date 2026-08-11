import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGenerationRun: vi.fn(),
  createGenerationRunIdempotently: vi.fn(),
  findSuccessfulGenerationRunReplay: vi.fn(),
  updateGenerationRunResultRefs: vi.fn(),
  generateStructured: vi.fn(),
}));

vi.mock("@/src/lib/generation-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/generation-runs")>()),
  createGenerationRun: mocks.createGenerationRun,
  createGenerationRunIdempotently: mocks.createGenerationRunIdempotently,
  findSuccessfulGenerationRunReplay: mocks.findSuccessfulGenerationRunReplay,
  updateGenerationRunResultRefs: mocks.updateGenerationRunResultRefs,
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

import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { mockClaimVerificationService } from "@/src/services/mock-claim-verification-service";

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

function highlight(index: number) {
  return {
    text: `Designed retry-safe repository workflow component ${index + 1}.`,
    confidence: "high" as const,
    ownershipClarity: "clear" as const,
    sensitivityFlag: false,
    verificationStatus: "draft" as const,
    visibility: "resume_safe" as const,
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    summary: `Manual evidence supports workflow component ${index + 1}.`,
    verificationNotes: "The note directly supports this implementation.",
    metadata: null,
    evidence: {
      summary: "The note directly supports the implementation.",
      verificationNotes: null,
      sourceRefs: [{
        evidenceItemId: "evidence-1",
        sourceId: "source-1",
        sourceLabel: "Manual accomplishment",
        sourceType: "manual_note" as const,
        title: "Manual accomplishment",
        excerpt: "Designed a retry-safe import workflow.",
      }],
    },
    tags: [],
  };
}

function verificationOutput(count: number) {
  return {
    results: Array.from({ length: count }, (_, claimIndex) => ({
      claimIndex,
      revisedText: null,
      confidence: "high" as const,
      ownershipClarity: "clear" as const,
      visibilitySuggestion: "resume_safe" as const,
      sensitivityWarning: false,
      shouldFlag: false,
      overstatementWarning: false,
      unsupportedImpactWarning: false,
      rationaleSummary: "The supplied evidence directly supports this candidate Highlight.",
      risksSummary: null,
      missingInfo: null,
      verificationNotes: "Verification retained the evidence-bounded wording.",
    })),
  };
}

function persistedRun(input: {
  id: string;
  parsedOutput: unknown;
  idempotencyKey: string;
}) {
  return {
    id: input.id,
    workItemId: workItem.id,
    kind: "highlight_verification",
    status: "success",
    idempotencyKey: input.idempotencyKey,
    provider: "openrouter",
    modelId: "openai/gpt-5.4-mini",
    inputSummary: {
      transportMode: "json_schema",
      transportAttempts: [],
    },
    rawOutput: JSON.stringify(input.parsedOutput),
    parsedOutput: input.parsedOutput,
    validationErrors: null,
    resultRefs: { agentRunId: "agent-1" },
    tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    estimatedCostUsd: 0.0001,
  };
}

function providerResult(output: ReturnType<typeof verificationOutput>) {
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
}

describe("manual Highlight verification replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateGenerationRunResultRefs.mockResolvedValue(undefined);
  });

  it("reuses a successful single verification batch and retains its attribution", async () => {
    const output = verificationOutput(1);
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(
      persistedRun({
        id: "verification-existing",
        parsedOutput: output,
        idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      }),
    );

    const verified = await claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: [highlight(0)],
      agentRunId: "agent-1",
    });

    expect(mocks.findSuccessfulGenerationRunReplay).toHaveBeenCalledWith({
      workItemId: "work-item-1",
      idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      kind: "highlight_verification",
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
    expect(readGenerationRunMetadata(verified)).toEqual({
      id: "verification-existing",
      kind: "highlight_verification",
    });
    expect(verified[0]).toEqual(expect.objectContaining({
      verificationStatus: "approved",
      confidence: "high",
    }));
  });

  it("keeps verifier warnings flagged instead of approving the generated draft", async () => {
    const output = verificationOutput(1);
    output.results[0] = {
      ...output.results[0],
      shouldFlag: true,
      overstatementWarning: true,
    };
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(
      persistedRun({
        id: "verification-flagged",
        parsedOutput: output,
        idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      }),
    );

    const verified = await claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: [highlight(0)],
      agentRunId: "agent-1",
    });

    expect(verified[0]).toEqual(expect.objectContaining({
      verificationStatus: "flagged",
      confidence: "medium",
    }));
  });

  it("resumes after one of two batches and links provider rows to one aggregate phase", async () => {
    const firstOutput = verificationOutput(6);
    const secondOutput = verificationOutput(1);
    mocks.findSuccessfulGenerationRunReplay
      .mockResolvedValueOnce(persistedRun({
        id: "verification-batch-0",
        parsedOutput: firstOutput,
        idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      }))
      .mockResolvedValueOnce(null);
    mocks.generateStructured.mockResolvedValue(providerResult(secondOutput));
    mocks.createGenerationRunIdempotently.mockImplementation(async (data) => {
      if (data.idempotencyKey.endsWith(":aggregate")) {
        return {
          id: "verification-aggregate",
          ...data,
        };
      }
      return persistedRun({
        id: "verification-batch-1",
        parsedOutput: data.parsedOutput,
        idempotencyKey: data.idempotencyKey,
      });
    });

    const verified = await claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: Array.from({ length: 7 }, (_, index) => highlight(index)),
      agentRunId: "agent-1",
    });

    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    expect(mocks.createGenerationRunIdempotently).toHaveBeenCalledTimes(2);
    expect(mocks.createGenerationRunIdempotently).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "agent-run:agent-1:highlight-verification:1",
        resultRefs: expect.objectContaining({
          agentRunId: "agent-1",
          phase: "highlight_verification",
          batchIndex: 1,
        }),
      }),
    );
    expect(mocks.createGenerationRunIdempotently).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey:
          "agent-run:agent-1:highlight-verification:aggregate",
        provider: "deterministic",
        resultRefs: expect.objectContaining({
          providerBatchGenerationRunIds: [
            "verification-batch-0",
            "verification-batch-1",
          ],
        }),
      }),
    );
    expect(mocks.updateGenerationRunResultRefs).toHaveBeenCalledTimes(2);
    expect(mocks.updateGenerationRunResultRefs).toHaveBeenCalledWith(
      "verification-batch-0",
      { authoritativeGenerationRunId: "verification-aggregate" },
    );
    expect(readGenerationRunMetadata(verified)?.id).toBe(
      "verification-aggregate",
    );
  });

  it("fails closed when a successful replay no longer matches its batch", async () => {
    mocks.findSuccessfulGenerationRunReplay.mockResolvedValue(
      persistedRun({
        id: "verification-corrupt",
        parsedOutput: verificationOutput(0),
        idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      }),
    );

    await expect(claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: [highlight(0)],
      agentRunId: "agent-1",
    })).rejects.toMatchObject({ name: "GenerationRunReplayError" });

    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
  });

  it("does not misclassify post-checkpoint lineage repair as a provider failure", async () => {
    mocks.findSuccessfulGenerationRunReplay
      .mockResolvedValueOnce(persistedRun({
        id: "verification-batch-0",
        parsedOutput: verificationOutput(6),
        idempotencyKey: "agent-run:agent-1:highlight-verification:0",
      }))
      .mockResolvedValueOnce(persistedRun({
        id: "verification-batch-1",
        parsedOutput: verificationOutput(1),
        idempotencyKey: "agent-run:agent-1:highlight-verification:1",
      }));
    mocks.createGenerationRunIdempotently.mockResolvedValue({
      id: "verification-aggregate",
    });
    mocks.updateGenerationRunResultRefs.mockRejectedValueOnce(
      new Error("database connection interrupted"),
    );

    await expect(claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: Array.from({ length: 7 }, (_, index) => highlight(index)),
      agentRunId: "agent-1",
    })).rejects.toThrow("database connection interrupted");

    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).not.toHaveBeenCalled();
  });

  it("preserves ordinary verification as one aggregate provider run", async () => {
    const output = verificationOutput(1);
    mocks.generateStructured.mockResolvedValue(providerResult(output));
    mocks.createGenerationRun.mockResolvedValue({ id: "verification-ordinary" });

    await claimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: [highlight(0)],
    });

    expect(mocks.findSuccessfulGenerationRunReplay).not.toHaveBeenCalled();
    expect(mocks.createGenerationRunIdempotently).not.toHaveBeenCalled();
    expect(mocks.createGenerationRun).toHaveBeenCalledTimes(1);
    expect(mocks.createGenerationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "openai/gpt-5.4-mini",
      }),
    );
  });
});

describe("mock Highlight verification policy", () => {
  it("approves safe generated drafts while preserving an existing flag", async () => {
    const verified = await mockClaimVerificationService.verify({
      workItem,
      evidenceItems: [evidenceItem],
      highlights: [
        highlight(0),
        { ...highlight(1), verificationStatus: "flagged" },
      ],
    });

    expect(verified.map((item) => item.verificationStatus)).toEqual([
      "approved",
      "flagged",
    ]);
  });
});
