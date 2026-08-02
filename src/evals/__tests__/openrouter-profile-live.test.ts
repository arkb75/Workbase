import {
  buildOpenRouterProfileEvaluationReport,
  buildOpenRouterProfileTelemetry,
  OPENROUTER_PROFILE_EVAL_SCHEMA_VERSION,
  type OpenRouterProfileConfigSummary,
  type OpenRouterProfileObservation,
  type OpenRouterProfileScenarioId,
} from "@/src/evals/openrouter-profile-live";
import {
  textModelProfiles,
  type TextModelProfile,
} from "@/src/lib/llm-config";
import { describe, expect, it } from "vitest";

const primaryModel = "openai/test-primary";
const fallbackModel = "anthropic/test-fallback";

function profileConfigs() {
  return Object.fromEntries(
    textModelProfiles.map((profile) => [
      profile,
      {
        configuredModelId: primaryModel,
        configuredFallbackModelId: fallbackModel,
      },
    ]),
  ) as Record<TextModelProfile, OpenRouterProfileConfigSummary>;
}

function liveUsage(
  id: OpenRouterProfileScenarioId,
  overrides: Record<string, unknown> = {},
) {
  return {
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    totalTokens: 15,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    cost: 0.001,
    providerAttemptCount: 1,
    requestId: `req-${id}`,
    modelId: primaryModel,
    routedProvider: "TestProvider",
    ...overrides,
  };
}

function validValue(id: OpenRouterProfileScenarioId): unknown {
  switch (id) {
    case "primary_answer":
      return {
        text: [
          "Repository refresh operates from a pinned snapshot before analysis, preserving a stable revision boundary. [citation:1]",
          "Grounded project-chat answers connect implementation statements to approved project memory. [citation:2]",
          "The supplied evidence says p95 is unavailable because no latency percentile measurement was provided. [citation:3]",
        ].join("\n\n"),
      };
    case "deep_synthesis":
      return {
        data: {
          subsystems: [
            {
              subsystemKey: "ai_runtime",
              facts: [{ citationIndexes: [1] }],
              highlights: [{ citationIndexes: [2] }],
            },
            {
              subsystemKey: "repository_knowledge_lifecycle",
              facts: [{ citationIndexes: [1, 2] }],
              highlights: [],
            },
          ],
        },
        notebookSizes: {
          ai_runtime: 2,
          repository_knowledge_lifecycle: 2,
        },
      };
    case "verification":
      return {
        data: {
          results: [
            {
              claimIndex: 0,
              shouldFlag: true,
              unsupportedImpactWarning: true,
              revisedText: "Configured privacy-aware model routing.",
            },
          ],
        },
      };
    case "drafting":
      return {
        data: {
          content:
            "Implemented configurable, privacy-aware model routing for specialized Workbase AI tasks.",
          usedHighlightIds: ["hl_runtime"],
          supportingEvidenceItemIds: [],
        },
      };
    case "code_extraction":
      return {
        analysis: {
          semanticSource: "model",
          facts: [
            {
              lineStart: 2,
              lineEnd: 4,
              subsystemKeys: ["ai_runtime"],
            },
          ],
        },
        allowedLines: [1, 2, 3, 4, 5],
      };
    case "routing":
      return {
        raw: {
          mode: "insufficient_context",
          suggestedWorkerCount: 0,
        },
        enforced: {
          mode: "insufficient_context",
          suggestedWorkerCount: 0,
          fallbackUsed: true,
        },
      };
    case "json_repair": {
      const usage = {
        attempts: [
          {
            ...liveUsage(id, {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              cost: 0,
              providerAttemptCount: 0,
              requestId: "local-fixture",
              modelId: "local-malformed-fixture",
              routedProvider: "local",
            }),
            localFixture: true,
          },
          liveUsage(id),
        ],
      };
      return {
        data: { status: "repaired", count: 2 },
        localFixtureAttempts: 1,
        rawUsageForQualityCheck: usage,
      };
    }
  }
}

