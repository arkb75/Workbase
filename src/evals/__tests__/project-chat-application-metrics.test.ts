import { describe, expect, it } from "vitest";
import {
  calculateApplicationModelMetrics,
  collectReferencedGenerationRunIds,
  selectScenarioGenerationRuns,
  type ApplicationGenerationRun,
} from "@/src/evals/project-chat-application-metrics";

const startedAt = new Date("2026-07-29T12:00:00.000Z");
const finishedAt = new Date("2026-07-29T12:01:00.000Z");

function generationRun(
  overrides: Partial<ApplicationGenerationRun> = {},
): ApplicationGenerationRun {
  return {
    id: "generation-1",
    status: "success",
    provider: "openrouter",
    modelId: "openai/gpt-5.6-terra",
    idempotencyKey: null,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    estimatedCostUsd: 0.001,
    resultRefs: {
      agentRunId: "agent-1",
      requestId: "request-1",
      auditAttemptCount: 1,
      unknownUsageAttempts: 0,
      usageComplete: true,
      knownEstimatedCostUsd: 0.001,
    },
    updatedAt: new Date("2026-07-29T12:00:30.000Z"),
    ...overrides,
  };
}

describe("application evaluator model telemetry", () => {
  it("counts completed event usage once while pairing its started event", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [
        {
          id: "event-start",
          message: "Reviewing the available project evidence.",
          payload: { modelEvent: "model_call_started", iteration: 1 },
        },
        {
          id: "event-complete",
          message: "Project evidence review completed.",
          payload: {
            modelEvent: "model_call_completed",
            iteration: 1,
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "request-event-1",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              costUsd: 0.001,
              providerAttemptCount: 1,
              costedAttemptCount: 1,
            },
          },
        },
      ],
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
      usageComplete: true,
    });
  });

  it("sums Bedrock per-call event usage without recounting aggregateUsage", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      generationRuns: [],
      dossierModelUsage: [],
      events: [
        {
          id: "bedrock-1",
          message: "Project evidence review completed.",
          payload: {
            modelEvent: "model_call_completed",
            iteration: 1,
            requestId: "bedrock-request-1",
            usage: {
              inputTokens: 1_000,
              outputTokens: 100,
              totalTokens: 1_100,
              providerAttemptCount: 1,
            },
            aggregateUsage: {
              inputTokens: 1_000,
              outputTokens: 100,
              totalTokens: 1_100,
            },
          },
        },
        {
          id: "bedrock-2",
          message: "Project evidence review completed.",
          payload: {
            modelEvent: "model_call_completed",
            iteration: 2,
            requestId: "bedrock-request-2",
            usage: {
              inputTokens: 2_000,
              outputTokens: 200,
              totalTokens: 2_200,
              providerAttemptCount: 1,
            },
            aggregateUsage: {
              inputTokens: 3_000,
              outputTokens: 300,
              totalTokens: 3_300,
            },
          },
        },
      ],
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      totalTokens: 3_300,
      estimatedCostUsd: 0.0135,
      usageComplete: true,
    });
  });

  it("keeps a failed unmetered provider attempt visible and incomplete", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [
        {
          id: "event-failed",
          message: "The model provider did not complete evidence review.",
          payload: {
            modelEvent: "model_call_failed",
            iteration: 1,
            provider: "openrouter",
            requestIds: [],
            providerStatus: 402,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              providerAttemptCount: 1,
              unknownUsageAttempts: 1,
            },
          },
        },
      ],
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: false,
    });
  });

  it("keeps a failed primary attempt rejecting after deterministic recovery", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "primary-failed",
        message: "The model provider did not complete the answer.",
        payload: {
          modelEvent: "model_call_failed",
          iteration: 1,
          profile: "primary_answer",
          provider: "openrouter",
          modelId: "openai/gpt-5.6-terra",
          requestIds: ["request-primary-failed"],
          providerStatus: 503,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            providerAttemptCount: 1,
            unknownUsageAttempts: 1,
          },
        },
      }],
      storedResult: {
        status: "answered",
        fallbackUsed: true,
        editorialFallbackUsed: true,
      },
      expectedModelIdsByProfile: {
        primary_answer: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      usageComplete: false,
      modelAttribution: {
        providerAttempts: 1,
        failedProviderAttempts: 1,
        fallbackUsed: false,
        profiles: {
          primary_answer: {
            providerAttempts: 1,
            failedProviderAttempts: 1,
            fallbackUsed: false,
          },
        },
      },
    });
  });

  it("requires authoritative cost for every OpenRouter attempt", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        usage: {
          attempts: [{
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
            cost: 0.0006,
          }],
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
        },
      }],
      events: [],
    });

    expect(metrics.modelCalls).toBe(2);
    expect(metrics.totalTokens).toBe(60);
    expect(metrics.estimatedCostUsd).toBe(0.0006);
    expect(metrics.usageComplete).toBe(false);
    expect(
      metrics.modelAttribution.profiles.unattributed.configuredRoutingMatched,
    ).toBe(false);
  });

  it("accepts the live audited artifact-verification usage shape", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        id: "generation-live-artifact-verification",
        idempotencyKey: "public-artifact-verification:artifact-run-live",
        tokenUsage: {
          auditUsageEvidenceVersion: 1,
          attempts: [{
            inputTokens: 500,
            outputTokens: 157,
            totalTokens: 657,
            cost: 0.00588,
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "gen-1785647202-E0dxEmPkhtNSwdnoTyLi",
            routedProvider: "Azure",
            providerAttemptCount: 1,
          }],
          providerAttemptCount: 1,
          unknownUsageAttempts: 0,
        },
        estimatedCostUsd: 0.00588,
        resultRefs: {
          agentRunId: "artifact-run-live",
          profile: "verification",
          configuredModelId: "openai/gpt-5.6-terra",
          requestId: "gen-1785647202-E0dxEmPkhtNSwdnoTyLi",
          routedProviders: ["Azure"],
          auditAttemptCount: 1,
          providerAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
          knownEstimatedCostUsd: 0.00588,
        },
      })],
      dossierModelUsage: [],
      events: [],
      expectedModelIdsByProfile: {
        verification: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 657,
      estimatedCostUsd: 0.00588,
      usageComplete: true,
      modelAttribution: {
        providers: ["openrouter"],
        actualModelIds: ["openai/gpt-5.6-terra"],
        routedProviders: ["Azure"],
        requestIds: ["gen-1785647202-E0dxEmPkhtNSwdnoTyLi"],
        providerAttempts: 1,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {
          verification: {
            providerAttempts: 1,
            totalTokens: 657,
            estimatedCostUsd: 0.00588,
            usageComplete: true,
            authoritativeAttributionComplete: true,
            configuredRoutingMatched: true,
          },
        },
      },
    });
  });

  it("keeps complete per-attempt cost and identity across audited idempotent retries", () => {
    const attempts = [
      {
        inputTokens: 500,
        outputTokens: 157,
        totalTokens: 657,
        cost: 0.00588,
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        requestId: "gen-audited-prior",
        routedProvider: "Azure",
        providerAttemptCount: 1,
      },
      {
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
        cost: 0.002,
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        requestId: "gen-audited-current",
        routedProvider: "Azure",
        providerAttemptCount: 1,
      },
    ];
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        id: "generation-audited-retry",
        tokenUsage: {
          auditUsageEvidenceVersion: 1,
          attempts,
          providerAttemptCount: 2,
          unknownUsageAttempts: 0,
        },
        estimatedCostUsd: 0.00788,
        resultRefs: {
          agentRunId: "artifact-run-retry",
          profile: "verification",
          configuredModelId: "openai/gpt-5.6-terra",
          requestId: "gen-audited-current",
          requestIds: ["gen-audited-prior", "gen-audited-current"],
          routedProviders: ["Azure"],
          auditAttemptCount: 2,
          providerAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
          knownEstimatedCostUsd: 0.00788,
        },
      })],
      dossierModelUsage: [],
      events: [],
      expectedModelIdsByProfile: {
        verification: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      totalTokens: 897,
      estimatedCostUsd: 0.00788,
      usageComplete: true,
      modelAttribution: {
        requestIds: ["gen-audited-current", "gen-audited-prior"],
        providerAttempts: 2,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {
          verification: {
            providerAttempts: 2,
            totalTokens: 897,
            estimatedCostUsd: 0.00788,
            usageComplete: true,
            authoritativeAttributionComplete: true,
          },
        },
      },
    });
  });

  it("keeps a costed audited attempt incomplete when a later attempt has unknown usage", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        id: "generation-audited-unknown-retry",
        status: "provider_error",
        tokenUsage: {
          auditUsageEvidenceVersion: 1,
          attempts: [
            {
              inputTokens: 500,
              outputTokens: 157,
              totalTokens: 657,
              cost: 0.00588,
              provider: "openrouter",
              modelId: "openai/gpt-5.6-terra",
              requestId: "gen-known",
              routedProvider: "Azure",
              providerAttemptCount: 1,
            },
            {
              attempts: [],
              failedAttempts: [{
                provider: "openrouter",
                modelId: "openai/gpt-5.6-terra",
                requestId: "gen-unknown",
                status: "provider_error",
                httpStatus: 503,
                retryable: true,
              }],
              providerAttemptCount: 1,
              unknownUsageAttempts: 1,
            },
          ],
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
        },
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "artifact-run-unknown",
          profile: "verification",
          configuredModelId: "openai/gpt-5.6-terra",
          auditAttemptCount: 2,
          providerAttemptCount: 1,
          unknownUsageAttempts: 1,
          usageComplete: false,
          knownEstimatedCostUsd: 0.00588,
          failedProviderAttempts: [{
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "gen-unknown",
            status: "provider_error",
            httpStatus: 503,
            retryable: true,
          }],
        },
      })],
      dossierModelUsage: [],
      events: [],
      expectedModelIdsByProfile: {
        verification: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      totalTokens: 657,
      estimatedCostUsd: 0.00588,
      usageComplete: false,
      modelAttribution: {
        requestIds: ["gen-known", "gen-unknown"],
        providerAttempts: 2,
        fallbackUsed: false,
        authoritativeAttributionComplete: false,
        profiles: {
          verification: {
            providerAttempts: 2,
            totalTokens: 657,
            estimatedCostUsd: 0.00588,
            usageComplete: false,
            authoritativeAttributionComplete: false,
          },
        },
      },
    });
    expect(metrics.modelAttribution.failedProviderAttempts).toBeGreaterThan(0);
  });

  it("keeps deterministic dossier phases at zero calls", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-nano",
        modelInvoked: false,
        usage: null,
      }],
      events: [],
    });

    expect(metrics).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      modelAttribution: {
        configuredModelIds: [],
        actualModelIds: [],
        providerAttempts: 0,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
      },
    });
  });

  it("keeps an explicitly invoked dossier phase visible when usage is missing", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "project_fact_extraction",
        profile: "code_extraction",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-mini",
        modelInvoked: true,
        fallbackUsed: false,
        usage: null,
      }],
      events: [],
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: false,
      modelAttribution: {
        providerAttempts: 1,
        failedProviderAttempts: 1,
        fallbackUsed: false,
        profiles: {
          code_extraction: {
            providerAttempts: 1,
            usageComplete: false,
          },
        },
      },
    });
  });

  it("attributes a specialized dossier profile without flagging it as fallback", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-nano",
        modelInvoked: true,
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          cost: 0.00002,
          requestId: "request-routing",
          modelId: "openai/gpt-5.4-nano",
          routedProvider: "openai",
          providerAttemptCount: 1,
        },
      }],
      events: [],
    });

    expect(metrics.modelAttribution).toMatchObject({
      configuredModelIds: ["openai/gpt-5.4-nano"],
      actualModelIds: ["openai/gpt-5.4-nano"],
      routedProviders: ["openai"],
      requestIds: ["request-routing"],
      providerAttempts: 1,
      failedProviderAttempts: 0,
      fallbackUsed: false,
    });
    expect(metrics.usageComplete).toBe(true);
  });

  it("requires an explicit OpenRouter gateway identity for an invoked event", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "missing-provider",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          profile: "primary_answer",
          modelId: "openai/gpt-5.6-terra",
          requestId: "request-missing-provider",
          routedProvider: "openai",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cost: 0.001,
            providerAttemptCount: 1,
            modelId: "openai/gpt-5.6-terra",
            routedProvider: "openai",
            requestId: "request-missing-provider",
          },
        },
      }],
    });

    expect(metrics.usageComplete).toBe(true);
    expect(metrics.modelAttribution).toMatchObject({
      providers: [],
      authoritativeAttributionComplete: false,
      profiles: {
        primary_answer: {
          authoritativeAttributionComplete: false,
        },
      },
    });
  });

  it("rejects OpenRouter itself as the routed upstream provider", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-nano",
        modelInvoked: true,
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cost: 0.0001,
          providerAttemptCount: 1,
          modelId: "openai/gpt-5.4-nano",
          routedProvider: "openrouter",
          requestId: "request-gateway-route",
        },
      }],
      events: [],
      expectedModelIdsByProfile: {
        routing: "openai/gpt-5.4-nano",
      },
    });

    expect(metrics.usageComplete).toBe(true);
    expect(metrics.modelAttribution).toMatchObject({
      routedProviders: ["openrouter"],
      authoritativeAttributionComplete: false,
      profiles: {
        routing: {
          authoritativeAttributionComplete: false,
        },
      },
    });
  });

  it("requires one unique request identity per provider attempt", () => {
    const repeatedAttempt = {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cost: 0.0005,
      modelId: "openai/gpt-5.6-terra",
      routedProvider: "openai",
      requestId: "request-reused",
    };
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "reused-request-id",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          profile: "primary_answer",
          provider: "openrouter",
          modelId: "openai/gpt-5.6-terra",
          requestId: "request-reused",
          usage: {
            attempts: [{ ...repeatedAttempt }, { ...repeatedAttempt }],
            providerAttemptCount: 2,
            unknownUsageAttempts: 0,
          },
        },
      }],
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      usageComplete: true,
      modelAttribution: {
        requestIds: ["request-reused"],
        authoritativeAttributionComplete: false,
        profiles: {
          primary_answer: {
            providerAttempts: 2,
            authoritativeAttributionComplete: false,
          },
        },
      },
    });
  });

  it("rejects a request identity reused by separate event attempts", () => {
    const event = (id: string, iteration: number) => ({
      id,
      message: "Project evidence review completed.",
      payload: {
        modelEvent: "model_call_completed",
        iteration,
        profile: "primary_answer",
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        routedProvider: "openai",
        requestId: "request-reused-across-events",
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 60,
          cost: 0.0005,
          providerAttemptCount: 1,
          modelId: "openai/gpt-5.6-terra",
          routedProvider: "openai",
          requestId: "request-reused-across-events",
        },
      },
    });
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [event("first-event", 1), event("second-event", 2)],
    });

    expect(metrics.modelAttribution).toMatchObject({
      requestIds: ["request-reused-across-events"],
      authoritativeAttributionComplete: false,
      profiles: {
        primary_answer: {
          authoritativeAttributionComplete: false,
        },
      },
    });
  });

  it("does not promote aggregate generation cost to per-attempt cost", () => {
    const usageAttempt = (requestId: string) => ({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      modelId: "openai/gpt-5.6-terra",
      routedProvider: "openai",
      requestId,
    });
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        tokenUsage: {
          attempts: [
            usageAttempt("request-aggregate-cost-1"),
            usageAttempt("request-aggregate-cost-2"),
          ],
          cost: 0.002,
          costedAttemptCount: 2,
          providerAttemptCount: 2,
        },
        estimatedCostUsd: 0.002,
        resultRefs: {
          profile: "primary_answer",
          configuredModelId: "openai/gpt-5.6-terra",
          auditAttemptCount: 2,
          unknownUsageAttempts: 0,
          usageComplete: true,
          routedProviders: ["openai"],
        },
      })],
      dossierModelUsage: [],
      events: [],
      expectedModelIdsByProfile: {
        primary_answer: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      estimatedCostUsd: 0.002,
      usageComplete: false,
      modelAttribution: {
        authoritativeAttributionComplete: true,
        profiles: {
          primary_answer: {
            usageComplete: false,
          },
        },
      },
    });
  });

  it("deduplicates one provider request represented by a run and an event", () => {
    const run = generationRun();
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [run, run],
      dossierModelUsage: [],
      events: [{
        id: "duplicate-event",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          provider: "openrouter",
          requestId: "request-1",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            costUsd: 0.001,
            providerAttemptCount: 1,
            costedAttemptCount: 1,
          },
        },
      }],
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
      usageComplete: true,
    });
  });

  it("counts duplicate usage once without reconciling conflicting model identity", () => {
    const requestId = "request-conflicting-duplicate";
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        resultRefs: {
          requestId,
          profile: "primary_answer",
          configuredModelId: "openai/gpt-5.6-terra",
          routedProviders: ["openai"],
          auditAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
        },
      })],
      dossierModelUsage: [],
      events: [{
        id: "conflicting-duplicate-event",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          profile: "primary_answer",
          provider: "openrouter",
          modelId: "anthropic/claude-sonnet-5",
          routedProvider: "anthropic",
          requestId,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cost: 0.001,
            providerAttemptCount: 1,
            modelId: "anthropic/claude-sonnet-5",
            routedProvider: "anthropic",
            requestId,
          },
        },
      }],
      expectedModelIdsByProfile: {
        primary_answer: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
      usageComplete: true,
      modelAttribution: {
        actualModelIds: [
          "anthropic/claude-sonnet-5",
          "openai/gpt-5.6-terra",
        ],
        routedProviders: ["anthropic", "openai"],
        fallbackUsed: true,
        authoritativeAttributionComplete: false,
        profiles: {
          primary_answer: {
            fallbackUsed: true,
            configuredRoutingMatched: false,
            authoritativeAttributionComplete: false,
          },
        },
      },
    });
  });

  it("keeps a same-model failed attempt from a duplicate telemetry source", () => {
    const requestId = "request-failed-duplicate";
    const completeUsage = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cost: 0.001,
      providerAttemptCount: 1,
      modelId: "openai/gpt-5.6-terra",
      routedProvider: "openai",
      requestId,
    };
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        tokenUsage: completeUsage,
        resultRefs: {
          requestId,
          profile: "primary_answer",
          configuredModelId: "openai/gpt-5.6-terra",
          routedProviders: ["openai"],
          auditAttemptCount: 1,
          unknownUsageAttempts: 0,
          usageComplete: true,
        },
      })],
      dossierModelUsage: [],
      events: [{
        id: "failed-duplicate-event",
        message: "Project evidence review completed.",
        payload: {
          modelEvent: "model_call_completed",
          iteration: 1,
          profile: "primary_answer",
          provider: "openrouter",
          modelId: "openai/gpt-5.6-terra",
          routedProvider: "openai",
          requestId,
          usage: {
            ...completeUsage,
            failedAttempts: [{
              provider: "openrouter",
              modelId: "openai/gpt-5.6-terra",
              requestId,
              httpStatus: 503,
            }],
          },
        },
      }],
      expectedModelIdsByProfile: {
        primary_answer: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      estimatedCostUsd: 0.001,
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 1,
        failedProviderAttempts: 1,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {
          primary_answer: {
            failedProviderAttempts: 1,
            fallbackUsed: false,
            authoritativeAttributionComplete: true,
          },
        },
      },
    });
  });

  it("exposes actual fallback attribution without prompt or response content", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        modelId: "anthropic/claude-sonnet-5",
        tokenUsage: {
          attempts: [{
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cost: 0.002,
            requestId: "request-fallback",
            modelId: "anthropic/claude-sonnet-5",
            routedProvider: "anthropic",
          }],
          failedAttempts: [{
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "request-primary",
            httpStatus: 503,
          }],
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
        },
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          configuredModelId: "openai/gpt-5.6-terra",
          auditAttemptCount: 2,
          unknownUsageAttempts: 1,
          usageComplete: false,
          knownEstimatedCostUsd: 0.002,
        },
      })],
      dossierModelUsage: [],
      events: [],
    });

    expect(metrics.modelAttribution).toEqual({
      providers: ["openrouter"],
      configuredModelIds: ["openai/gpt-5.6-terra"],
      actualModelIds: ["anthropic/claude-sonnet-5"],
      routedProviders: ["anthropic"],
      requestIds: ["request-fallback", "request-primary"],
      failedModelIds: ["openai/gpt-5.6-terra"],
      providerAttempts: 2,
      failedProviderAttempts: 1,
      fallbackUsed: true,
      authoritativeAttributionComplete: false,
      profiles: {
        unattributed: {
          providers: ["openrouter"],
          configuredModelIds: ["openai/gpt-5.6-terra"],
          expectedModelIds: ["openai/gpt-5.6-terra"],
          actualModelIds: ["anthropic/claude-sonnet-5"],
          providerAttempts: 2,
          failedProviderAttempts: 1,
          totalTokens: 120,
          estimatedCostUsd: 0.002,
          usageComplete: false,
          fallbackUsed: true,
          configuredRoutingMatched: false,
          authoritativeAttributionComplete: false,
        },
      },
    });
    expect(metrics.usageComplete).toBe(false);
    expect(metrics.estimatedCostUsd).toBe(0.002);
  });

  it("does not classify stored deterministic completion as a model fallback", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [],
      storedResult: {
        status: "answered",
        fallbackUsed: true,
      },
      expectedModelIdsByProfile: {
        primary_answer: "openai/gpt-5.6-terra",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      modelAttribution: {
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {},
      },
    });
  });

  it("does not classify a deterministic execution-router choice as a model fallback", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "route-result",
        message: null,
        toolName: "route_project_execution",
        payload: {
          mode: "memory_answer",
          fallbackUsed: true,
        },
      }],
      storedResult: {
        status: "answered",
        fallbackUsed: false,
      },
    });

    expect(metrics.modelAttribution).toMatchObject({
      providerAttempts: 0,
      failedProviderAttempts: 0,
      fallbackUsed: false,
      authoritativeAttributionComplete: true,
      profiles: {},
    });
  });

  it("reproduces a live mixed report without treating zero-call profiles as model fallbacks", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      generationRuns: [],
      dossierModelUsage: [],
      events: [
        {
          id: "route-result",
          message: null,
          toolName: "route_project_execution",
          payload: {
            mode: "memory_answer",
            fallbackUsed: true,
          },
        },
        {
          id: "verification-complete",
          message: "Project evidence review completed.",
          payload: {
            modelEvent: "model_call_completed",
            iteration: 1,
            profile: "verification",
            provider: "bedrock",
            modelId: "us.anthropic.claude-sonnet-4-6",
            requestId: "bedrock-verification-request",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              providerAttemptCount: 1,
            },
          },
        },
      ],
      storedResult: {
        status: "answered",
        fallbackUsed: true,
      },
      expectedModelIdsByProfile: {
        primary_answer: "us.anthropic.claude-sonnet-4-6",
        routing: "us.anthropic.claude-sonnet-4-6",
        verification: "us.anthropic.claude-sonnet-4-6",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 120,
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 1,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
        profiles: {
          verification: {
            providerAttempts: 1,
            fallbackUsed: false,
            configuredRoutingMatched: true,
          },
        },
      },
    });
  });

  it("does not classify editorial recovery after a configured model success as model fallback", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-nano",
        modelInvoked: true,
        editorialFallbackUsed: true,
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cost: 0.00001,
          requestId: "request-routing-fallback",
          modelId: "openai/gpt-5.4-nano",
          routedProvider: "openai",
          providerAttemptCount: 1,
        },
      }],
      events: [],
      expectedModelIdsByProfile: {
        routing: "openai/gpt-5.4-nano",
      },
    });

    expect(metrics).toMatchObject({
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 1,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        profiles: {
          routing: {
            providerAttempts: 1,
            fallbackUsed: false,
          },
        },
      },
    });
  });

  it("keeps verifier recovery diagnostics out of model-provider fallback attribution", () => {
    const input = {
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "verification-result",
        message: null,
        toolName: "verify_project_answer",
        payload: {
          verifier: { status: "success" },
          fallback: {
            attempted: false,
            candidateBlockCount: 0,
            acceptedBlockCount: 0,
          },
        },
      }],
    };

    expect(
      calculateApplicationModelMetrics(input).modelAttribution.fallbackUsed,
    ).toBe(false);
    expect(calculateApplicationModelMetrics({
      ...input,
      events: [{
        ...input.events[0],
        payload: {
          verifier: { status: "failed" },
          fallback: {
            attempted: true,
            candidateBlockCount: 2,
            acceptedBlockCount: 0,
          },
        },
      }],
    }).modelAttribution).toMatchObject({
      providerAttempts: 0,
      fallbackUsed: false,
      profiles: {},
    });
  });

  it("detects a fully metered dossier model fallback across every actual model", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "openai/gpt-5.4-nano",
        modelInvoked: true,
        usage: {
          attempts: [
            {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              cost: 0.00001,
              requestId: "request-primary",
              modelId: "openai/gpt-5.4-nano",
              routedProvider: "openai",
            },
            {
              inputTokens: 30,
              outputTokens: 10,
              totalTokens: 40,
              cost: 0.0002,
              requestId: "request-fallback",
              modelId: "anthropic/claude-sonnet-5",
              routedProvider: "anthropic",
            },
          ],
          failedAttempts: [{
            provider: "openrouter",
            modelId: "openai/gpt-5.4-nano",
            requestId: "request-primary",
            httpStatus: 503,
          }],
          providerAttemptCount: 2,
          unknownUsageAttempts: 0,
        },
      }],
      events: [],
      expectedModelIdsByProfile: {
        routing: "openai/gpt-5.4-nano",
      },
    });

    expect(metrics).toMatchObject({
      modelCalls: 2,
      totalTokens: 65,
      estimatedCostUsd: 0.00021,
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 2,
        failedProviderAttempts: 1,
        fallbackUsed: true,
        profiles: {
          routing: {
            configuredModelIds: ["openai/gpt-5.4-nano"],
            expectedModelIds: ["openai/gpt-5.4-nano"],
            actualModelIds: [
              "anthropic/claude-sonnet-5",
              "openai/gpt-5.4-nano",
            ],
            providerAttempts: 2,
            failedProviderAttempts: 1,
            usageComplete: true,
            fallbackUsed: true,
            configuredRoutingMatched: false,
          },
        },
      },
    });
    expect(metrics.modelAttribution.failedProviderAttempts).toBeLessThanOrEqual(
      metrics.modelAttribution.providerAttempts,
    );
  });

  it("flags a swapped profile even when its reported configured and actual model agree", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [],
      dossierModelUsage: [{
        phase: "planning",
        profile: "routing",
        provider: "openrouter",
        configuredModelId: "anthropic/claude-sonnet-5",
        modelInvoked: true,
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cost: 0.0001,
          requestId: "request-misrouted",
          modelId: "anthropic/claude-sonnet-5",
          providerAttemptCount: 1,
        },
      }],
      events: [],
      expectedModelIdsByProfile: {
        routing: "openai/gpt-5.4-nano",
      },
    });

    expect(metrics.usageComplete).toBe(true);
    expect(metrics.modelAttribution.fallbackUsed).toBe(false);
    expect(metrics.modelAttribution.profiles.routing).toMatchObject({
      configuredModelIds: ["anthropic/claude-sonnet-5"],
      expectedModelIds: ["openai/gpt-5.4-nano"],
      actualModelIds: ["anthropic/claude-sonnet-5"],
      configuredRoutingMatched: false,
    });
  });

  it("deduplicates a real nested OpenRouter fallback failure shape", () => {
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
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        status: "provider_error",
        modelId: "openai/gpt-5.4-nano",
        tokenUsage: {
          attempts: [{
            attempts: [],
            failedAttempts: [primaryFailure, fallbackFailure],
            providerAttemptCount: 2,
            unknownUsageAttempts: 2,
          }],
          failedAttempts: [primaryFailure, fallbackFailure],
          providerAttemptCount: 2,
          unknownUsageAttempts: 2,
        },
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          profile: "routing",
          configuredModelId: "openai/gpt-5.4-nano",
          auditAttemptCount: 2,
          unknownUsageAttempts: 2,
          usageComplete: false,
        },
      })],
      dossierModelUsage: [],
      events: [],
    });

    expect(metrics.modelAttribution).toMatchObject({
      providerAttempts: 2,
      failedProviderAttempts: 2,
      fallbackUsed: true,
    });
    expect(metrics.modelAttribution.failedProviderAttempts).toBeLessThanOrEqual(
      metrics.modelAttribution.providerAttempts,
    );
  });

  it("does not turn deterministic generation bookkeeping into a model call", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        provider: "workbase",
        modelId: "heuristic-retrieval",
        tokenUsage: null,
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          auditAttemptCount: 0,
          unknownUsageAttempts: 0,
          usageComplete: true,
        },
      })],
      dossierModelUsage: [],
      events: [],
    });

    expect(metrics).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
    });
  });

  it("keeps a pre-dispatch admission failure at zero provider calls", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      generationRuns: [generationRun({
        status: "provider_error",
        tokenUsage: null,
        estimatedCostUsd: null,
        resultRefs: {
          agentRunId: "agent-1",
          admissionFailure: true,
          auditAttemptCount: 0,
          unknownUsageAttempts: 0,
          usageComplete: true,
          knownEstimatedCostUsd: null,
        },
      })],
      dossierModelUsage: [],
      events: [],
    });

    expect(metrics).toMatchObject({
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      modelAttribution: {
        providerAttempts: 0,
        failedProviderAttempts: 0,
        fallbackUsed: false,
      },
    });
  });

  it("does not report a started model call as a complete zero-call path", () => {
    const metrics = calculateApplicationModelMetrics({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      generationRuns: [],
      dossierModelUsage: [],
      events: [{
        id: "start-without-terminal-event",
        message: "Reviewing the available project evidence.",
        payload: { modelEvent: "model_call_started", iteration: 1 },
      }],
    });

    expect(metrics).toMatchObject({
      modelCalls: 1,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: false,
    });
  });
});

