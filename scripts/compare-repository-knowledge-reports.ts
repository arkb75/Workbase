import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "repository-knowledge-comparison-v1" as const;
const AGGREGATE_METRICS = [
  "score", "repositoryKnowledgeScore", "highlightGenerationScore",
  "macroAverageScore", "minimumProjectScore", "passingFixtureRate",
] as const;
const QUALITY_METRICS = [
  "score", "repositoryKnowledgeScore", "repositoryKnowledgeCoverageScore",
  "repositoryKnowledgeGroundingScore", "highlightGenerationScore",
  "highlightSalienceCoverage", "highlightGroundingScore",
  "highlightPresentationScore", "capabilityRecall", "majorCapabilityRecall",
  "highlightCapabilityRecall", "majorHighlightCapabilityRecall",
  "highlightDomainRecall", "highlightEvidencePrecision", "highlightItemPrecision",
  "highlightNonRedundancy", "domainRecall", "knowledgeItemPrecision", "evidencePrecision",
  "claimStateCorrectness", "inventoryHygiene", "duplicateRate", "coverageCalibration",
] as const;
const OPERATIONAL_METRICS = [
  "modelAttempts", "modelCalls", "totalTokens", "estimatedCostUsd", "durationMs",
] as const;
const OPERATIONAL_METRIC_SEMANTICS = {
  modelAttempts: "Explicit attempt telemetry when a report supplies it; the current evaluator may omit it.",
  modelCalls: "Normalized provider-attempt count exposed as performance.modelCalls by the evaluator, not a count of logical GenerationRun records.",
} as const;

type AggregateMetric = typeof AGGREGATE_METRICS[number];
type QualityMetric = typeof QUALITY_METRICS[number];
type OperationalMetric = typeof OPERATIONAL_METRICS[number];
type JsonRecord = Record<string, unknown>;

export interface RepositoryKnowledgeComparisonTolerances {
  /** Absolute suite score/rate drop. */
  aggregateQualityDrop: number;
  /** Absolute fixture score drop. */
  fixtureScoreDrop: number;
  /** Absolute fixture metric drop. */
  fixtureMetricDrop: number;
  /** Relative calls/tokens/cost/duration increase. */
  operationalIncreaseRatio: number;
}

export const DEFAULT_REPOSITORY_KNOWLEDGE_COMPARISON_TOLERANCES = {
  aggregateQualityDrop: 0.02,
  fixtureScoreDrop: 0.03,
  fixtureMetricDrop: 0.05,
  operationalIncreaseRatio: 0.25,
} satisfies RepositoryKnowledgeComparisonTolerances;

interface NamedReport {
  name: string;
  report: unknown;
  path?: string;
}

interface ExecutionIntegrity {
  passed: boolean;
  issues: string[];
  modelIdentities: string[];
  policyVersions: string[];
}

interface Fixture {
  fixtureId: string;
  passed: boolean;
  quality: Record<QualityMetric, number | null>;
  operations: Record<OperationalMetric, number | null>;
  executionIntegrity: ExecutionIntegrity | null;
}

interface Report {
  name: string;
  path: string | null;
  evaluatorPolicyVersion: string | null;
  passed: boolean;
  fixtures: Map<string, Fixture>;
  executionIntegrityPassed: boolean;
}

interface Delta {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  relativeDelta: number | null;
  tolerance: number;
  status: "improved" | "within_tolerance" | "regressed" | "unavailable";
  reason?: string;
}

interface Regression {
  scope: "suite" | "fixture";
  fixtureId?: string;
  metric: string;
  reason: string;
}

function object(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function number(source: JsonRecord | null, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function requiredBoolean(value: unknown, description: string) {
  if (typeof value !== "boolean") throw new Error(`${description} must be a boolean.`);
  return value;
}

function optionalNonEmptyString(value: unknown, description: string) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} must be a non-empty string when supplied.`);
  }
  return value.trim();
}

function stringArray(value: unknown, description: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${description} must be an array of non-empty strings.`);
  }
  return Array.from(new Set(value.map((entry) => (entry as string).trim()))).sort();
}

