import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/src/domain/types";
import { Prisma } from "@/src/generated/prisma/client";
import { StructuredGenerationBudgetError } from "@/src/lib/bedrock-structured-llm-client";

const prismaMock = vi.hoisted(() => ({
  generationRun: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));
const activeIdentityMock = vi.hoisted(() => ({
  value: {
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6-v1:0",
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6-v1:0",
    region: "us-west-2",
  }),
  resolveActiveTextModelIdentity: () => activeIdentityMock.value,
}));

import {
  EXACT_PARSED_OUTPUT_MAX_BYTES,
  runAuditedStructuredGeneration,
} from "@/src/services/structured-generation-audit-service";

const modelId = "us.anthropic.claude-sonnet-4-6-v1:0";

function structuredResult(tokenUsage: JsonValue | null) {
  return {
    data: { answer: "ok" },
    rawOutput: '{"answer":"ok"}',
    parsedOutput: { answer: "ok" },
    tokenUsage,
    provider: "bedrock",
    modelId,
    transportMode: "bedrock_json_schema",
    attempts: [{ status: "success" }],
  };
}

describe("structured generation audit usage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    activeIdentityMock.value = {
      provider: "bedrock",
      modelId,
    };
    prismaMock.generationRun.update.mockResolvedValue({});
  });

  it("persists an opted-in bounded projection losslessly", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-exact",
      modelId,
      tokenUsage: null,
      resultRefs: null,
      estimatedCostUsd: null,
    });
    const longSummary = "x".repeat(700);
    const result = {
      ...structuredResult(null),
      parsedOutput: { summary: longSummary },
    };

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "capability_synthesis",
      idempotencyKey: "synthesis:exact",
      inputSummary: { phase: "synthesis" },
      exactParsedOutput: (generation) => generation.parsedOutput,
      execute: async () => result,
    });
    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "capability_synthesis",
      idempotencyKey: "synthesis:sanitized",
      inputSummary: { phase: "synthesis" },
      execute: async () => result,
    });

    expect(prismaMock.generationRun.update.mock.calls[0]![0].data.parsedOutput)
      .toEqual({ summary: longSummary });
    expect(prismaMock.generationRun.update.mock.calls[1]![0].data.parsedOutput)
      .toEqual({
        summary: `${"x".repeat(512)}…[truncated 188 chars]`,
      });
  });

  it("fails closed when an exact projection exceeds its UTF-8 byte cap", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-oversized",
      modelId,
      tokenUsage: null,
      resultRefs: null,
      estimatedCostUsd: null,
    });

    await expect(runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "capability_synthesis",
      idempotencyKey: "synthesis:oversized",
      inputSummary: { phase: "synthesis" },
      exactParsedOutput: (generation) => generation.parsedOutput,
      execute: async () => ({
        ...structuredResult(null),
        parsedOutput: { summary: "x".repeat(EXACT_PARSED_OUTPUT_MAX_BYTES) },
      }),
    })).rejects.toThrow(
      `exceeds ${EXACT_PARSED_OUTPUT_MAX_BYTES} UTF-8 bytes`,
    );
  });

  it("aggregates token usage and cost when a durable idempotency key is retried", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-1",
      modelId,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      resultRefs: {
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: true,
      },
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      agentRunId: "agent-run-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:retry",
      inputSummary: { path: "src/service.ts" },
      resultAttestation: (result) => ({
        answerDigest: result.data.answer === "ok" ? "verified" : "invalid",
      }),
      execute: async () => structuredResult({
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        cacheReadInputTokens: 500,
        cacheWriteInputTokens: 0,
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [
        {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          cacheReadInputTokens: 500,
          cacheWriteInputTokens: 0,
        },
      ],
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    });
    expect(data.estimatedCostUsd).toBe(0.00105);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      agentRunId: "agent-run-1",
      auditAttemptCount: 2,
      unknownUsageAttempts: 0,
      usageComplete: true,
      knownEstimatedCostUsd: 0.00105,
      resultAttestation: { answerDigest: "verified" },
    }));
  });

  it("retains known retry usage but reports total cost as unknown after an unobserved provider failure", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-2",
      modelId,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      resultRefs: {
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: true,
      },
    });

    await expect(runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:unknown-retry",
      inputSummary: { path: "src/service.ts" },
      execute: async () => {
        throw new Error("provider connection closed after dispatch");
      },
    })).rejects.toThrow("provider connection closed after dispatch");

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [{
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      }],
      providerAttemptCount: 2,
      unknownUsageAttempts: 1,
    });
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 2,
      unknownUsageAttempts: 1,
      usageComplete: false,
      knownEstimatedCostUsd: 0.0006,
    }));
  });

  it("does not turn missing provider usage into a zero-cost measurement", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-3",
      modelId,
      tokenUsage: null,
      resultRefs: null,
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:missing-usage",
      inputSummary: { path: "src/service.ts" },
      execute: async () => structuredResult(null),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toBe(Prisma.JsonNull);
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 1,
      unknownUsageAttempts: 1,
      usageComplete: false,
      knownEstimatedCostUsd: 0,
    }));
  });

  it("persists only cost-bearing OpenRouter usage evidence and provider identity", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-complete",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: null,
      estimatedCostUsd: null,
      resultRefs: null,
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      agentRunId: "artifact-run-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:artifact-run-1",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-live-verification",
        transportMode: "json_schema",
        tokenUsage: {
          inputTokens: 500,
          outputTokens: 157,
          totalTokens: 657,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 12,
          cost: 0.00588,
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-live-verification",
          routedProvider: "Azure",
          providerAttemptCount: 1,
          prompt: "must not be persisted",
          rawError: "must not be persisted",
          authorization: "Bearer must-not-remain",
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [{
        inputTokens: 500,
        outputTokens: 157,
        totalTokens: 657,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 12,
        cost: 0.00588,
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-live-verification",
        routedProvider: "Azure",
        providerAttemptCount: 1,
      }],
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
    });
    expect(JSON.stringify(data.tokenUsage)).not.toMatch(
      /prompt|rawError|authorization|must not|must-not/i,
    );
    expect(data).toMatchObject({
      provider: "openrouter",
      modelId: openRouterModelId,
      estimatedCostUsd: 0.00588,
      resultRefs: expect.objectContaining({
        agentRunId: "artifact-run-1",
        profile: "verification",
        requestId: "gen-live-verification",
        requestIds: ["gen-live-verification"],
        auditAttemptCount: 1,
        providerAttemptCount: 1,
        routedProviders: ["Azure"],
        unknownUsageAttempts: 0,
        usageComplete: true,
        knownEstimatedCostUsd: 0.00588,
      }),
    });
  });

  it("honors an explicit costed-attempt count on normalized multi-attempt usage", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-aggregate",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: null,
      estimatedCostUsd: null,
      resultRefs: null,
    });
    const aggregateUsage = {
      inputTokens: 700,
      outputTokens: 197,
      totalTokens: 897,
      cost: 0.00788,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestIds: ["gen-aggregate-1", "gen-aggregate-2"],
      routedProviders: ["Azure"],
      providerAttemptCount: 2,
      costedAttemptCount: 2,
      unknownUsageAttempts: 0,
    };

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:aggregate",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(aggregateUsage),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-aggregate-2",
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [aggregateUsage],
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    });
    expect(data.estimatedCostUsd).toBe(0.00788);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 2,
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
      usageComplete: true,
      knownEstimatedCostUsd: 0.00788,
    }));
  });

  it("flattens complete idempotent OpenRouter retries without losing per-attempt evidence", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    const priorAttempt = {
      inputTokens: 500,
      outputTokens: 157,
      totalTokens: 657,
      cost: 0.00588,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestId: "gen-prior",
      routedProvider: "Azure",
      providerAttemptCount: 1,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-retry",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: {
        auditUsageEvidenceVersion: 1,
        attempts: [priorAttempt],
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
      },
      estimatedCostUsd: 0.00588,
      resultRefs: {
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: true,
        knownEstimatedCostUsd: 0.00588,
      },
    });
    const currentAttempt = {
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      cost: 0.002,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestId: "gen-current",
      routedProvider: "Azure",
      providerAttemptCount: 1,
    };

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:retry",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(currentAttempt),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-current",
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [priorAttempt, currentAttempt],
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    });
    expect(data.estimatedCostUsd).toBe(0.00788);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 2,
      requestIds: ["gen-prior", "gen-current"],
      unknownUsageAttempts: 0,
      usageComplete: true,
      knownEstimatedCostUsd: 0.00788,
    }));
  });

  it("retains all cost and identity evidence through a twenty-first audited attempt", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    const priorAttempts = Array.from({ length: 20 }, (_, index) => ({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cost: 0.001,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestId: `gen-prior-${index + 1}`,
      routedProvider: "Azure",
      providerAttemptCount: 1,
    }));
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-attempt-21",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: {
        auditUsageEvidenceVersion: 1,
        attempts: priorAttempts,
        providerAttemptCount: 20,
        unknownUsageAttempts: 0,
      },
      estimatedCostUsd: 0.02,
      resultRefs: {
        auditAttemptCount: 20,
        unknownUsageAttempts: 0,
        usageComplete: true,
        knownEstimatedCostUsd: 0.02,
      },
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:attempt-21",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-current-21",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cost: 0.001,
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-current-21",
          routedProvider: "Azure",
          providerAttemptCount: 1,
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage.attempts).toHaveLength(21);
    expect(data.tokenUsage).not.toHaveProperty("auditEvidenceTruncated");
    expect(data.tokenUsage.attempts.at(-1)).toMatchObject({
      requestId: "gen-current-21",
      cost: 0.001,
    });
    expect(data.estimatedCostUsd).toBe(0.021);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 21,
      auditEvidenceTruncated: false,
      usageComplete: true,
      knownEstimatedCostUsd: 0.021,
    }));
  });

  it("retains valid usage nested beyond the generic event-sanitizer depth", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-deep-usage",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: null,
      estimatedCostUsd: null,
      resultRefs: null,
    });
    const leaf = {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cost: 0.0015,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestId: "gen-deep",
      routedProvider: "Azure",
      providerAttemptCount: 1,
    };

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:deep-usage",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-deep",
        tokenUsage: { usage: { attempts: [leaf] } },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toMatchObject({
      attempts: [{ usage: { attempts: [leaf] } }],
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
    });
    expect(JSON.stringify(data.tokenUsage)).not.toContain("depth limit");
    expect(data.estimatedCostUsd).toBe(0.0015);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditEvidenceTruncated: false,
      usageComplete: true,
      knownEstimatedCostUsd: 0.0015,
    }));
  });

  it("marks evidence beyond the explicit audit bound incomplete", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    const priorAttempts = Array.from({ length: 256 }, (_, index) => ({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: 0.001,
      provider: "openrouter",
      modelId: openRouterModelId,
      requestId: `gen-bounded-${index + 1}`,
      routedProvider: "Azure",
      providerAttemptCount: 1,
    }));
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-bounded",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: {
        auditUsageEvidenceVersion: 1,
        attempts: priorAttempts,
        providerAttemptCount: 256,
        unknownUsageAttempts: 0,
      },
      estimatedCostUsd: 0.256,
      resultRefs: {
        auditAttemptCount: 256,
        unknownUsageAttempts: 0,
        usageComplete: true,
        knownEstimatedCostUsd: 0.256,
      },
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:bounded",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-over-bound",
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cost: 0.001,
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-over-bound",
          routedProvider: "Azure",
          providerAttemptCount: 1,
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage.attempts).toHaveLength(256);
    expect(data.tokenUsage.auditEvidenceTruncated).toBe(true);
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 257,
      auditEvidenceTruncated: true,
      usageComplete: false,
      knownEstimatedCostUsd: 0.257,
    }));
  });

  it("fails closed when an object container exceeds the explicit evidence bound", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-object-bound",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: null,
      estimatedCostUsd: null,
      resultRefs: null,
    });
    const phases = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `attempt${index + 1}`,
        {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cost: 0.001,
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: `gen-object-${index + 1}`,
          routedProvider: "Azure",
          providerAttemptCount: 1,
        },
      ]),
    );

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:object-bound",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-object-257",
        tokenUsage: {
          phases,
          providerAttemptCount: 257,
          costedAttemptCount: 257,
          unknownUsageAttempts: 0,
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toMatchObject({
      auditEvidenceTruncated: true,
      providerAttemptCount: 257,
      unknownUsageAttempts: 0,
    });
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 257,
      auditEvidenceTruncated: true,
      usageComplete: false,
      knownEstimatedCostUsd: 0.257,
    }));
  });

  it("does not certify a legacy OpenRouter retry whose prior cost evidence was flattened away", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-legacy-retry",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: {
        inputTokens: 500,
        outputTokens: 157,
        totalTokens: 657,
      },
      estimatedCostUsd: 0.00588,
      resultRefs: {
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: true,
        knownEstimatedCostUsd: 0.00588,
      },
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:legacy-retry",
      inputSummary: { sourceCount: 1 },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-current",
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 40,
          totalTokens: 240,
          cost: 0.002,
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-current",
          routedProvider: "Azure",
          providerAttemptCount: 1,
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 2,
      unknownUsageAttempts: 0,
      usageComplete: false,
      knownEstimatedCostUsd: 0.00788,
    }));
    expect(data.tokenUsage).toMatchObject({
      auditUsageEvidenceVersion: 1,
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
      attempts: [
        expect.not.objectContaining({ cost: expect.anything() }),
        expect.objectContaining({
          cost: 0.002,
          requestId: "gen-current",
        }),
      ],
    });
  });

  it("persists bounded failed-attempt identity while excluding raw failure content", async () => {
    const openRouterModelId = "openai/gpt-5.6-terra";
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: openRouterModelId,
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter-failure",
      provider: "openrouter",
      modelId: openRouterModelId,
      tokenUsage: null,
      estimatedCostUsd: null,
      resultRefs: null,
    });
    const failure = Object.assign(
      new Error("raw upstream failure must not persist"),
      {
        providerAttemptCount: 1,
        unknownUsageAttempts: 1,
        failedAttempts: [{
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-failed",
          routedProvider: "Customer Launch Roadmap Alpha",
          status: "provider_error",
          code: "raw provider prose must not persist",
          errorType: "raw error prose must not persist",
          retryAfter: "raw retry prose must not persist",
          httpStatus: 503,
          retryable: true,
          message: "raw provider message must not persist",
          prompt: "private prompt must not persist",
        }],
      },
    );

    await expect(runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      profile: "verification",
      idempotencyKey: "public-artifact-verification:failure",
      inputSummary: { sourceCount: 1 },
      execute: async () => {
        throw failure;
      },
    })).rejects.toThrow("raw upstream failure");

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [{
        attempts: [],
        failedAttempts: [{
          provider: "openrouter",
          modelId: openRouterModelId,
          requestId: "gen-failed",
          status: "provider_error",
          httpStatus: 503,
          retryable: true,
        }],
        providerAttemptCount: 1,
        unknownUsageAttempts: 1,
      }],
      providerAttemptCount: 1,
      unknownUsageAttempts: 1,
    });
    expect(JSON.stringify(data)).not.toMatch(
      /customer launch|private prompt|raw upstream|raw provider|raw error|raw retry|must not persist/i,
    );
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 1,
      providerAttemptCount: 1,
      unknownUsageAttempts: 1,
      usageComplete: false,
      failedProviderAttempts: [{
        provider: "openrouter",
        modelId: openRouterModelId,
        requestId: "gen-failed",
        status: "provider_error",
        httpStatus: 503,
        retryable: true,
      }],
      requestIds: ["gen-failed"],
      message: "Structured generation provider request failed closed.",
    }));
  });

  it("does not count a pre-dispatch budget admission failure as a provider attempt", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-budget",
      modelId,
      tokenUsage: null,
      resultRefs: null,
    });

    await expect(runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:budget-admission",
      inputSummary: { path: "src/large-service.ts" },
      execute: async () => {
        throw new StructuredGenerationBudgetError(
          "token_budget_exhausted",
          "The request did not fit before dispatch.",
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
      },
    })).rejects.toThrow("did not fit before dispatch");

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.estimatedCostUsd).toBe(0);
    expect(data.tokenUsage).toBe(Prisma.JsonNull);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 0,
      providerAttemptCount: 0,
      unknownUsageAttempts: 0,
      usageComplete: true,
      admissionFailure: true,
      budgetCode: "token_budget_exhausted",
      message: "Structured generation stopped before dispatch: token_budget_exhausted.",
    }));
  });

  it("retains charged usage when the provider response exceeds the token budget", async () => {
    activeIdentityMock.value = {
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
    };
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-post-response-budget",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      tokenUsage: null,
      resultRefs: null,
    });

    await expect(runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:post-response-budget",
      inputSummary: { path: "src/large-service.ts" },
      execute: async () => {
        throw new StructuredGenerationBudgetError(
          "token_budget_exhausted",
          "The provider response crossed the cumulative token ceiling.",
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
      },
    })).rejects.toThrow("crossed the cumulative token ceiling");

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [{
        attempts: [{
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        }],
        failedAttempts: [],
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
      }],
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
    });
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 1,
      providerAttemptCount: 1,
      unknownUsageAttempts: 0,
      usageComplete: false,
      knownEstimatedCostUsd: null,
      admissionFailure: false,
      budgetCode: "token_budget_exhausted",
      message: "Structured generation stopped after provider dispatch: token_budget_exhausted.",
    }));
  });

  it("prices all known transport attempts but marks the total incomplete when one attempt has unknown usage", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-4",
      modelId,
      tokenUsage: null,
      resultRefs: null,
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "semantic_extraction",
      idempotencyKey: "semantic:multi-transport",
      inputSummary: { path: "src/service.ts" },
      execute: async () => structuredResult({
        attempts: [
          { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        ],
        unknownUsageAttempts: 1,
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data.tokenUsage).toEqual({
      auditUsageEvidenceVersion: 1,
      attempts: [{
        attempts: [
          { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        ],
        unknownUsageAttempts: 1,
      }],
      providerAttemptCount: 2,
      unknownUsageAttempts: 1,
    });
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      unknownUsageAttempts: 1,
      usageComplete: false,
      knownEstimatedCostUsd: 0.0009,
    }));
  });

  it("persists actual OpenRouter fallback attribution and carries known lower-bound cost across retries", async () => {
    prismaMock.generationRun.upsert.mockResolvedValue({
      id: "generation-openrouter",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      estimatedCostUsd: null,
      resultRefs: {
        auditAttemptCount: 2,
        unknownUsageAttempts: 1,
        usageComplete: false,
        knownEstimatedCostUsd: 0.001,
      },
    });

    await runAuditedStructuredGeneration({
      workItemId: "work-item-1",
      kind: "capability_synthesis",
      profile: "deep_synthesis",
      idempotencyKey: "openrouter:fallback-retry",
      inputSummary: { subsystem: "runtime" },
      execute: async () => ({
        ...structuredResult(null),
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-5",
        requestId: "req_fallback",
        transportMode: "json_schema",
        tokenUsage: {
          attempts: [
            {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              cost: 0.002,
              routedProvider: "anthropic",
            },
          ],
          failedAttempts: [
            {
              provider: "openrouter",
              modelId: "openai/gpt-5.6-terra",
              requestId: "req_primary",
              httpStatus: 503,
              retryable: true,
            },
          ],
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
        },
      }),
    });

    const data = prismaMock.generationRun.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
      estimatedCostUsd: null,
      resultRefs: expect.objectContaining({
        profile: "deep_synthesis",
        configuredModelId: modelId,
        requestId: "req_fallback",
        auditAttemptCount: 4,
        providerAttemptCount: 2,
        unknownUsageAttempts: 2,
        usageComplete: false,
        knownEstimatedCostUsd: 0.003,
        routedProviders: ["anthropic"],
        failedProviderAttempts: [
          expect.objectContaining({
            modelId: "openai/gpt-5.6-terra",
            requestId: "req_primary",
          }),
        ],
      }),
    });
  });
});
