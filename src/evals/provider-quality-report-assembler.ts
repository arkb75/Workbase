import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PROVIDER_QUALITY_REPORT_SCHEMA_VERSION,
  providerQualityDimensions,
  providerQualityReleaseGateRequiredScenarioIds,
  providerQualityReportSchema,
  type ProviderQualityDimension,
} from "@/src/evals/provider-quality-noninferiority";
import {
  REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION,
  REPOSITORY_ACCOMPLISHMENTS_REPORT_SCHEMA_VERSION,
  parseRepositoryAccomplishmentsProfile,
  repositoryAccomplishmentsComparisonKey,
} from "@/src/evals/repository-accomplishments-quality";
import {
  WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
  workItemLifecycleScenarioIds,
} from "@/src/evals/work-item-lifecycle-release-gate";

const providerSchema = z.enum(["bedrock", "openrouter"]);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/iu);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
const identifierSchema = z.string().trim().min(1).max(300);
const regexPatternSchema = z.string().trim().min(1).max(500).refine(
  (pattern) => {
    try {
      new RegExp(pattern, "iu");
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid regular expression." },
);
const nonnegativeInteger = z.number().int().nonnegative();
const EXPECTED_EXACT_MANUAL_HIGHLIGHT =
  "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.";
const EXPECTED_MANUAL_EVIDENCE_CONTENT_SHA256 =
  "55fa96b3c94df35255760c7788f242f8c399d10fdbdaaff1f3f33d8c7f8ae697";

const failedCheckSchema = z.object({
  id: identifierSchema,
  passed: z.literal(false),
}).passthrough();

const lifecycleGateScenarioSchema = z.object({
  id: z.enum(workItemLifecycleScenarioIds),
  provider: providerSchema,
  passed: z.boolean(),
  repository: identifierSchema.nullable(),
  expectedHeadSha: shaSchema.nullable(),
  automaticHighlightCount: nonnegativeInteger,
  totalLatencyMs: z.number().nonnegative(),
  failedChecks: z.array(failedCheckSchema),
}).passthrough();

const lifecycleGateReportSchema = z.object({
  schemaVersion: z.literal(WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION),
  gitCommit: shaSchema,
  passed: z.boolean(),
  evaluatedScenarios: nonnegativeInteger,
  missingScenarioIds: z.array(z.enum(workItemLifecycleScenarioIds)),
  duplicateScenarioIds: z.array(z.enum(workItemLifecycleScenarioIds)),
  aggregate: z.object({
    totalLatencyMs: z.number().nonnegative(),
    automaticHighlights: nonnegativeInteger,
    failedChecks: nonnegativeInteger,
  }).passthrough(),
  scenarios: z.array(lifecycleGateScenarioSchema),
}).passthrough();

const generationRunSchema = z.object({
  id: identifierSchema,
  kind: identifierSchema,
  status: identifierSchema,
  provider: identifierSchema,
  configuredProvider: identifierSchema.nullable(),
  modelId: identifierSchema,
  configuredModelId: identifierSchema.nullable(),
  requestIds: z.array(identifierSchema),
  tokenUsage: z.unknown().nullable(),
  tokenUsagePresent: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  usageComplete: z.boolean().nullable(),
  auditAttemptCount: nonnegativeInteger.nullable(),
  providerAttemptCount: nonnegativeInteger.nullable(),
  failedProviderAttempts: nonnegativeInteger.nullable(),
  unknownUsageAttempts: nonnegativeInteger.nullable(),
  auditEvidenceTruncated: z.boolean().nullable(),
  role: z.enum(["provider_call", "verification_aggregate"]),
}).passthrough();

const lifecycleHighlightSchema = z.object({
  id: identifierSchema,
  text: z.string().trim().min(1),
  lifecycleStatus: identifierSchema,
  generationStrategy: identifierSchema.nullable().optional(),
  extractivePolicyVersion: identifierSchema.nullable().optional(),
  evidence: z.array(z.object({
    evidenceItemId: identifierSchema,
    sourceId: identifierSchema,
    sourceType: identifierSchema,
    contentSha256: sha256Schema.nullable().optional(),
    content: z.never().optional(),
  }).passthrough()),
  validatedThroughSha: shaSchema.nullable(),
  validationHeads: z.array(z.object({
    sourceId: identifierSchema,
    repository: identifierSchema,
    commitSha: shaSchema,
  }).passthrough()),
}).passthrough();

const lifecycleObservationBaseSchema = z.object({
  schemaVersion: z.literal(WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION),
  scenarioId: z.enum(workItemLifecycleScenarioIds),
  provider: providerSchema,
  currentLineage: z.object({
    generationRunIds: z.array(identifierSchema),
  }).passthrough(),
  timingsMs: z.object({ total: z.number().nonnegative() }).passthrough(),
  automaticHighlights: z.array(lifecycleHighlightSchema),
}).passthrough();

const manualLifecycleObservationSchema = lifecycleObservationBaseSchema.extend({
  scenarioId: z.literal("manual_only_create"),
  manualEvidence: z.object({
    sourceIds: z.array(identifierSchema).min(1),
    evidenceItemIds: z.array(identifierSchema).min(1),
  }),
  manualAgentRun: z.object({
    result: z.object({
      generationRunIds: z.array(identifierSchema),
    }).passthrough().nullable(),
    generationRuns: z.array(generationRunSchema),
  }).passthrough(),
});

const repositoryLifecycleObservationSchema = lifecycleObservationBaseSchema.extend({
  scenarioId: z.enum([
    "empty_create_attach",
    "existing_attach",
    "completed_delete_readd_same_repo",
  ]),
  repository: z.object({
    sourceId: identifierSchema,
    fullName: identifierSchema,
    expectedHeadSha: shaSchema,
  }).passthrough(),
  automation: z.object({
    generationRunIds: z.array(identifierSchema),
    observedProviders: z.array(identifierSchema),
    observedModelIds: z.array(identifierSchema),
    capabilitySynthesisRuns: z.array(generationRunSchema),
    generationRuns: z.array(generationRunSchema),
  }).passthrough(),
  priorLineage: z.object({
    generationRunIds: z.array(identifierSchema),
    generationRuns: z.array(generationRunSchema),
  }).passthrough().nullable(),
});

const lifecycleObservationSchema = z.discriminatedUnion("scenarioId", [
  manualLifecycleObservationSchema,
  repositoryLifecycleObservationSchema,
]);

const lifecycleObservationReportSchema = z.object({
  schemaVersion: z.literal(WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION),
  gitCommit: shaSchema,
  observations: z.array(lifecycleObservationSchema),
}).passthrough();

const modelAttributionSchema = z.object({
  actualModelIds: z.array(identifierSchema),
  failedProviderAttempts: nonnegativeInteger,
  fallbackUsed: z.boolean(),
  authoritativeAttributionComplete: z.boolean(),
}).passthrough();

const accomplishmentsProfileSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION),
  workItemTitle: identifierSchema,
  repository: identifierSchema,
  requiredCapabilityPatterns: z.array(regexPatternSchema).min(1).max(12),
  forbiddenAnswerPatterns: z.array(regexPatternSchema).max(12),
  includeFreshnessFollowUp: z.literal(true),
  minimumPrimaryItems: z.number().int().min(1).max(6),
  maximumPrimaryItems: z.number().int().min(1).max(6),
  minimumDevelopedItems: z.number().int().min(1).max(6),
  minimumCitedItems: z.number().int().min(1).max(6),
  minimumCharacters: z.number().int().min(200).max(10_000),
  maximumCharacters: z.number().int().min(500).max(20_000),
}).strict();

