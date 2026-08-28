import { describe, expect, it } from "vitest";
import {
  modelCallsFromGenerationTelemetry,
  repositoryGenerationModelCalls,
} from "@/src/evals/repository-knowledge-database-observation";

const attempt = (requestId: string) => ({
  requestId,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
});

describe("repository knowledge database performance telemetry", () => {
  it("counts multiple provider attempts in one generation row once each", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2"), attempt("request-3")],
      providerAttemptCount: 3,
      unknownUsageAttempts: 0,
      budget: {
        modelCalls: 3,
        inputTokens: 300,
        outputTokens: 60,
        totalTokens: 360,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(3);
    expect(repositoryGenerationModelCalls([{ tokenUsage }])).toBe(3);
  });

  it("does not add nested attempt leaves to a matching budget counter", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2")],
      synthesisBudget: {
        modelCalls: 2,
        unknownUsageCalls: 0,
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(2);
  });

  it("sums distinct generation rows and uses cumulative refresh usage only as a floor", () => {
    const generationRuns = [
      { tokenUsage: { providerAttemptCount: 2, attempts: [attempt("a"), attempt("b")] } },
      { tokenUsage: { providerAttemptCount: 3, attempts: [attempt("c"), attempt("d"), attempt("e")] } },
      { tokenUsage: null },
    ];

    expect(repositoryGenerationModelCalls(generationRuns, {
      actual: { modelCalls: 5, unknownUsageCalls: 0 },
    })).toBe(5);
    expect(repositoryGenerationModelCalls([{ tokenUsage: null }], {
      actual: { modelCalls: 4, unknownUsageCalls: 1 },
    })).toBe(4);
  });

  it("counts unmetered dispatched attempts without inventing a call for empty rows", () => {
    expect(modelCallsFromGenerationTelemetry({
      attempts: [],
      unknownUsageAttempts: 2,
    })).toBe(2);
    expect(modelCallsFromGenerationTelemetry(null)).toBe(0);
  });
});
