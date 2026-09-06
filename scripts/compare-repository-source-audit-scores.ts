import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  aggregateRepositorySourceAuditOutcome,
  parseRepositorySourceAuditManifest,
  repositorySourceAuditManifestDigest,
  repositorySourceAuditRepositoryDigest,
  type RepositorySourceAuditManifest,
  type RepositorySourceAuditRepository,
} from "@/src/evals/repository-source-audit";
import { REPOSITORY_SOURCE_AUDIT_SCORE_SCHEMA_VERSION } from "./score-repository-source-audit";

export const REPOSITORY_SOURCE_AUDIT_COMPARISON_SCHEMA_VERSION =
  "repository-source-audit-comparison-v1" as const;

const coverageSchema = z.enum([
  "full",
  "substantial",
  "partial",
  "tangential",
  "none",
]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const nonEmptyString = z.string().trim().min(1);
const nullableMetricSchema = z.number().min(0).max(1).nullable();

const semanticOutcomeSchema = z.object({
  weightedKnowledgeRecall: nullableMetricSchema,
  majorKnowledgeRecall: nullableMetricSchema,
  supportingKnowledgeRecall: nullableMetricSchema,
  mustHighlightRecall: nullableMetricSchema,
  weightedHighlightRecall: nullableMetricSchema,
  matchedUnitGrounding: nullableMetricSchema,
  stateCorrectness: nullableMetricSchema,
  qualifierPreservation: nullableMetricSchema,
  constraintRecall: nullableMetricSchema,
  constraintCorrectness: nullableMetricSchema,
  contradictionRate: nullableMetricSchema,
  fullMajorUnitIds: z.array(nonEmptyString),
  missedMajorUnitIds: z.array(nonEmptyString),
  questionAnswerability: nullableMetricSchema,
  fullyAnswerableQuestionRate: nullableMetricSchema,
  highlightSalience: nullableMetricSchema,
  majorHighlightAllocationRate: nullableMetricSchema,
  duplicateHighlightRate: nullableMetricSchema,
}).strict();

const unitDetailSchema = z.object({
  unitId: nonEmptyString,
  claim: nonEmptyString,
  state: z.enum(["implemented", "partial", "planned", "absent"]),
  importance: z.enum(["major", "supporting"]),
  highlightRelevance: z.enum(["must", "should", "not_expected"]),
  domain: nonEmptyString,
  kind: z.enum([
    "workflow",
    "capability",
    "architecture",
    "integration",
    "data",
    "constraint",
  ]),
  uncertainty: z.string().nullable(),
  knowledgeCoverage: coverageSchema,
  highlightCoverage: coverageSchema,
  evidenceSupported: z.boolean(),
  stateCorrect: z.boolean(),
  qualifierCoverage: coverageSchema.nullable(),
  contradictsAudit: z.boolean(),
}).strict();

const highlightDetailSchema = z.object({
  highlightId: nonEmptyString,
  matchedUnitIds: z.array(nonEmptyString),
  salience: z.enum(["major_operation", "supporting_insight", "low_value"]),
  semanticDuplicateOf: nonEmptyString.nullable(),
}).strict();

const questionDetailSchema = z.object({
  question: nonEmptyString,
  answerability: coverageSchema,
  supportingUnitIds: z.array(nonEmptyString),
  evidenceSupported: z.boolean(),
  stateCorrect: z.boolean(),
  contradictsAudit: z.boolean(),
}).strict();

const sourceAuditScoreSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_SOURCE_AUDIT_SCORE_SCHEMA_VERSION),
  provenance: z.object({
    packetSchemaVersion: nonEmptyString,
    packetDigest: digestSchema,
    adjudicationDigest: digestSchema,
    manifestDigest: digestSchema,
    sourceAuditDigest: digestSchema,
    auditDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    workItemId: nonEmptyString,
    fixtureId: nonEmptyString,
    repository: nonEmptyString,
    commitSha: z.string().regex(/^[a-f0-9]{40}$/iu),
    sourceScope: z.literal("tracked_git_tree"),
    sourceDigest: digestSchema,
    liveRun: z.object({
      artifactDigest: digestSchema,
      variant: nonEmptyString,
      implementationCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu),
      implementationBranch: nonEmptyString.nullable(),
      refreshRunId: nonEmptyString,
    }).strict().optional(),
  }).strict(),
  certification: z.object({
    status: z.enum(["current_run_eligible", "historical_control"]),
    currentRunEligible: z.boolean(),
    historicalControlOverrideUsed: z.boolean(),
    executionIntegrity: z.object({
      passed: z.boolean(),
      issues: z.array(nonEmptyString),
      modelIdentities: z.array(nonEmptyString),
      policyVersions: z.array(nonEmptyString),
    }).strict(),
    sourceTreeVerification: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("verified"),
        repositoryRoot: nonEmptyString,
        computedSourceDigest: digestSchema,
      }).strict(),
      z.object({
        status: z.literal("not_verified"),
        repositoryRoot: z.null(),
        computedSourceDigest: z.null(),
      }).strict(),
    ]),
    liveRunBinding: z.object({
      status: z.literal("verified"),
      artifactDigest: digestSchema,
      implementationCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu),
      implementationBranch: nonEmptyString.nullable(),
      refreshRunId: nonEmptyString,
    }).strict().optional(),
  }).strict(),
  diagnostics: z.object({
    scoringUniverse: z.record(z.string(), z.unknown()),
    savedOutputs: z.object({
      highlights: z.number().int().nonnegative(),
      facts: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      evidenceReferences: z.number().int().nonnegative(),
      exactRangeAndQuoteReferences: z.number().int().nonnegative(),
      outputsWithoutEvidence: z.number().int().nonnegative(),
    }).strict(),
    adjudication: z.record(z.string(), z.unknown()),
    countNeutral: z.literal(true),
  }).strict(),
  semanticDetails: z.object({
    units: z.array(unitDetailSchema),
    highlights: z.array(highlightDetailSchema),
    questions: z.array(questionDetailSchema),
  }).strict(),
  outcome: semanticOutcomeSchema,
}).strict();