const accomplishmentsScenarioSchema = z.object({
  id: z.enum([
    "strongest_accomplishments",
    "strongest_accomplishments_freshness_follow_up",
  ]),
  passed: z.boolean(),
  outcome: identifierSchema,
  answer: z.string(),
  metrics: z.object({
    latencyMs: z.number().nonnegative(),
    modelCalls: nonnegativeInteger,
    estimatedCostUsd: z.number().nonnegative(),
    usageComplete: z.boolean(),
    modelAttribution: modelAttributionSchema,
  }).passthrough(),
  quality: z.object({
    passed: z.boolean(),
    checks: z.array(z.object({
      name: identifierSchema,
      passed: z.boolean(),
    }).passthrough()),
    primaryItemCount: nonnegativeInteger,
    developedItemCount: nonnegativeInteger.nullable(),
    citedItemCount: nonnegativeInteger.nullable(),
    requiredCapabilityRecall: z.number().min(0).max(1),
    repositoryCitationFreshness: z.object({
      targetHeads: z.array(z.object({
        sourceId: identifierSchema,
        repository: identifierSchema,
        commitSha: shaSchema,
      }).passthrough()),
      repositoryDerivedCitationCount: nonnegativeInteger,
      currentRepositoryDerivedCitationCount: nonnegativeInteger,
      staleCitationOrdinals: z.array(nonnegativeInteger),
    }).nullable(),
  }).passthrough(),
  failedChecks: z.array(z.object({
    name: identifierSchema,
    passed: z.literal(false),
  }).passthrough()),
}).passthrough();

const accomplishmentsReportSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_ACCOMPLISHMENTS_REPORT_SCHEMA_VERSION),
  gitCommit: shaSchema,
  passed: z.boolean(),
  provider: providerSchema,
  comparisonKey: identifierSchema,
  profile: accomplishmentsProfileSchema,
  target: z.object({
    workItemId: identifierSchema,
    workItemTitle: identifierSchema,
    sourceId: identifierSchema,
    repository: identifierSchema,
    commitSha: shaSchema,
    evidenceItemCount: nonnegativeInteger.nullable(),
  }).strict(),
  performance: z.object({
    latencyMs: z.number().nonnegative(),
    modelCalls: nonnegativeInteger,
    estimatedCostUsd: z.number().nonnegative(),
    usageComplete: z.boolean(),
  }).passthrough(),
  attribution: modelAttributionSchema,
  scenarios: z.array(accomplishmentsScenarioSchema),
}).passthrough();

