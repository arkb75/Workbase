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
    scenarios: [
      {
        id: "empty_create_attach",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.5),
      },
      {
        id: "strongest_accomplishments",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.4),
      },
      {
        id: "strongest_accomplishments_freshness_follow_up",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.4),
      },
      {
        id: "existing_attach",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.5),
      },
      {
        id: "completed_delete_readd_same_repo",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.5),
      },
      {
        id: "manual_only_create",
        passed: true,
        lifecycleGatePassed: true,
        hardGateFailures: [],
        quality: quality(4.5),
      },
    ],
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