type SourceAuditScore = z.infer<typeof sourceAuditScoreSchema>;
type UnitDetail = z.infer<typeof unitDetailSchema>;
type QuestionDetail = z.infer<typeof questionDetailSchema>;
type OutcomeMetric = Exclude<keyof SourceAuditScore["outcome"],
  "fullMajorUnitIds" | "missedMajorUnitIds">;

const outcomeMetricDefinitions = [
  ["weightedKnowledgeRecall", "higher"],
  ["majorKnowledgeRecall", "higher"],
  ["supportingKnowledgeRecall", "higher"],
  ["mustHighlightRecall", "higher"],
  ["weightedHighlightRecall", "higher"],
  ["matchedUnitGrounding", "higher"],
  ["stateCorrectness", "higher"],
  ["qualifierPreservation", "higher"],
  ["constraintRecall", "higher"],
  ["constraintCorrectness", "higher"],
  ["contradictionRate", "lower"],
  ["questionAnswerability", "higher"],
  ["fullyAnswerableQuestionRate", "higher"],
  ["highlightSalience", "higher"],
  ["majorHighlightAllocationRate", "higher"],
  ["duplicateHighlightRate", "lower"],
] as const satisfies ReadonlyArray<readonly [OutcomeMetric, "higher" | "lower"]>;

const coverageValue = {
  full: 1,
  substantial: 0.75,
  partial: 0.5,
  tangential: 0.25,
  none: 0,
} as const;

function round(value: number) {
  return Number(value.toFixed(6));
}