type LifecycleGateReport = z.infer<typeof lifecycleGateReportSchema>;
type LifecycleObservation = z.infer<typeof lifecycleObservationSchema>;
type AccomplishmentsReport = z.infer<typeof accomplishmentsReportSchema>;

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sortedUnique(values: readonly string[]) {
  return Array.from(new Set(values)).sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertExactScenarioSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
) {
  if (!sameStrings(actual, expected) || new Set(actual).size !== actual.length) {
    throw new Error(
      `${label} scenario mismatch: expected ${[...expected].sort().join(", ")}; received ${[...actual].sort().join(", ") || "none"}.`,
    );
  }
}

function assertArtifactCommit(
  artifact: unknown,
  expectedCommit: string,
  label: string,
) {
  const value = recordValue(artifact)?.gitCommit;
  if (value === undefined) {
    throw new Error(`${label} is missing gitCommit; rerun it from the tested revision.`);
  }
  if (typeof value !== "string" || !shaSchema.safeParse(value).success) {
    throw new Error(`${label} gitCommit is not a full 40-character SHA.`);
  }
  if (value.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(
      `${label} commit mismatch: expected ${expectedCommit}; received ${value}.`,
    );
  }
}

function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function roundedCost(value: number) {
  return Number(value.toFixed(12));
}

function rubricEntry(
  checks: ReadonlyArray<{ id: string; passed: boolean }>,
) {
  if (!checks.length) throw new Error("Every rubric dimension needs deterministic evidence.");
  const passed = checks.every((check) => check.passed);
  return {
    score: passed ? 5 : 0,
    evidence: {
      passed,
      evidenceIds: checks.map((check) => check.id),
    },
  };
}

function qualityRubric(
  evidence: Record<
    ProviderQualityDimension,
    ReadonlyArray<{ id: string; passed: boolean }>
  >,
) {
  const entries = Object.fromEntries(providerQualityDimensions.map((dimension) => [
    dimension,
    rubricEntry(evidence[dimension]),
  ])) as Record<
    ProviderQualityDimension,
    ReturnType<typeof rubricEntry>
  >;
  return {
    rubric: Object.fromEntries(providerQualityDimensions.map((dimension) => [
      dimension,
      entries[dimension].score,
    ])) as Record<ProviderQualityDimension, number>,
    rubricEvidence: Object.fromEntries(providerQualityDimensions.map((dimension) => [
      dimension,
      entries[dimension].evidence,
    ])) as Record<
      ProviderQualityDimension,
      ReturnType<typeof rubricEntry>["evidence"]
    >,
  };
}

function providerRuns(observation: LifecycleObservation) {
  return observation.scenarioId === "manual_only_create"
    ? observation.manualAgentRun.generationRuns.filter((run) =>
        run.role === "provider_call"
      )
    : [
        ...observation.automation.generationRuns,
        ...(observation.priorLineage?.generationRuns ?? []),
      ].filter((run) => run.role === "provider_call");
}

function generationRunIds(observation: LifecycleObservation) {
  return providerRuns(observation).map((run) => run.id);
}

function assertGenerationRunCoverage(observation: LifecycleObservation) {
  const currentRuns = observation.scenarioId === "manual_only_create"
    ? observation.manualAgentRun.generationRuns
    : observation.automation.generationRuns;
  if (
    !sameStrings(
      currentRuns.map((run) => run.id),
      observation.currentLineage.generationRunIds,
    ) || new Set(currentRuns.map((run) => run.id)).size !== currentRuns.length
  ) {
    throw new Error(
      `Lifecycle GenerationRun telemetry does not cover current lineage for ${observation.scenarioId}.`,
    );
  }
  if (observation.scenarioId === "manual_only_create") return;
  if (!observation.automation.generationRunIds.every((id) =>
    currentRuns.some((run) => run.id === id)
  )) {
    throw new Error(
      `Lifecycle automation GenerationRun telemetry is incomplete for ${observation.scenarioId}.`,
    );
  }
  const prior = observation.priorLineage;
  if (prior && (
    !sameStrings(
      prior.generationRuns.map((run) => run.id),
      prior.generationRunIds,
    ) || new Set(prior.generationRuns.map((run) => run.id)).size !==
      prior.generationRuns.length
  )) {
    throw new Error(
      `Lifecycle GenerationRun telemetry does not cover deleted prior lineage for ${observation.scenarioId}.`,
    );
  }
}