function executionIntegrity(value: unknown, description: string): ExecutionIntegrity | null {
  if (value == null) return null;
  const data = object(value);
  if (!data) throw new Error(`${description} must be an object.`);
  return {
    passed: requiredBoolean(data.passed, `${description}.passed`),
    issues: stringArray(data.issues, `${description}.issues`),
    modelIdentities: stringArray(data.modelIdentities, `${description}.modelIdentities`),
    policyVersions: stringArray(data.policyVersions, `${description}.policyVersions`),
  };
}

function isCompletePassedExecutionIntegrity(value: ExecutionIntegrity | null) {
  return value?.passed === true &&
    value.issues.length === 0 &&
    value.modelIdentities.length > 0 &&
    value.policyVersions.length > 0;
}

function executionIntegrityFailure(value: ExecutionIntegrity) {
  if (!value.passed) {
    return value.issues.join("; ") || "unspecified integrity failure";
  }
  const problems = [
    ...(value.issues.length ? ["a passed attestation contains issues"] : []),
    ...(!value.modelIdentities.length ? ["model identities are missing"] : []),
    ...(!value.policyVersions.length ? ["policy versions are missing"] : []),
  ];
  return problems.join("; ") || "incomplete integrity attestation";
}

function round(value: number) {
  return Number(value.toFixed(6));
}

