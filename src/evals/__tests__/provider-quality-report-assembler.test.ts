import { describe, expect, it } from "vitest";
import { assembleProviderQualityReport } from "@/src/evals/provider-quality-report-assembler";
import { providerQualityDimensions } from "@/src/evals/provider-quality-noninferiority";
import { WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION } from "@/src/evals/work-item-lifecycle-release-gate";

const GIT_COMMIT = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const REPOSITORY = "arkb75/Workbase";
const lifecycleScenarioIds = [
  "manual_only_create",
  "empty_create_attach",
  "existing_attach",
  "completed_delete_readd_same_repo",
] as const;

function generationRun(id: string, modelId: string, cost: number) {
  return {
    id,
    provider: "openrouter",
    modelId,
    configuredModelId: modelId,
    requestIds: [`request-${id}`],
    tokenUsagePresent: true,
    estimatedCostUsd: cost,
    usageComplete: true,
    providerAttemptCount: 1,
    failedProviderAttempts: 0,
    unknownUsageAttempts: 0,
    auditEvidenceTruncated: false,
    role: "provider_call",
  };
}

function highlight(id: string, sourceId: string, sourceType: string) {
  const repositoryHighlight = sourceType === "github_repo";
  return {
    id,
    text: `Grounded accomplishment ${id}`,
    lifecycleStatus: "active",
    evidence: [{
      evidenceItemId: `evidence-${id}`,
      sourceId,
      sourceType,
    }],
    validatedThroughSha: repositoryHighlight ? HEAD_SHA : null,
    validationHeads: repositoryHighlight
      ? [{ sourceId, repository: REPOSITORY, commitSha: HEAD_SHA }]
      : [],
  };
}

function fixtures() {
  const scenarios = lifecycleScenarioIds.map((id) => ({
    id,
    provider: "openrouter",
    passed: true,
    repository: id === "manual_only_create" ? null : REPOSITORY,
    expectedHeadSha: id === "manual_only_create" ? null : HEAD_SHA,
    automaticHighlightCount: 1,
    totalLatencyMs: 100,
    failedChecks: [],
  }));
  const lifecycleGate = {
    schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    passed: true,
    evaluatedScenarios: scenarios.length,
    missingScenarioIds: [],
    duplicateScenarioIds: [],
    aggregate: {
      totalLatencyMs: 400,
      automaticHighlights: 4,
      failedChecks: 0,
    },
    scenarios,
  };
  const lifecycleObservations = {
    schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    observations: lifecycleScenarioIds.map((scenarioId, index) => {
      const sourceId = `source-${scenarioId}`;
      const runId = `run-${scenarioId}`;
      const common = {
        schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
        scenarioId,
        provider: "openrouter",
        timingsMs: { total: 100 },
        automaticHighlights: [highlight(
          `highlight-${scenarioId}`,
          sourceId,
          scenarioId === "manual_only_create" ? "manual_note" : "github_repo",
        )],
      };
      if (scenarioId === "manual_only_create") {
        return {
          ...common,
          manualEvidence: {
            sourceIds: [sourceId],
            evidenceItemIds: [`evidence-highlight-${scenarioId}`],
          },
          manualAgentRun: {
            result: { generationRunIds: [runId] },
            generationRuns: [generationRun(
              runId,
              "openai/gpt-5.6-luna",
              0.01,
            )],
          },
        };
      }
      return {
        ...common,
        repository: {
          sourceId,
          fullName: REPOSITORY,
          expectedHeadSha: HEAD_SHA,
        },
        automation: {
          generationRunIds: [runId],
          observedProviders: ["openrouter"],
          observedModelIds: ["openai/gpt-5.6-terra"],
          capabilitySynthesisRuns: [generationRun(
            runId,
            "openai/gpt-5.6-terra",
            0.02 + index * 0,
          )],
        },
      };
    }),
  };
  const scenario = (
    id: "strongest_accomplishments" |
      "strongest_accomplishments_freshness_follow_up",
  ) => ({
    id,
    passed: true,
    outcome: "answered",
    answer: "A grounded and specific repository accomplishment with enough detail.",
    metrics: {
      latencyMs: 20,
      modelCalls: 1,
      estimatedCostUsd: 0.003,
      usageComplete: true,
      modelAttribution: {
        actualModelIds: ["openai/gpt-5.6-terra"],
        failedProviderAttempts: 0,
        fallbackUsed: false,
        authoritativeAttributionComplete: true,
      },
    },
    quality: {
      passed: true,
      checks: [{ name: "exact current head", passed: true }],
      primaryItemCount: 1,
      developedItemCount: 1,
      citedItemCount: 1,
      requiredCapabilityRecall: 1,
      repositoryCitationFreshness: {
        targetHeads: [{
          sourceId: "accomplishments-source",
          repository: REPOSITORY,
          commitSha: HEAD_SHA,
        }],
        repositoryDerivedCitationCount: 1,
        currentRepositoryDerivedCitationCount: 1,
        staleCitationOrdinals: [],
      },
    },
    failedChecks: [],
  });
  const accomplishments = {
    schemaVersion: "workbase-repository-accomplishments-report-v1",
    passed: true,
    provider: "openrouter",
    comparisonKey: `${REPOSITORY.toLowerCase()}@${HEAD_SHA}:profile-hash`,
    profile: {
      includeFreshnessFollowUp: true,
      minimumPrimaryItems: 1,
      maximumPrimaryItems: 3,
      minimumDevelopedItems: 1,
      minimumCitedItems: 1,
      minimumCharacters: 20,
      maximumCharacters: 1_000,
    },
    target: {
      sourceId: "accomplishments-source",
      repository: REPOSITORY,
      commitSha: HEAD_SHA,
    },
    performance: {
      latencyMs: 40,
      modelCalls: 2,
      estimatedCostUsd: 0.006,
      usageComplete: true,
    },
    attribution: {
      actualModelIds: ["openai/gpt-5.6-terra"],
      failedProviderAttempts: 0,
      fallbackUsed: false,
      authoritativeAttributionComplete: true,
    },
    scenarios: [
      scenario("strongest_accomplishments"),
      scenario("strongest_accomplishments_freshness_follow_up"),
    ],
  };
  return { lifecycleGate, lifecycleObservations, accomplishments };
}

