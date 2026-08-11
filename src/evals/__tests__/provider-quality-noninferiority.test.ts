import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUALITY_REPORT_SCHEMA_VERSION,
  compareProviderQualityReports,
  providerQualityDimensions,
  providerQualityReleaseGateRequiredScenarioIds,
  type ProviderQualityReport,
} from "@/src/evals/provider-quality-noninferiority";

const GIT_COMMIT = "c".repeat(40);
const REPOSITORY_HEAD = "d".repeat(40);

function quality(score: number) {
  return {
    rubric: Object.fromEntries(
      providerQualityDimensions.map((dimension) => [dimension, score]),
    ) as Record<(typeof providerQualityDimensions)[number], number>,
    groundedClaimPrecision: 1,
    requiredCapabilityRecall: 0.9,
    unsupportedClaimCount: 0,
    staleClaimCount: 0,
    duplicateHighlightCount: 0,
  };
}

function report(provider: "bedrock" | "openrouter"): ProviderQualityReport {
  const scenarioIds = [
    "empty_create_attach",
    "strongest_accomplishments",
    "strongest_accomplishments_freshness_follow_up",
    "existing_attach",
    "completed_delete_readd_same_repo",
    "manual_only_create",
  ];
  const costPerScenario = provider === "bedrock" ? 0.02 : 0.01;
  const latencyPerScenario = provider === "bedrock" ? 100 : 120;
  const scenarios = scenarioIds.map((id, index) => ({
    id,
    passed: true,
    lifecycleGatePassed: true,
    hardGateFailures: [],
    quality: quality(index === 1 || index === 2 ? 4.4 : 4.5),
    performance: {
      latencyMs: latencyPerScenario,
      observedEstimatedCostUsd: costPerScenario,
      observedGenerationRunCount: 1,
      costCoverageComplete: true,
      usageComplete: true,
    },
  }));
  return {
    schemaVersion: PROVIDER_QUALITY_REPORT_SCHEMA_VERSION,
    provider,
    comparisonKey: "workbase-current-head-paired-run-1",
    gitCommit: GIT_COMMIT,
    repositoryHeads: [{
      repository: "arkb75/Workbase",
      commitSha: REPOSITORY_HEAD,
    }],
    attribution: {
      authoritative: true,
      fallbackUsed: false,
      failedProviderAttempts: 0,
      actualModelIds: provider === "bedrock"
        ? ["anthropic.claude-sonnet-4-6"]
        : ["openai/gpt-5.6-terra"],
    },
    requiredScenarioIds: [...providerQualityReleaseGateRequiredScenarioIds],
    scenarios,
    performance: {
      latencyMs: latencyPerScenario * scenarios.length,
      observedEstimatedCostUsd: costPerScenario * scenarios.length,
      observedGenerationRunCount: scenarios.length,
      costCoverageComplete: true,
      usageComplete: true,
    },
  };
}