function runIsAuthoritative(run: z.infer<typeof generationRunSchema>) {
  return run.role === "provider_call" &&
    run.status === "success" &&
    run.configuredProvider?.toLowerCase() === run.provider.toLowerCase() &&
    run.configuredModelId === run.modelId &&
    run.requestIds.length > 0 &&
    new Set(run.requestIds).size === run.requestIds.length &&
    run.tokenUsage !== null &&
    run.tokenUsagePresent &&
    run.estimatedCostUsd !== null &&
    run.usageComplete === true &&
    (run.auditAttemptCount ?? 0) > 0 &&
    run.providerAttemptCount === run.auditAttemptCount &&
    run.requestIds.length === run.auditAttemptCount &&
    run.failedProviderAttempts === 0 &&
    run.unknownUsageAttempts === 0 &&
    run.auditEvidenceTruncated === false;
}

function observationQuality(
  observation: LifecycleObservation,
  gateScenario: z.infer<typeof lifecycleGateScenarioSchema>,
) {
  const eligibleHighlights = observation.automaticHighlights.filter((highlight) =>
    ["active", "needs_validation", "quarantined"].includes(
      highlight.lifecycleStatus,
    )
  );
  const invalidEvidenceIds = new Set<string>();
  const staleIds = new Set<string>();
  for (const highlight of eligibleHighlights) {
    if (!highlight.evidence.length) invalidEvidenceIds.add(highlight.id);
    if (observation.scenarioId === "manual_only_create") {
      const sourceIds = new Set(observation.manualEvidence.sourceIds);
      const evidenceItemIds = new Set(observation.manualEvidence.evidenceItemIds);
      if (!highlight.evidence.every((entry) =>
        entry.sourceType === "manual_note" &&
        sourceIds.has(entry.sourceId) &&
        evidenceItemIds.has(entry.evidenceItemId)
      )) invalidEvidenceIds.add(highlight.id);
      continue;
    }
    const repositoryEvidence = highlight.evidence.filter((entry) =>
      entry.sourceType === "github_repo"
    );
    if (!highlight.evidence.every((entry) =>
      entry.sourceType === "manual_note" ||
      (
        entry.sourceType === "github_repo" &&
        entry.sourceId === observation.repository.sourceId
      )
    )) invalidEvidenceIds.add(highlight.id);
    if (repositoryEvidence.length) {
      const exactHead =
        highlight.validatedThroughSha?.toLowerCase() ===
          observation.repository.expectedHeadSha.toLowerCase() &&
        highlight.validationHeads.length === 1 &&
        highlight.validationHeads[0]?.sourceId === observation.repository.sourceId &&
        highlight.validationHeads[0]?.repository.toLowerCase() ===
          observation.repository.fullName.toLowerCase() &&
        highlight.validationHeads[0]?.commitSha.toLowerCase() ===
          observation.repository.expectedHeadSha.toLowerCase();
      if (!exactHead) staleIds.add(highlight.id);
    }
  }
  const normalizedTexts = eligibleHighlights.map((highlight) =>
    normalizeText(highlight.text)
  );
  const duplicateHighlightCount = normalizedTexts.length -
    new Set(normalizedTexts).size;
  const invalidClaimIds = new Set([...invalidEvidenceIds, ...staleIds]);
  const groundedClaimPrecision = eligibleHighlights.length
    ? Number((
        (eligibleHighlights.length - invalidClaimIds.size) /
        eligibleHighlights.length
      ).toFixed(6))
    : 0;
  const exactIdentity = observation.scenarioId === "manual_only_create"
    ? hasPrivateManualEvidenceProof(observation)
    : gateScenario.repository?.toLowerCase() ===
        observation.repository.fullName.toLowerCase() &&
      gateScenario.expectedHeadSha?.toLowerCase() ===
        observation.repository.expectedHeadSha.toLowerCase();
  const gatePassed = gateScenario.passed;
  const evidenceFidelity = groundedClaimPrecision === 1 &&
    invalidEvidenceIds.size === 0 && staleIds.size === 0;
  const useful = eligibleHighlights.length > 0;
  const prioritized = duplicateHighlightCount === 0;
  const rubric = qualityRubric({
    correctness: [{ id: "lifecycle_gate_passed", passed: gatePassed }],
    evidenceFidelity: [
      { id: "all_eligible_highlights_are_grounded", passed: evidenceFidelity },
      { id: "grounded_claim_precision_is_one", passed: groundedClaimPrecision === 1 },
    ],
    usefulness: [{ id: "eligible_automatic_highlights_exist", passed: useful }],
    prioritization: [{ id: "eligible_highlight_text_is_unique", passed: prioritized }],
    specificity: [{
      id: observation.scenarioId === "manual_only_create"
        ? "manual_highlights_recover_exact_grounded_migration_note"
        : "exact_repository_head_identity_matches",
      passed: exactIdentity,
    }],
    instructionAdherence: [
      { id: "declared_provider_matches_run", passed: observation.provider === gateScenario.provider },
      { id: "all_lifecycle_hard_checks_passed", passed: gatePassed },
    ],
  });
  return {
    ...rubric,
    groundedClaimPrecision,
    requiredCapabilityRecall: gatePassed && useful ? 1 : 0,
    unsupportedClaimCount: invalidEvidenceIds.size,
    staleClaimCount: staleIds.size,
    duplicateHighlightCount,
  };
}

