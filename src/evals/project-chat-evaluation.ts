import {
  getProjectChatEvaluationFixture,
  projectChatEvaluationFixtures,
  type ProjectChatEvaluationAuthority,
  type ProjectChatEvaluationFixture,
  type ProjectChatEvaluationLifecycle,
  type ProjectChatEvaluationRoute,
  type ProjectChatEvaluationSourceKind,
  type ProjectChatScenarioId,
} from "@/src/evals/project-chat-fixtures";

export interface ProjectChatScenarioSourceObservation {
  kind: ProjectChatEvaluationSourceKind;
  authority: ProjectChatEvaluationAuthority;
  title: string;
  /** Only sources that materially support the final response may be persisted. */
  used: boolean;
  /** Repository excerpts may be nested provenance, but never peer citations. */
  presentation?: "primary" | "nested_provenance";
  /** Immutable owner/repository scope that ultimately supports this source. */
  repository?: string;
}

export interface ProjectChatScenarioMetrics {
  latencyMs: number;
  modelCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  repositoryTreeLookups: number;
  repositorySearches: number;
  repositoryFileReads: number;
  repositoryVisibleBytes: number;
  workerCount: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ProjectChatScenarioObservation {
  scenarioId: ProjectChatScenarioId;
  route: ProjectChatEvaluationRoute;
  lifecycle: ProjectChatEvaluationLifecycle;
  tools: string[];
  sources: ProjectChatScenarioSourceObservation[];
  metrics: ProjectChatScenarioMetrics;
  answer: string;
  coverageGaps: string[];
  partial: boolean;
  repositoryHeadsCurrent: boolean;
}

export type ProjectChatEvaluationCheckCode =
  | "route"
  | "lifecycle"
  | "required_tool"
  | "forbidden_tool"
  | "source_kind"
  | "source_authority"
  | "unused_source"
  | "raw_repository_source"
  | "required_source"
  | "minimum_sources"
  | "repository_scope"
  | "coverage_gap"
  | "partial_result"
  | "freshness"
  | "markdown"
  | "required_answer_pattern"
  | "forbidden_answer_pattern"
  | "metric"
  | "performance_budget";

export interface ProjectChatEvaluationCheck {
  code: ProjectChatEvaluationCheckCode;
  passed: boolean;
  message: string;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface ProjectChatScenarioEvaluation {
  scenarioId: ProjectChatScenarioId;
  title: string;
  passed: boolean;
  checks: ProjectChatEvaluationCheck[];
}

export interface ProjectChatSuiteEvaluation {
  passed: boolean;
  evaluatedScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  missingScenarioIds: ProjectChatScenarioId[];
  duplicateScenarioIds: ProjectChatScenarioId[];
  results: ProjectChatScenarioEvaluation[];
  aggregateMetrics: ProjectChatScenarioMetrics;
}

const requiredScenarioIds = projectChatEvaluationFixtures.map((fixture) => fixture.id);

function check(
  checks: ProjectChatEvaluationCheck[],
  code: ProjectChatEvaluationCheckCode,
  passed: boolean,
  message: string,
  actual?: string | number | boolean,
  expected?: string | number | boolean,
) {
  checks.push({ code, passed, message, actual, expected });
}

function isFiniteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function looksLikeMarkdown(value: string) {
  return /(^|\n)(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|\|.+\|)/m.test(value)
    || /\[[^\]]+\]\([^\)]+\)/.test(value)
    || /\*\*[^*]+\*\*/.test(value);
}

function matches(value: string, pattern: string) {
  return new RegExp(pattern, "iu").test(value);
}

const metricBudgetPairs = [
  ["latencyMs", "maxLatencyMs"],
  ["modelCalls", "maxModelCalls"],
  ["totalTokens", "maxTotalTokens"],
  ["estimatedCostUsd", "maxEstimatedCostUsd"],
  ["repositoryTreeLookups", "maxRepositoryTreeLookups"],
  ["repositorySearches", "maxRepositorySearches"],
  ["repositoryFileReads", "maxRepositoryFileReads"],
  ["repositoryVisibleBytes", "maxRepositoryVisibleBytes"],
  ["workerCount", "maxWorkerCount"],
] as const;