describe("paired Bedrock/OpenRouter quality non-inferiority", () => {
  it("accepts an exact paired run when every OpenRouter scenario is non-inferior", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    candidate.scenarios[0].quality.rubric.usefulness = 4.25;
    candidate.scenarios[1].quality.requiredCapabilityRecall = 0.95;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
      rubricMargin: 0.25,
    });

    expect(result.passed).toBe(true);
    expect(result.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(result.performance.matchedDeltas).toEqual({
      lifecycle: {
        costDeltaUsd: -0.04,
        costRatio: 0.5,
        latencyDeltaMs: 80,
        latencyRatio: 1.2,
      },
      accomplishments: {
        costDeltaUsd: -0.02,
        costRatio: 0.5,
        latencyDeltaMs: 40,
        latencyRatio: 1.2,
      },
      total: {
        costDeltaUsd: -0.06,
        costRatio: 0.5,
        latencyDeltaMs: 120,
        latencyRatio: 1.2,
      },
    });
  });

  it("fails closed when any lineage cost coverage is incomplete", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    candidate.scenarios[0].performance.costCoverageComplete = false;
    candidate.performance.costCoverageComplete = false;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    expect(result.globalChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openrouter_every_scenario_has_complete_cost_coverage",
        passed: false,
      }),
      expect.objectContaining({
        id: "openrouter_report_has_complete_cost_coverage",
        passed: false,
      }),
    ]));
  });

  it("blocks a provider migration whose matched measured total cost exceeds Bedrock", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    for (const scenario of candidate.scenarios) {
      scenario.performance.observedEstimatedCostUsd = 0.03;
    }
    candidate.performance.observedEstimatedCostUsd = 0.18;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    expect(result.globalChecks).toContainEqual(expect.objectContaining({
      id: "openrouter_measured_total_cost_does_not_exceed_bedrock",
      passed: false,
      actual: 0.18,
      expected: 0.12,
    }));
    expect(result.performance.matchedDeltas.total.costRatio).toBe(1.5);
  });

  it("rejects one inferior scenario even when another scenario raises the aggregate", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    candidate.scenarios[0].quality.rubric.correctness = 4.2;
    for (const dimension of providerQualityDimensions) {
      candidate.scenarios[1].quality.rubric[dimension] = 5;
    }

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
      rubricMargin: 0.25,
    });

    expect(result.passed).toBe(false);
    expect(result.scenarios.find((scenario) =>
      scenario.scenarioId === "empty_create_attach"
    )?.checks).toContainEqual(expect.objectContaining({
      id: "openrouter_correctness_is_non_inferior",
      passed: false,
    }));
    expect(result.scenarios.find((scenario) =>
      scenario.scenarioId === "strongest_accomplishments"
    )?.passed).toBe(true);
  });

  it("keeps stale, unsupported, duplicate, and ungrounded output as absolute failures", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    candidate.scenarios[0].quality.groundedClaimPrecision = 0.99;
    candidate.scenarios[0].quality.unsupportedClaimCount = 1;
    candidate.scenarios[0].quality.staleClaimCount = 1;
    candidate.scenarios[0].quality.duplicateHighlightCount = 1;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    const failures = result.scenarios.find((scenario) =>
      scenario.scenarioId === "empty_create_attach"
    )!.checks
      .filter((check) => !check.passed)
      .map((check) => check.id);
    expect(failures).toEqual(expect.arrayContaining([
      "openrouter_grounded_claim_precision_is_perfect",
      "openrouter_unsupportedClaimCount_is_zero",
      "openrouter_staleClaimCount_is_zero",
      "openrouter_duplicateHighlightCount_is_zero",
    ]));
  });

  it("applies the same grounded non-inferiority contract to manual-only output", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    const manual = candidate.scenarios.find((scenario) =>
      scenario.id === "manual_only_create"
    )!;
    manual.quality.requiredCapabilityRecall = 0.8;
    manual.quality.unsupportedClaimCount = 1;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    const failures = result.scenarios.find((scenario) =>
      scenario.scenarioId === "manual_only_create"
    )!.checks.filter((check) => !check.passed).map((check) => check.id);
    expect(failures).toEqual(expect.arrayContaining([
      "openrouter_capability_recall_is_not_lower",
      "openrouter_unsupportedClaimCount_is_zero",
      "openrouter_unsupportedClaimCount_is_not_worse",
    ]));
  });

  it("rejects missing scenarios, mismatched heads, fallback, and incomplete attribution", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    candidate.scenarios.pop();
    candidate.repositoryHeads[0].commitSha = "e".repeat(40);
    candidate.attribution.fallbackUsed = true;
    candidate.attribution.authoritative = false;

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    expect(result.globalChecks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "repository_heads_match",
        "scenario_sets_match",
        "openrouter_attribution_is_authoritative",
        "openrouter_used_no_fallback",
      ]));
  });

  it("cannot pass by omitting a required lifecycle or prior benchmark scenario", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    baseline.requiredScenarioIds = ["empty_create_attach"];
    candidate.requiredScenarioIds = ["empty_create_attach"];

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    expect(result.globalChecks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "bedrock_declares_release_gate_scenarios",
        "openrouter_declares_release_gate_scenarios",
      ]));
  });

  it("requires the candidate to pass absolute gates even if Bedrock failed", () => {
    const baseline = report("bedrock");
    const candidate = report("openrouter");
    baseline.scenarios[0].passed = false;
    baseline.scenarios[0].hardGateFailures = ["legacy provider timeout"];
    candidate.scenarios[0].passed = false;
    candidate.scenarios[0].lifecycleGatePassed = false;
    candidate.scenarios[0].hardGateFailures = ["candidate timed out"];

    const result = compareProviderQualityReports({
      bedrock: baseline,
      openrouter: candidate,
    });

    expect(result.passed).toBe(false);
    const emptyCreateChecks = result.scenarios.find((scenario) =>
      scenario.scenarioId === "empty_create_attach"
    )!.checks;
    expect(emptyCreateChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openrouter_absolute_gate_passed",
        passed: false,
      }),
      expect.objectContaining({
        id: "openrouter_lifecycle_gate_passed",
        passed: false,
      }),
      expect.objectContaining({
        id: "openrouter_has_no_hard_gate_failures",
        passed: false,
      }),
    ]));
  });
});
