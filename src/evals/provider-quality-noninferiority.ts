import { z } from "zod";
import { workItemLifecycleScenarioIds } from "@/src/evals/work-item-lifecycle-release-gate";

export const PROVIDER_QUALITY_REPORT_SCHEMA_VERSION =
  "workbase-provider-quality-report-v1" as const;
export const PROVIDER_QUALITY_COMPARISON_SCHEMA_VERSION =
  "workbase-provider-quality-comparison-v1" as const;

export const providerQualityDimensions = [
  "correctness",
  "evidenceFidelity",
  "usefulness",
  "prioritization",
  "specificity",
  "instructionAdherence",
] as const;

export type ProviderQualityDimension =
  (typeof providerQualityDimensions)[number];

export const providerQualityReleaseGateRequiredScenarioIds = [
  ...workItemLifecycleScenarioIds,
  "strongest_accomplishments",
  "strongest_accomplishments_freshness_follow_up",
] as const;

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/iu);
const boundedQualityScore = z.number().min(0).max(5);
const ratio = z.number().min(0).max(1);
const scenarioIdSchema = z.string().trim().min(1).max(200);

const scenarioQualitySchema = z.object({
  rubric: z.object(Object.fromEntries(
    providerQualityDimensions.map((dimension) => [
      dimension,
      boundedQualityScore,
    ]),
  ) as Record<ProviderQualityDimension, typeof boundedQualityScore>),
  groundedClaimPrecision: ratio,
  requiredCapabilityRecall: ratio,
  unsupportedClaimCount: z.number().int().nonnegative(),
  staleClaimCount: z.number().int().nonnegative(),
  duplicateHighlightCount: z.number().int().nonnegative(),
  rubricEvidence: z.object(Object.fromEntries(
    providerQualityDimensions.map((dimension) => [
      dimension,
      z.object({
        passed: z.boolean(),
        evidenceIds: z.array(z.string().trim().min(1).max(300)).min(1),
      }),
    ]),
  ) as Record<
    ProviderQualityDimension,
    z.ZodObject<{
      passed: z.ZodBoolean;
      evidenceIds: z.ZodArray<z.ZodString>;
    }>
  >).optional(),
});

const observedPerformanceSchema = z.object({
  latencyMs: z.number().nonnegative(),
  observedEstimatedCostUsd: z.number().nonnegative(),
  observedGenerationRunCount: z.number().int().nonnegative(),
  costCoverageComplete: z.boolean(),
  usageComplete: z.boolean(),
});

const scenarioSchema = z.object({
  id: scenarioIdSchema,
  passed: z.boolean(),
  lifecycleGatePassed: z.boolean(),
  hardGateFailures: z.array(z.string().trim().min(1).max(300)),
  quality: scenarioQualitySchema,
  performance: observedPerformanceSchema,
});

export const providerQualityReportSchema = z.object({
  schemaVersion: z.literal(PROVIDER_QUALITY_REPORT_SCHEMA_VERSION),
  provider: z.enum(["bedrock", "openrouter"]),
  comparisonKey: z.string().trim().min(1).max(300),
  gitCommit: shaSchema,
  repositoryHeads: z.array(z.object({
    repository: z.string().trim().min(1).max(300),
    commitSha: shaSchema,
  })).min(1),
  attribution: z.object({
    authoritative: z.boolean(),
    fallbackUsed: z.boolean(),
    failedProviderAttempts: z.number().int().nonnegative(),
    actualModelIds: z.array(z.string().trim().min(1).max(300)).min(1),
  }),
  requiredScenarioIds: z.array(scenarioIdSchema).min(1),
  scenarios: z.array(scenarioSchema).min(1),
  performance: observedPerformanceSchema,
});

export type ProviderQualityReport = z.infer<typeof providerQualityReportSchema>;