function normalize(input: NamedReport): Report {
  const root = object(input.report);
  if (!root) throw new Error(`${input.name}: report must be a JSON object.`);
  const aggregate = object(root.aggregate) ?? root;
  const rawFixtures = Array.isArray(root.reports)
    ? root.reports
    : Array.isArray(aggregate.results) ? aggregate.results : [];
  if (!rawFixtures.length) throw new Error(`${input.name}: report has no fixture reports.`);

  const evaluatorPolicyDeclarations = [
    { location: "report", value: root.evaluatorPolicyVersion },
    ...(aggregate === root
      ? []
      : [{ location: "aggregate", value: aggregate.evaluatorPolicyVersion }]),
    ...rawFixtures.map((raw, index) => ({
      location: `fixture report ${index + 1}`,
      value: object(raw)?.evaluatorPolicyVersion,
    })),
  ].flatMap(({ location, value }) => {
    const version = optionalNonEmptyString(
      value,
      `${input.name}.${location}.evaluatorPolicyVersion`,
    );
    return version === null ? [] : [{ location, version }];
  });
  const evaluatorPolicyVersions = Array.from(new Set(
    evaluatorPolicyDeclarations.map(({ version }) => version),
  ));
  if (evaluatorPolicyVersions.length > 1) {
    throw new Error(
      `${input.name}: evaluator policy declarations disagree (${evaluatorPolicyDeclarations
        .map(({ location, version }) => `${location}=${version}`)
        .join(", ")}).`,
    );
  }
  const evaluatorPolicyVersion = evaluatorPolicyVersions[0] ?? null;

  const observations = new Map<string, JsonRecord>();
  for (const raw of Array.isArray(root.observations) ? root.observations : []) {
    const observation = object(raw);
    const fixtureId = observation?.fixtureId;
    if (typeof fixtureId !== "string" || !fixtureId) continue;
    if (observations.has(fixtureId)) {
      throw new Error(`${input.name}: duplicate observation for ${fixtureId}.`);
    }
    observations.set(fixtureId, observation);
  }

  const fixtures = new Map<string, Fixture>();
  for (const raw of rawFixtures) {
    const fixture = object(raw);
    const fixtureId = fixture?.fixtureId;
    if (typeof fixtureId !== "string" || !fixtureId) {
      throw new Error(`${input.name}: every fixture report needs a fixtureId.`);
    }
    if (fixtures.has(fixtureId)) {
      throw new Error(`${input.name}: duplicate fixture report for ${fixtureId}.`);
    }
    const metrics = object(fixture.metrics);
    const score = number(fixture, "score");
    if (!metrics || score === null) {
      throw new Error(`${input.name}/${fixtureId}: score or metrics are missing.`);
    }
    const observation = observations.get(fixtureId) ?? null;
    const usage = object(observation?.performance) ?? object(fixture.performance);
    fixtures.set(fixtureId, {
      fixtureId,
      passed: requiredBoolean(fixture.passed, `${input.name}/${fixtureId}.passed`),
      quality: {
        score,
        repositoryKnowledgeScore: number(metrics, "repositoryKnowledgeScore"),
        repositoryKnowledgeCoverageScore: number(
          metrics,
          "repositoryKnowledgeCoverageScore",
        ),
        repositoryKnowledgeGroundingScore: number(
          metrics,
          "repositoryKnowledgeGroundingScore",
        ),
        highlightGenerationScore: number(metrics, "highlightGenerationScore"),
        highlightSalienceCoverage: number(metrics, "highlightSalienceCoverage"),
        highlightGroundingScore: number(metrics, "highlightGroundingScore"),
        highlightPresentationScore: number(metrics, "highlightPresentationScore"),
        capabilityRecall: number(metrics, "capabilityRecall"),
        majorCapabilityRecall: number(metrics, "majorCapabilityRecall"),
        highlightCapabilityRecall: number(metrics, "highlightCapabilityRecall"),
        majorHighlightCapabilityRecall: number(
          metrics,
          "majorHighlightCapabilityRecall",
        ),
        highlightDomainRecall: number(metrics, "highlightDomainRecall"),
        highlightEvidencePrecision: number(metrics, "highlightEvidencePrecision"),
        highlightItemPrecision: number(metrics, "highlightItemPrecision"),
        highlightNonRedundancy: number(metrics, "highlightNonRedundancy"),
        domainRecall: number(metrics, "domainRecall"),
        knowledgeItemPrecision: number(metrics, "knowledgeItemPrecision", "itemPrecision"),
        evidencePrecision: number(metrics, "evidencePrecision"),
        claimStateCorrectness: number(metrics, "claimStateCorrectness", "stateCorrectness"),
        inventoryHygiene: number(metrics, "inventoryHygiene"),
        duplicateRate: number(metrics, "duplicateRate"),
        coverageCalibration: number(metrics, "coverageCalibration"),
      },
      operations: {
        modelAttempts: number(usage, "modelAttempts", "attempts"),
        modelCalls: number(usage, "modelCalls", "calls"),
        totalTokens: number(usage, "totalTokens", "tokens"),
        estimatedCostUsd: number(usage, "estimatedCostUsd", "costUsd"),
        durationMs: number(usage, "durationMs"),
      },
      executionIntegrity: executionIntegrity(
        observation?.executionIntegrity ?? fixture.executionIntegrity,
        `${input.name}/${fixtureId}.executionIntegrity`,
      ),
    });
  }
  return {
    name: input.name,
    path: input.path ?? null,
    evaluatorPolicyVersion,
    passed: requiredBoolean(aggregate.passed, `${input.name}.aggregate.passed`),
    fixtures,
    executionIntegrityPassed: Array.from(fixtures.values()).every((fixture) =>
      isCompletePassedExecutionIntegrity(fixture.executionIntegrity)
    ),
  };
}

function summarizeQuality(fixtures: readonly Fixture[]) {
  const scores = fixtures.map(({ quality }) => quality.score!);
  const macroAverageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const minimumProjectScore = Math.min(...scores);
  const repositoryKnowledgeScores = fixtures.map(
    ({ quality }) => quality.repositoryKnowledgeScore,
  );
  const highlightGenerationScores = fixtures.map(
    ({ quality }) => quality.highlightGenerationScore,
  );
  const aggregateOutcome = (values: Array<number | null>) => {
    if (!values.every((value): value is number => value !== null)) return null;
    const macro = values.reduce((sum, value) => sum + value, 0) / values.length;
    return round(macro * 0.7 + Math.min(...values) * 0.3);
  };
  return {
    score: round(macroAverageScore * 0.7 + minimumProjectScore * 0.3),
    repositoryKnowledgeScore: aggregateOutcome(repositoryKnowledgeScores),
    highlightGenerationScore: aggregateOutcome(highlightGenerationScores),
    macroAverageScore: round(macroAverageScore),
    minimumProjectScore: round(minimumProjectScore),
    passingFixtureRate: round(fixtures.filter(({ passed }) => passed).length / fixtures.length),
  } satisfies Record<AggregateMetric, number | null>;
}

