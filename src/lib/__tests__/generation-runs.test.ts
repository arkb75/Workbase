import { beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredGenerationBudgetError } from "@/src/lib/bedrock-structured-llm-client";

const prismaMock = vi.hoisted(() => ({
  generationRun: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  createGenerationRun,
  createGenerationRunIdempotently,
  findSuccessfulGenerationRunReplay,
  GenerationRunReplayError,
  generationRunFailureTokenUsage,
  isStructuredGenerationAdmissionFailure,
} from "@/src/lib/generation-runs";

describe("generation run telemetry privacy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("loads only the successful parsed result bound to a workflow key", async () => {
    prismaMock.generationRun.findUnique.mockResolvedValue({
      id: "generation-replay",
      workItemId: "work-item-1",
      idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
      kind: "highlight_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      inputSummary: {},
      rawOutput: "{}",
      parsedOutput: { highlights: [] },
      validationErrors: null,
      resultRefs: { agentRunId: "agent-1" },
      tokenUsage: null,
      estimatedCostUsd: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const replay = await findSuccessfulGenerationRunReplay({
      workItemId: "work-item-1",
      idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
      kind: "highlight_generation",
    });

    expect(replay?.id).toBe("generation-replay");
    expect(prismaMock.generationRun.findUnique).toHaveBeenCalledWith({
      where: {
        workItemId_idempotencyKey: {
          workItemId: "work-item-1",
          idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
        },
      },
    });
  });

  it("rejects a conflicting replay row before a caller can spend again", async () => {
    prismaMock.generationRun.findUnique.mockResolvedValue({
      id: "generation-running",
      workItemId: "work-item-1",
      kind: "highlight_generation",
      status: "running",
      parsedOutput: null,
    });

    await expect(findSuccessfulGenerationRunReplay({
      workItemId: "work-item-1",
      idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
      kind: "highlight_generation",
    })).rejects.toBeInstanceOf(GenerationRunReplayError);
  });

  it("returns the successful unique-key winner after a concurrent create", async () => {
    prismaMock.generationRun.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed."), { code: "P2002" }),
    );
    prismaMock.generationRun.findUnique.mockResolvedValue({
      id: "generation-winner",
      workItemId: "work-item-1",
      idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
      kind: "highlight_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      inputSummary: {},
      rawOutput: "{}",
      parsedOutput: { highlights: [] },
      validationErrors: null,
      resultRefs: { agentRunId: "agent-1" },
      tokenUsage: null,
      estimatedCostUsd: null,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const winner = await createGenerationRunIdempotently({
      workItemId: "work-item-1",
      kind: "highlight_generation",
      status: "success",
      idempotencyKey: "agent-run:agent-1:highlight-generation:batch-0",
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      inputSummary: {},
      parsedOutput: { highlights: [] },
    });

    expect(winner.id).toBe("generation-winner");
    expect(prismaMock.generationRun.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.generationRun.findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps prompt and generated content out of deployment logs", async () => {
    const sentinel = "PRIVATE_REPOSITORY_SENTINEL";
    prismaMock.generationRun.create.mockResolvedValue({
      id: "generation-1",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: { prompt: sentinel },
      rawOutput: `raw ${sentinel}`,
      parsedOutput: { answer: sentinel },
      validationErrors: null,
      resultRefs: null,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      estimatedCostUsd: 0.001,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: { prompt: sentinel },
      rawOutput: `raw ${sentinel}`,
      parsedOutput: { answer: sentinel },
    });

    const serialized = error.mock.calls.flat().join(" ");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("rawOutputHash");
    expect(serialized).toContain("generation-1");
    expect(info).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("persists authoritative OpenRouter cost completeness with linked result refs", async () => {
    prismaMock.generationRun.create.mockImplementation(async ({ data }) => ({
      id: "generation-metered",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      rawOutput: null,
      parsedOutput: null,
      validationErrors: null,
      ...data,
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: {},
      resultRefs: { agentRunId: "agent-1" },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cost: 0.001,
        providerAttemptCount: 1,
      },
    });

    expect(prismaMock.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedCostUsd: 0.001,
        resultRefs: {
          agentRunId: "agent-1",
          auditAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
          knownEstimatedCostUsd: 0.001,
        },
      }),
    });
  });

  it("retains an unmetered OpenRouter failure as incomplete instead of $0", async () => {
    prismaMock.generationRun.create.mockImplementation(async ({ data }) => ({
      id: "generation-unmetered",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      rawOutput: null,
      parsedOutput: null,
      validationErrors: null,
      ...data,
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: {},
      resultRefs: { agentRunId: "agent-1" },
      tokenUsage: null,
    });

    expect(prismaMock.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          auditAttemptCount: 1,
          unknownUsageAttempts: 1,
          usageComplete: false,
          knownEstimatedCostUsd: null,
        },
      }),
    });
  });

  it("retains attempt counts and request identity from a raw provider failure", async () => {
    const tokenUsage = generationRunFailureTokenUsage({
      requestId: "request-402",
      providerAttemptCount: 2,
      unknownUsageAttempts: 2,
      failedAttempts: [{
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        requestId: "request-primary",
        httpStatus: 402,
      }],
      tokenUsage: null,
    });

    expect(tokenUsage).toEqual({
      attempts: [],
      failedAttempts: [{
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        requestId: "request-primary",
        httpStatus: 402,
      }],
      requestIds: ["request-402"],
      providerAttemptCount: 2,
      unknownUsageAttempts: 2,
    });

    prismaMock.generationRun.create.mockImplementation(async ({ data }) => ({
      id: "generation-raw-failure",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      rawOutput: null,
      parsedOutput: null,
      validationErrors: null,
      ...data,
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: {},
      resultRefs: { agentRunId: "agent-1" },
      tokenUsage,
    });

    expect(prismaMock.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          auditAttemptCount: 2,
          unknownUsageAttempts: 2,
          usageComplete: false,
          knownEstimatedCostUsd: null,
        },
      }),
    });
  });

  it("does not invent a provider attempt for a pre-dispatch admission failure", async () => {
    prismaMock.generationRun.create.mockImplementation(async ({ data }) => ({
      id: "generation-admission-failure",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      rawOutput: null,
      parsedOutput: null,
      validationErrors: null,
      ...data,
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: {},
      resultRefs: {
        agentRunId: "agent-1",
        admissionFailure: true,
      },
      tokenUsage: null,
    });

    expect(prismaMock.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          admissionFailure: true,
          auditAttemptCount: 0,
          unknownUsageAttempts: 0,
          usageComplete: true,
          knownEstimatedCostUsd: null,
        },
      }),
    });
  });

  it("distinguishes zero-call admission from a post-response token budget error", async () => {
    const admissionError = new StructuredGenerationBudgetError(
      "token_budget_exhausted",
      "request did not fit",
      {
        modelCalls: 0,
        repairPasses: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        unknownUsageCalls: 0,
      },
    );
    const chargedError = new StructuredGenerationBudgetError(
      "token_budget_exhausted",
      "provider response exceeded the cumulative limit",
      {
        modelCalls: 1,
        repairPasses: 0,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        unknownUsageCalls: 0,
      },
    );
    const sharedBudgetAdmissionError = new StructuredGenerationBudgetError(
      "token_budget_exhausted",
      "request did not fit after earlier shared-budget work",
      {
        modelCalls: 6,
        repairPasses: 0,
        inputTokens: 48_000,
        outputTokens: 12_000,
        totalTokens: 60_000,
        unknownUsageCalls: 0,
      },
      {
        providerAttemptCount: 0,
        unknownUsageAttempts: 0,
        tokenUsage: null,
      },
    );
    const sharedBudgetChargedError = new StructuredGenerationBudgetError(
      "token_budget_exhausted",
      "provider response exceeded the shared cumulative limit",
      {
        modelCalls: 6,
        repairPasses: 0,
        inputTokens: 48_120,
        outputTokens: 12_030,
        totalTokens: 60_150,
        unknownUsageCalls: 0,
      },
      {
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      },
    );

    expect(isStructuredGenerationAdmissionFailure(admissionError)).toBe(true);
    expect(generationRunFailureTokenUsage(admissionError)).toBeNull();
    expect(isStructuredGenerationAdmissionFailure(chargedError)).toBe(false);
    expect(generationRunFailureTokenUsage(chargedError)).toEqual({
      attempts: [{
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      }],
      failedAttempts: [],
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
      budgetCode: "token_budget_exhausted",
    });
    expect(
      isStructuredGenerationAdmissionFailure(sharedBudgetAdmissionError),
    ).toBe(true);
    expect(
      generationRunFailureTokenUsage(sharedBudgetAdmissionError),
    ).toBeNull();
    expect(
      isStructuredGenerationAdmissionFailure(sharedBudgetChargedError),
    ).toBe(false);
    expect(
      generationRunFailureTokenUsage(sharedBudgetChargedError),
    ).toEqual({
      attempts: [{
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      }],
      failedAttempts: [],
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
      budgetCode: "token_budget_exhausted",
    });

    prismaMock.generationRun.create.mockImplementation(async ({ data }) => ({
      id: "generation-charged-budget",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      rawOutput: null,
      parsedOutput: null,
      validationErrors: null,
      ...data,
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "provider_error",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: {},
      resultRefs: {
        agentRunId: "agent-1",
        admissionFailure: false,
      },
      tokenUsage: generationRunFailureTokenUsage(chargedError),
    });

    expect(prismaMock.generationRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        estimatedCostUsd: null,
        resultRefs: expect.objectContaining({
          admissionFailure: false,
          auditAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: false,
          knownEstimatedCostUsd: null,
        }),
      }),
    });
  });

  it("flattens and deduplicates nested OpenRouter fallback failures", () => {
    const primaryFailure = {
      provider: "openrouter",
      modelId: "openai/gpt-5.4-nano",
      requestId: "request-primary",
      httpStatus: 503,
    };
    const fallbackFailure = {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
      requestId: "request-fallback",
      httpStatus: 429,
    };
    const tokenUsage = generationRunFailureTokenUsage({
      requestId: "request-fallback",
      providerAttemptCount: 2,
      unknownUsageAttempts: 2,
      failedAttempts: [primaryFailure, fallbackFailure],
      tokenUsage: {
        attempts: [],
        failedAttempts: [primaryFailure, fallbackFailure],
        providerAttemptCount: 2,
        unknownUsageAttempts: 2,
      },
    });

    expect(tokenUsage).toEqual({
      attempts: [],
      failedAttempts: [primaryFailure, fallbackFailure],
      requestIds: ["request-fallback"],
      providerAttemptCount: 2,
      unknownUsageAttempts: 2,
    });
  });
});