export interface ProviderQualityNonInferiorityCheck {
  id: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface ProviderQualityScenarioComparison {
  scenarioId: string;
  passed: boolean;
  checks: ProviderQualityNonInferiorityCheck[];
}

function addCheck(
  checks: ProviderQualityNonInferiorityCheck[],
  id: string,
  passed: boolean,
  actual?: ProviderQualityNonInferiorityCheck["actual"],
  expected?: ProviderQualityNonInferiorityCheck["expected"],
) {
  checks.push({ id, passed, actual, expected });
}

function repositoryHeadIdentity(report: ProviderQualityReport) {
  return report.repositoryHeads
    .map((head) => `${head.repository.toLowerCase()}@${head.commitSha.toLowerCase()}`)
    .sort();
}

function averageRubricScore(
  quality: z.infer<typeof scenarioQualitySchema>,
) {
  return providerQualityDimensions.reduce(
    (sum, dimension) => sum + quality.rubric[dimension],
    0,
  ) / providerQualityDimensions.length;
}

function duplicateScenarioIds(report: ProviderQualityReport) {
  const counts = new Map<string, number>();
  for (const scenario of report.scenarios) {
    counts.set(scenario.id, (counts.get(scenario.id) ?? 0) + 1);
  }
  return Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([scenarioId]) => scenarioId)
    .sort();
}

function hasManualExactEvidenceProof(report: ProviderQualityReport) {
  const manual = report.scenarios.find((scenario) =>
    scenario.id === "manual_only_create"
  );
  const proof = manual?.quality.rubricEvidence?.specificity;
  return proof?.passed === true && proof.evidenceIds.includes(
    "manual_highlights_recover_exact_grounded_migration_note",
  );
}

function roundedMetric(value: number) {
  return Number(value.toFixed(12));
}

function performanceForScenarioIds(
  report: ProviderQualityReport,
  scenarioIds: ReadonlySet<string>,
) {
  const scenarios = report.scenarios.filter((scenario) =>
    scenarioIds.has(scenario.id)
  );
  return {
    latencyMs: scenarios.reduce(
      (sum, scenario) => sum + scenario.performance.latencyMs,
      0,
    ),
    observedEstimatedCostUsd: roundedMetric(scenarios.reduce(
      (sum, scenario) =>
        sum + scenario.performance.observedEstimatedCostUsd,
      0,
    )),
    observedGenerationRunCount: scenarios.reduce(
      (sum, scenario) =>
        sum + scenario.performance.observedGenerationRunCount,
      0,
    ),
    costCoverageComplete:
      scenarios.length > 0 &&
      scenarios.every((scenario) => scenario.performance.costCoverageComplete),
    usageComplete:
      scenarios.length > 0 &&
      scenarios.every((scenario) => scenario.performance.usageComplete),
  };
}

function samePerformance(
  left: z.infer<typeof observedPerformanceSchema>,
  right: z.infer<typeof observedPerformanceSchema>,
) {
  return left.latencyMs === right.latencyMs &&
    roundedMetric(left.observedEstimatedCostUsd) ===
      roundedMetric(right.observedEstimatedCostUsd) &&
    left.observedGenerationRunCount === right.observedGenerationRunCount &&
    left.costCoverageComplete === right.costCoverageComplete &&
    left.usageComplete === right.usageComplete;
}

function performanceDelta(
  baseline: z.infer<typeof observedPerformanceSchema>,
  candidate: z.infer<typeof observedPerformanceSchema>,
) {
  return {
    costDeltaUsd: roundedMetric(
      candidate.observedEstimatedCostUsd - baseline.observedEstimatedCostUsd,
    ),
    costRatio: baseline.observedEstimatedCostUsd === 0
      ? null
      : Number((
          candidate.observedEstimatedCostUsd /
          baseline.observedEstimatedCostUsd
        ).toFixed(6)),
    latencyDeltaMs: candidate.latencyMs - baseline.latencyMs,
    latencyRatio: baseline.latencyMs === 0
      ? null
      : Number((candidate.latencyMs / baseline.latencyMs).toFixed(6)),
  };
}

