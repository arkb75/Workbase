export const REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION =
  "repository-knowledge-evaluation-v1" as const;

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
}

export interface RepositoryKnowledgeMetricCheck {
  name: string;
  passed: boolean;
  actual: number | string | boolean;
  expected: number | string | boolean;
}

export interface RepositoryKnowledgeEvaluationReport {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION;
  fixtureId: string;
  repository: string | null;
  passed: boolean;
  score: number;
  metrics: {
    capabilityRecall: number;
    majorCapabilityRecall: number;
    highlightCapabilityRecall: number;
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
  passed: boolean;
  score: number;
  macroAverageScore: number;
  minimumProjectScore: number;
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

function inferredClaimState(
  item: RepositoryKnowledgeEvaluationItem,
): RepositoryKnowledgeClaimState {
  if (item.claimState) return item.claimState;
  const text = itemSearchText(item);
  if (
    /\b(?:planned|planning|roadmap|future|next|todo|not yet|in progress|wip)\b/iu
      .test(text)
  ) {
    return "planned";
  }
  if (
    /\b(?:built|created|delivered|implemented|integrated|supports?|uses?|records?|validates?|generates?|provides?|routes?|stores?|renders?|loads?|parses?|executes?)\b/iu
      .test(text)
  ) {
    return "implemented";
  }
  return "unknown";
}

function normalizedPath(path: string) {
  return path.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function quoteSupported(file: RepositoryEvaluationFile, quote: string | null | undefined) {
  if (!quote?.trim() || file.content === undefined) return true;
  const normalizedContent = file.content.replace(/\s+/gu, " ").trim();
  const normalizedQuote = quote.replace(/\s+/gu, " ").trim();
  return normalizedContent.includes(normalizedQuote);
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
        return anyPattern(itemSearchText(item), capability.matchPatterns) &&
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
    return item.evidence.some((reference) => {
      const path = normalizedPath(reference.path);
      const file = filesByPath.get(path);
      return Boolean(
        file &&
        anyPattern(path, capability.evidencePathPatterns) &&
        quoteSupported(file, reference.quote),
      );
    });
  }

  const recoveredCapabilities = implementedCapabilities.filter((capability) =>
    (capabilityMatches.get(capability.key) ?? []).some((itemIndex) => {
      const item = run.items[itemIndex]!;
      return inferredClaimState(item) !== "planned" &&
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
  const highlightCapabilityRecall = ratio(
    expectedHighlightCapabilities.filter((capability) =>
      (capabilityMatches.get(capability.key) ?? []).some((itemIndex) => {
        const item = run.items[itemIndex]!;
        return item.kind === "highlight" &&
          inferredClaimState(item) !== "planned" &&
          evidenceSupportsCapability(item, capability);
      })
    ).length,
    expectedHighlightCapabilities.length,
  );

  const outputDomainText = [
    ...(run.domains ?? []).flatMap((domain) => [domain.key, domain.label]),
    ...run.items.flatMap((item) => [item.domain, itemSearchText(item)]),
  ].filter((value): value is string => Boolean(value));
  const recoveredDomains = fixture.expectedDomains.filter((domain) => {
    const named = outputDomainText.some((value) =>
      anyPattern(value, domain.matchPatterns)
    );
    const cited = run.items.some((item) =>
      item.evidence.some((reference) => {
        const path = normalizedPath(reference.path);
        return filesByPath.has(path) &&
          anyPattern(path, domain.evidencePathPatterns);
      })
    );
    return named && cited;
  });
  const domainRecall = ratio(
    recoveredDomains.length,
    fixture.expectedDomains.length,
  );

  const evidenceReferences = run.items.flatMap((item) => item.evidence);
  const validEvidenceReferences = evidenceReferences.filter((reference) => {
    const file = filesByPath.get(normalizedPath(reference.path));
    return file && quoteSupported(file, reference.quote);
  });
  const citationPathPrecision = ratio(
    validEvidenceReferences.length,
    evidenceReferences.length,
  );
  const claimEvidencePairs = fixture.expectedCapabilities.flatMap((capability) =>
    (capabilityMatches.get(capability.key) ?? []).map((itemIndex) => ({
      capability,
      item: run.items[itemIndex]!,
    }))
  );
  const supportedClaimEvidencePairs = claimEvidencePairs.filter(({ capability, item }) =>
    evidenceSupportsCapability(item, capability)
  );
  const claimEvidencePrecision = ratio(
    supportedClaimEvidencePairs.length,
    claimEvidencePairs.length,
  );
  const evidencePrecision = average([
    citationPathPrecision,
    claimEvidencePrecision,
  ]);
  const supportedItemIds = new Set(
    supportedClaimEvidencePairs.map(({ item }) => item.id),
  );
  const knowledgeItemPrecision = ratio(supportedItemIds.size, run.items.length);
  const unsupportedItemRate = 1 - knowledgeItemPrecision;

  const stateScores = claimEvidencePairs.map(({ capability, item }) => {
    const state = inferredClaimState(item);
    if (state === "unknown") return 0.5;
    return state === capability.implementationState ? 1 : 0;
  });
  const claimStateCorrectness = average(stateScores);

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

  const analyzedPaths = run.inventory.analyzedPaths ?? [];
  const semanticAnalyzedPaths = run.inventory.semanticAnalyzedPaths ?? [];
  const selectedPaths = [...analyzedPaths, ...semanticAnalyzedPaths];
  const noisySelectedPaths = selectedPaths.filter((path) =>
    anyPattern(normalizedPath(path), fixture.ignoredPathPatterns)
  );
  const structuralReportingCompleteness = average([
    run.inventory.analyzedPaths ? 1 : 0,
    run.inventory.semanticAnalyzedPaths ? 1 : 0,
    run.discoveredCapabilities ? 1 : 0,
  ]);
  const inventoryHygiene = selectedPaths.length
    ? 1 - ratio(noisySelectedPaths.length, selectedPaths.length)
    : 0;

  const discoveredCapabilities = run.discoveredCapabilities ?? [];
  const falsePositiveCapabilities = discoveredCapabilities.filter((candidate) => {
    const identity = [candidate.key, candidate.label].filter(Boolean).join(" ");
    return fixture.falsePositiveTraps.some((trap) => {
      if (!anyPattern(identity, trap.capabilityPatterns)) return false;
      const hasAllowedEvidence = candidate.evidencePaths.some((path) =>
        anyPattern(normalizedPath(path), trap.allowedEvidencePathPatterns ?? [])
      );
      const hasMisleadingEvidence = candidate.evidencePaths.some((path) =>
        anyPattern(normalizedPath(path), trap.misleadingEvidencePathPatterns)
      );
      return hasMisleadingEvidence && !hasAllowedEvidence;
    });
  });
  const genericTokenFalsePositiveRate = ratio(
    falsePositiveCapabilities.length,
    discoveredCapabilities.length,
  );
  const relevantDiscoveredCapabilities = discoveredCapabilities.filter((candidate) => {
    if (falsePositiveCapabilities.includes(candidate)) return false;
    const identity = [candidate.key, candidate.label].filter(Boolean).join(" ");
    return fixture.expectedCapabilities.some((expected) =>
      anyPattern(identity, expected.matchPatterns) ||
      candidate.evidencePaths.some((path) =>
        anyPattern(normalizedPath(path), expected.evidencePathPatterns)
      )
    ) || fixture.expectedDomains.some((expected) =>
      anyPattern(identity, expected.matchPatterns) ||
      candidate.evidencePaths.some((path) =>
        anyPattern(normalizedPath(path), expected.evidencePathPatterns)
      )
    );
  });
  const capabilityMapPrecision = ratio(
    relevantDiscoveredCapabilities.length,
    discoveredCapabilities.length,
  ) * (run.discoveredCapabilities ? 1 : 0);
  const maximumUsefulCapabilityCount = Math.max(
    fixture.expectedDomains.length,
    fixture.expectedCapabilities.length * 2,
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
    metricCheck("generated and tooling artifact exclusion", inventoryHygiene, 0.95, "minimum"),
    metricCheck("capability-map precision", capabilityMapPrecision, 0.7, "minimum"),
    metricCheck("capability granularity", capabilityGranularity, 0.75, "minimum"),
    metricCheck("generic-token false-positive rate", genericTokenFalsePositiveRate, 0.05, "maximum"),
    metricCheck("structural observation completeness", structuralReportingCompleteness, 1, "minimum"),
    metricCheck("overall fixture score", score, 0.68, "minimum"),
  ];
  const unsupportedItems = run.items
    .filter((item) => !supportedItemIds.has(item.id))
    .map((item) => item.id);

  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    passed: checks.every((check) => check.passed),
    score: round(score),
    metrics: {
      capabilityRecall: round(capabilityRecall),
      majorCapabilityRecall: round(majorCapabilityRecall),
      highlightCapabilityRecall: round(highlightCapabilityRecall),
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
  const passingFixtureCount = results.filter((result) => result.passed).length;
  const requiredPassingFixtures = Math.ceil(results.length * 0.75);
  const score = macroAverageScore * 0.7 + minimumProjectScore * 0.3;
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    passed:
      catalog.passed &&
      macroAverageScore >= 0.68 &&
      minimumProjectScore >= 0.55 &&
      passingFixtureCount >= requiredPassingFixtures,
    score: round(score),
    macroAverageScore: round(macroAverageScore),
    minimumProjectScore: round(minimumProjectScore),
    passingFixtureCount,
    fixtureCount: results.length,
    catalog,
    results,
  };
}
