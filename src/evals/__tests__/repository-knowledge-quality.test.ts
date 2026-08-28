import { describe, expect, it } from "vitest";
import {
  repositoryKnowledgeFixture,
  repositoryKnowledgeFixtures,
} from "@/src/evals/repository-knowledge-fixtures";
import {
  auditRepositoryKnowledgeFixtureCatalog,
  evaluateRepositoryKnowledgeRun,
  evaluateRepositoryKnowledgeSuite,
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryExpectedCapability,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";
import { parseRepositoryKnowledgeEvaluationRuns } from "@/src/evals/repository-knowledge-observation";

function pathForCapability(
  fixture: RepositoryKnowledgeFixture,
  capability: RepositoryExpectedCapability,
) {
  const found = fixture.files.find((file) =>
    capability.evidencePathPatterns.some((pattern) =>
      new RegExp(pattern, "iu").test(file.path)
    )
  );
  if (!found) {
    throw new Error(`Fixture ${fixture.id} has no evidence path for ${capability.key}.`);
  }
  return found.path;
}

function isIgnored(fixture: RepositoryKnowledgeFixture, path: string) {
  return fixture.ignoredPathPatterns.some((pattern) =>
    new RegExp(pattern, "iu").test(path)
  );
}

function representativeRun(
  fixture: RepositoryKnowledgeFixture,
): RepositoryKnowledgeEvaluationRun {
  const analyzedPaths = fixture.files
    .map((file) => file.path)
    .filter((path) => !isIgnored(fixture, path));
  const semanticAnalyzedPaths = Array.from(new Set(
    fixture.expectedCapabilities.map((capability) =>
      pathForCapability(fixture, capability)
    ),
  ));
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    commitSha: fixture.snapshotCommit,
    items: fixture.expectedCapabilities.map((capability, index) => ({
      id: `${fixture.id}-item-${index + 1}`,
      kind: capability.expectedInHighlights ? "highlight" : "fact",
      text: capability.exampleClaim,
      summary: `${capability.label} is grounded in repository implementation evidence.`,
      claimState: capability.implementationState,
      domain: capability.domainKey,
      evidence: [{ path: pathForCapability(fixture, capability) }],
    })),
    domains: fixture.expectedDomains.map((expected) => ({
      key: expected.key,
      label: expected.label,
    })),
    discoveredCapabilities: fixture.expectedCapabilities.map((expected) => ({
      key: expected.key,
      label: expected.label,
      evidencePaths: [pathForCapability(fixture, expected)],
    })),
    inventory: {
      scannableFiles: analyzedPaths.length,
      analyzedFiles: analyzedPaths.length,
      semanticEligibleFiles: semanticAnalyzedPaths.length,
      semanticAnalyzedFiles: semanticAnalyzedPaths.length,
      analyzedPaths,
      semanticAnalyzedPaths,
    },
    coverage: { static: 1, semantic: 1, knowledge: 1 },
    performance: {
      durationMs: Math.floor(fixture.budget.maximumDurationMs * 0.5),
      modelCalls: Math.floor(fixture.budget.maximumModelCalls * 0.5),
      totalTokens: Math.floor(fixture.budget.maximumTokens * 0.5),
      estimatedCostUsd: fixture.budget.maximumEstimatedCostUsd * 0.5,
    },
  };
}