function accomplishmentQuality(
  scenario: z.infer<typeof accomplishmentsScenarioSchema>,
  report: AccomplishmentsReport,
) {
  const quality = scenario.quality;
  const requiredCapabilityMatches = report.profile.requiredCapabilityPatterns.map(
    (pattern) => new RegExp(pattern, "iu").test(scenario.answer),
  );
  const requiredCapabilityRecall = Number((
    requiredCapabilityMatches.filter(Boolean).length /
    requiredCapabilityMatches.length
  ).toFixed(6));
  if (quality.requiredCapabilityRecall !== requiredCapabilityRecall) {
    throw new Error(
      `Accomplishments required-capability recall mismatch for ${scenario.id}.`,
    );
  }
  const forbiddenAnswerMatches = report.profile.forbiddenAnswerPatterns.filter(
    (pattern) => new RegExp(pattern, "iu").test(scenario.answer),
  );
  const freshness = quality.repositoryCitationFreshness;
  const primaryItems = quality.primaryItemCount;
  const developedItems = quality.developedItemCount ?? 0;
  const citedItems = quality.citedItemCount ?? 0;
  const currentCitationRatio = freshness?.repositoryDerivedCitationCount
    ? freshness.currentRepositoryDerivedCitationCount /
      freshness.repositoryDerivedCitationCount
    : 0;
  const groundedClaimPrecision = primaryItems
    ? Number((
        Math.min(primaryItems, citedItems) / primaryItems * currentCitationRatio
      ).toFixed(6))
    : 0;
  const staleClaimCount = freshness?.staleCitationOrdinals.length ?? 0;
  const unsupportedClaimCount = Math.max(0, primaryItems - citedItems);
  const exactHead = freshness?.targetHeads.length === 1 &&
    freshness.targetHeads[0]?.sourceId === report.target.sourceId &&
    freshness.targetHeads[0]?.repository.toLowerCase() ===
      report.target.repository.toLowerCase() &&
    freshness.targetHeads[0]?.commitSha.toLowerCase() ===
      report.target.commitSha.toLowerCase();
  const citationsCurrent = currentCitationRatio === 1 && staleClaimCount === 0;
  const hardGateFailures = sortedUnique([
    ...scenario.failedChecks.map((check) => check.name),
    ...quality.checks.filter((check) => !check.passed).map((check) => check.name),
    ...(scenario.outcome === "answered" ? [] : [`outcome_${scenario.outcome}`]),
    ...forbiddenAnswerMatches.map((pattern) =>
      `forbidden_answer_pattern_sha256:${createHash("sha256").update(pattern).digest("hex").slice(0, 16)}`
    ),
  ]);
  const rubric = qualityRubric({
    correctness: [
      { id: "scenario_quality_passed", passed: scenario.passed && quality.passed },
      { id: "all_primary_items_are_grounded", passed: groundedClaimPrecision === 1 },
      { id: "no_stale_citations", passed: staleClaimCount === 0 },
    ],
    evidenceFidelity: [
      { id: "exact_target_head_is_cited", passed: exactHead },
      { id: "repository_citations_exist", passed: (freshness?.repositoryDerivedCitationCount ?? 0) > 0 },
      { id: "all_repository_citations_are_current", passed: citationsCurrent },
    ],
    usefulness: [
      { id: "minimum_primary_items_met", passed: primaryItems >= report.profile.minimumPrimaryItems },
      { id: "minimum_developed_items_met", passed: developedItems >= report.profile.minimumDevelopedItems },
      { id: "all_required_capabilities_recalled", passed: requiredCapabilityRecall === 1 },
    ],
    prioritization: [
      { id: "minimum_primary_items_met", passed: primaryItems >= report.profile.minimumPrimaryItems },
      { id: "maximum_primary_items_respected", passed: primaryItems <= report.profile.maximumPrimaryItems },
    ],
    specificity: [
      { id: "minimum_cited_items_met", passed: citedItems >= report.profile.minimumCitedItems },
      { id: "all_required_capabilities_recalled", passed: requiredCapabilityRecall === 1 },
    ],
    instructionAdherence: [
      { id: "answer_outcome_is_answered", passed: scenario.outcome === "answered" },
      { id: "answer_meets_minimum_length", passed: scenario.answer.length >= report.profile.minimumCharacters },
      { id: "answer_respects_maximum_length", passed: scenario.answer.length <= report.profile.maximumCharacters },
      { id: "no_forbidden_answer_patterns", passed: forbiddenAnswerMatches.length === 0 },
      { id: "no_hard_gate_failures", passed: hardGateFailures.length === 0 },
    ],
  });
  return {
    passed:
      scenario.passed && quality.passed &&
      Object.values(rubric.rubric).every((score) => score === 5),
    hardGateFailures,
    quality: {
      ...rubric,
      groundedClaimPrecision,
      requiredCapabilityRecall,
      unsupportedClaimCount,
      staleClaimCount,
      duplicateHighlightCount: 0,
    },
  };
}

