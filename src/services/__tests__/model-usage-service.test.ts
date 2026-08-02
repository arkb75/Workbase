import { afterEach, describe, expect, it } from "vitest";
import {
  addModelTokenUsage,
  collectModelTokenUsage,
  collectReportedModelCostUsd,
  collectUnknownModelUsageAttempts,
  countCostedModelProviderAttempts,
  countModelUsageEntries,
  countModelProviderAttempts,
  countReportedModelCostEntries,
  estimateBedrockCostUsd,
  modelTokenUsageJson,
  resolveModelCostUsd,
} from "@/src/services/model-usage-service";

const pricingEnvironmentKeys = [
  "WORKBASE_BEDROCK_INPUT_USD_PER_MILLION",
  "WORKBASE_BEDROCK_OUTPUT_USD_PER_MILLION",
  "WORKBASE_BEDROCK_CACHE_READ_USD_PER_MILLION",
  "WORKBASE_BEDROCK_CACHE_WRITE_USD_PER_MILLION",
] as const;

afterEach(() => {
  pricingEnvironmentKeys.forEach((key) => delete process.env[key]);
});

describe("model usage accounting", () => {
  it("counts nested provider attempts whose token usage is unknown", () => {
    expect(collectUnknownModelUsageAttempts({
      phases: [
        { usage: null, unknownUsageAttempts: 1 },
        { usage: { inputTokens: 10, outputTokens: 2 }, unknownUsageAttempts: 0 },
      ],
    })).toBe(1);
  });

  it("uses explicit provider dispatch counts without double-counting nested attempts", () => {
    const usage = {
      attempts: [
        {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cost: 0.001,
        },
      ],
      providerAttemptCount: 2,
      unknownUsageAttempts: 1,
    };
    expect(countModelProviderAttempts(usage)).toBe(2);
    expect(collectUnknownModelUsageAttempts(usage)).toBe(1);
  });

  it("aggregates nested attempts without double-counting wrapper objects", () => {
    const usage = collectModelTokenUsage({
      firstAttempt: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 500,
        cacheWriteInputTokens: 50,
      },
      repairAttempt: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadInputTokens: 100,
      },
      metadata: { requestCount: 2 },
    });

    expect(usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      cacheReadInputTokens: 600,
      cacheWriteInputTokens: 50,
    });
    expect(modelTokenUsageJson({ attempts: { usage } })).toEqual(usage);
  });

  it("normalizes invalid counts and derives a total when the provider omits one", () => {
    expect(collectModelTokenUsage({
      inputTokens: 10.9,
      outputTokens: 4.2,
      totalTokens: Number.NaN,
      cacheReadInputTokens: -2,
      cacheWriteInputTokens: Number.POSITIVE_INFINITY,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("adds normalized usage from separate durable attempts", () => {
    expect(addModelTokenUsage(
      collectModelTokenUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      collectModelTokenUsage({
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        cacheReadInputTokens: 500,
      }),
    )).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      totalTokens: 170,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 0,
    });
  });

  it("uses provider aggregate usage instead of counting nested attempt detail twice", () => {
    expect(collectModelTokenUsage({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      attempts: {
        first: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        second: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      },
    })).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("prices uncached, cached-read, and cache-write tokens independently", () => {
    expect(estimateBedrockCostUsd("us.anthropic.claude-sonnet-4-6-v1:0", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
    })).toBe(22.05);
  });

  it("supports operational price overrides and declines to guess unknown-model pricing", () => {
    process.env.WORKBASE_BEDROCK_INPUT_USD_PER_MILLION = "1";
    process.env.WORKBASE_BEDROCK_OUTPUT_USD_PER_MILLION = "2";
    process.env.WORKBASE_BEDROCK_CACHE_READ_USD_PER_MILLION = "0.1";
    process.env.WORKBASE_BEDROCK_CACHE_WRITE_USD_PER_MILLION = "1.25";
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheWriteInputTokens: 1_000_000,
    };

    expect(estimateBedrockCostUsd("us.anthropic.claude-sonnet-4-6-v1:0", usage)).toBe(4.35);
    expect(estimateBedrockCostUsd("another-provider.model", usage)).toBeNull();
    expect(estimateBedrockCostUsd("mock", usage)).toBe(0);
  });

  it("uses authoritative OpenRouter usage.cost across provider attempts", () => {
    const rawUsage = {
      attempts: [
        { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.0012 },
        { inputTokens: 30, outputTokens: 5, totalTokens: 35, costUsd: 0.0004 },
      ],
    };
    expect(collectReportedModelCostUsd(rawUsage)).toBe(0.0016);
    expect(countCostedModelProviderAttempts(rawUsage)).toBe(2);
    expect(countModelUsageEntries(rawUsage)).toBe(2);
    expect(countReportedModelCostEntries(rawUsage)).toBe(2);
    expect(resolveModelCostUsd({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      usage: collectModelTokenUsage(rawUsage),
      rawUsage,
    })).toBe(0.0016);
  });

  it("uses an explicit costed-attempt aggregate without recounting nested detail", () => {
    expect(countCostedModelProviderAttempts({
      costedAttemptCount: 2,
      attempts: [
        { inputTokens: 100, outputTokens: 20, cost: 0.0012 },
        { inputTokens: 30, outputTokens: 5, cost: 0.0004 },
      ],
    })).toBe(2);
  });

  it("does not guess OpenRouter cost when usage.cost is unavailable", () => {
    expect(resolveModelCostUsd({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      usage: collectModelTokenUsage({
        inputTokens: 100,
        outputTokens: 20,
      }),
    })).toBeNull();
  });

  it("normalizes reasoning tokens without changing legacy zero-value shapes", () => {
    expect(collectModelTokenUsage({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      reasoningTokens: 6,
    })).toMatchObject({
      totalTokens: 30,
      reasoningTokens: 6,
    });
  });
});