describe("application evaluator generation-run attribution", () => {
  it("uses durable linkage and the update window without admitting background work", () => {
    const referenced = collectReferencedGenerationRunIds({
      generationRunIds: {
        generation: ["generation-result"],
        verification: "generation-verification",
      },
    });
    const selected = selectScenarioGenerationRuns({
      generationRuns: [
        generationRun(),
        generationRun({
          id: "generation-refresh",
          idempotencyKey: "semantic:refresh-1:src/service.ts",
          resultRefs: null,
        }),
        generationRun({
          id: "generation-result",
          resultRefs: null,
        }),
        generationRun({
          id: "generation-background",
          resultRefs: null,
          idempotencyKey: "semantic:other-refresh:src/background.ts",
        }),
        generationRun({
          id: "generation-stale",
          resultRefs: { agentRunId: "agent-1" },
          updatedAt: new Date("2026-07-29T11:59:59.999Z"),
        }),
      ],
      runId: "agent-1",
      refreshRunId: "refresh-1",
      referencedGenerationRunIds: referenced,
      startedAt,
      finishedAt,
    });

    expect(selected.map((run) => run.id).sort()).toEqual([
      "generation-1",
      "generation-refresh",
      "generation-result",
    ]);
    expect(referenced).toEqual(new Set([
      "generation-result",
      "generation-verification",
    ]));
  });
});
