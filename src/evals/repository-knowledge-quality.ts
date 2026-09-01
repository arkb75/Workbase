export const REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION =
  "repository-knowledge-evaluation-v1" as const;
/** Fingerprints scorer semantics and curated fixture expectations, not JSON shape. */
export const REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION =
  "repository-knowledge-evaluator-v7" as const;

export type RepositoryKnowledgeItemKind = "highlight" | "fact";
export type RepositoryKnowledgeClaimState =
  | "implemented"
  | "planned"
  | "unknown";

export interface RepositoryEvaluationFile {
  path: string;
  /** Optional fixture excerpt. When present, quote validation is exact. */
  content?: string;
}

export interface RepositoryExpectedCapability {
  key: string;
  label: string;
  domainKey: string;
  importance: "major" | "supporting";
  implementationState: "implemented" | "planned";
  expectedInHighlights: boolean;
  matchPatterns: string[];
  evidencePathPatterns: string[];
  /** A test-readable example, never used by the scorer. */
  exampleClaim: string;
}

export interface RepositoryExpectedDomain {
  key: string;
  label: string;
  matchPatterns: string[];
  evidencePathPatterns: string[];
}

export interface RepositoryKnowledgeBudget {
  maximumDurationMs: number;
  maximumModelCalls: number;
  maximumTokens: number;
  maximumEstimatedCostUsd: number;
}

export interface RepositoryKnowledgeFixture {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION;
  id: string;
  title: string;
  repository: string | null;
  sourceKind: "curated_real_repository" | "synthetic_archetype";
  snapshotCommit: string | null;
  archetype: string;
  languages: string[];
  description: string;
  files: RepositoryEvaluationFile[];
  /** Build output, caches, vendored files, fixtures, and binary artifacts. */
  ignoredPathPatterns: string[];
  expectedDomains: RepositoryExpectedDomain[];
  expectedCapabilities: RepositoryExpectedCapability[];
  falsePositiveTraps: Array<{
    label: string;
    capabilityPatterns: string[];
    misleadingEvidencePathPatterns: string[];
    allowedEvidencePathPatterns?: string[];
  }>;
  budget: RepositoryKnowledgeBudget;
}

export interface RepositoryKnowledgeEvidenceReference {
  path: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  quote?: string | null;
}

export interface RepositoryKnowledgeEvaluationItem {
  id: string;
  kind: RepositoryKnowledgeItemKind;
  text: string;
  summary?: string | null;
  claimState?: RepositoryKnowledgeClaimState;
  domain?: string | null;
  evidence: RepositoryKnowledgeEvidenceReference[];
}

export interface RepositoryKnowledgeEvaluationRun {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION;
  fixtureId: string;
  repository: string | null;
  commitSha?: string | null;
  items: RepositoryKnowledgeEvaluationItem[];
  domains?: Array<{ key?: string | null; label: string }>;
  discoveredCapabilities?: Array<{
    key?: string | null;
    label: string;
    evidencePaths: string[];
  }>;
  inventory: {
    scannableFiles: number;
    analyzedFiles: number;
    semanticEligibleFiles?: number | null;
    semanticAnalyzedFiles: number;
    analyzedPaths?: string[];
    semanticAnalyzedPaths?: string[];
  };
  coverage: {
    static: number | null;
    semantic: number | null;
    knowledge: number | null;
  };
  performance: {
    durationMs: number | null;
    modelCalls: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
  };
  executionIntegrity?: {
    passed: boolean;
    issues: string[];
    modelIdentities: string[];
    policyVersions: string[];
  };
}

export interface RepositoryKnowledgeMetricCheck {
  name: string;
  passed: boolean;
  actual: number | string | boolean;
  expected: number | string | boolean;
}

export interface RepositoryKnowledgeEvaluationReport {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION;
  evaluatorPolicyVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION;
  fixtureId: string;
  repository: string | null;
  passed: boolean;
  executionIntegrityStatus: "passed" | "failed" | "unreported" | "not_required";
  /** Legacy blended score retained for report compatibility. */
  score: number;
  metrics: {
    repositoryKnowledgeScore: number;
    repositoryKnowledgeCoverageScore: number;
    repositoryKnowledgeGroundingScore: number;
    highlightGenerationScore: number;
    highlightSalienceCoverage: number;
    highlightGroundingScore: number;
    highlightPresentationScore: number;
    capabilityRecall: number;
    majorCapabilityRecall: number;
    highlightCapabilityRecall: number;
    majorHighlightCapabilityRecall: number;
    highlightDomainRecall: number;
    highlightEvidencePrecision: number;
    highlightCitationPathPrecision: number;
    highlightItemPrecision: number;
    highlightNonRedundancy: number;
    highlightCount: number;
    expectedHighlightCapabilityCount: number;
    recoveredHighlightCapabilityCount: number;
    domainRecall: number;
    evidencePrecision: number;
    citationPathPrecision: number;
    knowledgeItemPrecision: number;
    unsupportedItemRate: number;
    claimStateCorrectness: number;
    diversity: number;
    duplicateRate: number;
    coverageCalibration: number;
    coverageReportingCompleteness: number;
    budgetAdherence: number;
    inventoryHygiene: number;
    capabilityMapPrecision: number;
    capabilityGranularity: number;
    genericTokenFalsePositiveRate: number;
    structuralReportingCompleteness: number;
  };
  recoveredCapabilityKeys: string[];
  missedCapabilityKeys: string[];
  recoveredDomainKeys: string[];
  unsupportedItems: string[];
  duplicateItemPairs: Array<[string, string]>;
  falsePositiveCapabilities: string[];
  rawItems: RepositoryKnowledgeEvaluationItem[];
  rawDiscoveredCapabilities: NonNullable<
    RepositoryKnowledgeEvaluationRun["discoveredCapabilities"]
  >;
  checks: RepositoryKnowledgeMetricCheck[];
}

export interface RepositoryKnowledgeCatalogAudit {
  passed: boolean;
  fixtureCount: number;
  archetypeCount: number;
  languageFamilyCount: number;
  realRepositoryCount: number;
  repositories: string[];
  checks: RepositoryKnowledgeMetricCheck[];
}

export interface RepositoryKnowledgeSuiteReport {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION;
  evaluatorPolicyVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION;
  passed: boolean;
  hardBudgetPassed: boolean;
  executionIntegrityPassed: boolean;
  /** Legacy blended score retained for report compatibility. */
  score: number;
  macroAverageScore: number;
  minimumProjectScore: number;
  repositoryKnowledgeScore: number;
  macroAverageRepositoryKnowledgeScore: number;
  minimumProjectRepositoryKnowledgeScore: number;
  highlightGenerationScore: number;
  macroAverageHighlightGenerationScore: number;
  minimumProjectHighlightGenerationScore: number;
  passingFixtureCount: number;
  fixtureCount: number;
  catalog: RepositoryKnowledgeCatalogAudit;
  results: RepositoryKnowledgeEvaluationReport[];
}

const stopWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "this",
  "through",
  "to",
  "with",
]);

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number) {
  return Number(value.toFixed(6));
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function harmonicMean(values: number[]) {
  if (!values.length || values.some((value) => value <= 0)) return 0;
  return values.length / values.reduce((sum, value) => sum + 1 / value, 0);
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function regex(pattern: string) {
  return new RegExp(pattern, "iu");
}

function anyPattern(value: string, patterns: readonly string[]) {
  return patterns.some((pattern) => regex(pattern).test(value));
}

function itemSearchText(item: RepositoryKnowledgeEvaluationItem) {
  return [item.text, item.summary, item.domain].filter(Boolean).join(" ");
}

function itemClaimText(item: RepositoryKnowledgeEvaluationItem) {
  return [item.text, item.summary].filter(Boolean).join(" ");
}

function itemClaimSurfaces(item: RepositoryKnowledgeEvaluationItem) {
  return [item.text, item.summary].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

function inferredClaimState(
  item: RepositoryKnowledgeEvaluationItem,
): RepositoryKnowledgeClaimState {
  // Repository observations are assertive current-state knowledge by
  // contract: planned documentation is filtered before synthesis. State must
  // be explicit when another evaluator adapter supports planned or unknown
  // knowledge; guessing from prose makes correctness depend on wording and
  // misreads names such as Next.js or "planning engine".
  return item.claimState ?? "implemented";
}

function normalizedPath(path: string) {
  return path.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function referencedContent(
  file: RepositoryEvaluationFile,
  reference: RepositoryKnowledgeEvidenceReference,
) {
  if (file.content === undefined) return null;
  if (reference.lineStart == null && reference.lineEnd == null) {
    return file.content;
  }
  const lineStart = reference.lineStart ?? reference.lineEnd!;
  const lineEnd = reference.lineEnd ?? reference.lineStart!;
  const lines = file.content.split("\n");
  if (
    lineStart < 1 ||
    lineEnd < lineStart ||
    lineStart > lines.length ||
    lineEnd > lines.length
  ) {
    return undefined;
  }
  return lines.slice(lineStart - 1, lineEnd).join("\n");
}

function quoteSupported(
  file: RepositoryEvaluationFile,
  reference: RepositoryKnowledgeEvidenceReference,
  requireContent = false,
) {
  if (file.content === undefined) return !requireContent;
  const normalizeEvidenceText = (value: string) => value
    .replace(/\s+/gu, " ")
    .trim();
  const quote = reference.quote?.trim() ?? "";
  const hasLineStart = reference.lineStart != null;
  const hasLineEnd = reference.lineEnd != null;
  if (requireContent && hasLineStart !== hasLineEnd) return false;
  if (requireContent && !hasLineStart) {
    if (!quote) return false;
    const normalizedContent = normalizeEvidenceText(file.content);
    const normalizedQuote = normalizeEvidenceText(quote);
    const redactionPattern = /["']?\[REDACTED(?: [^\]]+)?\]["']?/giu;
    const anchors = redactionPattern.test(normalizedQuote)
      ? normalizedQuote
        .split(redactionPattern)
        .map(normalizeEvidenceText)
        .filter((fragment) => fragment.length >= 16)
      : [normalizedQuote];
    redactionPattern.lastIndex = 0;
    const anchor = [...anchors].sort((left, right) => right.length - left.length)[0];
    if (!anchor) return false;
    const first = normalizedContent.indexOf(anchor);
    if (first < 0 || normalizedContent.indexOf(anchor, first + 1) >= 0) {
      return false;
    }
  }
  if (!quote) {
    return referencedContent(file, reference) !== undefined;
  }
  // Exact repository excerpts remain authoritative even when a local checkout
  // has inserted lines before the snapshot range. The immutable observation
  // still retains its original line numbers for auditability.
  const hasDeclaredRange =
    reference.lineStart != null || reference.lineEnd != null;
  // Curated runs are evaluated against the exact pinned commit, so a declared
  // range must exist and contain its quote. Relaxed anywhere-in-file matching
  // remains available only to compact synthetic/legacy observations.
  const quoteSearchContent = requireContent && hasDeclaredRange
    ? referencedContent(file, reference)
    : file.content;
  if (quoteSearchContent === undefined || quoteSearchContent === null) {
    return false;
  }
  const normalizedContent = normalizeEvidenceText(quoteSearchContent);
  const normalizedQuote = normalizeEvidenceText(quote);
  const redactionPattern = /["']?\[REDACTED(?: [^\]]+)?\]["']?/giu;
  if (!redactionPattern.test(normalizedQuote)) {
    return normalizedContent.includes(normalizedQuote);
  }

  // Repository ingestion intentionally redacts secret-shaped values before
  // persistence. Verify every literal fragment in order and permit only a
  // bounded gap at an explicit redaction marker; a placeholder alone is not
  // evidence.
  redactionPattern.lastIndex = 0;
  const fragments = normalizedQuote
    .split(redactionPattern)
    .map(normalizeEvidenceText)
    .filter(Boolean);
  if (fragments.reduce((length, fragment) => length + fragment.length, 0) < 16) {
    return false;
  }
  let cursor = 0;
  let hasMatchedFragment = false;
  for (const fragment of fragments) {
    const index = normalizedContent.indexOf(fragment, cursor);
    if (index < 0 || (hasMatchedFragment && index - cursor > 4_096)) return false;
    cursor = index + fragment.length;
    hasMatchedFragment = true;
  }
  return true;
}

function groundingEvidenceExcerpt(
  file: RepositoryEvaluationFile,
  reference: RepositoryKnowledgeEvidenceReference,
) {
  if (file.content === undefined) return "";
  const quote = reference.quote?.trim();
  const hasDeclaredRange = reference.lineStart != null || reference.lineEnd != null;
  const content = hasDeclaredRange || !quote
    ? referencedContent(file, reference)?.slice(0, 20_000)
    : null;
  return [quote, content].filter(Boolean).join(" ");
}

const genericGroundingTokens = new Set([
  "add",
  "added",
  "application",
  "built",
  "capability",
  "class",
  "code",
  "component",
  "created",
  "data",
  "delivered",
  "feature",
  "file",
  "function",
  "handler",
  "implemented",
  "implementation",
  "integration",
  "logic",
  "model",
  "module",
  "process",
  "project",
  "repository",
  "route",
  "runtime",
  "service",
  "source",
  "support",
  "supported",
  "system",
  "uses",
  "workflow",
]);

function groundingToken(value: string) {
  if (value === "status") return "state";
  let normalized = value;
  if (normalized.length > 5 && normalized.endsWith("ies")) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.length > 6 && normalized.endsWith("ing")) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.length > 5 && normalized.endsWith("ed")) {
    normalized = normalized.slice(0, -2);
  } else if (
    normalized.length > 5 &&
    /(?:ch|sh|ss|x|z)es$/u.test(normalized)
  ) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.length > 4 && normalized.endsWith("s")) {
    normalized = normalized.slice(0, -1);
  }
  if (["display", "render", "visualization", "visualize"].includes(normalized)) {
    return "render";
  }
  if (["card", "container", "div", "panel", "section"].includes(normalized)) {
    return "container";
  }
  return normalized;
}

function groundingTokens(value: string) {
  return Array.from(new Set(
    value
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
      .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 2 && !stopWords.has(token))
      .map(groundingToken),
  ));
}

function groundingTokensMatch(left: string, right: string) {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 5 && longer.startsWith(shorter);
}

function isGenericGroundingToken(token: string) {
  return Array.from(genericGroundingTokens).some((genericToken) =>
    groundingTokensMatch(token, groundingToken(genericToken))
  );
}

/**
 * Deterministic, language-neutral relevance check for natural-language claims
 * against paths, identifiers, and exact evidence excerpts. Match coverage is
 * claim-relative so one genuine term cannot launder an otherwise unrelated
 * assertion; generic architecture vocabulary requires stronger overlap.
 */
function lexicallyRelated(left: string, right: string, minimumCoverage = 0.6) {
  const leftTokens = groundingTokens(left);
  const rightTokens = groundingTokens(right);
  const matches = Array.from(new Set(leftTokens.filter((leftToken) =>
    rightTokens.some((rightToken) => groundingTokensMatch(leftToken, rightToken))
  )));
  const distinctiveLeft = leftTokens.filter((token) =>
    !isGenericGroundingToken(token)
  );
  const distinctiveMatches = matches.filter((token) =>
    !isGenericGroundingToken(token)
  );
  const claimCoverage = ratio(matches.length, leftTokens.length);
  if (distinctiveMatches.length >= 2) return claimCoverage >= minimumCoverage;
  if (distinctiveMatches.length === 1) {
    return ratio(distinctiveMatches.length, distinctiveLeft.length) >= 0.6 &&
      claimCoverage >= Math.max(0.6, minimumCoverage);
  }
  return matches.length >= 2 && claimCoverage >= Math.max(0.7, minimumCoverage);
}

function hasSufficientDistinctiveGroundingOverlap(left: string, right: string) {
  const rightTokens = groundingTokens(right);
  const distinctiveLeft = groundingTokens(left).filter((leftToken) =>
    !isGenericGroundingToken(leftToken)
  );
  const distinctiveMatches = distinctiveLeft.filter((leftToken) =>
    rightTokens.some((rightToken) => groundingTokensMatch(leftToken, rightToken))
  );
  return distinctiveLeft.length > 0 &&
    distinctiveMatches.length >= Math.min(2, distinctiveLeft.length);
}

/**
 * A checked-out source path can disambiguate identifiers in a cited excerpt
 * (for example, `ProductDetailsList` around an `add` method), but it cannot
 * prove a claim by itself. Require the excerpt to share a distinctive claim
 * term before allowing its path to contribute the remaining lexical context.
 */
function lexicallyRelatedToEvidence(
  claim: string,
  excerpt: string,
  path: string,
  minimumCoverage = 0.6,
) {
  return lexicallyRelated(claim, excerpt, minimumCoverage) || (
    hasSufficientDistinctiveGroundingOverlap(claim, excerpt) &&
    lexicallyRelated(claim, `${path} ${excerpt}`, minimumCoverage)
  );
}

function claimClauses(value: string) {
  return value
    .split(
      /(?:[.;]\s+|(?:,\s+(?:and|but)\s+|\s+(?:and|but)\s+)(?=(?:added|built|created|delivered|implemented|integrated|trained|uses?|validates?|generates?)\b))/iu,
    )
    .map((clause) => clause.trim())
    .filter((clause) => groundingTokens(clause).length > 0);
}

function citationClaimClauses(value: string) {
  return value
    .split(
      /(?:[.;]\s+|(?:,\s+|\s+)(?:and|but)\s+(?=(?:added|built|created|delivered|implemented|integrated|trained|uses?|validates?|generates?)\b))/iu,
    )
    .map((clause) => clause.trim())
    .filter((clause) => groundingTokens(clause).length > 0);
}

function tokenSet(value: string) {
  return new Set(
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 2 && !stopWords.has(token)),
  );
}

function jaccard(left: Set<string>, right: Set<string>) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

function metricCheck(
  name: string,
  actual: number,
  expected: number,
  comparison: "minimum" | "maximum",
): RepositoryKnowledgeMetricCheck {
  return {
    name,
    passed: comparison === "minimum" ? actual >= expected : actual <= expected,
    actual: round(actual),
    expected: `${comparison === "minimum" ? ">=" : "<="} ${expected}`,
  };
}

function maximumBudgetCheck(
  name: string,
  actual: number | null,
  maximum: number,
): RepositoryKnowledgeMetricCheck {
  const reported = actual !== null && Number.isFinite(actual) && actual >= 0;
  return {
    name,
    passed: reported && actual !== null && actual <= maximum,
    actual: reported ? round(actual) : "unreported",
    expected: `<= ${maximum}`,
  };
}

function repositoryKnowledgeHardBudgetChecks(
  run: RepositoryKnowledgeEvaluationRun,
  budget: RepositoryKnowledgeBudget,
) {
  return [
    maximumBudgetCheck(
      "duration does not exceed the fixture maximum",
      run.performance.durationMs,
      budget.maximumDurationMs,
    ),
    maximumBudgetCheck(
      "model calls do not exceed the fixture maximum",
      run.performance.modelCalls,
      budget.maximumModelCalls,
    ),
    maximumBudgetCheck(
      "tokens do not exceed the fixture maximum",
      run.performance.totalTokens,
      budget.maximumTokens,
    ),
    maximumBudgetCheck(
      "estimated cost does not exceed the fixture maximum",
      run.performance.estimatedCostUsd,
      budget.maximumEstimatedCostUsd,
    ),
  ];
}

function repositoryKnowledgeExecutionIntegrityStatus(
  fixture: RepositoryKnowledgeFixture,
  run: RepositoryKnowledgeEvaluationRun,
): RepositoryKnowledgeEvaluationReport["executionIntegrityStatus"] {
  if (fixture.sourceKind !== "curated_real_repository") return "not_required";
  const integrity = run.executionIntegrity;
  if (!integrity) return "unreported";
  return integrity.passed &&
      integrity.issues.length === 0 &&
      integrity.modelIdentities.length > 0 &&
      integrity.policyVersions.length > 0
    ? "passed"
    : "failed";
}

function repositoryKnowledgeExecutionIntegrityCheck(
  fixture: RepositoryKnowledgeFixture,
  run: RepositoryKnowledgeEvaluationRun,
): RepositoryKnowledgeMetricCheck {
  const status = repositoryKnowledgeExecutionIntegrityStatus(fixture, run);
  return {
    name: "main-path execution integrity",
    passed: status === "passed" || status === "not_required",
    actual: status,
    expected: fixture.sourceKind === "curated_real_repository"
      ? "complete passed attestation"
      : "not required",
  };
}

function languageFamily(language: string) {
  const normalized = language.toLocaleLowerCase();
  if (["javascript", "typescript", "tsx", "jsx"].includes(normalized)) {
    return "javascript-typescript";
  }
  if (["java", "kotlin", "scala"].includes(normalized)) return "jvm";
  if (["python"].includes(normalized)) return "python";
  if (["go"].includes(normalized)) return "go";
  if (["rust"].includes(normalized)) return "rust";
  return normalized;
}

export function auditRepositoryKnowledgeFixtureCatalog(
  fixtures: readonly RepositoryKnowledgeFixture[],
): RepositoryKnowledgeCatalogAudit {
  const archetypes = new Set(fixtures.map((fixture) => fixture.archetype));
  const languageFamilies = new Set(
    fixtures.flatMap((fixture) => fixture.languages.map(languageFamily)),
  );
  const realRepositories = fixtures.filter(
    (fixture) => fixture.sourceKind === "curated_real_repository",
  );
  const repositories = realRepositories.flatMap((fixture) =>
    fixture.repository ? [fixture.repository] : []
  );
  const hasPlannedAndImplemented = fixtures.every((fixture) =>
    fixture.expectedCapabilities.some(
      (capability) => capability.implementationState === "implemented",
    )
  ) && fixtures.some((fixture) =>
    fixture.expectedCapabilities.some(
      (capability) => capability.implementationState === "planned",
    )
  );
  const outcomesAreMeasurable = fixtures.every((fixture) => {
    const implemented = fixture.expectedCapabilities.filter(
      (capability) => capability.implementationState === "implemented",
    );
    return fixture.expectedDomains.length > 0 &&
      implemented.some((capability) => capability.importance === "major") &&
      implemented.some((capability) => capability.expectedInHighlights) &&
      implemented.some((capability) =>
        capability.expectedInHighlights && capability.importance === "major"
      );
  });
  const uniqueFixtureIds = new Set(fixtures.map((fixture) => fixture.id)).size;
  const checks: RepositoryKnowledgeMetricCheck[] = [
    metricCheck("catalog spans at least six repository archetypes", archetypes.size, 6, "minimum"),
    metricCheck("catalog spans at least three language families", languageFamilies.size, 3, "minimum"),
    metricCheck("catalog includes at least five curated real repositories", realRepositories.length, 5, "minimum"),
    {
      name: "catalog includes implemented and explicitly planned behavior",
      passed: hasPlannedAndImplemented,
      actual: hasPlannedAndImplemented,
      expected: true,
    },
    {
      name: "every fixture defines measurable knowledge and Highlight outcomes",
      passed: outcomesAreMeasurable,
      actual: outcomesAreMeasurable,
      expected: true,
    },
    {
      name: "fixture identifiers are unique",
      passed: uniqueFixtureIds === fixtures.length,
      actual: uniqueFixtureIds,
      expected: fixtures.length,
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    fixtureCount: fixtures.length,
    archetypeCount: archetypes.size,
    languageFamilyCount: languageFamilies.size,
    realRepositoryCount: realRepositories.length,
    repositories,
    checks,
  };
}

export function evaluateRepositoryKnowledgeRun(input: {
  fixture: RepositoryKnowledgeFixture;
  run: RepositoryKnowledgeEvaluationRun;
}): RepositoryKnowledgeEvaluationReport {
  const { fixture, run } = input;
  if (run.schemaVersion !== REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported repository knowledge run schema: ${run.schemaVersion}.`,
    );
  }
  if (run.fixtureId !== fixture.id) {
    throw new Error(
      `Evaluation run fixture ${run.fixtureId} does not match ${fixture.id}.`,
    );
  }
  if (fixture.sourceKind === "curated_real_repository") {
    if (!fixture.repository || !run.repository) {
      throw new Error(
        `Curated fixture ${fixture.id} requires its repository identity in the evaluation run.`,
      );
    }
    if (
      fixture.repository.toLocaleLowerCase() !==
        run.repository.toLocaleLowerCase()
    ) {
      throw new Error(
        `Evaluation run repository ${run.repository} does not match ${fixture.repository}.`,
      );
    }
    if (
      !fixture.snapshotCommit ||
      run.commitSha?.toLocaleLowerCase() !== fixture.snapshotCommit.toLocaleLowerCase()
    ) {
      throw new Error(
        `Evaluation run commit ${run.commitSha ?? "<missing>"} does not match pinned commit ${fixture.snapshotCommit ?? "<missing>"} for ${fixture.id}.`,
      );
    }
  }
  if (
    fixture.repository && run.repository &&
    fixture.repository.toLocaleLowerCase() !== run.repository.toLocaleLowerCase()
  ) {
    throw new Error(
      `Evaluation run repository ${run.repository} does not match ${fixture.repository}.`,
    );
  }

  const filesByPath = new Map(
    fixture.files.map((file) => [normalizedPath(file.path), file]),
  );
  const requireContentGrounding =
    fixture.sourceKind === "curated_real_repository";
  const discoveredCapabilities = run.discoveredCapabilities ?? [];
  const isIgnoredRepositoryPath = (path: string) =>
    anyPattern(normalizedPath(path), fixture.ignoredPathPatterns);
  const repositoryFileForPath = (path: string) => {
    const normalized = normalizedPath(path);
    return isIgnoredRepositoryPath(normalized)
      ? undefined
      : filesByPath.get(normalized);
  };
  const validRepositoryReference = (
    reference: RepositoryKnowledgeEvidenceReference,
  ) => {
    const file = repositoryFileForPath(reference.path);
    return Boolean(
      file && quoteSupported(file, reference, requireContentGrounding),
    );
  };
  const matchesExplicitFalsePositiveTrap = (
    identity: string,
    evidencePaths: readonly string[],
  ) => fixture.falsePositiveTraps.some((trap) => {
    if (!anyPattern(identity, trap.capabilityPatterns)) return false;
    const hasAllowedEvidence = evidencePaths.some((path) =>
      anyPattern(normalizedPath(path), trap.allowedEvidencePathPatterns ?? [])
    );
    const hasMisleadingEvidence = evidencePaths.some((path) =>
      anyPattern(normalizedPath(path), trap.misleadingEvidencePathPatterns)
    );
    return hasMisleadingEvidence && !hasAllowedEvidence;
  });

  function referenceGroundsItem(
    item: RepositoryKnowledgeEvaluationItem,
    reference: RepositoryKnowledgeEvidenceReference,
  ) {
    const file = repositoryFileForPath(reference.path);
    if (
      !file ||
      !quoteSupported(file, reference, requireContentGrounding)
    ) return false;
    const excerpt = groundingEvidenceExcerpt(file, reference);
    // Curated certification must be grounded by checked-out source content.
    // A descriptive filename is useful context, but cannot prove the claim.
    const path = normalizedPath(reference.path);
    const evidenceSurface = requireContentGrounding
      ? excerpt
      : `${path} ${excerpt}`;
    if (!evidenceSurface.trim()) return false;
    return itemClaimSurfaces(item).some((claim) =>
      citationClaimClauses(claim).some((clause) =>
        requireContentGrounding
          ? lexicallyRelatedToEvidence(clause, excerpt, path, 0.35)
          : lexicallyRelated(clause, evidenceSurface, 0.35)
      )
    );
  }

  function evidenceSetGroundsItem(item: RepositoryKnowledgeEvaluationItem) {
    const evidence = item.evidence.flatMap((reference) => {
      const file = repositoryFileForPath(reference.path);
      if (
        !file ||
        !quoteSupported(file, reference, requireContentGrounding)
      ) return [];
      const excerpt = groundingEvidenceExcerpt(file, reference);
      return [{ path: normalizedPath(reference.path), excerpt }];
    });
    const excerptSurface = evidence.map(({ excerpt }) => excerpt)
      .join(" ").slice(0, 120_000);
    const pathSurface = evidence.map(({ path }) => path)
      .join(" ").slice(0, 20_000);
    if (!excerptSurface) return false;
    const surfaceGrounded = (claim: string) => {
      const clauses = claimClauses(claim);
      const results = clauses.map((clause) =>
        requireContentGrounding
          ? lexicallyRelatedToEvidence(clause, excerptSurface, pathSurface, 0.2)
          : lexicallyRelated(clause, `${pathSurface} ${excerptSurface}`, 0.2)
      );
      return results.every(Boolean);
    };
    const summary = item.summary?.trim();
    if (!summary) return surfaceGrounded(item.text);
    return surfaceGrounded(summary) && (
      surfaceGrounded(item.text) || lexicallyRelated(item.text, summary, 0.35)
    );
  }

  const falsePositiveItems = new Set(run.items.filter((item) =>
    matchesExplicitFalsePositiveTrap(
      itemSearchText(item),
      item.evidence.map((reference) => reference.path),
    )
  ).map((item) => item.id));
  const groundedEvidenceReferences = new Set(
    run.items.flatMap((item) =>
      falsePositiveItems.has(item.id)
        ? []
        : item.evidence.flatMap((reference) =>
            referenceGroundsItem(item, reference) ? [reference] : []
          )
    ),
  );
  const supportedItemIds = new Set(
    run.items.flatMap((item) =>
      !falsePositiveItems.has(item.id) &&
          evidenceSetGroundsItem(item)
        ? [item.id]
        : []
    ),
  );
  const implementedCapabilities = fixture.expectedCapabilities.filter(
    (capability) => capability.implementationState === "implemented",
  );
  const capabilityMatches = new Map<string, number[]>();
  for (const capability of fixture.expectedCapabilities) {
    capabilityMatches.set(
      capability.key,
      run.items.flatMap((item, index) => {
        const usesExpectedDomainKey = fixture.expectedDomains.some((domain) =>
          domain.key === item.domain
        );
        // Generated domain labels are evaluated separately below. Exclude
        // them here so a model-authored label cannot answer the capability
        // oracle when the claim itself does not describe the capability.
        return anyPattern(itemClaimText(item), capability.matchPatterns) &&
            (!usesExpectedDomainKey || item.domain === capability.domainKey)
          ? [index]
          : [];
      }),
    );
  }

  function evidenceSupportsCapability(
    item: RepositoryKnowledgeEvaluationItem,
    capability: RepositoryExpectedCapability,
  ) {
    const evidenceSurface = item.evidence.flatMap((reference) => {
      const path = normalizedPath(reference.path);
      const file = repositoryFileForPath(path);
      if (
        !file ||
        !anyPattern(path, capability.evidencePathPatterns) ||
        !validRepositoryReference(reference)
      ) return [];
      const excerpt = groundingEvidenceExcerpt(file, reference);
      return [requireContentGrounding
        ? excerpt
        : `${path} ${excerpt}`];
    }).join(" ").slice(0, 120_000);
    if (!evidenceSurface.trim()) return false;

    const separateMatchingSurfaces = itemClaimSurfaces(item).filter((claim) =>
      anyPattern(claim, capability.matchPatterns)
    );
    const matchingSurfaces = separateMatchingSurfaces.length
      ? separateMatchingSurfaces
      : anyPattern(itemClaimText(item), capability.matchPatterns)
        ? [itemClaimText(item)]
        : [];
    const capabilityClaims = matchingSurfaces.flatMap((claim) => {
      const clauses = citationClaimClauses(claim);
      const matchingClauses = clauses.filter((clause) =>
        anyPattern(clause, capability.matchPatterns)
      );
      return matchingClauses.length ? matchingClauses : [claim];
    });
    return capabilityClaims.some((claim) =>
      lexicallyRelated(claim, evidenceSurface, 0.35)
    );
  }

  const recoveredCapabilities = implementedCapabilities.filter((capability) =>
    (capabilityMatches.get(capability.key) ?? []).some((itemIndex) => {
      const item = run.items[itemIndex]!;
      return supportedItemIds.has(item.id) &&
        inferredClaimState(item) !== "planned" &&
        evidenceSupportsCapability(item, capability);
    })
  );
  const weightedCapabilityTotal = implementedCapabilities.reduce(
    (sum, capability) => sum + (capability.importance === "major" ? 2 : 1),
    0,
  );
  const weightedCapabilityRecovered = recoveredCapabilities.reduce(
    (sum, capability) => sum + (capability.importance === "major" ? 2 : 1),
    0,
  );
  const capabilityRecall = ratio(
    weightedCapabilityRecovered,
    weightedCapabilityTotal,
  );
  const majorCapabilities = implementedCapabilities.filter(
    (capability) => capability.importance === "major",
  );
  const majorCapabilityRecall = ratio(
    majorCapabilities.filter((capability) =>
      recoveredCapabilities.some((recovered) => recovered.key === capability.key)
    ).length,
    majorCapabilities.length,
  );
  const expectedHighlightCapabilities = implementedCapabilities.filter(
    (capability) => capability.expectedInHighlights,
  );
  const recoveredHighlightCapabilities = expectedHighlightCapabilities.filter(
    (capability) =>
      (capabilityMatches.get(capability.key) ?? []).some((itemIndex) => {
        const item = run.items[itemIndex]!;
        return item.kind === "highlight" &&
          supportedItemIds.has(item.id) &&
          inferredClaimState(item) !== "planned" &&
          evidenceSupportsCapability(item, capability);
      }),
  );
  const highlightCapabilityRecall = ratio(
    recoveredHighlightCapabilities.length,
    expectedHighlightCapabilities.length,
  );
  const expectedMajorHighlightCapabilities = expectedHighlightCapabilities.filter(
    (capability) => capability.importance === "major",
  );
  const majorHighlightCapabilityRecall = ratio(
    expectedMajorHighlightCapabilities.filter((capability) =>
      recoveredHighlightCapabilities.some((recovered) =>
        recovered.key === capability.key
      )
    ).length,
    expectedMajorHighlightCapabilities.length,
  );

  const recoveredDomains = fixture.expectedDomains.filter((domain) => {
    const hasRecoveredCapability = recoveredCapabilities.some(
      (capability) => capability.domainKey === domain.key,
    );
    const hasGroundedDomainItem = run.items.some((item) => {
      const itemMatchesDomain = item.domain === domain.key || anyPattern(
        itemSearchText(item),
        domain.matchPatterns,
      );
      return supportedItemIds.has(item.id) && itemMatchesDomain &&
        item.evidence.some((reference) => {
          const path = normalizedPath(reference.path);
          return groundedEvidenceReferences.has(reference) &&
            validRepositoryReference(reference) &&
            anyPattern(path, domain.evidencePathPatterns);
        });
    });
    return hasRecoveredCapability || hasGroundedDomainItem;
  });
  const domainRecall = ratio(
    recoveredDomains.length,
    fixture.expectedDomains.length,
  );

  const evidenceReferences = run.items.flatMap((item) => item.evidence);
  const validEvidenceReferences = evidenceReferences.filter(
    validRepositoryReference,
  );
  const citationPathPrecision = ratio(
    validEvidenceReferences.length,
    evidenceReferences.length,
  );
  const claimEvidencePrecision = ratio(
    groundedEvidenceReferences.size,
    evidenceReferences.length,
  );
  const evidencePrecision = average([
    citationPathPrecision,
    claimEvidencePrecision,
  ]);
  const knowledgeItemPrecision = ratio(supportedItemIds.size, run.items.length);
  const unsupportedItemRate = 1 - knowledgeItemPrecision;

  // Curated capability patterns remain a recall and implementation-state
  // oracle. They are deliberately not a closed-world whitelist for precision:
  // an extractor may discover additional repository-grounded knowledge.
  const claimEvidencePairs = fixture.expectedCapabilities.flatMap((capability) =>
    (capabilityMatches.get(capability.key) ?? []).flatMap((itemIndex) => {
      const item = run.items[itemIndex]!;
      return evidenceSupportsCapability(item, capability)
        ? [{ capability, item }]
        : [];
    })
  );

  const stateScores = claimEvidencePairs.map(({ capability, item }) => {
    const state = inferredClaimState(item);
    if (state === "unknown") return 0.5;
    return state === capability.implementationState ? 1 : 0;
  });
  // No evidence-backed oracle match means state is not measurable for this
  // run. Recall already scores the absence; treating the empty denominator as
  // an additional state failure would penalize the same miss twice.
  const claimStateCorrectness = stateScores.length
    ? average(stateScores)
    : 1;

  const highlights = run.items.filter((item) => item.kind === "highlight");
  const duplicateItemPairs: Array<[string, string]> = [];
  const duplicateIndexes = new Set<number>();
  for (let left = 0; left < highlights.length; left += 1) {
    for (let right = left + 1; right < highlights.length; right += 1) {
      if (
        jaccard(
          tokenSet(itemSearchText(highlights[left]!)),
          tokenSet(itemSearchText(highlights[right]!)),
        ) >= 0.72
      ) {
        duplicateItemPairs.push([highlights[left]!.id, highlights[right]!.id]);
        duplicateIndexes.add(right);
      }
    }
  }
  const duplicateRate = ratio(duplicateIndexes.size, highlights.length);
  const diversity = average([1 - duplicateRate, domainRecall]);
  const highlightDomainRecall = ratio(
    fixture.expectedDomains.filter((domain) =>
      recoveredHighlightCapabilities.some((capability) =>
        capability.domainKey === domain.key
      ) || highlights.some((item) => {
        const itemMatchesDomain = item.domain === domain.key || anyPattern(
          itemSearchText(item),
          domain.matchPatterns,
        );
        return supportedItemIds.has(item.id) && itemMatchesDomain &&
          item.evidence.some((reference) => {
            const path = normalizedPath(reference.path);
            return groundedEvidenceReferences.has(reference) &&
              validRepositoryReference(reference) &&
              anyPattern(path, domain.evidencePathPatterns);
          });
      })
    ).length,
    fixture.expectedDomains.length,
  );
  const highlightEvidenceReferences = highlights.flatMap((item) => item.evidence);
  const validHighlightEvidenceReferences = highlightEvidenceReferences.filter(
    validRepositoryReference,
  );
  const highlightCitationPathPrecision = ratio(
    validHighlightEvidenceReferences.length,
    highlightEvidenceReferences.length,
  );
  const highlightClaimEvidencePrecision = ratio(
    highlightEvidenceReferences.filter((reference) =>
      groundedEvidenceReferences.has(reference)
    ).length,
    highlightEvidenceReferences.length,
  );
  const highlightEvidencePrecision = average([
    highlightCitationPathPrecision,
    highlightClaimEvidencePrecision,
  ]);
  const highlightItemPrecision = ratio(
    highlights.filter((item) => supportedItemIds.has(item.id)).length,
    highlights.length,
  );
  const highlightNonRedundancy = highlights.length ? 1 - duplicateRate : 0;
  const highlightSalienceCoverage = harmonicMean([
    highlightCapabilityRecall,
    majorHighlightCapabilityRecall,
  ]);
  const highlightGroundingScore = harmonicMean([
    highlightEvidencePrecision,
    highlightItemPrecision,
  ]);
  const highlightPresentationScore = harmonicMean([
    highlightDomainRecall,
    highlightNonRedundancy,
  ]);
  const highlightGenerationScore = harmonicMean([
    highlightSalienceCoverage,
    highlightGroundingScore,
    highlightPresentationScore,
  ]);

  // Keep repository knowledge and user-facing Highlights as separate outcomes.
  // Each outcome is the harmonic mean of required, separately reported axes.
  // This prevents strong grounding from hiding absent coverage or salience.
  const repositoryKnowledgeCoverageScore = harmonicMean([
    capabilityRecall,
    majorCapabilityRecall,
    domainRecall,
  ]);
  const repositoryKnowledgeGroundingScore = harmonicMean([
    evidencePrecision,
    knowledgeItemPrecision,
  ]);
  const measurableClaimStateCorrectness = recoveredCapabilities.length
    ? claimStateCorrectness
    : 0;
  const repositoryKnowledgeScore = harmonicMean([
    repositoryKnowledgeCoverageScore,
    repositoryKnowledgeGroundingScore,
    measurableClaimStateCorrectness,
  ]);

  const analyzedPaths = run.inventory.analyzedPaths ?? [];
  const semanticAnalyzedPaths = run.inventory.semanticAnalyzedPaths ?? [];
  const selectedPaths = Array.from(new Set(
    [...analyzedPaths, ...semanticAnalyzedPaths].map(normalizedPath),
  ));
  const noisySelectedPaths = selectedPaths.filter((path) =>
    anyPattern(path, fixture.ignoredPathPatterns)
  );
  const structuralReportingCompleteness = average([
    run.inventory.analyzedPaths ? 1 : 0,
    run.inventory.semanticAnalyzedPaths ? 1 : 0,
    run.discoveredCapabilities ? 1 : 0,
  ]);
  const inventoryHygiene = selectedPaths.length
    ? 1 - ratio(noisySelectedPaths.length, selectedPaths.length)
    : 0;

  const falsePositiveCapabilities = discoveredCapabilities.filter((candidate) => {
    const identity = [candidate.key, candidate.label].filter(Boolean).join(" ");
    return matchesExplicitFalsePositiveTrap(identity, candidate.evidencePaths);
  });
  const falsePositiveCapabilitySet = new Set(falsePositiveCapabilities);
  const genericTokenFalsePositiveRate = ratio(
    falsePositiveCapabilities.length,
    discoveredCapabilities.length,
  );
  // Precision applies to mappings the extractor actually asserted. Empty
  // ledger rows are useful structural placeholders, but they neither prove nor
  // disprove a repository mapping. They remain visible to the independent
  // granularity metric below. An entirely unmapped capability map still scores
  // zero because average([]) is zero.
  const mappedCapabilities = discoveredCapabilities.filter((candidate) =>
    candidate.evidencePaths.length > 0
  );
  const capabilityMapPrecision = average(mappedCapabilities.map((candidate) => {
    if (falsePositiveCapabilitySet.has(candidate)) return 0;
    const identity = [candidate.key, candidate.label].filter(Boolean).join(" ");
    const evidencePaths = Array.from(new Set(
      candidate.evidencePaths.map(normalizedPath),
    ));
    const validEvidencePaths = evidencePaths.filter((path) =>
      Boolean(repositoryFileForPath(path))
    );
    const evidenceSurface = validEvidencePaths.map((path) => {
      const file = repositoryFileForPath(path)!;
      return `${path} ${file.content?.slice(0, 12_000) ?? ""}`;
    }).join(" ").slice(0, 120_000);
    const groundedByItem = run.items.some((item) =>
      supportedItemIds.has(item.id) &&
      item.evidence.some((reference) =>
        validEvidencePaths.includes(normalizedPath(reference.path))
      ) &&
      lexicallyRelated(
        identity,
        [item.domain, item.text, item.summary].filter(Boolean).join(" "),
      )
    );
    const pathPrecision = ratio(validEvidencePaths.length, evidencePaths.length);
    const semanticallyGrounded = lexicallyRelated(identity, evidenceSurface) ||
      groundedByItem;
    // Valid repository provenance is necessary but not sufficient. Preserve a
    // partial provenance score for broad structural labels that a lexical
    // checker cannot prove, while ensuring a map made entirely of arbitrary
    // labels remains below the release threshold.
    return pathPrecision * (semanticallyGrounded ? 1 : 0.6);
  })) * (run.discoveredCapabilities ? 1 : 0);
  // A useful taxonomy grows sublinearly with repository size. This neutral
  // ceiling catches one-capability-per-file explosions without consulting the
  // fixture's curated recall list or assuming a particular architecture.
  const repositoryScale = Math.max(1, fixture.files.filter((file) =>
    !isIgnoredRepositoryPath(file.path)
  ).length);
  const maximumUsefulCapabilityCount = Math.max(
    8,
    Math.ceil(2 * Math.sqrt(repositoryScale)),
  );
  const capabilityGranularity = discoveredCapabilities.length
    ? clamp(maximumUsefulCapabilityCount / discoveredCapabilities.length)
    : 0;

  const staticActual = clamp(
    ratio(run.inventory.analyzedFiles, run.inventory.scannableFiles),
  );
  const semanticDenominator = run.inventory.semanticEligibleFiles ??
    run.inventory.analyzedFiles;
  const semanticActual = clamp(
    ratio(run.inventory.semanticAnalyzedFiles, semanticDenominator),
  );
  const coveragePairs = [
    [run.coverage.static, staticActual],
    [run.coverage.semantic, semanticActual],
    [run.coverage.knowledge, capabilityRecall],
  ] as const;
  const reportedCoveragePairs = coveragePairs.filter(
    (pair): pair is readonly [number, number] => typeof pair[0] === "number",
  );
  const coverageReportingCompleteness = ratio(
    reportedCoveragePairs.length,
    coveragePairs.length,
  );
  const coverageCalibration = average(
    reportedCoveragePairs.map(([reported, actual]) =>
      1 - Math.abs(clamp(reported) - actual)
    ),
  ) * coverageReportingCompleteness;

  const budgetMeasurements = [
    [run.performance.durationMs, fixture.budget.maximumDurationMs],
    [run.performance.modelCalls, fixture.budget.maximumModelCalls],
    [run.performance.totalTokens, fixture.budget.maximumTokens],
    [run.performance.estimatedCostUsd, fixture.budget.maximumEstimatedCostUsd],
  ] as const;
  const budgetAdherence = average(
    budgetMeasurements.map(([actual, maximum]) => {
      if (actual === null || actual < 0) return 0;
      if (actual <= maximum) return 1;
      return clamp(maximum / actual);
    }),
  );

  const score =
    capabilityRecall * 0.17 +
    majorCapabilityRecall * 0.09 +
    highlightCapabilityRecall * 0.07 +
    domainRecall * 0.07 +
    evidencePrecision * 0.12 +
    knowledgeItemPrecision * 0.10 +
    claimStateCorrectness * 0.07 +
    diversity * 0.05 +
    coverageCalibration * 0.07 +
    budgetAdherence * 0.03 +
    inventoryHygiene * 0.06 +
    capabilityMapPrecision * 0.06 +
    capabilityGranularity * 0.04;
  const checks = [
    metricCheck("weighted implemented-capability recall", capabilityRecall, 0.55, "minimum"),
    metricCheck("major implemented-capability recall", majorCapabilityRecall, 0.6, "minimum"),
    metricCheck("highlight capability recall", highlightCapabilityRecall, 0.5, "minimum"),
    metricCheck("domain recall", domainRecall, 0.6, "minimum"),
    metricCheck("claim-to-evidence precision", evidencePrecision, 0.65, "minimum"),
    metricCheck("supported knowledge-item precision", knowledgeItemPrecision, 0.75, "minimum"),
    metricCheck("implemented-versus-planned correctness", claimStateCorrectness, 0.9, "minimum"),
    metricCheck("duplicate highlight rate", duplicateRate, 0.35, "maximum"),
    metricCheck("coverage calibration", coverageCalibration, 0.7, "minimum"),
    metricCheck("bounded cost and latency", budgetAdherence, 0.75, "minimum"),
    ...repositoryKnowledgeHardBudgetChecks(run, fixture.budget),
    repositoryKnowledgeExecutionIntegrityCheck(fixture, run),
    metricCheck("generated and tooling artifact exclusion", inventoryHygiene, 0.95, "minimum"),
    metricCheck("capability-map precision", capabilityMapPrecision, 0.7, "minimum"),
    metricCheck("capability granularity", capabilityGranularity, 0.75, "minimum"),
    metricCheck("generic-token false-positive rate", genericTokenFalsePositiveRate, 0.05, "maximum"),
    metricCheck("structural observation completeness", structuralReportingCompleteness, 1, "minimum"),
    metricCheck("repository knowledge outcome", repositoryKnowledgeScore, 0.68, "minimum"),
    metricCheck("Highlight generation outcome", highlightGenerationScore, 0.5, "minimum"),
  ];
  const unsupportedItems = run.items
    .filter((item) => !supportedItemIds.has(item.id))
    .map((item) => item.id);

  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    evaluatorPolicyVersion: REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    passed: checks.every((check) => check.passed),
    executionIntegrityStatus: repositoryKnowledgeExecutionIntegrityStatus(
      fixture,
      run,
    ),
    score: round(score),
    metrics: {
      repositoryKnowledgeScore: round(repositoryKnowledgeScore),
      repositoryKnowledgeCoverageScore: round(repositoryKnowledgeCoverageScore),
      repositoryKnowledgeGroundingScore: round(repositoryKnowledgeGroundingScore),
      highlightGenerationScore: round(highlightGenerationScore),
      highlightSalienceCoverage: round(highlightSalienceCoverage),
      highlightGroundingScore: round(highlightGroundingScore),
      highlightPresentationScore: round(highlightPresentationScore),
      capabilityRecall: round(capabilityRecall),
      majorCapabilityRecall: round(majorCapabilityRecall),
      highlightCapabilityRecall: round(highlightCapabilityRecall),
      majorHighlightCapabilityRecall: round(majorHighlightCapabilityRecall),
      highlightDomainRecall: round(highlightDomainRecall),
      highlightEvidencePrecision: round(highlightEvidencePrecision),
      highlightCitationPathPrecision: round(highlightCitationPathPrecision),
      highlightItemPrecision: round(highlightItemPrecision),
      highlightNonRedundancy: round(highlightNonRedundancy),
      highlightCount: highlights.length,
      expectedHighlightCapabilityCount: expectedHighlightCapabilities.length,
      recoveredHighlightCapabilityCount: recoveredHighlightCapabilities.length,
      domainRecall: round(domainRecall),
      evidencePrecision: round(evidencePrecision),
      citationPathPrecision: round(citationPathPrecision),
      knowledgeItemPrecision: round(knowledgeItemPrecision),
      unsupportedItemRate: round(unsupportedItemRate),
      claimStateCorrectness: round(claimStateCorrectness),
      diversity: round(diversity),
      duplicateRate: round(duplicateRate),
      coverageCalibration: round(coverageCalibration),
      coverageReportingCompleteness: round(coverageReportingCompleteness),
      budgetAdherence: round(budgetAdherence),
      inventoryHygiene: round(inventoryHygiene),
      capabilityMapPrecision: round(capabilityMapPrecision),
      capabilityGranularity: round(capabilityGranularity),
      genericTokenFalsePositiveRate: round(genericTokenFalsePositiveRate),
      structuralReportingCompleteness: round(structuralReportingCompleteness),
    },
    recoveredCapabilityKeys: recoveredCapabilities.map((capability) => capability.key),
    missedCapabilityKeys: implementedCapabilities
      .filter((capability) =>
        !recoveredCapabilities.some((recovered) => recovered.key === capability.key)
      )
      .map((capability) => capability.key),
    recoveredDomainKeys: recoveredDomains.map((domain) => domain.key),
    unsupportedItems,
    duplicateItemPairs,
    falsePositiveCapabilities: falsePositiveCapabilities.map((capability) =>
      capability.key || capability.label
    ),
    rawItems: run.items,
    rawDiscoveredCapabilities: discoveredCapabilities,
    checks,
  };
}

export function evaluateRepositoryKnowledgeSuite(input: {
  fixtures: readonly RepositoryKnowledgeFixture[];
  runs: readonly RepositoryKnowledgeEvaluationRun[];
}): RepositoryKnowledgeSuiteReport {
  const catalog = auditRepositoryKnowledgeFixtureCatalog(input.fixtures);
  const fixturesById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture]));
  const runsByFixture = new Map<string, RepositoryKnowledgeEvaluationRun>();
  for (const run of input.runs) {
    if (runsByFixture.has(run.fixtureId)) {
      throw new Error(`Multiple evaluation runs supplied for ${run.fixtureId}.`);
    }
    runsByFixture.set(run.fixtureId, run);
  }
  const missingFixtures = input.fixtures.filter((fixture) =>
    !runsByFixture.has(fixture.id)
  );
  if (missingFixtures.length) {
    throw new Error(
      `Missing repository knowledge runs: ${missingFixtures.map((fixture) => fixture.id).join(", ")}.`,
    );
  }
  const unknownRuns = input.runs.filter((run) => !fixturesById.has(run.fixtureId));
  if (unknownRuns.length) {
    throw new Error(
      `Unknown repository knowledge fixtures: ${unknownRuns.map((run) => run.fixtureId).join(", ")}.`,
    );
  }
  const results = input.fixtures.map((fixture) =>
    evaluateRepositoryKnowledgeRun({
      fixture,
      run: runsByFixture.get(fixture.id)!,
    })
  );
  const macroAverageScore = average(results.map((result) => result.score));
  const minimumProjectScore = Math.min(...results.map((result) => result.score));
  const macroAverageRepositoryKnowledgeScore = average(
    results.map((result) => result.metrics.repositoryKnowledgeScore),
  );
  const minimumProjectRepositoryKnowledgeScore = Math.min(
    ...results.map((result) => result.metrics.repositoryKnowledgeScore),
  );
  const repositoryKnowledgeScore =
    macroAverageRepositoryKnowledgeScore * 0.7 +
    minimumProjectRepositoryKnowledgeScore * 0.3;
  const macroAverageHighlightGenerationScore = average(
    results.map((result) => result.metrics.highlightGenerationScore),
  );
  const minimumProjectHighlightGenerationScore = Math.min(
    ...results.map((result) => result.metrics.highlightGenerationScore),
  );
  const highlightGenerationScore =
    macroAverageHighlightGenerationScore * 0.7 +
    minimumProjectHighlightGenerationScore * 0.3;
  const passingFixtureCount = results.filter((result) => result.passed).length;
  const requiredPassingFixtures = Math.ceil(results.length * 0.75);
  const hardBudgetPassed = input.fixtures.every((fixture) =>
    repositoryKnowledgeHardBudgetChecks(
      runsByFixture.get(fixture.id)!,
      fixture.budget,
    ).every((check) => check.passed)
  );
  const executionIntegrityPassed = input.fixtures.every((fixture) =>
    repositoryKnowledgeExecutionIntegrityCheck(
      fixture,
      runsByFixture.get(fixture.id)!,
    ).passed
  );
  const score = macroAverageScore * 0.7 + minimumProjectScore * 0.3;
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    evaluatorPolicyVersion: REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION,
    passed:
      catalog.passed &&
      macroAverageRepositoryKnowledgeScore >= 0.68 &&
      minimumProjectRepositoryKnowledgeScore >= 0.55 &&
      macroAverageHighlightGenerationScore >= 0.5 &&
      minimumProjectHighlightGenerationScore >= 0.3 &&
      hardBudgetPassed &&
      executionIntegrityPassed &&
      passingFixtureCount >= requiredPassingFixtures,
    hardBudgetPassed,
    executionIntegrityPassed,
    score: round(score),
    macroAverageScore: round(macroAverageScore),
    minimumProjectScore: round(minimumProjectScore),
    repositoryKnowledgeScore: round(repositoryKnowledgeScore),
    macroAverageRepositoryKnowledgeScore: round(
      macroAverageRepositoryKnowledgeScore,
    ),
    minimumProjectRepositoryKnowledgeScore: round(
      minimumProjectRepositoryKnowledgeScore,
    ),
    highlightGenerationScore: round(highlightGenerationScore),
    macroAverageHighlightGenerationScore: round(
      macroAverageHighlightGenerationScore,
    ),
    minimumProjectHighlightGenerationScore: round(
      minimumProjectHighlightGenerationScore,
    ),
    passingFixtureCount,
    fixtureCount: results.length,
    catalog,
    results,
  };
}
