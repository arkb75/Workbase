import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/src/domain/types";
import { Prisma } from "@/src/generated/prisma/client";

const prismaMock = vi.hoisted(() => ({
  generationRun: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6-v1:0",
    region: "us-west-2",
  }),
}));

import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";

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
    prismaMock.generationRun.update.mockResolvedValue({});
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
      kind: "semantic_extraction",
      idempotencyKey: "semantic:retry",
      inputSummary: { path: "src/service.ts" },
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
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 0,
    });
    expect(data.estimatedCostUsd).toBe(0.00105);
    expect(data.resultRefs).toEqual(expect.objectContaining({
      auditAttemptCount: 2,
      unknownUsageAttempts: 0,
      usageComplete: true,
      knownEstimatedCostUsd: 0.00105,
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
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
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
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(data.estimatedCostUsd).toBeNull();
    expect(data.resultRefs).toEqual(expect.objectContaining({
      unknownUsageAttempts: 1,
      usageComplete: false,
      knownEstimatedCostUsd: 0.0009,
    }));
  });
});