export function compareProviderQualityReports(input: {
  bedrock: unknown;
  openrouter: unknown;
  rubricMargin?: number;
}) {
  const bedrock = providerQualityReportSchema.parse(input.bedrock);
  const openrouter = providerQualityReportSchema.parse(input.openrouter);
  const rubricMargin = input.rubricMargin ?? 0.25;
  if (!Number.isFinite(rubricMargin) || rubricMargin < 0 || rubricMargin > 1) {
    throw new Error("The rubric non-inferiority margin must be between 0 and 1.");
  }

  const globalChecks: ProviderQualityNonInferiorityCheck[] = [];
  addCheck(
    globalChecks,
    "baseline_provider_is_bedrock",
    bedrock.provider === "bedrock",
    bedrock.provider,
    "bedrock",
  );
  addCheck(
    globalChecks,
    "candidate_provider_is_openrouter",
    openrouter.provider === "openrouter",
    openrouter.provider,
    "openrouter",
  );
  addCheck(
    globalChecks,
    "comparison_key_matches",
    bedrock.comparisonKey === openrouter.comparisonKey,
    openrouter.comparisonKey,
    bedrock.comparisonKey,
  );
  addCheck(
    globalChecks,
    "git_commit_matches",
    bedrock.gitCommit.toLowerCase() === openrouter.gitCommit.toLowerCase(),
    openrouter.gitCommit,
    bedrock.gitCommit,
  );
  addCheck(
    globalChecks,
    "repository_heads_match",
    JSON.stringify(repositoryHeadIdentity(bedrock)) ===
      JSON.stringify(repositoryHeadIdentity(openrouter)),
    repositoryHeadIdentity(openrouter).join(", "),
    repositoryHeadIdentity(bedrock).join(", "),
  );
  const bedrockRequiredScenarioIds = [...bedrock.requiredScenarioIds].sort();
  const openrouterRequiredScenarioIds = [...openrouter.requiredScenarioIds].sort();
  addCheck(
    globalChecks,
    "required_scenario_sets_match",
    JSON.stringify(bedrockRequiredScenarioIds) ===
      JSON.stringify(openrouterRequiredScenarioIds),
    openrouterRequiredScenarioIds.join(", "),
    bedrockRequiredScenarioIds.join(", "),
  );

  for (const [label, report] of [
    ["bedrock", bedrock],
    ["openrouter", openrouter],
  ] as const) {
    const duplicates = duplicateScenarioIds(report);
    const duplicateRequiredScenarioIds = report.requiredScenarioIds.filter(
      (scenarioId, index) => report.requiredScenarioIds.indexOf(scenarioId) !== index,
    );
    const scenarioIds = new Set(report.scenarios.map((scenario) => scenario.id));
    const missingDeclaredScenarios = report.requiredScenarioIds.filter(
      (scenarioId) => !scenarioIds.has(scenarioId),
    );
    const missingReleaseGateScenarios =
      providerQualityReleaseGateRequiredScenarioIds.filter(
        (scenarioId) => !report.requiredScenarioIds.includes(scenarioId),
      );
    addCheck(
      globalChecks,
      `${label}_scenario_ids_are_unique`,
      duplicates.length === 0,
      duplicates.join(", ") || "none",
      "none",
    );
    addCheck(
      globalChecks,
      `${label}_required_scenario_ids_are_unique`,
      duplicateRequiredScenarioIds.length === 0,
      Array.from(new Set(duplicateRequiredScenarioIds)).sort().join(", ") || "none",
      "none",
    );
    addCheck(
      globalChecks,
      `${label}_includes_every_declared_required_scenario`,
      missingDeclaredScenarios.length === 0,
      missingDeclaredScenarios.join(", ") || "none",
      "none",
    );
    addCheck(
      globalChecks,
      `${label}_declares_release_gate_scenarios`,
      missingReleaseGateScenarios.length === 0,
      missingReleaseGateScenarios.join(", ") || "none",
      "none",
    );
    addCheck(
      globalChecks,
      `${label}_attribution_is_authoritative`,
      report.attribution.authoritative,
      report.attribution.authoritative,
      true,
    );
    addCheck(
      globalChecks,
      `${label}_used_no_fallback`,
      !report.attribution.fallbackUsed,
      report.attribution.fallbackUsed,
      false,
    );
    addCheck(
      globalChecks,
      `${label}_had_no_failed_provider_attempts`,
      report.attribution.failedProviderAttempts === 0,
      report.attribution.failedProviderAttempts,
      0,
    );
    addCheck(
      globalChecks,
      `${label}_manual_exact_evidence_proof_is_present`,
      hasManualExactEvidenceProof(report),
      hasManualExactEvidenceProof(report),
      true,
    );
    const scenarioAggregate = performanceForScenarioIds(
      report,
      new Set(report.scenarios.map((scenario) => scenario.id)),
    );
    const incompleteScenarioCostIds = report.scenarios.filter((scenario) =>
      !scenario.performance.costCoverageComplete ||
      !scenario.performance.usageComplete
    ).map((scenario) => scenario.id).sort();
    addCheck(
      globalChecks,
      `${label}_every_scenario_has_complete_cost_coverage`,
      incompleteScenarioCostIds.length === 0,
      incompleteScenarioCostIds.join(", ") || "none",
      "none",
    );
    addCheck(
      globalChecks,
      `${label}_report_has_complete_cost_coverage`,
      report.performance.costCoverageComplete &&
        report.performance.usageComplete,
      `${report.performance.costCoverageComplete}/${report.performance.usageComplete}`,
      "true/true",
    );
    addCheck(
      globalChecks,
      `${label}_performance_aggregate_matches_scenarios`,
      samePerformance(report.performance, scenarioAggregate),
      JSON.stringify(report.performance),
      JSON.stringify(scenarioAggregate),
    );
  }

  const bedrockById = new Map(
    bedrock.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const openrouterById = new Map(
    openrouter.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const bedrockScenarioIds = Array.from(bedrockById.keys()).sort();
  const openrouterScenarioIds = Array.from(openrouterById.keys()).sort();
  addCheck(
    globalChecks,
    "scenario_sets_match",
    JSON.stringify(bedrockScenarioIds) === JSON.stringify(openrouterScenarioIds),
    openrouterScenarioIds.join(", "),
    bedrockScenarioIds.join(", "),
  );

  const scenarioIds = Array.from(new Set([
    ...bedrockScenarioIds,
    ...openrouterScenarioIds,
  ])).sort();
  const scenarios: ProviderQualityScenarioComparison[] = scenarioIds.map(
    (scenarioId) => {
      const checks: ProviderQualityNonInferiorityCheck[] = [];
      const baseline = bedrockById.get(scenarioId);
      const candidate = openrouterById.get(scenarioId);
      addCheck(
        checks,
        "paired_observations_exist",
        Boolean(baseline && candidate),
        `${Boolean(baseline)}/${Boolean(candidate)}`,
        "true/true",
      );
      if (!baseline || !candidate) {
        return { scenarioId, passed: false, checks };
      }

      addCheck(
        checks,
        "openrouter_absolute_gate_passed",
        candidate.passed,
        candidate.passed,
        true,
      );
      addCheck(
        checks,
        "openrouter_lifecycle_gate_passed",
        candidate.lifecycleGatePassed,
        candidate.lifecycleGatePassed,
        true,
      );
      addCheck(
        checks,
        "openrouter_has_no_hard_gate_failures",
        candidate.hardGateFailures.length === 0,
        candidate.hardGateFailures.join(", ") || "none",
        "none",
      );
      addCheck(
        checks,
        "openrouter_passes_every_bedrock_pass",
        !baseline.passed || candidate.passed,
        candidate.passed,
        baseline.passed,
      );
      addCheck(
        checks,
        "openrouter_grounded_claim_precision_is_perfect",
        candidate.quality.groundedClaimPrecision === 1,
        candidate.quality.groundedClaimPrecision,
        1,
      );
      addCheck(
        checks,
        "openrouter_capability_recall_is_not_lower",
        candidate.quality.requiredCapabilityRecall >=
          baseline.quality.requiredCapabilityRecall,
        candidate.quality.requiredCapabilityRecall,
        baseline.quality.requiredCapabilityRecall,
      );
      for (const metric of [
        "unsupportedClaimCount",
        "staleClaimCount",
        "duplicateHighlightCount",
      ] as const) {
        addCheck(
          checks,
          `openrouter_${metric}_is_zero`,
          candidate.quality[metric] === 0,
          candidate.quality[metric],
          0,
        );
        addCheck(
          checks,
          `openrouter_${metric}_is_not_worse`,
          candidate.quality[metric] <= baseline.quality[metric],
          candidate.quality[metric],
          baseline.quality[metric],
        );
      }
      for (const dimension of providerQualityDimensions) {
        const minimum = baseline.quality.rubric[dimension] - rubricMargin;
        addCheck(
          checks,
          `openrouter_${dimension}_is_non_inferior`,
          candidate.quality.rubric[dimension] >= minimum,
          candidate.quality.rubric[dimension],
          minimum,
        );
      }
      const baselineAverage = averageRubricScore(baseline.quality);
      const candidateAverage = averageRubricScore(candidate.quality);
      addCheck(
        checks,
        "openrouter_average_rubric_is_non_inferior",
        candidateAverage >= baselineAverage - rubricMargin,
        Number(candidateAverage.toFixed(4)),
        Number((baselineAverage - rubricMargin).toFixed(4)),
      );

      return {
        scenarioId,
        passed: checks.every((check) => check.passed),
        checks,
      };
    },
  );

  const lifecycleScenarioIdSet = new Set<string>(workItemLifecycleScenarioIds);
  const accomplishmentScenarioIdSet = new Set<string>([
    "strongest_accomplishments",
    "strongest_accomplishments_freshness_follow_up",
  ]);
  const allBedrockScenarioIds = new Set(
    bedrock.scenarios.map((scenario) => scenario.id),
  );
  const allOpenRouterScenarioIds = new Set(
    openrouter.scenarios.map((scenario) => scenario.id),
  );
  const bedrockPerformance = {
    lifecycle: performanceForScenarioIds(bedrock, lifecycleScenarioIdSet),
    accomplishments: performanceForScenarioIds(
      bedrock,
      accomplishmentScenarioIdSet,
    ),
    total: performanceForScenarioIds(bedrock, allBedrockScenarioIds),
  };
  const openrouterPerformance = {
    lifecycle: performanceForScenarioIds(openrouter, lifecycleScenarioIdSet),
    accomplishments: performanceForScenarioIds(
      openrouter,
      accomplishmentScenarioIdSet,
    ),
    total: performanceForScenarioIds(openrouter, allOpenRouterScenarioIds),
  };
  addCheck(
    globalChecks,
    "openrouter_measured_total_cost_does_not_exceed_bedrock",
    openrouterPerformance.total.observedEstimatedCostUsd <=
      bedrockPerformance.total.observedEstimatedCostUsd,
    openrouterPerformance.total.observedEstimatedCostUsd,
    bedrockPerformance.total.observedEstimatedCostUsd,
  );
  const performance = {
    bedrock: bedrockPerformance,
    openrouter: openrouterPerformance,
    matchedDeltas: {
      lifecycle: performanceDelta(
        bedrockPerformance.lifecycle,
        openrouterPerformance.lifecycle,
      ),
      accomplishments: performanceDelta(
        bedrockPerformance.accomplishments,
        openrouterPerformance.accomplishments,
      ),
      total: performanceDelta(
        bedrockPerformance.total,
        openrouterPerformance.total,
      ),
    },
  };

  return {
    schemaVersion: PROVIDER_QUALITY_COMPARISON_SCHEMA_VERSION,
    passed: globalChecks.every((check) => check.passed) &&
      scenarios.every((scenario) => scenario.passed),
    rubricMargin,
    bedrock: {
      comparisonKey: bedrock.comparisonKey,
      gitCommit: bedrock.gitCommit,
      actualModelIds: bedrock.attribution.actualModelIds,
    },
    openrouter: {
      comparisonKey: openrouter.comparisonKey,
      gitCommit: openrouter.gitCommit,
      actualModelIds: openrouter.attribution.actualModelIds,
    },
    performance,
    globalChecks,
    scenarios,
  };
}