function assertGateIntegrity(gate: LifecycleGateReport) {
  assertExactScenarioSet(
    gate.scenarios.map((scenario) => scenario.id),
    workItemLifecycleScenarioIds,
    "Lifecycle gate",
  );
  if (
    gate.evaluatedScenarios !== gate.scenarios.length ||
    gate.missingScenarioIds.length ||
    gate.duplicateScenarioIds.length
  ) {
    throw new Error("Lifecycle gate scenario accounting is incomplete or duplicated.");
  }
  for (const scenario of gate.scenarios) {
    if (scenario.passed !== (scenario.failedChecks.length === 0)) {
      throw new Error(`Lifecycle gate pass/failure mismatch for ${scenario.id}.`);
    }
  }
  const expectedPassed = gate.scenarios.every((scenario) => scenario.passed);
  const expectedLatency = gate.scenarios.reduce(
    (sum, scenario) => sum + scenario.totalLatencyMs,
    0,
  );
  const expectedHighlights = gate.scenarios.reduce(
    (sum, scenario) => sum + scenario.automaticHighlightCount,
    0,
  );
  const expectedFailedChecks = gate.scenarios.reduce(
    (sum, scenario) => sum + scenario.failedChecks.length,
    0,
  );
  if (
    gate.passed !== expectedPassed ||
    gate.aggregate.totalLatencyMs !== expectedLatency ||
    gate.aggregate.automaticHighlights !== expectedHighlights ||
    gate.aggregate.failedChecks !== expectedFailedChecks
  ) {
    throw new Error("Lifecycle gate aggregate does not match its scenarios.");
  }
}

function hasPrivateManualEvidenceProof(
  observation: Extract<LifecycleObservation, { scenarioId: "manual_only_create" }>,
) {
  const exact = observation.automaticHighlights.filter((highlight) =>
    highlight.text === EXPECTED_EXACT_MANUAL_HIGHLIGHT &&
    highlight.generationStrategy === "exact_manual_evidence_fallback" &&
    highlight.extractivePolicyVersion === "manual-evidence-extractive-v1" &&
    highlight.evidence.length === 1 &&
    highlight.evidence[0]?.sourceType === "manual_note" &&
    highlight.evidence[0]?.contentSha256 ===
      EXPECTED_MANUAL_EVIDENCE_CONTENT_SHA256
  );
  return exact.length === 1;
}

function assertPrivateManualEvidenceProof(
  observation: Extract<LifecycleObservation, { scenarioId: "manual_only_create" }>,
) {
  if (!hasPrivateManualEvidenceProof(observation)) {
    throw new Error(
      "Manual lifecycle observation is missing the privacy-preserving exact extractive Evidence proof.",
    );
  }
}