function assemble(
  fixture: ReturnType<typeof fixtures>,
  provider: "bedrock" | "openrouter" = "openrouter",
) {
  return assembleProviderQualityReport({
    provider,
    gitCommit: GIT_COMMIT,
    ...fixture,
  });
}

describe("provider quality report assembler", () => {
  it("assembles all six scenarios from deterministic evidence and preserves telemetry", () => {
    const report = assemble(fixtures());

    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      ...lifecycleScenarioIds,
      "strongest_accomplishments",
      "strongest_accomplishments_freshness_follow_up",
    ]);
    expect(report.attribution).toEqual({
      authoritative: true,
      fallbackUsed: false,
      failedProviderAttempts: 0,
      actualModelIds: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
    });
    expect(report.performance).toEqual({
      latencyMs: 440,
      observedEstimatedCostUsd: 0.076,
      observedGenerationRunCount: 6,
      costCoverageComplete: true,
      usageComplete: true,
    });
    for (const scenario of report.scenarios) {
      expect(scenario.quality.groundedClaimPrecision).toBe(1);
      expect(scenario.quality.requiredCapabilityRecall).toBe(1);
      expect(scenario.quality.rubricEvidence).toBeDefined();
      for (const dimension of providerQualityDimensions) {
        expect(scenario.quality.rubric[dimension]).toBe(5);
        expect(scenario.quality.rubricEvidence?.[dimension].passed).toBe(true);
      }
    }
  });

  it("fails closed on an embedded build-commit mismatch", () => {
    const fixture = fixtures();
    Object.assign(fixture.accomplishments, { gitCommit: "c".repeat(40) });

    expect(() => assemble(fixture)).toThrow(/commit mismatch/iu);
  });

  it("fails closed on a provider mismatch", () => {
    const fixture = fixtures();
    fixture.accomplishments.provider = "bedrock";

    expect(() => assemble(fixture)).toThrow(/provider mismatch/iu);
  });

  it("fails closed on a repository-head mismatch", () => {
    const fixture = fixtures();
    const repositoryObservation = fixture.lifecycleObservations.observations.find(
      (observation) => "repository" in observation,
    );
    if (!repositoryObservation || !("repository" in repositoryObservation)) {
      throw new Error("Expected a repository observation fixture.");
    }
    repositoryObservation.repository.expectedHeadSha = "d".repeat(40);

    expect(() => assemble(fixture)).toThrow(/head mismatch/iu);
  });

  it("fails closed on a missing required scenario", () => {
    const fixture = fixtures();
    fixture.accomplishments.scenarios.pop();

    expect(() => assemble(fixture)).toThrow(/scenario mismatch/iu);
  });

  it("fails closed when the evaluated gate and raw observation disagree", () => {
    const fixture = fixtures();
    fixture.lifecycleObservations.observations[0]!.timingsMs.total = 101;

    expect(() => assemble(fixture)).toThrow(/observation\/gate mismatch/iu);
  });
});
