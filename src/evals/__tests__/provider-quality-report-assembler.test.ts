import { describe, expect, it } from "vitest";
import { assembleProviderQualityReport } from "@/src/evals/provider-quality-report-assembler";
import {
  parseRepositoryAccomplishmentsProfile,
  repositoryAccomplishmentsComparisonKey,
} from "@/src/evals/repository-accomplishments-quality";
import { providerQualityDimensions } from "@/src/evals/provider-quality-noninferiority";
import { WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION } from "@/src/evals/work-item-lifecycle-release-gate";

const GIT_COMMIT = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const REPOSITORY = "arkb75/Workbase";
const EXPECTED_EXACT_MANUAL_HIGHLIGHT =
  "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.";
const EXPECTED_MANUAL_EVIDENCE_CONTENT_SHA256 =
  "55fa96b3c94df35255760c7788f242f8c399d10fdbdaaff1f3f33d8c7f8ae697";
const lifecycleScenarioIds = [
  "manual_only_create",
  "empty_create_attach",
  "existing_attach",
  "completed_delete_readd_same_repo",
] as const;

function generationRun(
  id: string,
  kind: string,
  modelId: string,
  cost: number,
  profile: string,
) {
  return {
    id,
    kind,
    status: "success",
    provider: "openrouter",
    configuredProvider: "openrouter",
    modelId,
    profile,
    configuredModelId: modelId,
    requestIds: [`request-${id}`],
    tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    tokenUsagePresent: true,
    estimatedCostUsd: cost,
    usageComplete: true,
    auditAttemptCount: 1,
    providerAttemptCount: 1,
    failedProviderAttempts: 0,
    unknownUsageAttempts: 0,
    auditEvidenceTruncated: false,
    role: "provider_call",
    agentRunId: null,
    authoritativeGenerationRunId: null,
    providerBatchGenerationRunIds: [],
  };
}

