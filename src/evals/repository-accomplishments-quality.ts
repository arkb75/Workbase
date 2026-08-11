import { createHash } from "node:crypto";
import {
  projectChatApplicationScenarios,
  type ProjectChatApplicationScenario,
  type ProjectChatApplicationScenarioResult,
} from "@/src/evals/project-chat-application-runner";
import { projectChatPrimaryAnswerItems } from "@/src/evals/project-chat-answer-quality";

export const REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION =
  "workbase-repository-accomplishments-profile-v1" as const;
export const REPOSITORY_ACCOMPLISHMENTS_REPORT_SCHEMA_VERSION =
  "workbase-repository-accomplishments-report-v1" as const;

export interface RepositoryAccomplishmentsProfile {
  schemaVersion: typeof REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION;
  workItemTitle: string;
  repository: string;
  requiredCapabilityPatterns: string[];
  includeFreshnessFollowUp: boolean;
  minimumPrimaryItems: number;
  maximumPrimaryItems: number;
  minimumDevelopedItems: number;
  minimumCitedItems: number;
  minimumCharacters: number;
  maximumCharacters: number;
}

export interface RepositoryAccomplishmentsTargetCandidate {
  id: string;
  title: string;
  sources: Array<{
    id: string;
    type: string;
    metadata: unknown;
    evidenceItemCount?: number;
  }>;
}

export interface ExactRepositoryAccomplishmentsTarget {
  workItemId: string;
  workItemTitle: string;
  sourceId: string;
  repository: string;
  commitSha: string;
  evidenceItemCount: number | null;
}