function summarizeOperations(fixtures: readonly Fixture[]) {
  return Object.fromEntries(OPERATIONAL_METRICS.map((metric) => {
    const values = fixtures.map(({ operations }) => operations[metric]);
    const total = values.every((value): value is number => value !== null)
      ? round(values.reduce((sum, value) => sum + value, 0))
      : null;
    return [metric, total];
  })) as Record<OperationalMetric, number | null>;
}

function compareMetric(input: {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  tolerance: number;
  lowerIsBetter?: boolean;
  relativeTolerance?: boolean;
}): Delta {
  const {
    metric,
    baseline,
    candidate,
    tolerance,
    lowerIsBetter = false,
    relativeTolerance = false,
  } = input;
  if (baseline === null) {
    return {
      metric, baseline, candidate, delta: null, relativeDelta: null, tolerance,
      status: "unavailable",
      reason: `Baseline did not report this ${lowerIsBetter ? "telemetry" : "metric"}.`,
    };
  }
  if (candidate === null) {
    return {
      metric, baseline, candidate, delta: null, relativeDelta: null, tolerance,
      status: "regressed",
      reason: `Candidate stopped reporting baseline ${lowerIsBetter ? "telemetry" : "metrics"}.`,
    };
  }
  const delta = round(candidate - baseline);
  const relativeDelta = baseline === 0
    ? candidate === 0 ? 0 : null
    : round(delta / Math.abs(baseline));
  const regressed = lowerIsBetter
    ? relativeTolerance
      ? baseline === 0 ? candidate > 0 : candidate > baseline * (1 + tolerance)
      : delta > tolerance
    : delta < -tolerance;
  return {
    metric, baseline, candidate, delta, relativeDelta, tolerance,
    status: regressed
      ? "regressed"
      : delta === 0
        ? "within_tolerance"
        : lowerIsBetter === (delta < 0) ? "improved" : "within_tolerance",
  };
}

function regressions(deltas: readonly Delta[], scope: Regression["scope"], fixtureId?: string) {
  return deltas.flatMap((delta): Regression[] => delta.status === "regressed" ? [{
    scope,
    ...(fixtureId ? { fixtureId } : {}),
    metric: delta.metric,
    reason: delta.reason ?? `${delta.metric} moved beyond its configured tolerance.`,
  }] : []);
}

function compareExecutionIntegrity(
  baseline: ExecutionIntegrity | null,
  candidate: ExecutionIntegrity | null,
  fixtureId: string,
) {
  const found: Regression[] = [];
  if (!baseline) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "executionIntegrity",
      reason: "Baseline has no main-path execution attestation.",
    });
  } else if (!isCompletePassedExecutionIntegrity(baseline)) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "executionIntegrity",
      reason: `Baseline main-path execution failed: ${executionIntegrityFailure(baseline)}.`,
    });
  }
  if (!candidate) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "executionIntegrity",
      reason: "Candidate has no main-path execution attestation.",
    });
  } else if (!isCompletePassedExecutionIntegrity(candidate)) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "executionIntegrity",
      reason: `Candidate main-path execution failed: ${executionIntegrityFailure(candidate)}.`,
    });
  }
  const baselineModels = baseline?.modelIdentities ?? [];
  const candidateModels = candidate?.modelIdentities ?? [];
  const modelIdentityMatch = baselineModels.length > 0 &&
    candidateModels.length > 0 &&
    JSON.stringify(baselineModels) === JSON.stringify(candidateModels);
  if (baseline && candidate && !modelIdentityMatch) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "modelIdentity",
      reason: "Candidate and baseline did not use the same provider/model identities.",
    });
  }
  if (baseline && !baseline.policyVersions.length) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "policyIdentity",
      reason: "Baseline has no policy-version attestation.",
    });
  }
  if (candidate && !candidate.policyVersions.length) {
    found.push({
      scope: "fixture",
      fixtureId,
      metric: "policyIdentity",
      reason: "Candidate has no policy-version attestation.",
    });
  }
  return {
    baseline,
    candidate,
    modelIdentityMatch,
    policyChanged: Boolean(
      baseline && candidate &&
      JSON.stringify(baseline.policyVersions) !== JSON.stringify(candidate.policyVersions)
    ),
    regressions: found,
  };
}

