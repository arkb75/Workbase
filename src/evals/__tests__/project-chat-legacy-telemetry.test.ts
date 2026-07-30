import { describe, expect, it } from "vitest";
import { buildLegacyProjectChatModelTelemetry } from "@/src/evals/project-chat-legacy-telemetry";

const primaryModel = "openai/gpt-5.6-terra";

function openRouterEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-primary",
    message: "Project evidence review completed.",
    payload: {
      modelEvent: "model_call_completed",
      iteration: 1,
      profile: "primary_answer",
      provider: "openrouter",
      modelId: primaryModel,
      routedProvider: "openai",
      requestId: "request-primary",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cost: 0.001,
        providerAttemptCount: 1,
        modelId: primaryModel,
        routedProvider: "openai",
        requestId: "request-primary",
      },
      ...overrides,
    },
  };
}

function buildOpenRouter(
  events: ReturnType<typeof openRouterEvent>[],
) {
  return buildLegacyProjectChatModelTelemetry({
    provider: "openrouter",
    modelId: primaryModel,
    events,
    dossierModelUsage: [],
    generationRuns: [],
    storedResult: { fallbackUsed: false },
    expectedModelIdsByProfile: {
      primary_answer: primaryModel,
    },
  });
}

describe("legacy project-chat live model acceptance", () => {
  it("accepts complete authoritative OpenRouter attribution", () => {
    const result = buildOpenRouter([openRouterEvent()]);

    expect(result.metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
      usageComplete: true,
      modelAttribution: {
        providers: ["openrouter"],
        actualModelIds: [primaryModel],
        routedProviders: ["openai"],
        requestIds: ["request-primary"],
        fallbackUsed: false,
        profiles: {
          primary_answer: {
            configuredRoutingMatched: true,
          },
        },
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: true,
      noFallbackAttempts: true,
      profileRoutingMatches: true,
    });
  });

  it("rejects fully metered fallback attempts and cross-model routing", () => {
    const fallbackModel = "anthropic/claude-sonnet-5";
    const result = buildOpenRouter([openRouterEvent({
      modelId: fallbackModel,
      routedProvider: "anthropic",
      requestId: "request-fallback",
      usage: {
        attempts: [
          {
            inputTokens: 60,
            outputTokens: 5,
            totalTokens: 65,
            cost: 0.0002,
            providerAttemptCount: 1,
            modelId: primaryModel,
            routedProvider: "openai",
            requestId: "request-primary",
          },
          {
            inputTokens: 40,
            outputTokens: 15,
            totalTokens: 55,
            cost: 0.0015,
            providerAttemptCount: 1,
            modelId: fallbackModel,
            routedProvider: "anthropic",
            requestId: "request-fallback",
          },
        ],
        failedAttempts: [{
          provider: "openrouter",
          modelId: primaryModel,
          requestId: "request-primary",
          httpStatus: 503,
        }],
        providerAttemptCount: 2,
        unknownUsageAttempts: 0,
      },
    })]);

    expect(result.metrics.usageComplete).toBe(true);
    expect(result.metrics.modelAttribution).toMatchObject({
      actualModelIds: [fallbackModel, primaryModel].sort(),
      failedProviderAttempts: 1,
      fallbackUsed: true,
      profiles: {
        primary_answer: {
          configuredRoutingMatched: false,
          fallbackUsed: true,
        },
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: true,
      noFallbackAttempts: false,
      profileRoutingMatches: false,
    });
  });

  it("rejects OpenRouter usage without authoritative model, provider, or request identity", () => {
    const result = buildOpenRouter([openRouterEvent({
      modelId: null,
      routedProvider: null,
      requestId: null,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cost: 0.001,
        providerAttemptCount: 1,
      },
    })]);

    expect(result.metrics.usageComplete).toBe(true);
    expect(result.metrics.modelAttribution).toMatchObject({
      actualModelIds: [],
      routedProviders: [],
      requestIds: [],
    });
    expect(result.acceptance.authoritativeAttributionComplete).toBe(false);
    expect(result.acceptance.profileRoutingMatches).toBe(false);
  });

  it("preserves valid Bedrock baseline behavior without OpenRouter-only identifiers", () => {
    const modelId = "us.anthropic.claude-sonnet-4-6";
    const result = buildLegacyProjectChatModelTelemetry({
      provider: "bedrock",
      modelId,
      events: [{
        id: "bedrock-event",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          profile: "primary_answer",
          provider: "bedrock",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            providerAttemptCount: 1,
          },
        },
      }],
      dossierModelUsage: [],
      generationRuns: [],
      storedResult: {},
      expectedModelIdsByProfile: {
        primary_answer: modelId,
      },
    });

    expect(result.metrics.usageComplete).toBe(true);
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: true,
      noFallbackAttempts: true,
      profileRoutingMatches: true,
    });
  });
});