export interface RepositoryAccomplishmentsHarnessCheck {
  name: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
) {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function validPattern(value: unknown, index: number) {
  const pattern = nonEmptyString(
    value,
    `requiredCapabilityPatterns[${index}]`,
  );
  if (pattern.length > 500) {
    throw new Error(`requiredCapabilityPatterns[${index}] exceeds 500 characters.`);
  }
  try {
    new RegExp(pattern, "iu");
  } catch (error) {
    throw new Error(
      `requiredCapabilityPatterns[${index}] is not a valid regular expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return pattern;
}

export function parseRepositoryAccomplishmentsProfile(
  input: unknown,
): RepositoryAccomplishmentsProfile {
  const value = objectValue(input);
  if (!value) {
    throw new Error("The repository accomplishments profile must be a JSON object.");
  }
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION
  ) {
    throw new Error(
      `schemaVersion must be ${REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION}.`,
    );
  }
  const rawPatterns = value.requiredCapabilityPatterns;
  if (!Array.isArray(rawPatterns) || !rawPatterns.length) {
    throw new Error(
      "requiredCapabilityPatterns must contain at least one repository-specific regular expression.",
    );
  }
  if (rawPatterns.length > 12) {
    throw new Error("requiredCapabilityPatterns cannot contain more than 12 expressions.");
  }

  const minimumPrimaryItems = boundedInteger(
    value.minimumPrimaryItems,
    4,
    "minimumPrimaryItems",
    1,
    6,
  );
  const maximumPrimaryItems = boundedInteger(
    value.maximumPrimaryItems,
    6,
    "maximumPrimaryItems",
    1,
    6,
  );
  const minimumDevelopedItems = boundedInteger(
    value.minimumDevelopedItems,
    minimumPrimaryItems,
    "minimumDevelopedItems",
    1,
    6,
  );
  const minimumCitedItems = boundedInteger(
    value.minimumCitedItems,
    minimumPrimaryItems,
    "minimumCitedItems",
    1,
    6,
  );
  if (minimumPrimaryItems > maximumPrimaryItems) {
    throw new Error("minimumPrimaryItems cannot exceed maximumPrimaryItems.");
  }
  if (minimumDevelopedItems > maximumPrimaryItems) {
    throw new Error("minimumDevelopedItems cannot exceed maximumPrimaryItems.");
  }
  if (minimumCitedItems > maximumPrimaryItems) {
    throw new Error("minimumCitedItems cannot exceed maximumPrimaryItems.");
  }

  const minimumCharacters = boundedInteger(
    value.minimumCharacters,
    Math.max(500, minimumDevelopedItems * 180),
    "minimumCharacters",
    200,
    10_000,
  );
  const maximumCharacters = boundedInteger(
    value.maximumCharacters,
    5_500,
    "maximumCharacters",
    500,
    20_000,
  );
  if (minimumCharacters > maximumCharacters) {
    throw new Error("minimumCharacters cannot exceed maximumCharacters.");
  }
  if (
    value.includeFreshnessFollowUp !== undefined &&
    typeof value.includeFreshnessFollowUp !== "boolean"
  ) {
    throw new Error("includeFreshnessFollowUp must be a boolean.");
  }

  return {
    schemaVersion: REPOSITORY_ACCOMPLISHMENTS_PROFILE_SCHEMA_VERSION,
    workItemTitle: nonEmptyString(value.workItemTitle, "workItemTitle"),
    repository: nonEmptyString(value.repository, "repository"),
    requiredCapabilityPatterns: rawPatterns.map(validPattern),
    includeFreshnessFollowUp:
      value.includeFreshnessFollowUp === undefined
        ? true
        : value.includeFreshnessFollowUp,
    minimumPrimaryItems,
    maximumPrimaryItems,
    minimumDevelopedItems,
    minimumCitedItems,
    minimumCharacters,
    maximumCharacters,
  };
}

function nestedString(value: unknown, path: readonly string[]) {
  let current: unknown = value;
  for (const key of path) current = objectValue(current)?.[key];
  return typeof current === "string" && current.trim()
    ? current.trim()
    : null;
}

function sourceRepository(source: RepositoryAccomplishmentsTargetCandidate["sources"][number]) {
  return nestedString(source.metadata, ["repository", "fullName"]);
}

function sourceCommitSha(source: RepositoryAccomplishmentsTargetCandidate["sources"][number]) {
  return nestedString(source.metadata, ["revision", "commitSha"])
    ?? nestedString(source.metadata, ["commitSha"]);
}

/**
 * Exact means exact: no case folding, latest-row preference, label fallback,
 * or fallback to another repository-bearing Work Item is permitted here.
 */
export function resolveExactRepositoryAccomplishmentsTarget(input: {
  profile: RepositoryAccomplishmentsProfile;
  candidates: readonly RepositoryAccomplishmentsTargetCandidate[];
}): ExactRepositoryAccomplishmentsTarget {
  const exactWorkItems = input.candidates.filter(
    (candidate) => candidate.title === input.profile.workItemTitle,
  );
  const matches = exactWorkItems.flatMap((workItem) =>
    workItem.sources
      .filter((source) =>
        source.type === "github_repo" &&
        sourceRepository(source) === input.profile.repository
      )
      .map((source) => ({ workItem, source })),
  );
  if (!matches.length) {
    throw new Error(
      `No exact Work Item/repository target matched ${JSON.stringify(input.profile.workItemTitle)} and ${JSON.stringify(input.profile.repository)}. No fallback was attempted.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `The exact Work Item/repository target is ambiguous: ${matches.length} matches were found for ${JSON.stringify(input.profile.workItemTitle)} and ${JSON.stringify(input.profile.repository)}.`,
    );
  }
  const [{ workItem, source }] = matches;
  const commitSha = sourceCommitSha(source);
  if (!commitSha || !/^[a-f0-9]{40}$/iu.test(commitSha)) {
    throw new Error(
      `The exact repository Source ${source.id} has no valid current 40-character commit SHA; wait for its import/refresh to complete before evaluation.`,
    );
  }
  return {
    workItemId: workItem.id,
    workItemTitle: workItem.title,
    sourceId: source.id,
    repository: input.profile.repository,
    commitSha: commitSha.toLowerCase(),
    evidenceItemCount:
      typeof source.evidenceItemCount === "number"
        ? source.evidenceItemCount
        : null,
  };
}

export function buildRepositoryAccomplishmentsScenarioCatalog(
  profile: RepositoryAccomplishmentsProfile,
): ProjectChatApplicationScenario[] {
  const selectedIds = new Set([
    "strongest_accomplishments",
    ...(profile.includeFreshnessFollowUp
      ? ["strongest_accomplishments_freshness_follow_up"]
      : []),
  ]);
  const applicationScenarios: readonly ProjectChatApplicationScenario[] =
    projectChatApplicationScenarios;
  return applicationScenarios
    .filter((scenario) => selectedIds.has(scenario.id))
    .map((scenario) => ({
      ...scenario,
      title: `${scenario.title} · ${profile.repository}`,
      answerContract: {
        ...scenario.answerContract,
        minCharacters: profile.minimumCharacters,
        maxCharacters: profile.maximumCharacters,
        // Workbase's default theme taxonomy is intentionally product-specific.
        // Repository profiles express their own capability coverage instead.
        minReaderThemes: 0,
        minPrimaryItems: profile.minimumPrimaryItems,
        maxPrimaryItems: profile.maximumPrimaryItems,
        minDevelopedItems: profile.minimumDevelopedItems,
        minMechanismValueItems: Math.min(3, profile.minimumDevelopedItems),
        minCitedItems: profile.minimumCitedItems,
        requirePrioritizedOpening: false,
        requiredPatterns: profile.requiredCapabilityPatterns,
      },
    }));
}

function checkActual(
  result: ProjectChatApplicationScenarioResult,
  name: string,
) {
  return result.checks.find((check) => check.name === name)?.actual;
}

function addCheck(
  checks: RepositoryAccomplishmentsHarnessCheck[],
  name: string,
  passed: boolean,
  actual?: RepositoryAccomplishmentsHarnessCheck["actual"],
  expected?: RepositoryAccomplishmentsHarnessCheck["expected"],
) {
  checks.push({ name, passed, actual, expected });
}

function headIdentity(input: {
  sourceId: string;
  repository: string;
  commitSha: string;
}) {
  return `${input.sourceId}:${input.repository}@${input.commitSha}`;
}

function scenarioQuality(input: {
  result: ProjectChatApplicationScenarioResult;
  profile: RepositoryAccomplishmentsProfile;
  target: ExactRepositoryAccomplishmentsTarget;
}) {
  const { result, profile, target } = input;
  const answer = result.observation.answer;
  const requiredCapabilities = profile.requiredCapabilityPatterns.map(
    (pattern) => ({ pattern, matched: new RegExp(pattern, "iu").test(answer) }),
  );
  const matchedCapabilities = requiredCapabilities.filter(
    (capability) => capability.matched,
  ).length;
  const freshness = result.observation.repositoryCitationFreshness;
  const allRepositoryCitationsCurrent = freshness != null &&
    freshness.repositoryDerivedCitationCount > 0 &&
    freshness.currentRepositoryDerivedCitationCount ===
      freshness.repositoryDerivedCitationCount &&
    freshness.staleCitationOrdinals.length === 0;
  const expectedHead = headIdentity(target);
  const observedTargetHeads = freshness?.targetHeads.map(headIdentity) ?? [];
  const checks: RepositoryAccomplishmentsHarnessCheck[] = [];
  addCheck(
    checks,
    "exact repository head was present in the citation freshness target",
    observedTargetHeads.includes(expectedHead),
    observedTargetHeads.join(", ") || "missing",
    expectedHead,
  );
  addCheck(
    checks,
    "answer used repository-derived durable citations",
    (freshness?.repositoryDerivedCitationCount ?? 0) > 0,
    freshness?.repositoryDerivedCitationCount ?? 0,
    "> 0",
  );
  addCheck(
    checks,
    "every repository-derived citation was current",
    allRepositoryCitationsCurrent,
    freshness
      ? `${freshness.currentRepositoryDerivedCitationCount}/${freshness.repositoryDerivedCitationCount}`
      : "missing",
    "all current",
  );
  if (
    result.scenario.id === "strongest_accomplishments_freshness_follow_up"
  ) {
    const refresh = result.observation.knowledgeRefresh;
    const refreshTargets = refresh?.targetHeads.map(headIdentity) ?? [];
    const refreshCompleted = refresh?.completedHeads.map(headIdentity) ?? [];
    addCheck(
      checks,
      "freshness barrier targeted the exact configured repository head",
      refreshTargets.includes(expectedHead),
      refreshTargets.join(", ") || "missing",
      expectedHead,
    );
    addCheck(
      checks,
      "freshness barrier completed the exact configured repository head",
      refreshCompleted.includes(expectedHead),
      refreshCompleted.join(", ") || "missing",
      expectedHead,
    );
  }

  return {
    passed: result.passed && checks.every((check) => check.passed),
    checks,
    primaryItemCount: projectChatPrimaryAnswerItems(answer),
    developedItemCount:
      checkActual(result, "answer develops its major points") ?? null,
    citedItemCount:
      checkActual(
        result,
        "answer grounds its major points with claim-local citations",
      ) ?? null,
    citationCount: result.observation.citationCount,
    requiredCapabilities,
    requiredCapabilityRecall: Number(
      (matchedCapabilities / requiredCapabilities.length).toFixed(6),
    ),
    repositoryCitationFreshness: freshness ?? null,
  };
}

export function buildRepositoryAccomplishmentsReport(input: {
  provider: "mock" | "bedrock" | "openrouter";
  profile: RepositoryAccomplishmentsProfile;
  target: ExactRepositoryAccomplishmentsTarget;
  suite: {
    passed: boolean;
    results: ProjectChatApplicationScenarioResult[];
    aggregate: Pick<
      ProjectChatApplicationScenarioResult["observation"]["metrics"],
      | "latencyMs"
      | "modelCalls"
      | "totalTokens"
      | "estimatedCostUsd"
      | "usageComplete"
      | "modelAttribution"
    >;
  };
  keepEvaluationData: boolean;
}) {
  const scenarios = input.suite.results.map((result) => {
    const quality = scenarioQuality({
      result,
      profile: input.profile,
      target: input.target,
    });
    return {
      id: result.scenario.id,
      question: result.scenario.question,
      passed: quality.passed,
      outcome: result.observation.outcome,
      runId: result.observation.runId,
      threadId: result.observation.threadId,
      workItemId: result.observation.workItemId,
      executionMode: result.observation.executionMode,
      metrics: result.observation.metrics,
      tools: result.observation.tools,
      knowledgeRefreshRunId:
        result.observation.knowledgeRefreshRunId ?? null,
      knowledgeRefresh: result.observation.knowledgeRefresh ?? null,
      quality,
      failedChecks: result.checks.filter((check) => !check.passed),
      answer: result.observation.answer,
      error: result.observation.error,
    };
  });
  const comparisonProfile = JSON.stringify({
    requiredCapabilityPatterns: input.profile.requiredCapabilityPatterns,
    includeFreshnessFollowUp: input.profile.includeFreshnessFollowUp,
    minimumPrimaryItems: input.profile.minimumPrimaryItems,
    maximumPrimaryItems: input.profile.maximumPrimaryItems,
    minimumDevelopedItems: input.profile.minimumDevelopedItems,
    minimumCitedItems: input.profile.minimumCitedItems,
  });
  const profileHash = createHash("sha256")
    .update(comparisonProfile)
    .digest("hex")
    .slice(0, 16);
  return {
    schemaVersion: REPOSITORY_ACCOMPLISHMENTS_REPORT_SCHEMA_VERSION,
    passed: input.suite.passed && scenarios.every((scenario) => scenario.passed),
    provider: input.provider,
    comparisonKey:
      `${input.target.repository.toLowerCase()}@${input.target.commitSha}:${profileHash}`,
    profile: input.profile,
    target: input.target,
    retention: {
      workItemRetained: true,
      evaluationDataRetained: input.keepEvaluationData,
    },
    performance: {
      latencyMs: input.suite.aggregate.latencyMs,
      modelCalls: input.suite.aggregate.modelCalls,
      totalTokens: input.suite.aggregate.totalTokens,
      estimatedCostUsd: input.suite.aggregate.estimatedCostUsd,
      usageComplete: input.suite.aggregate.usageComplete,
    },
    attribution: input.suite.aggregate.modelAttribution,
    scenarios,
  };
}