function highlight(id: string, sourceId: string, sourceType: string) {
  const repositoryHighlight = sourceType === "github_repo";
  return {
    id,
    text: repositoryHighlight
      ? `Grounded accomplishment ${id}`
      : EXPECTED_EXACT_MANUAL_HIGHLIGHT,
    lifecycleStatus: "active",
    generationStrategy: repositoryHighlight
      ? null
      : "exact_manual_evidence_fallback",
    extractivePolicyVersion: repositoryHighlight
      ? null
      : "manual-evidence-extractive-v1",
    evidence: [{
      evidenceItemId: `evidence-${id}`,
      sourceId,
      sourceType,
      contentSha256: repositoryHighlight
        ? null
        : EXPECTED_MANUAL_EVIDENCE_CONTENT_SHA256,
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
    gitCommit: GIT_COMMIT,
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
    gitCommit: GIT_COMMIT,
    observations: lifecycleScenarioIds.map((scenarioId, index) => {
      const sourceId = `source-${scenarioId}`;
      const runId = `run-${scenarioId}`;
      const semanticRunId = `${runId}-semantic`;
      const synthesisRunId = `${runId}-synthesis`;
      const common = {
        schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
        scenarioId,
        provider: "openrouter",
        currentLineage: { generationRunIds: [runId] },
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
              "highlight_generation",
              "openai/gpt-5.6-luna",
              0.01,
              "drafting",
            )],
          },
        };
      }
      return {
        ...common,
        currentLineage: {
          generationRunIds: [semanticRunId, synthesisRunId],
        },
        repository: {
          sourceId,
          fullName: REPOSITORY,
          expectedHeadSha: HEAD_SHA,
        },
        automation: {
          generationRunIds: [semanticRunId, synthesisRunId],
          observedProviders: ["openrouter"],
          observedModelIds: ["openai/gpt-5.4-mini", "openai/gpt-5.6-terra"],
          capabilitySynthesisRuns: [generationRun(
            synthesisRunId,
            "capability_synthesis",
            "openai/gpt-5.6-terra",
            0.02 + index * 0,
            "deep_synthesis",
          )],
          generationRuns: [
            generationRun(
              semanticRunId,
              "semantic_extraction",
              "openai/gpt-5.4-mini",
              0.005,
              "code_extraction",
            ),
            generationRun(
              synthesisRunId,
              "capability_synthesis",
              "openai/gpt-5.6-terra",
              0.02,
              "deep_synthesis",
            ),
          ],
        },
        priorLineage: scenarioId === "completed_delete_readd_same_repo"
          ? {
              generationRunIds: [
                `${runId}-prior-semantic`,
                `${runId}-prior-synthesis`,
              ],
              generationRuns: [
                generationRun(
                  `${runId}-prior-semantic`,
                  "semantic_extraction",
                  "openai/gpt-5.4-mini",
                  0.005,
                  "code_extraction",
                ),
                generationRun(
                  `${runId}-prior-synthesis`,
                  "capability_synthesis",
                  "openai/gpt-5.6-terra",
                  0.02,
                  "deep_synthesis",
                ),
              ],
            }
          : null,
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
    answer: "A grounded and specific repository accomplishment with enough detail to explain the mechanism, its practical value, and the current implementation evidence. ".repeat(2),
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
  const profile = parseRepositoryAccomplishmentsProfile({
    schemaVersion: "repository-accomplishments-profile-v3",
    workItemTitle: "Workbase",
    repository: REPOSITORY,
    requiredCapabilityPatterns: ["grounded", "repository"],
    forbiddenAnswerPatterns: ["cross-repository contamination"],
    includeFreshnessFollowUp: true,
    minimumPrimaryItems: 1,
    maximumPrimaryItems: 3,
    minimumDevelopedItems: 1,
    minimumCitedItems: 1,
    minimumCharacters: 200,
    maximumCharacters: 1_000,
  });
  const target = {
    workItemId: "work-item-workbase",
    workItemTitle: "Workbase",
    sourceId: "accomplishments-source",
    repository: REPOSITORY,
    commitSha: HEAD_SHA,
    evidenceItemCount: 50,
  };
  const accomplishments = {
    schemaVersion: "repository-accomplishments-report-v3",
    gitCommit: GIT_COMMIT,
    passed: true,
    provider: "openrouter",
    comparisonKey: repositoryAccomplishmentsComparisonKey(profile, target),
    profile,
    target,
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
      actualModelIds: [
        "openai/gpt-5.4-mini",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-terra",
      ],
    });
    expect(report.performance).toEqual({
      latencyMs: 440,
      observedEstimatedCostUsd: 0.116,
      observedGenerationRunCount: 11,
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
    expect(report.scenarios.find((scenario) =>
      scenario.id === "manual_only_create"
    )?.quality.rubricEvidence?.specificity.evidenceIds).toEqual([
      "manual_highlights_recover_exact_grounded_migration_note",
    ]);
  });

  it("fails closed on an embedded build-commit mismatch", () => {
    const fixture = fixtures();
    Object.assign(fixture.accomplishments, { gitCommit: "c".repeat(40) });

    expect(() => assemble(fixture)).toThrow(/commit mismatch/iu);
  });

  it("rejects pre-v4 lifecycle artifacts before provider comparison assembly", () => {
    const oldGate = fixtures();
    oldGate.lifecycleGate.schemaVersion =
      "workbase-work-item-lifecycle-release-gate-v3" as
        typeof oldGate.lifecycleGate.schemaVersion;
    expect(() => assemble(oldGate)).toThrow(/schemaVersion/iu);

    const oldObservations = fixtures();
    oldObservations.lifecycleObservations.schemaVersion =
      "workbase-work-item-lifecycle-release-gate-v3" as
        typeof oldObservations.lifecycleObservations.schemaVersion;
    expect(() => assemble(oldObservations)).toThrow(/schemaVersion/iu);
  });

  it("requires the private exact manual Evidence proof in raw lifecycle input", () => {
    const fixture = fixtures();
    const manual = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "manual_only_create",
    );
    if (!manual) throw new Error("Expected manual observation fixture.");
    manual.automaticHighlights[0]!.evidence[0]!.contentSha256 = "c".repeat(64);

    expect(() => assemble(fixture)).toThrow(
      /privacy-preserving exact extractive Evidence proof/iu,
    );
  });

  it("rejects raw manual Evidence content before quality report assembly", () => {
    const fixture = fixtures();
    const manual = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "manual_only_create",
    );
    if (!manual) throw new Error("Expected manual observation fixture.");
    Object.assign(manual.automaticHighlights[0]!.evidence[0]!, {
      content: "Private Evidence must remain outside the assembled report.",
    });

    expect(() => assemble(fixture)).toThrow();
  });

  it("rejects artifacts that do not embed the tested build commit", () => {
    const fixture = fixtures();
    delete (fixture.lifecycleGate as { gitCommit?: string }).gitCommit;

    expect(() => assemble(fixture)).toThrow(/missing gitCommit/iu);
  });

  it("counts semantic extraction and deleted-prior provider runs in cost coverage", () => {
    const fixture = fixtures();
    const repositoryObservation = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "empty_create_attach",
    );
    if (!repositoryObservation || !("automation" in repositoryObservation)) {
      throw new Error("Expected repository lifecycle fixture.");
    }
    const semanticRun = repositoryObservation.automation.generationRuns.find(
      (run) => run.kind === "semantic_extraction",
    );
    Object.assign(semanticRun!, {
      estimatedCostUsd: null,
      usageComplete: false,
    });

    const report = assemble(fixture);
    expect(report.attribution.authoritative).toBe(false);
    expect(report.performance.costCoverageComplete).toBe(false);
    expect(report.scenarios.find((scenario) =>
      scenario.id === "empty_create_attach"
    )?.performance.costCoverageComplete).toBe(false);
  });

  it("keeps a quality-failing Bedrock control authoritative when provider telemetry is complete", () => {
    const fixture = fixtures();
    const failedScenario = fixture.lifecycleGate.scenarios.find((scenario) =>
      scenario.id === "completed_delete_readd_same_repo"
    );
    if (!failedScenario) throw new Error("Expected delete/re-add gate scenario.");
    failedScenario.passed = false;
    (failedScenario.failedChecks as Array<{ id: string; passed: false }>).push({
      id: "automatic_highlights_are_active_approved_automatic_and_grounded",
      passed: false,
    });
    fixture.lifecycleGate.passed = false;
    fixture.lifecycleGate.aggregate.failedChecks = 1;

    const report = assemble(fixture);

    expect(report.attribution.authoritative).toBe(true);
    expect(report.performance).toMatchObject({
      costCoverageComplete: true,
      usageComplete: true,
    });
    expect(report.scenarios.find((scenario) =>
      scenario.id === "completed_delete_readd_same_repo"
    )).toMatchObject({
      passed: false,
      lifecycleGatePassed: false,
      hardGateFailures: [
        "automatic_highlights_are_active_approved_automatic_and_grounded",
      ],
    });
  });

  it("does not mistake a failing quality gate for complete attribution when telemetry is incomplete", () => {
    const fixture = fixtures();
    const failedScenario = fixture.lifecycleGate.scenarios.find((scenario) =>
      scenario.id === "empty_create_attach"
    );
    if (!failedScenario) throw new Error("Expected empty-create gate scenario.");
    failedScenario.passed = false;
    (failedScenario.failedChecks as Array<{ id: string; passed: false }>).push({
      id: "automatic_highlights_are_active_approved_automatic_and_grounded",
      passed: false,
    });
    fixture.lifecycleGate.passed = false;
    fixture.lifecycleGate.aggregate.failedChecks = 1;

    const repositoryObservation = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "empty_create_attach",
    );
    if (!repositoryObservation || !("automation" in repositoryObservation)) {
      throw new Error("Expected repository lifecycle fixture.");
    }
    repositoryObservation.automation.generationRuns[0]!.requestIds = [];

    const report = assemble(fixture);

    expect(report.attribution.authoritative).toBe(false);
    expect(report.performance.costCoverageComplete).toBe(false);
    expect(report.scenarios.find((scenario) =>
      scenario.id === "empty_create_attach"
    )?.performance.costCoverageComplete).toBe(false);
  });

  it.each([
    {
      name: "the provider attempt count differs from the durable audit count",
      mutate: (run: ReturnType<typeof generationRun>) => {
        run.providerAttemptCount = 2;
      },
    },
    {
      name: "one audited provider attempt has no unique request ID",
      mutate: (run: ReturnType<typeof generationRun>) => {
        run.auditAttemptCount = 2;
        run.providerAttemptCount = 2;
      },
    },
  ])("fails attribution when $name", ({ mutate }) => {
    const fixture = fixtures();
    const repositoryObservation = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "empty_create_attach",
    );
    if (!repositoryObservation || !("automation" in repositoryObservation)) {
      throw new Error("Expected repository lifecycle fixture.");
    }
    mutate(repositoryObservation.automation.generationRuns[0]!);

    const report = assemble(fixture);

    expect(report.attribution.authoritative).toBe(false);
    expect(report.performance.costCoverageComplete).toBe(false);
  });

  it("excludes deterministic verification aggregates from provider spend", () => {
    const fixture = fixtures();
    const manualObservation = fixture.lifecycleObservations.observations.find(
      (observation) => observation.scenarioId === "manual_only_create",
    );
    if (!manualObservation || !("manualAgentRun" in manualObservation)) {
      throw new Error("Expected a manual lifecycle fixture.");
    }
    const aggregateId = "manual-verification-aggregate";
    const generationRuns = manualObservation.manualAgentRun.generationRuns as
      unknown as Array<Record<string, unknown>>;
    generationRuns.push({
      id: aggregateId,
      kind: "highlight_verification",
      status: "success",
      provider: "deterministic",
      configuredProvider: "openrouter",
      modelId: "highlight-verification-aggregate-v1",
      profile: "verification",
      configuredModelId: "openai/gpt-5.6-luna",
      requestIds: ["request-provider-verification-1", "request-provider-verification-2"],
      tokenUsage: null,
      tokenUsagePresent: false,
      estimatedCostUsd: null,
      usageComplete: true,
      auditAttemptCount: 0,
      providerAttemptCount: 0,
      failedProviderAttempts: 0,
      unknownUsageAttempts: 0,
      auditEvidenceTruncated: false,
      role: "verification_aggregate",
      agentRunId: "manual-agent-run",
      authoritativeGenerationRunId: null,
      providerBatchGenerationRunIds: [
        "provider-verification-1",
        "provider-verification-2",
      ],
    });
    manualObservation.currentLineage.generationRunIds.push(aggregateId);

    const report = assemble(fixture);

    expect(report.attribution.authoritative).toBe(true);
    expect(report.performance).toMatchObject({
      observedEstimatedCostUsd: 0.116,
      observedGenerationRunCount: 11,
      costCoverageComplete: true,
      usageComplete: true,
    });
    expect(report.scenarios.find((scenario) =>
      scenario.id === "manual_only_create"
    )?.performance).toMatchObject({
      observedEstimatedCostUsd: 0.01,
      observedGenerationRunCount: 1,
      costCoverageComplete: true,
      usageComplete: true,
    });
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

  it("requires a complete normalized v2 accomplishments profile", () => {
    const missingField = fixtures();
    delete (missingField.accomplishments.profile as {
      workItemTitle?: string;
    }).workItemTitle;
    expect(() => assemble(missingField)).toThrow();

    const invalidRegex = fixtures();
    invalidRegex.accomplishments.profile.requiredCapabilityPatterns = ["["];
    expect(() => assemble(invalidRegex)).toThrow(/regular expression/iu);
  });

  it("rejects profile/target and complete comparison-key mismatches", () => {
    const targetMismatch = fixtures();
    targetMismatch.accomplishments.target.workItemTitle = "Other";
    expect(() => assemble(targetMismatch)).toThrow(
      /profile and target title\/repository/iu,
    );

    const keyMismatch = fixtures();
    keyMismatch.accomplishments.profile.maximumCharacters = 1_001;
    expect(() => assemble(keyMismatch)).toThrow(/complete quality profile/iu);
  });

  it("recomputes required recall and forbidden matches from every answer", () => {
    const recallMismatch = fixtures();
    recallMismatch.accomplishments.scenarios[1]!.answer =
      "A grounded answer without the other configured capability. ".repeat(5);
    expect(() => assemble(recallMismatch)).toThrow(
      /required-capability recall mismatch/iu,
    );

    const contamination = fixtures();
    contamination.accomplishments.scenarios[1]!.answer +=
      " cross-repository contamination";
    const report = assemble(contamination);
    const scenario = report.scenarios.find((entry) =>
      entry.id === "strongest_accomplishments_freshness_follow_up"
    );
    expect(scenario).toMatchObject({
      passed: false,
      hardGateFailures: [
        "forbidden_answer_pattern_sha256:56b63cc3b7d5212a",
      ],
    });
    expect(scenario?.quality.rubric.instructionAdherence).toBe(0);
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