function sameRepository(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function exactStringSet(expected: readonly string[], actual: readonly string[], label: string) {
  if (new Set(expected).size !== expected.length) {
    throw new Error(`Frozen ${label} contains duplicates.`);
  }
  if (new Set(actual).size !== actual.length) {
    throw new Error(`${label} contains duplicates.`);
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unknown = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || unknown.length) {
    throw new Error(
      `${label} does not match the frozen source audit. Missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}.`,
    );
  }
}

function assertUnitMetadata(
  repository: RepositorySourceAuditRepository,
  details: readonly UnitDetail[],
) {
  exactStringSet(
    repository.knowledgeUnits.map((unit) => unit.id),
    details.map((unit) => unit.unitId),
    `${repository.fixtureId} unit details`,
  );
  const detailById = new Map(details.map((unit) => [unit.unitId, unit]));
  for (const unit of repository.knowledgeUnits) {
    const detail = detailById.get(unit.id)!;
    const expected = {
      claim: unit.claim,
      state: unit.state,
      importance: unit.importance,
      highlightRelevance: unit.highlightRelevance,
      domain: unit.domain,
      kind: unit.kind,
      uncertainty: unit.uncertainty ?? null,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (detail[key as keyof typeof expected] !== value) {
        throw new Error(
          `${repository.fixtureId}/${unit.id} ${key} does not match the frozen source audit.`,
        );
      }
    }
  }
}

function assertScoreMatchesAudit(input: {
  manifest: RepositorySourceAuditManifest;
  repository: RepositorySourceAuditRepository;
  score: SourceAuditScore;
  role: "current" | "historical";
}) {
  const { manifest, repository, score, role } = input;
  if (
    score.provenance.fixtureId !== repository.fixtureId ||
    !sameRepository(score.provenance.repository, repository.repository) ||
    score.provenance.commitSha.toLocaleLowerCase() !==
      repository.commitSha.toLocaleLowerCase() ||
    score.provenance.sourceDigest.toLocaleLowerCase() !==
      repository.sourceDigest.toLocaleLowerCase()
  ) {
    throw new Error(`${role} score identity does not match ${repository.fixtureId}.`);
  }
  if (
    score.provenance.sourceAuditDigest !==
      repositorySourceAuditRepositoryDigest(repository)
  ) {
    throw new Error(
      `${role} score ${repository.fixtureId} does not match the complete frozen repository audit.`,
    );
  }
  const expectedManifestDigest = repositorySourceAuditManifestDigest(manifest);
  if (score.provenance.manifestDigest !== expectedManifestDigest) {
    throw new Error(
      `${role} score ${repository.fixtureId} was not produced from the supplied frozen manifest.`,
    );
  }
  const sourceVerification = score.certification.sourceTreeVerification;
  if (
    sourceVerification.status !== "verified" ||
    sourceVerification.computedSourceDigest.toLocaleLowerCase() !==
      repository.sourceDigest.toLocaleLowerCase()
  ) {
    throw new Error(
      `${role} score ${repository.fixtureId} lacks matching clean-checkout source verification.`,
    );
  }
  if (role === "current") {
    const integrity = score.certification.executionIntegrity;
    const liveRun = score.provenance.liveRun;
    const liveRunBinding = score.certification.liveRunBinding;
    if (
      score.certification.status !== "current_run_eligible" ||
      !score.certification.currentRunEligible ||
      score.certification.historicalControlOverrideUsed ||
      !integrity.passed ||
      integrity.issues.length > 0 ||
      integrity.modelIdentities.length === 0 ||
      integrity.policyVersions.length === 0 ||
      !liveRun ||
      !liveRunBinding ||
      liveRunBinding.status !== "verified" ||
      liveRun.artifactDigest !== liveRunBinding.artifactDigest ||
      liveRun.implementationCommitSha.toLocaleLowerCase() !==
        liveRunBinding.implementationCommitSha.toLocaleLowerCase() ||
      liveRun.implementationBranch !== liveRunBinding.implementationBranch ||
      liveRun.refreshRunId !== liveRunBinding.refreshRunId
    ) {
      throw new Error(
        `Current score ${repository.fixtureId} is not a fully attested, live-run-bound main-path run.`,
      );
    }
  } else if (
    score.certification.status !== "historical_control" ||
    score.certification.currentRunEligible ||
    !score.certification.historicalControlOverrideUsed
  ) {
    throw new Error(
      `Historical score ${repository.fixtureId} is not explicitly labeled as a historical control.`,
    );
  }

  assertUnitMetadata(repository, score.semanticDetails.units);
  exactStringSet(
    repository.userQuestions,
    score.semanticDetails.questions.map((question) => question.question),
    `${repository.fixtureId} question details`,
  );
  if (
    score.semanticDetails.highlights.length !==
      score.diagnostics.savedOutputs.highlights
  ) {
    throw new Error(
      `${role} score ${repository.fixtureId} Highlight adjudications do not match its saved-output count.`,
    );
  }
  const recomputed = aggregateRepositorySourceAuditOutcome({
    repository,
    unitAdjudications: score.semanticDetails.units.map((unit) => ({
      unitId: unit.unitId,
      knowledgeCoverage: unit.knowledgeCoverage,
      highlightCoverage: unit.highlightCoverage,
      evidenceSupported: unit.evidenceSupported,
      stateCorrect: unit.stateCorrect,
      qualifierCoverage: unit.qualifierCoverage,
      contradictsAudit: unit.contradictsAudit,
    })),
    observedHighlightIds: score.semanticDetails.highlights.map((highlight) =>
      highlight.highlightId
    ),
    highlightAdjudications: score.semanticDetails.highlights,
    questionAdjudications: score.semanticDetails.questions,
  });
  if (JSON.stringify(recomputed) !== JSON.stringify(score.outcome)) {
    throw new Error(
      `${role} score ${repository.fixtureId} outcome does not match its semantic details.`,
    );
  }
}

function indexScores(scores: readonly SourceAuditScore[], label: string) {
  const indexed = new Map<string, SourceAuditScore>();
  for (const score of scores) {
    const fixtureId = score.provenance.fixtureId;
    if (indexed.has(fixtureId)) {
      throw new Error(`Duplicate ${label} score for ${fixtureId}.`);
    }
    indexed.set(fixtureId, score);
  }
  return indexed;
}

function metricComparison(
  metric: OutcomeMetric,
  direction: "higher" | "lower",
  current: number | null,
  baseline: number | null,
) {
  const delta = current === null || baseline === null
    ? null
    : round(current - baseline);
  const status = delta === null
    ? "not_comparable"
    : delta === 0
      ? "equal"
      : direction === "higher"
        ? delta > 0 ? "improved" : "regressed"
        : delta < 0 ? "improved" : "regressed";
  return { metric, direction, baseline, current, delta, status } as const;
}

function sourceTruthMetric(metric: OutcomeMetric, direction: "higher" | "lower", value: number | null) {
  const target = direction === "higher" ? 1 : 0;
  return {
    metric,
    direction,
    value,
    target,
    gap: value === null
      ? null
      : round(direction === "higher" ? target - value : value - target),
  } as const;
}

function effectiveQuestionValue(question: QuestionDetail) {
  return question.evidenceSupported &&
      question.stateCorrect &&
      !question.contradictsAudit
    ? coverageValue[question.answerability]
    : 0;
}

function hasNonDuplicateHighlightForUnit(score: SourceAuditScore, unitId: string) {
  return score.semanticDetails.highlights.some((highlight) =>
    highlight.semanticDuplicateOf === null &&
    highlight.matchedUnitIds.includes(unitId)
  );
}

function unitSourceTruthGaps(unit: UnitDetail) {
  const knowledgeValue = coverageValue[unit.knowledgeCoverage];
  const highlightValue = coverageValue[unit.highlightCoverage];
  const qualifierValue = unit.qualifierCoverage === null
    ? null
    : coverageValue[unit.qualifierCoverage];
  const highlightExpected = unit.highlightRelevance !== "not_expected";
  const issues = [
    ...(knowledgeValue < 1 ? ["knowledge_incomplete"] : []),
    ...(highlightExpected && highlightValue < 1 ? ["highlight_incomplete"] : []),
    ...((knowledgeValue > 0 || highlightValue > 0) && !unit.evidenceSupported
      ? ["evidence_unsupported"]
      : []),
    ...((knowledgeValue > 0 || highlightValue > 0 || unit.contradictsAudit) &&
        !unit.stateCorrect
      ? ["state_incorrect"]
      : []),
    ...(qualifierValue !== null && qualifierValue < 1
      ? ["qualifier_incomplete"]
      : []),
    ...(unit.contradictsAudit ? ["contradiction"] : []),
  ];
  return {
    unitId: unit.unitId,
    claim: unit.claim,
    state: unit.state,
    importance: unit.importance,
    highlightRelevance: unit.highlightRelevance,
    knowledgeCoverage: unit.knowledgeCoverage,
    knowledgeGapToFull: round(1 - knowledgeValue),
    highlightCoverage: unit.highlightCoverage,
    highlightGapToFull: highlightExpected ? round(1 - highlightValue) : null,
    qualifierCoverage: unit.qualifierCoverage,
    qualifierGapToFull: qualifierValue === null ? null : round(1 - qualifierValue),
    evidenceSupported: unit.evidenceSupported,
    stateCorrect: unit.stateCorrect,
    contradictsAudit: unit.contradictsAudit,
    issues,
  };
}

function questionSourceTruthGaps(question: QuestionDetail) {
  const effectiveValue = effectiveQuestionValue(question);
  return {
    question: question.question,
    answerability: question.answerability,
    effectiveAnswerability: effectiveValue,
    gapToFull: round(1 - effectiveValue),
    supportingUnitIds: [...question.supportingUnitIds].sort(),
    evidenceSupported: question.evidenceSupported,
    stateCorrect: question.stateCorrect,
    contradictsAudit: question.contradictsAudit,
  };
}

function semanticRegressions(current: SourceAuditScore, baseline: SourceAuditScore) {
  const baselineUnits = new Map(
    baseline.semanticDetails.units.map((unit) => [unit.unitId, unit]),
  );
  const units = current.semanticDetails.units.flatMap((unit) => {
    const prior = baselineUnits.get(unit.unitId)!;
    const priorAddressed = coverageValue[prior.knowledgeCoverage] > 0 ||
      coverageValue[prior.highlightCoverage] > 0 ||
      prior.contradictsAudit;
    const currentAddressed = coverageValue[unit.knowledgeCoverage] > 0 ||
      coverageValue[unit.highlightCoverage] > 0 ||
      unit.contradictsAudit;
    const comparisons = [
      {
        field: "knowledgeCoverage",
        baseline: coverageValue[prior.knowledgeCoverage],
        current: coverageValue[unit.knowledgeCoverage],
      },
      {
        field: "highlightCoverage",
        baseline: coverageValue[prior.highlightCoverage],
        current: coverageValue[unit.highlightCoverage],
      },
      ...(unit.qualifierCoverage === null || prior.qualifierCoverage === null
        ? []
        : [{
            field: "qualifierCoverage",
            baseline: coverageValue[prior.qualifierCoverage],
            current: coverageValue[unit.qualifierCoverage],
          }]),
      ...(priorAddressed && currentAddressed
        ? [
            {
              field: "evidenceSupported",
              baseline: prior.evidenceSupported ? 1 : 0,
              current: unit.evidenceSupported ? 1 : 0,
            },
            {
              field: "stateCorrect",
              baseline: prior.stateCorrect ? 1 : 0,
              current: unit.stateCorrect ? 1 : 0,
            },
          ]
        : []),
      ...(hasNonDuplicateHighlightForUnit(baseline, unit.unitId)
        ? [{
            field: "nonDuplicateHighlightRepresentation",
            baseline: 1,
            current: hasNonDuplicateHighlightForUnit(current, unit.unitId) ? 1 : 0,
          }]
        : []),
      {
        field: "contradictsAudit",
        baseline: prior.contradictsAudit ? 1 : 0,
        current: unit.contradictsAudit ? 1 : 0,
        lowerIsBetter: true,
      },
    ];
    return comparisons.flatMap((comparison) => {
      const regressed = comparison.lowerIsBetter
        ? comparison.current > comparison.baseline
        : comparison.current < comparison.baseline;
      return regressed ? [{
        unitId: unit.unitId,
        field: comparison.field,
        baseline: comparison.baseline,
        current: comparison.current,
      }] : [];
    });
  });
  const baselineQuestions = new Map(
    baseline.semanticDetails.questions.map((question) => [question.question, question]),
  );
  const questions = current.semanticDetails.questions.flatMap((question) => {
    const prior = baselineQuestions.get(question.question)!;
    const priorValue = effectiveQuestionValue(prior);
    const currentValue = effectiveQuestionValue(question);
    return currentValue < priorValue ? [{
      question: question.question,
      baselineEffectiveAnswerability: priorValue,
      currentEffectiveAnswerability: currentValue,
    }] : [];
  });
  return { units, questions };
}

function macroMetric(scores: readonly SourceAuditScore[], metric: OutcomeMetric) {
  const values = scores
    .map((score) => score.outcome[metric])
    .filter((value): value is number => value !== null);
  return values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function comparableMacroMetrics(
  currentScores: readonly SourceAuditScore[],
  baselineScores: readonly SourceAuditScore[],
  metric: OutcomeMetric,
) {
  if (currentScores.length !== baselineScores.length) {
    throw new Error(`Cannot aggregate unmatched ${metric} score sets.`);
  }
  const pairs = currentScores.flatMap((current, index) => {
    const baseline = baselineScores[index]!;
    const currentValue = current.outcome[metric];
    const baselineValue = baseline.outcome[metric];
    return currentValue === null || baselineValue === null
      ? []
      : [{ current: currentValue, baseline: baselineValue }];
  });
  if (!pairs.length) return { current: null, baseline: null };
  return {
    current: round(
      pairs.reduce((sum, pair) => sum + pair.current, 0) / pairs.length,
    ),
    baseline: round(
      pairs.reduce((sum, pair) => sum + pair.baseline, 0) / pairs.length,
    ),
  };
}

export function compareRepositorySourceAuditScores(input: {
  manifest: unknown;
  currentScores: readonly unknown[];
  historicalScores?: readonly unknown[];
  requiredHistoricalFixtureIds?: readonly string[];
  excludedFixtures?: readonly { fixtureId: string; reason: string }[];
}) {
  const manifest = parseRepositorySourceAuditManifest(input.manifest);
  const excludedFixtures = z.array(z.object({
    fixtureId: nonEmptyString,
    reason: nonEmptyString,
  }).strict()).parse(input.excludedFixtures ?? []);
  const excludedIds = new Set(excludedFixtures.map(({ fixtureId }) => fixtureId));
  if (excludedIds.size !== excludedFixtures.length || excludedFixtures.some(({ fixtureId }) =>
    !manifest.repositories.some((repository) => repository.fixtureId === fixtureId)
  )) {
    throw new Error("Excluded fixtures must be distinct members of the frozen audit.");
  }
  const includedRepositories = manifest.repositories.filter(({ fixtureId }) => !excludedIds.has(fixtureId));
  if (!includedRepositories.length) throw new Error("At least one audited repository must remain in scope.");
  const currentScores = input.currentScores.map((score) =>
    sourceAuditScoreSchema.parse(score)
  );
  const historicalScores = (input.historicalScores ?? []).map((score) =>
    sourceAuditScoreSchema.parse(score)
  );
  const currentByFixture = indexScores(currentScores, "current");
  const historicalByFixture = indexScores(historicalScores, "historical");
  exactStringSet(
    includedRepositories.map((repository) => repository.fixtureId),
    Array.from(currentByFixture.keys()),
    "Current score fixture set",
  );
  const knownFixtureIds = new Set(currentByFixture.keys());
  const unknownHistorical = Array.from(historicalByFixture.keys())
    .filter((fixtureId) => !knownFixtureIds.has(fixtureId));
  if (unknownHistorical.length) {
    throw new Error(
      `Historical controls reference fixtures outside the frozen audit: ${unknownHistorical.join(", ")}.`,
    );
  }
  const requiredHistoricalFixtureIds = Array.from(new Set(
    input.requiredHistoricalFixtureIds ?? [],
  )).sort();
  const unknownRequired = requiredHistoricalFixtureIds.filter((fixtureId) =>
    !knownFixtureIds.has(fixtureId)
  );
  if (unknownRequired.length) {
    throw new Error(
      `Required historical fixtures are outside the frozen audit: ${unknownRequired.join(", ")}.`,
    );
  }

  const repositoryByFixture = new Map(
    manifest.repositories.map((repository) => [repository.fixtureId, repository]),
  );
  for (const [fixtureId, score] of currentByFixture) {
    assertScoreMatchesAudit({
      manifest,
      repository: repositoryByFixture.get(fixtureId)!,
      score,
      role: "current",
    });
  }
  for (const [fixtureId, score] of historicalByFixture) {
    assertScoreMatchesAudit({
      manifest,
      repository: repositoryByFixture.get(fixtureId)!,
      score,
      role: "historical",
    });
  }
  const implementationCommits = new Set(currentScores.map((score) =>
    score.provenance.liveRun!.implementationCommitSha.toLocaleLowerCase()
  ));
  if (implementationCommits.size !== 1) {
    throw new Error(
      "Current source-audit suite contains results from multiple Workbase implementation commits.",
    );
  }

  const fixtureIds = Array.from(currentByFixture.keys()).sort();
  const sourceTruth = fixtureIds.map((fixtureId) => {
    const score = currentByFixture.get(fixtureId)!;
    const unitGaps = score.semanticDetails.units
      .map(unitSourceTruthGaps)
      .filter((unit) => unit.issues.length > 0);
    const questionGaps = score.semanticDetails.questions
      .map(questionSourceTruthGaps)
      .filter((question) => question.gapToFull > 0);
    return {
      fixtureId,
      repository: score.provenance.repository,
      workItemId: score.provenance.workItemId,
      certification: "verified_current_main_path",
      metrics: outcomeMetricDefinitions.map(([metric, direction]) =>
        sourceTruthMetric(metric, direction, score.outcome[metric])
      ),
      unitGaps,
      questionGaps,
    };
  });
  const sourceTruthAggregate = outcomeMetricDefinitions.map(([metric, direction]) =>
    sourceTruthMetric(metric, direction, macroMetric(currentScores, metric))
  );

  const matchedFixtureIds = Array.from(historicalByFixture.keys()).sort();
  const matchedHistorical = matchedFixtureIds.map((fixtureId) => {
    const current = currentByFixture.get(fixtureId)!;
    const baseline = historicalByFixture.get(fixtureId)!;
    if (
      current.provenance.sourceAuditDigest !== baseline.provenance.sourceAuditDigest ||
      current.provenance.commitSha.toLocaleLowerCase() !==
        baseline.provenance.commitSha.toLocaleLowerCase()
    ) {
      throw new Error(
        `Current and historical scores for ${fixtureId} do not share the same audit source.`,
      );
    }
    const metrics = outcomeMetricDefinitions.map(([metric, direction]) =>
      metricComparison(
        metric,
        direction,
        current.outcome[metric],
        baseline.outcome[metric],
      )
    );
    const regressions = semanticRegressions(current, baseline);
    return {
      fixtureId,
      repository: current.provenance.repository,
      currentWorkItemId: current.provenance.workItemId,
      historicalWorkItemId: baseline.provenance.workItemId,
      metrics,
      metricRegressions: metrics
        .filter((comparison) => comparison.status === "regressed")
        .map((comparison) => comparison.metric),
      semanticRegressions: regressions,
      passed: metrics.every((comparison) => comparison.status !== "regressed") &&
        regressions.units.length === 0 &&
        regressions.questions.length === 0,
    };
  });
  const matchedCurrentScores = matchedFixtureIds.map((fixtureId) =>
    currentByFixture.get(fixtureId)!
  );
  const matchedBaselineScores = matchedFixtureIds.map((fixtureId) =>
    historicalByFixture.get(fixtureId)!
  );
  const matchedAggregate = outcomeMetricDefinitions.map(([metric, direction]) => {
    const comparable = comparableMacroMetrics(
      matchedCurrentScores,
      matchedBaselineScores,
      metric,
    );
    return metricComparison(
      metric,
      direction,
      comparable.current,
      comparable.baseline,
    );
  });
  const currentOnlyHoldouts = fixtureIds.filter((fixtureId) =>
    !historicalByFixture.has(fixtureId)
  );
  const missingRequiredHistorical = requiredHistoricalFixtureIds.filter((fixtureId) =>
    !historicalByFixture.has(fixtureId)
  );

  const comparableThresholdFailures = sourceTruth.flatMap((fixture) => {
    const score = currentByFixture.get(fixture.fixtureId)!;
    const unitFailures = score.semanticDetails.units.flatMap((unit) => {
      const knowledgeRequired =
        (unit.state === "implemented" || unit.state === "partial") &&
        unit.importance === "major";
      const highlightRequired = unit.highlightRelevance === "must";
      const addressed = coverageValue[unit.knowledgeCoverage] > 0 ||
        coverageValue[unit.highlightCoverage] > 0 ||
        unit.contradictsAudit;
      return [
        ...(knowledgeRequired && coverageValue[unit.knowledgeCoverage] < 0.75
          ? [`${unit.unitId}:major_knowledge_below_substantial`]
          : []),
        ...(highlightRequired && coverageValue[unit.highlightCoverage] < 0.75
          ? [`${unit.unitId}:must_highlight_below_substantial`]
          : []),
        ...(knowledgeRequired && addressed && !unit.evidenceSupported
          ? [`${unit.unitId}:major_knowledge_not_grounded`]
          : []),
        ...(knowledgeRequired && addressed && !unit.stateCorrect
          ? [`${unit.unitId}:major_knowledge_state_incorrect`]
          : []),
        ...(highlightRequired && coverageValue[unit.highlightCoverage] > 0 &&
            !unit.evidenceSupported
          ? [`${unit.unitId}:must_highlight_not_grounded`]
          : []),
        ...(highlightRequired && coverageValue[unit.highlightCoverage] > 0 &&
            !unit.stateCorrect
          ? [`${unit.unitId}:must_highlight_state_incorrect`]
          : []),
        ...(highlightRequired && coverageValue[unit.highlightCoverage] >= 0.75 &&
            !hasNonDuplicateHighlightForUnit(score, unit.unitId)
          ? [`${unit.unitId}:must_highlight_only_duplicated_or_unmatched`]
          : []),
        ...(unit.contradictsAudit ? [`${unit.unitId}:contradicts_source_audit`] : []),
      ];
    });
    const questionFailures = score.semanticDetails.questions.flatMap((question) =>
      effectiveQuestionValue(question) < 0.75
        ? [`${question.question}:answerability_below_substantial`]
        : []
    );
    return [...unitFailures, ...questionFailures].map((failure) => ({
      fixtureId: fixture.fixtureId,
      failure,
    }));
  });
  const historicalRegressions = matchedHistorical.flatMap((fixture) => [
    ...fixture.metricRegressions.map((metric) => ({
      fixtureId: fixture.fixtureId,
      scope: "metric",
      key: metric,
    })),
    ...fixture.semanticRegressions.units.map((unit) => ({
      fixtureId: fixture.fixtureId,
      scope: "unit",
      key: `${unit.unitId}:${unit.field}`,
    })),
    ...fixture.semanticRegressions.questions.map((question) => ({
      fixtureId: fixture.fixtureId,
      scope: "question",
      key: question.question,
    })),
  ]);

  return {
    schemaVersion: REPOSITORY_SOURCE_AUDIT_COMPARISON_SCHEMA_VERSION,
    provenance: {
      manifestDigest: repositorySourceAuditManifestDigest(manifest),
      auditDate: manifest.auditDate,
      currentFixtureIds: fixtureIds,
      excludedFixtures: [...excludedFixtures].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)),
      matchedHistoricalFixtureIds: matchedFixtureIds,
      currentOnlyHoldoutFixtureIds: currentOnlyHoldouts,
      requiredHistoricalFixtureIds,
      implementationCommitSha:
        currentScores[0]!.provenance.liveRun!.implementationCommitSha,
    },
    sourceTruth: {
      aggregateMetrics: sourceTruthAggregate,
      repositories: sourceTruth,
    },
    historicalComparison: {
      aggregateMetrics: matchedAggregate,
      repositories: matchedHistorical,
      missingRequiredHistoricalFixtureIds: missingRequiredHistorical,
    },
    holdouts: currentOnlyHoldouts.map((fixtureId) => ({
      fixtureId,
      comparison: "source_truth_only",
      reason: "No historical control was supplied for this audited repository.",
    })),
    acceptance: {
      passed: missingRequiredHistorical.length === 0 &&
        comparableThresholdFailures.length === 0 &&
        historicalRegressions.length === 0,
      sourceTruthThresholds: {
        majorImplementedOrPartialKnowledge: "substantial_or_better",
        mustHighlightCoverage: "substantial_or_better",
        groundedStateCorrectQuestionAnswerability: "substantial_or_better",
        contradictions: "none",
      },
      comparableThresholdFailures,
      historicalRegressions,
      missingRequiredHistoricalFixtureIds: missingRequiredHistorical,
    },
    diagnostics: {
      countNeutral: true,
      note: "Saved-output counts are reported for operating context only and do not affect source-truth gaps, regression status, or acceptance.",
      savedOutputCounts: fixtureIds.map((fixtureId) => ({
        fixtureId,
        ...currentByFixture.get(fixtureId)!.diagnostics.savedOutputs,
      })),
    },
  } as const;
}