function validObservation(
  id: OpenRouterProfileScenarioId,
): OpenRouterProfileObservation {
  const value = validValue(id);
  const rawUsage = id === "json_repair"
    ? (value as { rawUsageForQualityCheck: unknown }).rawUsageForQualityCheck
    : liveUsage(id);
  return {
    id,
    profile: id,
    latencyMs: 20,
    value,
    usage: rawUsage,
    metadata: { provider: "openrouter" },
  };
}

function validObservations() {
  return textModelProfiles.map((profile) => validObservation(profile));
}

function buildReport(observations = validObservations()) {
  return buildOpenRouterProfileEvaluationReport({
    label: "specialized profile validation",
    gitCommit: "1234567890abcdef",
    profiles: profileConfigs(),
    observations,
  });
}

describe("OpenRouter profile live evaluation report", () => {
  it("aggregates nested live usage without double counting wrapper objects", () => {
    const observation = validObservation("deep_synthesis");
    observation.usage = {
      attempts: [
        liveUsage("deep_synthesis", {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cost: 0.001,
          requestId: "req-one",
        }),
        liveUsage("deep_synthesis", {
          inputTokens: 20,
          outputTokens: 3,
          totalTokens: 23,
          cost: 0.002,
          requestId: "req-two",
        }),
      ],
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    };

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().deep_synthesis,
    });

    expect(telemetry).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      providerAttempts: 2,
      authoritativeCostUsd: 0.003,
      usageComplete: true,
    });
  });

  it("marks missing cost and unknown attempts incomplete", () => {
    const missingCost = validObservation("verification");
    missingCost.usage = liveUsage("verification", { cost: undefined });
    const unknownAttempt = validObservation("drafting");
    unknownAttempt.usage = {
      attempts: [liveUsage("drafting")],
      unknownUsageAttempts: 1,
      providerAttemptCount: 2,
    };

    expect(
      buildOpenRouterProfileTelemetry({
        observation: missingCost,
        config: profileConfigs().verification,
      }),
    ).toMatchObject({
      usageComplete: false,
      authoritativeCostUsd: null,
      knownCostLowerBoundUsd: null,
    });
    expect(
      buildOpenRouterProfileTelemetry({
        observation: unknownAttempt,
        config: profileConfigs().drafting,
      }),
    ).toMatchObject({
      usageComplete: false,
      unknownUsageAttempts: 1,
      authoritativeCostUsd: null,
      knownCostLowerBoundUsd: 0.001,
    });
  });

  it("rejects fallback and failed-provider contamination", () => {
    const fallback = validObservation("primary_answer");
    fallback.usage = liveUsage("primary_answer", {
      modelId: fallbackModel,
    });
    const failed = validObservation("routing");
    failed.usage = {
      attempts: [liveUsage("routing")],
      failedAttempts: [
        {
          provider: "openrouter",
          modelId: primaryModel,
          requestId: "req-failed",
          status: "provider_error",
          httpStatus: 503,
        },
      ],
      providerAttemptCount: 2,
    };

    expect(
      buildOpenRouterProfileTelemetry({
        observation: fallback,
        config: profileConfigs().primary_answer,
      }),
    ).toMatchObject({
      fallbackUsed: true,
      usageComplete: false,
      authoritativeCostUsd: null,
    });
    expect(
      buildOpenRouterProfileTelemetry({
        observation: failed,
        config: profileConfigs().routing,
      }),
    ).toMatchObject({
      failedProviderAttempts: 1,
      usageComplete: false,
      authoritativeCostUsd: null,
    });
  });

  it("excludes the local malformed fixture from attempts, tokens, cost, and IDs", () => {
    const observation = validObservation("json_repair");
    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().json_repair,
    });

    expect(telemetry).toMatchObject({
      providerAttempts: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      authoritativeCostUsd: 0.001,
      usageComplete: true,
    });
    expect(telemetry.requestIds).toEqual(["req-json_repair"]);
    expect(telemetry.actualModelIds).toEqual([primaryModel]);
    expect(telemetry.routedProviders).toEqual(["TestProvider"]);
  });

  it("passes complete safe fixtures for every production profile", () => {
    const report = buildReport();

    expect(report.schemaVersion).toBe(
      OPENROUTER_PROFILE_EVAL_SCHEMA_VERSION,
    );
    expect(report.passed).toBe(true);
    expect(report.aggregate).toMatchObject({
      providerAttempts: 7,
      inputTokens: 70,
      outputTokens: 35,
      reasoningTokens: 14,
      totalTokens: 105,
      authoritativeCostUsd: 0.007,
      knownCostLowerBoundUsd: 0.007,
      usageComplete: true,
    });
    expect(report.scenarios).toHaveLength(7);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
  });

  it("rejects an authoritative model that differs from the configured profile", () => {
    const observations = validObservations();
    const routing = observations.find(
      (observation) => observation.id === "routing",
    )!;
    routing.usage = liveUsage("routing", {
      modelId: "openai/unexpected-routing-model",
    });

    const report = buildReport(observations);
    const scenario = report.scenarios.find(
      (entry) => entry.id === "routing",
    )!;

    expect(scenario.telemetry).toMatchObject({
      actualModelIds: ["openai/unexpected-routing-model"],
      usageComplete: true,
      fallbackUsed: false,
    });
    expect(scenario.passed).toBe(false);
    expect(scenario.checks).toContainEqual({
      id: "actual_model_matches_configured_profile",
      passed: false,
    });
    expect(report.passed).toBe(false);
  });

  it("rejects an invoked profile whose authoritative model identity is missing", () => {
    const observations = validObservations();
    const drafting = observations.find(
      (observation) => observation.id === "drafting",
    )!;
    drafting.usage = liveUsage("drafting", {
      modelId: undefined,
    });

    const report = buildReport(observations);
    const scenario = report.scenarios.find(
      (entry) => entry.id === "drafting",
    )!;

    expect(scenario.telemetry.providerAttempts).toBe(1);
    expect(scenario.telemetry.actualModelIds).toEqual([]);
    expect(scenario.passed).toBe(false);
    expect(scenario.checks).toContainEqual({
      id: "actual_model_matches_configured_profile",
      passed: false,
    });
  });

  it("does not accept the OpenRouter gateway as the routed provider", () => {
    const observations = validObservations();
    const primary = observations.find(
      (observation) => observation.id === "primary_answer",
    )!;
    primary.usage = liveUsage("primary_answer", {
      routedProvider: undefined,
      provider: "openrouter",
    });

    const report = buildReport(observations);
    const scenario = report.scenarios.find(
      (entry) => entry.id === "primary_answer",
    )!;

    expect(scenario.telemetry).toMatchObject({
      providers: ["openrouter"],
      routedProviders: [],
      usageComplete: false,
      authoritativeCostUsd: null,
    });
    expect(scenario.passed).toBe(false);
    expect(scenario.checks).toContainEqual({
      id: "usage_telemetry_is_complete",
      passed: false,
    });
  });

  it("requires an explicit OpenRouter gateway identity", () => {
    const observation = validObservation("primary_answer");
    observation.metadata = undefined;

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().primary_answer,
    });

    expect(telemetry).toMatchObject({
      providers: [],
      usageComplete: false,
      authoritativeCostUsd: null,
    });
  });

  it("accepts the paid code-extraction usage leaf without separate result metadata", () => {
    const observation = validObservation("code_extraction");
    observation.metadata = undefined;
    observation.usage = {
      inputTokens: 2_737,
      outputTokens: 667,
      reasoningTokens: 0,
      totalTokens: 3_404,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      provider: "openrouter",
      cost: 0.0168475,
      requestId: "gen-test-code-extraction-terra-1",
      modelId: "openai/gpt-5.6-terra",
      routedProvider: "Azure",
      providerAttemptCount: 1,
    };

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: {
        configuredModelId: "openai/gpt-5.6-terra",
        configuredFallbackModelId: null,
      },
    });

    expect(telemetry).toMatchObject({
      actualModelIds: ["openai/gpt-5.6-terra"],
      providers: ["openrouter"],
      routedProviders: ["Azure"],
      requestIds: ["gen-test-code-extraction-terra-1"],
      providerAttempts: 1,
      inputTokens: 2_737,
      outputTokens: 667,
      totalTokens: 3_404,
      authoritativeCostUsd: 0.0168475,
      knownCostLowerBoundUsd: 0.0168475,
      usageComplete: true,
    });
  });

  it("rejects OpenRouter itself as the routed upstream provider", () => {
    const observation = validObservation("primary_answer");
    observation.usage = liveUsage("primary_answer", {
      routedProvider: "openrouter",
    });

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().primary_answer,
    });

    expect(telemetry).toMatchObject({
      providers: ["openrouter"],
      routedProviders: ["openrouter"],
      usageComplete: false,
      authoritativeCostUsd: null,
    });
  });

  it("rejects ambiguous per-attempt model and routed-provider identity", () => {
    const observation = validObservation("primary_answer");
    observation.usage = liveUsage("primary_answer", {
      modelId: undefined,
      modelIds: [primaryModel, "openai/unexpected-model"],
      routedProvider: undefined,
      routedProviders: ["TestProvider", "UnexpectedProvider"],
    });

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().primary_answer,
    });

    expect(telemetry).toMatchObject({
      providerAttempts: 1,
      usageComplete: false,
      authoritativeCostUsd: null,
    });
  });

  it("requires one authoritative usage and identity record per provider attempt", () => {
    const observations = validObservations();
    const primary = observations.find(
      (observation) => observation.id === "primary_answer",
    )!;
    primary.usage = liveUsage("primary_answer", {
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    });

    const report = buildReport(observations);
    const scenario = report.scenarios.find(
      (entry) => entry.id === "primary_answer",
    )!;

    expect(scenario.telemetry).toMatchObject({
      providerAttempts: 2,
      requestIds: ["req-primary_answer"],
      usageComplete: false,
      authoritativeCostUsd: null,
    });
    expect(scenario.passed).toBe(false);
  });

  it("does not use aggregate metadata to fill multiple unattributed attempts", () => {
    const observation = validObservation("deep_synthesis");
    observation.usage = {
      attempts: [
        {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cost: 0.001,
          providerAttemptCount: 1,
        },
        {
          inputTokens: 20,
          outputTokens: 3,
          totalTokens: 23,
          cost: 0.002,
          providerAttemptCount: 1,
        },
      ],
      providerAttemptCount: 2,
      unknownUsageAttempts: 0,
    };
    observation.metadata = {
      provider: "openrouter",
      actualModelIds: [primaryModel],
      routedProviders: ["TestProvider"],
      requestIds: ["req-one", "req-two"],
    };

    const telemetry = buildOpenRouterProfileTelemetry({
      observation,
      config: profileConfigs().deep_synthesis,
    });

    expect(telemetry).toMatchObject({
      providerAttempts: 2,
      usageComplete: false,
      authoritativeCostUsd: null,
    });
  });

  it.each<{
    id: OpenRouterProfileScenarioId;
    unsafeValue: unknown;
  }>([
    {
      id: "primary_answer",
      unsafeValue: {
        text: "The system improved p95 by 42%. [citation:1] [citation:2] [citation:3]",
      },
    },
    {
      id: "deep_synthesis",
      unsafeValue: {
        data: {
          subsystems: [
            {
              subsystemKey: "invented",
              facts: [{ citationIndexes: [99] }],
              highlights: [],
            },
          ],
        },
        notebookSizes: { invented: 1 },
      },
    },
    {
      id: "verification",
      unsafeValue: {
        data: {
          results: [
            {
              claimIndex: 0,
              shouldFlag: false,
              unsupportedImpactWarning: false,
              revisedText: "Reduced p95 by 42%.",
            },
          ],
        },
      },
    },
    {
      id: "drafting",
      unsafeValue: {
        data: {
          content: "Improved performance by 42% using unsupported evidence.",
          usedHighlightIds: ["invented"],
          supportingEvidenceItemIds: ["raw"],
        },
      },
    },
    {
      id: "code_extraction",
      unsafeValue: {
        analysis: {
          semanticSource: "deterministic_fallback",
          facts: [
            {
              lineStart: 1,
              lineEnd: 999,
              subsystemKeys: ["unassigned"],
            },
          ],
        },
        allowedLines: [1, 2],
      },
    },
    {
      id: "routing",
      unsafeValue: {
        raw: { mode: "repository_refresh", suggestedWorkerCount: 4 },
        enforced: { mode: "memory_only", suggestedWorkerCount: 1 },
      },
    },
    {
      id: "json_repair",
      unsafeValue: {
        data: { status: "repaired", count: 2, leaked: true },
        localFixtureAttempts: 0,
        rawUsageForQualityCheck: liveUsage("json_repair"),
      },
    },
  ])("fails unsafe $id quality fixtures", ({ id, unsafeValue }) => {
    const observations = validObservations();
    const target = observations.find((observation) => observation.id === id)!;
    target.value = unsafeValue;

    const report = buildReport(observations);
    const scenario = report.scenarios.find((entry) => entry.id === id)!;

    expect(report.passed).toBe(false);
    expect(scenario.passed).toBe(false);
    expect(scenario.checks.some((entry) => !entry.passed)).toBe(true);
  });

  it("serializes only allowlisted data and drops prompts, outputs, code, errors, config, and secrets", () => {
    const sentinel = "SERIALIZATION_LEAK_SENTINEL_91f3";
    const observations = validObservations();
    const primary = observations.find(
      (observation) => observation.id === "primary_answer",
    )!;
    primary.value = {
      ...primary.value as Record<string, unknown>,
      prompt: sentinel,
      output: sentinel,
      codeContents: sentinel,
      errorMessage: sentinel,
      config: { apiKey: sentinel },
    };
    primary.usage = {
      ...liveUsage("primary_answer"),
      prompt: sentinel,
      rawOutput: sentinel,
      errorMessage: sentinel,
      config: { apiKey: sentinel },
      apiKey: sentinel,
    };
    primary.failure = {
      kind: "runtime_error",
      code: null,
      status: null,
      retryable: null,
      message: sentinel,
    } as typeof primary.failure;

    const serialized = JSON.stringify(buildReport(observations));

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("rawOutput");
    expect(serialized).not.toContain("errorMessage");
    expect(serialized).not.toContain("codeContents");
  });

  it("retains a known cost lower bound while withholding incomplete aggregate cost", () => {
    const observations = validObservations();
    const incomplete = observations.find(
      (observation) => observation.id === "verification",
    )!;
    incomplete.usage = {
      attempts: [
        liveUsage("verification", {
          requestId: "req-known",
          cost: 0.002,
        }),
        liveUsage("verification", {
          requestId: "req-missing-cost",
          cost: undefined,
        }),
      ],
      providerAttemptCount: 2,
    };

    const report = buildReport(observations);

    expect(report.aggregate.usageComplete).toBe(false);
    expect(report.aggregate.authoritativeCostUsd).toBeNull();
    expect(report.aggregate.knownCostLowerBoundUsd).toBe(0.008);
    expect(
      report.scenarios.find((scenario) => scenario.id === "verification")
        ?.telemetry,
    ).toMatchObject({
      usageComplete: false,
      authoritativeCostUsd: null,
      knownCostLowerBoundUsd: 0.002,
    });
  });
});