export function assembleProviderQualityReport(input: {
  provider: "bedrock" | "openrouter";
  gitCommit: string;
  lifecycleGate: unknown;
  lifecycleObservations: unknown;
  accomplishments: unknown;
}) {
  const gitCommit = shaSchema.parse(input.gitCommit).toLowerCase();
  assertArtifactCommit(input.lifecycleGate, gitCommit, "Lifecycle gate");
  assertArtifactCommit(
    input.lifecycleObservations,
    gitCommit,
    "Lifecycle observation report",
  );
  assertArtifactCommit(input.accomplishments, gitCommit, "Accomplishments report");

  const gate = lifecycleGateReportSchema.parse(input.lifecycleGate);
  const observationsReport = lifecycleObservationReportSchema.parse(
    input.lifecycleObservations,
  );
  const accomplishments = accomplishmentsReportSchema.parse(input.accomplishments);
  const normalizedAccomplishmentsProfile = parseRepositoryAccomplishmentsProfile(
    accomplishments.profile,
  );
  assertGateIntegrity(gate);
  const manualObservation = observationsReport.observations.find(
    (observation) => observation.scenarioId === "manual_only_create",
  );
  if (!manualObservation || manualObservation.scenarioId !== "manual_only_create") {
    throw new Error("Lifecycle observations are missing manual_only_create.");
  }
  assertPrivateManualEvidenceProof(manualObservation);
  assertExactScenarioSet(
    observationsReport.observations.map((observation) => observation.scenarioId),
    workItemLifecycleScenarioIds,
    "Lifecycle observations",
  );
  assertExactScenarioSet(
    accomplishments.scenarios.map((scenario) => scenario.id),
    [
      "strongest_accomplishments",
      "strongest_accomplishments_freshness_follow_up",
    ],
    "Accomplishments report",
  );

  if (
    gate.scenarios.some((scenario) => scenario.provider !== input.provider) ||
    observationsReport.observations.some((observation) =>
      observation.provider !== input.provider
    ) ||
    accomplishments.provider !== input.provider
  ) {
    throw new Error(`Provider mismatch: every artifact must be ${input.provider}.`);
  }

  if (
    normalizedAccomplishmentsProfile.workItemTitle !==
      accomplishments.target.workItemTitle ||
    normalizedAccomplishmentsProfile.repository !==
      accomplishments.target.repository
  ) {
    throw new Error(
      "Accomplishments profile and target title/repository do not match exactly.",
    );
  }
  const targetRepository = accomplishments.target.repository.toLowerCase();
  const targetHead = accomplishments.target.commitSha.toLowerCase();
  const expectedComparisonKey = repositoryAccomplishmentsComparisonKey(
    normalizedAccomplishmentsProfile,
    accomplishments.target,
  );
  if (accomplishments.comparisonKey !== expectedComparisonKey) {
    throw new Error(
      "Accomplishments comparison key does not match its complete quality profile and repository head.",
    );
  }

  const gatesById = new Map(gate.scenarios.map((scenario) => [scenario.id, scenario]));
  const observationsById = new Map(
    observationsReport.observations.map((observation) => [
      observation.scenarioId,
      observation,
    ]),
  );
  for (const scenarioId of workItemLifecycleScenarioIds) {
    const gateScenario = gatesById.get(scenarioId)!;
    const observation = observationsById.get(scenarioId)!;
    assertGenerationRunCoverage(observation);
    if (
      gateScenario.totalLatencyMs !== observation.timingsMs.total ||
      gateScenario.automaticHighlightCount !== observation.automaticHighlights.length
    ) {
      throw new Error(`Lifecycle observation/gate mismatch for ${scenarioId}.`);
    }
    if (observation.scenarioId === "manual_only_create") {
      if (gateScenario.repository !== null || gateScenario.expectedHeadSha !== null) {
        throw new Error("Manual lifecycle scenario unexpectedly declared a repository head.");
      }
      continue;
    }
    if (
      gateScenario.repository?.toLowerCase() !==
        observation.repository.fullName.toLowerCase() ||
      gateScenario.expectedHeadSha?.toLowerCase() !==
        observation.repository.expectedHeadSha.toLowerCase()
    ) {
      throw new Error(`Lifecycle observation/gate head mismatch for ${scenarioId}.`);
    }
    if (
      observation.repository.fullName.toLowerCase() !== targetRepository ||
      observation.repository.expectedHeadSha.toLowerCase() !== targetHead
    ) {
      throw new Error(`Repository head mismatch for ${scenarioId}.`);
    }
  }

  for (const scenario of accomplishments.scenarios) {
    const targetHeads = scenario.quality.repositoryCitationFreshness?.targetHeads ?? [];
    if (
      targetHeads.length !== 1 ||
      targetHeads[0]?.sourceId !== accomplishments.target.sourceId ||
      targetHeads[0]?.repository.toLowerCase() !== targetRepository ||
      targetHeads[0]?.commitSha.toLowerCase() !== targetHead
    ) {
      throw new Error(`Accomplishments head mismatch for ${scenario.id}.`);
    }
  }
  const accomplishmentLatencyMs = accomplishments.scenarios.reduce(
    (sum, scenario) => sum + scenario.metrics.latencyMs,
    0,
  );
  const accomplishmentModelCalls = accomplishments.scenarios.reduce(
    (sum, scenario) => sum + scenario.metrics.modelCalls,
    0,
  );
  const accomplishmentCostUsd = roundedCost(accomplishments.scenarios.reduce(
    (sum, scenario) => sum + scenario.metrics.estimatedCostUsd,
    0,
  ));
  if (
    accomplishments.performance.latencyMs !== accomplishmentLatencyMs ||
    accomplishments.performance.modelCalls !== accomplishmentModelCalls ||
    roundedCost(accomplishments.performance.estimatedCostUsd) !==
      accomplishmentCostUsd ||
    accomplishments.performance.usageComplete !==
      accomplishments.scenarios.every((scenario) =>
        scenario.metrics.usageComplete
      )
  ) {
    throw new Error(
      "Accomplishments aggregate performance does not match its scenarios.",
    );
  }

  const detailedRuns = observationsReport.observations.flatMap(providerRuns);
  if (new Set(detailedRuns.map((run) => run.id)).size !== detailedRuns.length) {
    throw new Error("Lifecycle provider GenerationRun telemetry contains duplicate IDs.");
  }
  for (const run of detailedRuns) {
    if (run.provider.toLowerCase() !== input.provider) {
      throw new Error(`Provider mismatch in generation run ${run.id}.`);
    }
  }
  for (const observation of observationsReport.observations) {
    if (
      observation.scenarioId !== "manual_only_create" &&
      observation.automation.observedProviders.some((provider) =>
        provider.toLowerCase() !== input.provider
      )
    ) {
      throw new Error(`Provider mismatch in ${observation.scenarioId} attribution.`);
    }
  }

  const actualModelIds = sortedUnique([
    ...detailedRuns.map((run) => run.modelId),
    ...observationsReport.observations.flatMap((observation) =>
      observation.scenarioId === "manual_only_create"
        ? []
        : observation.automation.observedModelIds
    ),
    ...accomplishments.attribution.actualModelIds,
  ]);
  if (!actualModelIds.length) {
    throw new Error("Authoritative provider quality output requires an observed model ID.");
  }
  const fallbackUsed = accomplishments.attribution.fallbackUsed ||
    detailedRuns.some((run) =>
      run.configuredProvider?.toLowerCase() !== run.provider.toLowerCase() ||
      run.configuredModelId !== run.modelId
    );
  const failedProviderAttempts = detailedRuns.reduce(
    (sum, run) => sum + (run.failedProviderAttempts ?? 0),
    accomplishments.attribution.failedProviderAttempts,
  );
  // Attribution answers whether every measured provider attempt is bound to
  // the configured provider/model with complete usage and cost evidence. A
  // Bedrock control is still authoritative when the quality gate correctly
  // records a model-quality failure (for example, a quarantined Highlight).
  // Scenario pass/failure remains on the assembled scenarios and the paired
  // comparator independently requires every OpenRouter absolute gate to pass.
  const authoritative =
    accomplishments.attribution.authoritativeAttributionComplete &&
    accomplishments.performance.usageComplete &&
    detailedRuns.length > 0 && detailedRuns.every(runIsAuthoritative) &&
    !fallbackUsed && failedProviderAttempts === 0;

  const lifecycleScenarios = workItemLifecycleScenarioIds.map((scenarioId) => {
    const gateScenario = gatesById.get(scenarioId)!;
    const observation = observationsById.get(scenarioId)!;
    const runs = providerRuns(observation);
    return {
      id: scenarioId,
      passed: gateScenario.passed,
      lifecycleGatePassed: gateScenario.passed,
      hardGateFailures: gateScenario.failedChecks.map((check) => check.id),
      quality: observationQuality(observation, gateScenario),
      performance: {
        latencyMs: gateScenario.totalLatencyMs,
        observedEstimatedCostUsd: roundedCost(runs.reduce(
          (sum, run) => sum + (run.estimatedCostUsd ?? 0),
          0,
        )),
        observedGenerationRunCount: runs.length,
        costCoverageComplete:
          runs.length > 0 && runs.every(runIsAuthoritative),
        usageComplete: runs.length > 0 && runs.every((run) => run.usageComplete === true),
      },
    };
  });

  const accomplishmentScenarios = accomplishments.scenarios.map((scenario) => {
    const assembled = accomplishmentQuality(scenario, accomplishments);
    return {
      id: scenario.id,
      passed: assembled.passed,
      lifecycleGatePassed: assembled.passed,
      hardGateFailures: assembled.hardGateFailures,
      quality: assembled.quality,
      performance: {
        latencyMs: scenario.metrics.latencyMs,
        observedEstimatedCostUsd: scenario.metrics.estimatedCostUsd,
        observedGenerationRunCount: scenario.metrics.modelCalls,
        costCoverageComplete: scenario.metrics.usageComplete,
        usageComplete: scenario.metrics.usageComplete,
      },
    };
  });
  const scenarios = [...lifecycleScenarios, ...accomplishmentScenarios];
  const lifecycleObservedCost = detailedRuns.reduce(
    (sum, run) => sum + (run.estimatedCostUsd ?? 0),
    0,
  );
  const lifecycleRunIds = observationsReport.observations.flatMap(generationRunIds);
  const report = {
    schemaVersion: PROVIDER_QUALITY_REPORT_SCHEMA_VERSION,
    provider: input.provider,
    comparisonKey: accomplishments.comparisonKey,
    gitCommit,
    repositoryHeads: [{
      repository: accomplishments.target.repository,
      commitSha: targetHead,
    }],
    attribution: {
      authoritative,
      fallbackUsed,
      failedProviderAttempts,
      actualModelIds,
    },
    requiredScenarioIds: [...providerQualityReleaseGateRequiredScenarioIds],
    scenarios,
    performance: {
      latencyMs: gate.aggregate.totalLatencyMs + accomplishments.performance.latencyMs,
      observedEstimatedCostUsd: roundedCost(
        lifecycleObservedCost + accomplishments.performance.estimatedCostUsd,
      ),
      observedGenerationRunCount:
        lifecycleRunIds.length + accomplishments.performance.modelCalls,
      costCoverageComplete:
        lifecycleRunIds.length > 0 &&
        detailedRuns.every(runIsAuthoritative) &&
        accomplishments.performance.usageComplete,
      usageComplete:
        detailedRuns.every((run) => run.usageComplete === true) &&
        accomplishments.performance.usageComplete,
    },
  };
  return providerQualityReportSchema.parse(report);
}