export function validateProjectChatScenarioFixtures(
  fixtures: readonly ProjectChatEvaluationFixture[] = projectChatEvaluationFixtures,
) {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) errors.push(`Duplicate scenario id: ${fixture.id}`);
    seen.add(fixture.id);
    if (!fixture.question.trim()) errors.push(`${fixture.id}: question is empty`);
    if (!fixture.expected.lifecycle.length) errors.push(`${fixture.id}: no accepted lifecycle state`);
    if (fixture.expected.minimumUsedSources < 0) errors.push(`${fixture.id}: minimumUsedSources is negative`);
    if (fixture.expected.minimumUsedSources > 0 && !fixture.expected.allowedSourceKinds.length) {
      errors.push(`${fixture.id}: requires sources but allows no source kinds`);
    }
    if (
      fixture.expected.minimumRepositoryScopes !== undefined &&
      (fixture.expected.minimumRepositoryScopes < 1 || fixture.expected.minimumRepositoryScopes > fixture.setup.attachedRepositoryCount)
    ) {
      errors.push(`${fixture.id}: minimumRepositoryScopes must be between 1 and attachedRepositoryCount`);
    }
    for (const sourceKind of fixture.expected.requiredSourceKinds) {
      if (!fixture.expected.allowedSourceKinds.includes(sourceKind)) {
        errors.push(`${fixture.id}: required source kind ${sourceKind} is not allowed`);
      }
    }
    for (const tool of fixture.expected.requiredTools) {
      if (fixture.expected.forbiddenTools.includes(tool)) {
        errors.push(`${fixture.id}: tool ${tool} is both required and forbidden`);
      }
    }
    for (const [, maximumKey] of metricBudgetPairs) {
      if (!isFiniteNonNegative(fixture.envelope[maximumKey])) {
        errors.push(`${fixture.id}: ${maximumKey} must be finite and non-negative`);
      }
    }
    for (const pattern of [
      ...(fixture.expected.requiredAnswerPatterns ?? []),
      ...(fixture.expected.forbiddenAnswerPatterns ?? []),
    ]) {
      try {
        new RegExp(pattern, "iu");
      } catch {
        errors.push(`${fixture.id}: invalid answer pattern ${JSON.stringify(pattern)}`);
      }
    }
  }
  return errors;
}

export function evaluateProjectChatScenario(
  observation: ProjectChatScenarioObservation,
  requestedFixture?: ProjectChatEvaluationFixture,
): ProjectChatScenarioEvaluation {
  const fixture = requestedFixture ?? getProjectChatEvaluationFixture(observation.scenarioId);
  if (!fixture) throw new Error(`Unknown project-chat evaluation scenario: ${observation.scenarioId}`);
  const checks: ProjectChatEvaluationCheck[] = [];

  check(checks, "route", observation.route === fixture.expected.route,
    `Execution route must be ${fixture.expected.route}.`, observation.route, fixture.expected.route);
  check(checks, "lifecycle", fixture.expected.lifecycle.includes(observation.lifecycle),
    `Lifecycle must be one of: ${fixture.expected.lifecycle.join(", ")}.`, observation.lifecycle, fixture.expected.lifecycle.join(", "));

  const invokedTools = new Set(observation.tools);
  for (const tool of fixture.expected.requiredTools) {
    check(checks, "required_tool", invokedTools.has(tool), `Required tool was invoked: ${tool}.`, invokedTools.has(tool), true);
  }
  for (const tool of fixture.expected.forbiddenTools) {
    check(checks, "forbidden_tool", !invokedTools.has(tool), `Forbidden tool was not invoked: ${tool}.`, invokedTools.has(tool), false);
  }

  const usedSources = observation.sources.filter((source) => source.used && source.presentation !== "nested_provenance");
  for (const source of observation.sources) {
    const nestedRepositoryProvenance = source.kind === "github_file" && source.presentation === "nested_provenance";
    check(checks, "unused_source", source.used, `Persisted source is used by the final answer: ${source.title}.`, source.used, true);
    check(checks, "source_kind", nestedRepositoryProvenance || fixture.expected.allowedSourceKinds.includes(source.kind),
      `Source kind is allowed: ${source.kind}.`, source.kind, fixture.expected.allowedSourceKinds.join(", "));
    check(checks, "source_authority", nestedRepositoryProvenance || fixture.expected.allowedAuthorities.includes(source.authority),
      `Source authority is allowed: ${source.authority}.`, source.authority, fixture.expected.allowedAuthorities.join(", "));
    check(checks, "raw_repository_source", source.kind !== "github_file" || source.presentation === "nested_provenance",
      "Raw GitHub files may appear only as nested provenance, never as peer sources.", source.presentation ?? "primary", "nested_provenance");
  }
  for (const sourceKind of fixture.expected.requiredSourceKinds) {
    check(checks, "required_source", usedSources.some((source) => source.kind === sourceKind),
      `At least one used ${sourceKind} source is required.`, usedSources.some((source) => source.kind === sourceKind), true);
  }
  check(checks, "minimum_sources", usedSources.length >= fixture.expected.minimumUsedSources,
    `At least ${fixture.expected.minimumUsedSources} used sources are required.`, usedSources.length, fixture.expected.minimumUsedSources);
  if (fixture.expected.minimumRepositoryScopes !== undefined) {
    const repositoryScopes = new Set(usedSources.flatMap((source) => source.repository ? [source.repository] : []));
    const explicitPartialCoverage = observation.partial && observation.coverageGaps.some((gap) => gap.trim().length > 0);
    check(
      checks,
      "repository_scope",
      repositoryScopes.size >= fixture.expected.minimumRepositoryScopes || explicitPartialCoverage,
      `The answer must use sources from ${fixture.expected.minimumRepositoryScopes} repositories or explicitly report partial coverage.`,
      repositoryScopes.size,
      fixture.expected.minimumRepositoryScopes,
    );
  }

  if (fixture.expected.requiresCoverageGap) {
    check(checks, "coverage_gap", observation.coverageGaps.some((gap) => gap.trim().length > 0),
      "The result must identify a specific coverage gap.", observation.coverageGaps.length, 1);
  }
  if (fixture.expected.requiresPartialResult) {
    check(checks, "partial_result", observation.partial,
      "Limit recovery must explicitly label the result partial.", observation.partial, true);
  }
  if (fixture.expected.requiresCurrentRepositoryHeads) {
    check(checks, "freshness", observation.repositoryHeadsCurrent,
      "The response must be validated through current repository heads.", observation.repositoryHeadsCurrent, true);
  }
  if (fixture.expected.requiresMarkdown) {
    check(checks, "markdown", looksLikeMarkdown(observation.answer),
      "The response must contain renderable Markdown structure.", looksLikeMarkdown(observation.answer), true);
  }
  for (const pattern of fixture.expected.requiredAnswerPatterns ?? []) {
    check(checks, "required_answer_pattern", matches(observation.answer, pattern),
      `Answer must match /${pattern}/iu.`, matches(observation.answer, pattern), true);
  }
  for (const pattern of fixture.expected.forbiddenAnswerPatterns ?? []) {
    check(checks, "forbidden_answer_pattern", !matches(observation.answer, pattern),
      `Answer must not match /${pattern}/iu.`, matches(observation.answer, pattern), false);
  }

  for (const [metricKey, maximumKey] of metricBudgetPairs) {
    const actual = observation.metrics[metricKey];
    const maximum = fixture.envelope[maximumKey];
    check(checks, "metric", isFiniteNonNegative(actual), `${metricKey} is measured and non-negative.`, actual, true);
    check(checks, "performance_budget", isFiniteNonNegative(actual) && actual <= maximum,
      `${metricKey} stays within ${maximumKey}.`, actual, maximum);
  }

  return {
    scenarioId: fixture.id,
    title: fixture.title,
    passed: checks.every((entry) => entry.passed),
    checks,
  };
}