function compareBaseline(
  candidate: Report,
  baseline: Report,
  tolerances: RepositoryKnowledgeComparisonTolerances,
) {
  const evaluatorVersionsCompatible =
    baseline.evaluatorPolicyVersion === null ||
    candidate.evaluatorPolicyVersion === null ||
    baseline.evaluatorPolicyVersion === candidate.evaluatorPolicyVersion;
  const evaluatorVersionDiagnostic =
    baseline.evaluatorPolicyVersion === null || candidate.evaluatorPolicyVersion === null
      ? "At least one report predates evaluator policy attestation; comparison uses legacy compatibility and cannot prove identical scorer semantics."
      : evaluatorVersionsCompatible
        ? null
        : "Candidate and baseline declare different evaluator policy versions.";
  const baselineFixtures = Array.from(baseline.fixtures.values());
  const baselineFixtureIds = Array.from(baseline.fixtures.keys()).sort();
  const candidateFixtureIds = Array.from(candidate.fixtures.keys()).sort();
  const baselineOnlyFixtureIds = baselineFixtureIds.filter((fixtureId) =>
    !candidate.fixtures.has(fixtureId)
  );
  const candidateOnlyFixtureIds = candidateFixtureIds.filter((fixtureId) =>
    !baseline.fixtures.has(fixtureId)
  );
  const candidateFixtures = baselineFixtures.flatMap((fixture) => {
    const match = candidate.fixtures.get(fixture.fixtureId);
    return match ? [match] : [];
  });
  const complete = candidateFixtures.length === baselineFixtures.length;
  const baselineQuality = summarizeQuality(baselineFixtures);
  const candidateQuality = complete ? summarizeQuality(candidateFixtures) : null;
  const aggregateQuality = AGGREGATE_METRICS.map((metric) => compareMetric({
    metric,
    baseline: baselineQuality[metric],
    candidate: candidateQuality?.[metric] ?? null,
    tolerance: tolerances.aggregateQualityDrop,
  }));
  const baselineOperations = summarizeOperations(baselineFixtures);
  const candidateOperations = complete ? summarizeOperations(candidateFixtures) : null;
  const aggregateOperations = OPERATIONAL_METRICS.map((metric) => compareMetric({
    metric,
    baseline: baselineOperations[metric],
    candidate: candidateOperations?.[metric] ?? null,
    tolerance: tolerances.operationalIncreaseRatio,
    lowerIsBetter: true,
    relativeTolerance: true,
  }));
  const suiteRegressions = regressions(
    [...aggregateQuality, ...aggregateOperations], "suite",
  );
  if (!evaluatorVersionsCompatible) {
    suiteRegressions.push({
      scope: "suite",
      metric: "evaluatorPolicyVersion",
      reason: evaluatorVersionDiagnostic!,
    });
  }
  if (baseline.passed && !candidate.passed) {
    suiteRegressions.push({
      scope: "suite", metric: "passed",
      reason: "Candidate changed the suite from passing to failing.",
    });
  }
  const invalidCandidateOnlyFixtures = candidateOnlyFixtureIds.filter((fixtureId) =>
    !isCompletePassedExecutionIntegrity(
      candidate.fixtures.get(fixtureId)?.executionIntegrity ?? null,
    )
  );
  if (invalidCandidateOnlyFixtures.length) {
    suiteRegressions.push({
      scope: "suite",
      metric: "executionIntegrity",
      reason: `Candidate-only fixtures lack complete passed main-path attestations: ${invalidCandidateOnlyFixtures.join(", ")}.`,
    });
  }

  const fixtures = baselineFixtures
    .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
    .map((baselineFixture) => {
      const candidateFixture = candidate.fixtures.get(baselineFixture.fixtureId);
      if (!candidateFixture) {
        return {
          fixtureId: baselineFixture.fixtureId,
          present: false,
          baselinePassed: baselineFixture.passed,
          candidatePassed: null,
          quality: [] as Delta[],
          operations: [] as Delta[],
          integrity: null,
          regressions: [{
            scope: "fixture" as const,
            fixtureId: baselineFixture.fixtureId,
            metric: "presence",
            reason: "Candidate is missing a baseline fixture.",
          }],
        };
      }
      const quality = QUALITY_METRICS.map((metric) => compareMetric({
        metric,
        baseline: baselineFixture.quality[metric],
        candidate: candidateFixture.quality[metric],
        tolerance: metric === "score" ? tolerances.fixtureScoreDrop : tolerances.fixtureMetricDrop,
        lowerIsBetter: metric === "duplicateRate",
      }));
      const operations = OPERATIONAL_METRICS.map((metric) => compareMetric({
        metric,
        baseline: baselineFixture.operations[metric],
        candidate: candidateFixture.operations[metric],
        tolerance: tolerances.operationalIncreaseRatio,
        lowerIsBetter: true,
        relativeTolerance: true,
      }));
      const fixtureRegressions = regressions(
        [...quality, ...operations], "fixture", baselineFixture.fixtureId,
      );
      const integrity = compareExecutionIntegrity(
        baselineFixture.executionIntegrity,
        candidateFixture.executionIntegrity,
        baselineFixture.fixtureId,
      );
      fixtureRegressions.push(...integrity.regressions);
      if (baselineFixture.passed && !candidateFixture.passed) {
        fixtureRegressions.push({
          scope: "fixture",
          fixtureId: baselineFixture.fixtureId,
          metric: "passed",
          reason: "Candidate changed this fixture from passing to failing.",
        });
      }
      return {
        fixtureId: baselineFixture.fixtureId,
        present: true,
        baselinePassed: baselineFixture.passed,
        candidatePassed: candidateFixture.passed,
        quality,
        operations,
        integrity,
        regressions: fixtureRegressions,
      };
    });
  const allRegressions = [
    ...suiteRegressions,
    ...fixtures.flatMap((fixture) => fixture.regressions),
  ];
  return {
    baseline: { name: baseline.name, path: baseline.path },
    evaluatorPolicyCompatibility: {
      baseline: baseline.evaluatorPolicyVersion,
      candidate: candidate.evaluatorPolicyVersion,
      compatible: evaluatorVersionsCompatible,
      diagnostic: evaluatorVersionDiagnostic,
    },
    passed: allRegressions.length === 0,
    comparedFixtureCount: baselineFixtures.length - baselineOnlyFixtureIds.length,
    candidateOnlyFixtureIds,
    baselineOnlyFixtureIds,
    aggregateQuality,
    aggregateOperations,
    fixtures,
    regressions: allRegressions,
  };
}

