import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  generationRun: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  createGenerationRun,
  generationRunFailureTokenUsage,
} from "@/src/lib/generation-runs";

describe("generation run telemetry privacy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
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
});