describe("generalized repository knowledge evaluation", () => {
  it("audits a catalog spanning real projects, archetypes, and language families", () => {
    const audit = auditRepositoryKnowledgeFixtureCatalog(repositoryKnowledgeFixtures);

    expect(audit).toMatchObject({
      passed: true,
      fixtureCount: 7,
      archetypeCount: 7,
      realRepositoryCount: 6,
    });
    expect(audit.languageFamilyCount).toBeGreaterThanOrEqual(3);
    expect(audit.repositories).toEqual(expect.arrayContaining([
      "arkb75/Workbase",
      "arkb75/SoloPilot",
      "arkb75/CircleFund",
      "arkb75/Backer",
      "arkb75/InsightUBC",
      "arkb75/Amazon-Marketplace-Analytic-Software",
    ]));
  });

  it("passes broad, grounded observations without exact-prose assertions", () => {
    const runs = repositoryKnowledgeFixtures.map(representativeRun);
    const report = evaluateRepositoryKnowledgeSuite({
      fixtures: repositoryKnowledgeFixtures,
      runs,
    });

    expect(report.passed).toBe(true);
    expect(report.passingFixtureCount).toBe(repositoryKnowledgeFixtures.length);
    expect(report.minimumProjectScore).toBeGreaterThanOrEqual(0.9);
    expect(report.results.every((result) =>
      result.rawItems.length > 0 && result.metrics.evidencePrecision >= 0.9
    )).toBe(true);
  });

  it("does not reward a Workbase-specific answer reused across unrelated repositories", () => {
    const workbase = repositoryKnowledgeFixture("workbase-project-knowledge")!;
    const workbaseRun = representativeRun(workbase);
    const runs = repositoryKnowledgeFixtures.map((fixture) => {
      if (fixture.id === workbase.id) return workbaseRun;
      const cleanPaths = fixture.files
        .map((file) => file.path)
        .filter((path) => !isIgnored(fixture, path));
      return {
        ...workbaseRun,
        fixtureId: fixture.id,
        repository: fixture.repository,
        commitSha: fixture.snapshotCommit,
        items: workbaseRun.items.map((item) => ({
          ...item,
          id: `${fixture.id}-${item.id}`,
          evidence: [{ path: cleanPaths[0]! }],
        })),
        inventory: {
          ...workbaseRun.inventory,
          scannableFiles: cleanPaths.length,
          analyzedFiles: cleanPaths.length,
          analyzedPaths: cleanPaths,
          semanticAnalyzedPaths: cleanPaths.slice(0, 2),
          semanticEligibleFiles: 2,
          semanticAnalyzedFiles: 2,
        },
      } satisfies RepositoryKnowledgeEvaluationRun;
    });
    const report = evaluateRepositoryKnowledgeSuite({
      fixtures: repositoryKnowledgeFixtures,
      runs,
    });

    expect(report.passed).toBe(false);
    expect(report.minimumProjectScore).toBeLessThan(0.35);
    expect(report.results.find((result) =>
      result.fixtureId === "amazon-marketplace-analytics"
    )?.metrics.capabilityRecall).toBe(0);
  });

  it("penalizes presenting planned README features as implemented", () => {
    for (const fixtureId of ["circlefund-fintech", "insightubc-dataset-platform"]) {
      const fixture = repositoryKnowledgeFixture(fixtureId)!;
      const run = representativeRun(fixture);
      const planned = fixture.expectedCapabilities.find((capability) =>
        capability.implementationState === "planned"
      )!;
      const plannedItem = run.items.find((item) =>
        item.text === planned.exampleClaim
      )!;
      plannedItem.claimState = "implemented";
      plannedItem.text = `Implemented ${planned.label} as a shipped product capability.`;
      const report = evaluateRepositoryKnowledgeRun({ fixture, run });

      expect(report.metrics.claimStateCorrectness).toBeLessThan(0.9);
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: "implemented-versus-planned correctness",
        passed: false,
      }));
    }
  });

  it("catches generated artifacts, generic-token mappings, and capability explosion", () => {
    const fixture = repositoryKnowledgeFixture("amazon-marketplace-analytics")!;
    const run = representativeRun(fixture);
    run.inventory.analyzedPaths!.push(
      ".idea/workspace.xml",
      "AmazonAnalytics.jar",
    );
    run.inventory.semanticAnalyzedPaths!.push(
      "lib/junit-jupiter-5.4.2.jar",
      "data/tobs.jpg",
    );
    run.discoveredCapabilities = Array.from({ length: 30 }, (_, index) => ({
      key: `ai_runtime_model_${index}`,
      label: `AI runtime model ${index}`,
      evidencePaths: ["src/main/model/ProductDetails.java"],
    }));

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.passed).toBe(false);
    expect(report.metrics.inventoryHygiene).toBeLessThan(0.95);
    expect(report.metrics.capabilityGranularity).toBeLessThan(0.75);
    expect(report.metrics.genericTokenFalsePositiveRate).toBe(1);
    expect(report.falsePositiveCapabilities).toHaveLength(30);
  });

  it("penalizes irrelevant output volume, duplicate highlights, and inflated coverage", () => {
    const fixture = repositoryKnowledgeFixture("backer-marketplace")!;
    const run = representativeRun(fixture);
    run.items = run.items.slice(0, 2);
    const copied = run.items[0]!;
    run.items.push(
      ...Array.from({ length: 8 }, (_, index) => ({
        ...copied,
        id: `duplicate-${index}`,
        text: `${copied.text} This is the same workflow and product result.`,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `noise-${index}`,
        kind: "highlight" as const,
        text: `Refactored helper ${index} and changed formatting.`,
        claimState: "implemented" as const,
        evidence: [{ path: "README.md" }],
      })),
    );
    run.coverage.knowledge = 1;

    const report = evaluateRepositoryKnowledgeRun({ fixture, run });

    expect(report.passed).toBe(false);
    expect(report.metrics.knowledgeItemPrecision).toBeLessThan(0.75);
    expect(report.metrics.duplicateRate).toBeGreaterThan(0.35);
    expect(report.metrics.coverageCalibration).toBeLessThan(0.9);
    expect(report.unsupportedItems).toHaveLength(8);
  });

  it("validates serialized observations before scoring them", () => {
    const fixture = repositoryKnowledgeFixture("circlefund-fintech")!;
    const run = representativeRun(fixture);
    expect(parseRepositoryKnowledgeEvaluationRuns({ runs: [run] })).toEqual([run]);
    expect(() => parseRepositoryKnowledgeEvaluationRuns({
      runs: [{ ...run, coverage: { ...run.coverage, knowledge: 1.2 } }],
    })).toThrow();
    expect(() => parseRepositoryKnowledgeEvaluationRuns({
      runs: [{ ...run, unexpected: true }],
    })).toThrow();
  });
});