function tolerance(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

export function compareRepositoryKnowledgeReports(input: {
  candidate: NamedReport;
  baselines: NamedReport[];
  tolerances?: Partial<RepositoryKnowledgeComparisonTolerances>;
}) {
  if (!input.baselines.length) throw new Error("At least one named baseline is required.");
  const names = [input.candidate.name, ...input.baselines.map(({ name }) => name)];
  if (names.some((name) => !name.trim()) || new Set(names).size !== names.length) {
    throw new Error("Candidate and baseline names must be non-empty and unique.");
  }
  const configured = {
    ...DEFAULT_REPOSITORY_KNOWLEDGE_COMPARISON_TOLERANCES,
    ...input.tolerances,
  };
  for (const [name, value] of Object.entries(configured)) tolerance(value, name);
  const candidate = normalize(input.candidate);
  const comparisons = input.baselines.map((baseline) =>
    compareBaseline(candidate, normalize(baseline), configured)
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    passed: comparisons.every(({ passed }) => passed),
    candidate: {
      name: candidate.name,
      path: candidate.path,
      fixtureCount: candidate.fixtures.size,
      executionIntegrityPassed: candidate.executionIntegrityPassed,
      evaluatorPolicyVersion: candidate.evaluatorPolicyVersion,
    },
    tolerances: configured,
    operationalMetricSemantics: OPERATIONAL_METRIC_SEMANTICS,
    comparisons,
  };
}

const TOLERANCE_OPTIONS = {
  "--aggregate-quality-tolerance": "aggregateQualityDrop",
  "--fixture-score-tolerance": "fixtureScoreDrop",
  "--fixture-metric-tolerance": "fixtureMetricDrop",
  "--operational-tolerance": "operationalIncreaseRatio",
} as const;

function usage() {
  return `Usage:
  npm run --silent eval:repository-knowledge:compare -- \\
    --candidate <name>=<report.json> \\
    --baseline <name>=<report.json> [--baseline <name>=<report.json> ...]

Options:
  --aggregate-quality-tolerance <ratio>  Default 0.02 (absolute score drop)
  --fixture-score-tolerance <ratio>      Default 0.03 (absolute score drop)
  --fixture-metric-tolerance <ratio>     Default 0.05 (absolute metric drop)
  --operational-tolerance <ratio>        Default 0.25 (relative increase)
  --compact                              Emit single-line JSON

Exit code 0 means no configured regression, 1 means a regression, and 2 means
invalid input.`;
}

function valueAfter(args: string[], index: number, option: string) {
  const argument = args[index]!;
  const inline = argument.startsWith(`${option}=`) ? argument.slice(option.length + 1) : null;
  if (inline) return { value: inline, consumed: 0 };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return { value, consumed: 1 };
}

function namedPath(value: string, option: string) {
  const delimiter = value.indexOf("=");
  if (delimiter < 1 || delimiter === value.length - 1) {
    throw new Error(`${option} must use <name>=<report.json>.`);
  }
  return { name: value.slice(0, delimiter), path: resolve(value.slice(delimiter + 1)) };
}

function parseArgs(args: string[]) {
  let candidate: ReturnType<typeof namedPath> | null = null;
  const baselines: Array<ReturnType<typeof namedPath>> = [];
  const tolerances: Partial<RepositoryKnowledgeComparisonTolerances> = {};
  let pretty = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--compact") {
      pretty = false;
      continue;
    }
    if (argument === "--candidate" || argument.startsWith("--candidate=")) {
      const resolvedValue = valueAfter(args, index, "--candidate");
      if (candidate) throw new Error("Supply exactly one --candidate.");
      candidate = namedPath(resolvedValue.value, "--candidate");
      index += resolvedValue.consumed;
      continue;
    }
    if (argument === "--baseline" || argument.startsWith("--baseline=")) {
      const resolvedValue = valueAfter(args, index, "--baseline");
      baselines.push(namedPath(resolvedValue.value, "--baseline"));
      index += resolvedValue.consumed;
      continue;
    }
    const flag = Object.keys(TOLERANCE_OPTIONS).find((key) =>
      argument === key || argument.startsWith(`${key}=`)
    ) as keyof typeof TOLERANCE_OPTIONS | undefined;
    if (flag) {
      const resolvedValue = valueAfter(args, index, flag);
      tolerances[TOLERANCE_OPTIONS[flag]] = tolerance(Number(resolvedValue.value), flag);
      index += resolvedValue.consumed;
      continue;
    }
    throw new Error(`Unknown option: ${argument}.\n\n${usage()}`);
  }
  if (!candidate || !baselines.length) {
    throw new Error(`Supply one --candidate and at least one --baseline.\n\n${usage()}`);
  }
  return { candidate, baselines, tolerances, pretty };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serialized = await Promise.all([
    readFile(options.candidate.path, "utf8"),
    ...options.baselines.map(({ path }) => readFile(path, "utf8")),
  ]);
  const output = compareRepositoryKnowledgeReports({
    candidate: { ...options.candidate, report: JSON.parse(serialized[0]!) as unknown },
    baselines: options.baselines.map((baseline, index) => ({
      ...baseline,
      report: JSON.parse(serialized[index + 1]!) as unknown,
    })),
    tolerances: options.tolerances,
  });
  process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
  if (!output.passed) process.exitCode = 1;
}

const executablePath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (executablePath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
