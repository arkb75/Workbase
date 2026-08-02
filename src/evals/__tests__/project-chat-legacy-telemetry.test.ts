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
  it("accepts an authoritative deterministic result when no model was invoked", () => {
    const result = buildOpenRouter([]);

    expect(result.metrics).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 0,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {},
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: true,
      noFallbackAttempts: true,
      profileRoutingMatches: true,
    });
  });

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

  it("does not accept the OpenRouter gateway as the routed provider", () => {
    const result = buildOpenRouter([openRouterEvent({
      routedProvider: null,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cost: 0.001,
        providerAttemptCount: 1,
        provider: "openrouter",
        modelId: primaryModel,
        requestId: "request-primary",
      },
    })]);

    expect(result.metrics.modelAttribution).toMatchObject({
      providers: ["openrouter"],
      routedProviders: [],
      authoritativeAttributionComplete: false,
      profiles: {
        primary_answer: {
          authoritativeAttributionComplete: false,
        },
      },
    });
    expect(result.acceptance.authoritativeAttributionComplete).toBe(false);
  });

  it("rejects conflicting model identity within one provider call", () => {
    const fallbackModel = "anthropic/claude-sonnet-5";
    const result = buildOpenRouter([openRouterEvent({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cost: 0.001,
        providerAttemptCount: 1,
        modelId: fallbackModel,
        routedProvider: "openai",
        requestId: "request-primary",
      },
    })]);

    expect(result.metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      usageComplete: true,
      modelAttribution: {
        actualModelIds: [fallbackModel, primaryModel].sort(),
        fallbackUsed: true,
        authoritativeAttributionComplete: false,
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: false,
      noFallbackAttempts: false,
      profileRoutingMatches: false,
    });
  });

  it("rejects a partially attributed call even when another call in the profile is complete", () => {
    const complete = openRouterEvent();
    const partial = {
      ...openRouterEvent({
        iteration: 2,
        modelId: null,
        routedProvider: null,
        requestId: null,
        usage: {
          inputTokens: 80,
          outputTokens: 10,
          totalTokens: 90,
          cost: 0.0008,
          providerAttemptCount: 1,
        },
      }),
      id: "event-partial",
    };
    const result = buildOpenRouter([complete, partial]);

    expect(result.metrics).toMatchObject({
      modelCalls: 2,
      usageComplete: true,
      modelAttribution: {
        actualModelIds: [primaryModel],
        routedProviders: ["openai"],
        requestIds: ["request-primary"],
        authoritativeAttributionComplete: false,
        profiles: {
          primary_answer: {
            authoritativeAttributionComplete: false,
          },
        },
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: false,
      noFallbackAttempts: true,
      profileRoutingMatches: true,
    });
  });

  it("keeps conflicting duplicate-source model, fallback, and failure evidence", () => {
    const fallbackModel = "anthropic/claude-sonnet-5";
    const requestId = "request-shared";
    const result = buildLegacyProjectChatModelTelemetry({
      provider: "openrouter",
      modelId: primaryModel,
      events: [openRouterEvent({
        modelId: fallbackModel,
        routedProvider: "anthropic",
        requestId,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cost: 0.002,
          providerAttemptCount: 1,
          modelId: fallbackModel,
          routedProvider: "anthropic",
          requestId,
          failedAttempts: [{
            provider: "openrouter",
            modelId: primaryModel,
            requestId,
            httpStatus: 503,
          }],
        },
      })],
      dossierModelUsage: [],
      generationRuns: [{
        id: "generation-shared",
        status: "success",
        provider: "openrouter",
        modelId: primaryModel,
        idempotencyKey: null,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
        estimatedCostUsd: 0.001,
        resultRefs: {
          requestId,
          profile: "primary_answer",
          configuredModelId: primaryModel,
          auditAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
          routedProviders: ["openai"],
        },
        updatedAt: new Date(),
      }],
      storedResult: {},
      expectedModelIdsByProfile: {
        primary_answer: primaryModel,
      },
    });

    expect(result.metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      usageComplete: false,
      modelAttribution: {
        actualModelIds: [fallbackModel, primaryModel].sort(),
        routedProviders: ["anthropic", "openai"],
        failedModelIds: [primaryModel],
        failedProviderAttempts: 1,
        fallbackUsed: true,
        profiles: {
          primary_answer: {
            configuredRoutingMatched: false,
            fallbackUsed: true,
          },
        },
      },
    });
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: false,
      noFallbackAttempts: false,
      profileRoutingMatches: false,
    });
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
    expect(
      result.metrics.modelAttribution.authoritativeAttributionComplete,
    ).toBe(true);
    expect(result.acceptance).toEqual({
      authoritativeAttributionComplete: true,
      noFallbackAttempts: true,
      profileRoutingMatches: true,
    });
  });
});