function zeroMetrics(): ProjectChatScenarioMetrics {
  return {
    latencyMs: 0,
    modelCalls: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    repositoryTreeLookups: 0,
    repositorySearches: 0,
    repositoryFileReads: 0,
    repositoryVisibleBytes: 0,
    workerCount: 0,
  };
}

export function evaluateProjectChatSuite(
  observations: readonly ProjectChatScenarioObservation[],
): ProjectChatSuiteEvaluation {
  const counts = new Map<ProjectChatScenarioId, number>();
  for (const observation of observations) counts.set(observation.scenarioId, (counts.get(observation.scenarioId) ?? 0) + 1);
  const duplicateScenarioIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const missingScenarioIds = requiredScenarioIds.filter((id) => !counts.has(id));
  const uniqueObservations = observations.filter((observation, index) =>
    observations.findIndex((candidate) => candidate.scenarioId === observation.scenarioId) === index);
  const results = uniqueObservations.map((observation) => evaluateProjectChatScenario(observation));
  const aggregateMetrics = uniqueObservations.reduce<ProjectChatScenarioMetrics>((total, observation) => ({
    latencyMs: total.latencyMs + observation.metrics.latencyMs,
    modelCalls: total.modelCalls + observation.metrics.modelCalls,
    totalTokens: total.totalTokens + observation.metrics.totalTokens,
    estimatedCostUsd: total.estimatedCostUsd + observation.metrics.estimatedCostUsd,
    repositoryTreeLookups: total.repositoryTreeLookups + observation.metrics.repositoryTreeLookups,
    repositorySearches: total.repositorySearches + observation.metrics.repositorySearches,
    repositoryFileReads: total.repositoryFileReads + observation.metrics.repositoryFileReads,
    repositoryVisibleBytes: total.repositoryVisibleBytes + observation.metrics.repositoryVisibleBytes,
    workerCount: total.workerCount + observation.metrics.workerCount,
    cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + (observation.metrics.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens: (total.cacheWriteInputTokens ?? 0) + (observation.metrics.cacheWriteInputTokens ?? 0),
  }), zeroMetrics());
  const passedScenarios = results.filter((result) => result.passed).length;
  return {
    passed: missingScenarioIds.length === 0 && duplicateScenarioIds.length === 0 && results.every((result) => result.passed),
    evaluatedScenarios: results.length,
    passedScenarios,
    failedScenarios: results.length - passedScenarios,
    missingScenarioIds,
    duplicateScenarioIds,
    results,
    aggregateMetrics,
  };
}