type Options = {
  compact: boolean;
  currentScorePaths: string[];
  help: boolean;
  historicalScorePaths: string[];
  manifestPath: string | null;
  outputPath: string | null;
  requiredHistoricalFixtureIds: string[];
  excludedFixtures: { fixtureId: string; reason: string }[];
};

function usage() {
  return `Compare verified source-audit score artifacts with source truth and matched historical controls.

Usage:
  npx tsx scripts/compare-repository-source-audit-scores.ts \\
    --manifest <repository-source-audits.json> \\
    --current-score <current-score.json> [--current-score ...] \\
    --historical-score <historical-score.json> [--historical-score ...] \\
    --require-historical <fixture-id> [--require-historical ...] \\
    [--output <new-comparison.json>] [--compact]

Every repository in the frozen manifest must have exactly one verified current
score unless explicitly excluded with --exclude-fixture <fixture-id=reason>.
Exclusions are recorded in comparison provenance; the frozen manifest and its
digest remain unchanged. Historical controls are matched by fixture id; unmatched current runs are
reported separately as holdouts. Repeat --require-historical for every fixture
that must have a baseline. Semantic metrics and exact unit/question regressions
determine acceptance. --output refuses to overwrite a file. Highlight, Fact,
token, call, and file counts never do.`;
}

function optionValue(args: readonly string[], index: number, name: string) {
  const argument = args[index]!;
  const inline = argument.startsWith(`${name}=`)
    ? argument.slice(name.length + 1)
    : null;
  const value = inline ?? args[index + 1];
  if (!value?.trim() || (inline === null && value.startsWith("--"))) {
    throw new Error(`${name} requires a value.\n\n${usage()}`);
  }
  return { consumed: inline === null ? 1 : 0, value: value.trim() };
}

export function parseRepositorySourceAuditComparisonOptions(args: readonly string[]) {
  const options: Options = {
    compact: false,
    currentScorePaths: [],
    help: false,
    historicalScorePaths: [],
    manifestPath: null,
    outputPath: null,
    requiredHistoricalFixtureIds: [],
    excludedFixtures: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--compact") {
      options.compact = true;
      continue;
    }
    if (argument === "--exclude-fixture" || argument.startsWith("--exclude-fixture=")) {
      const parsed = optionValue(args, index, "--exclude-fixture");
      const separator = parsed.value.indexOf("=");
      const fixtureId = parsed.value.slice(0, separator).trim();
      const reason = parsed.value.slice(separator + 1).trim();
      if (separator < 1 || !fixtureId || !reason) {
        throw new Error("--exclude-fixture requires fixture-id=reason.");
      }
      options.excludedFixtures.push({ fixtureId, reason });
      index += parsed.consumed;
      continue;
    }
    const definitions = [
      ["--manifest", "manifestPath", false],
      ["--current-score", "currentScorePaths", true],
      ["--historical-score", "historicalScorePaths", true],
      ["--require-historical", "requiredHistoricalFixtureIds", true],
      ["--output", "outputPath", false],
    ] as const;
    const definition = definitions.find(([name]) =>
      argument === name || argument.startsWith(`${name}=`)
    );
    if (!definition) {
      throw new Error(`Unknown option: ${argument}.\n\n${usage()}`);
    }
    const [name, key, repeatable] = definition;
    const parsed = optionValue(args, index, name);
    const value = name === "--require-historical"
      ? parsed.value
      : resolve(parsed.value);
    if (repeatable) {
      (options[key] as string[]).push(value);
    } else {
      if (options[key] !== null) {
        throw new Error(`${name} may only be supplied once.\n\n${usage()}`);
      }
      (options as Record<string, unknown>)[key] = value;
    }
    index += parsed.consumed;
  }
  return options;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main() {
  const options = parseRepositorySourceAuditComparisonOptions(
    process.argv.slice(2),
  );
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.manifestPath || options.currentScorePaths.length === 0) {
    throw new Error(
      `--manifest and at least one --current-score are required.\n\n${usage()}`,
    );
  }
  const [manifest, currentScores, historicalScores] = await Promise.all([
    readJson(options.manifestPath),
    Promise.all(options.currentScorePaths.map(readJson)),
    Promise.all(options.historicalScorePaths.map(readJson)),
  ]);
  const comparison = compareRepositorySourceAuditScores({
    manifest,
    currentScores,
    historicalScores,
    requiredHistoricalFixtureIds: options.requiredHistoricalFixtureIds,
    excludedFixtures: options.excludedFixtures,
  });
  const serialized = `${JSON.stringify(
    comparison,
    null,
    options.compact ? 0 : 2,
  )}\n`;
  if (options.outputPath) {
    await writeFile(options.outputPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  process.stdout.write(serialized);
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (executablePath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
