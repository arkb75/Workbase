import { describe, expect, it } from "vitest";
import {
  compareRepositoryKnowledgeReports,
  DEFAULT_REPOSITORY_KNOWLEDGE_COMPARISON_TOLERANCES,
} from "../../../scripts/compare-repository-knowledge-reports";

interface FixtureInput {
  fixtureId: string;
  passed?: boolean;
  score: number;
  capabilityRecall?: number;
  knowledgeItemPrecision?: number;
  evidencePrecision?: number;
  claimStateCorrectness?: number;
  inventoryHygiene?: number;
  performance?: {
    modelCalls?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    durationMs?: number;
  };
}

function evaluatorReport(fixtures: FixtureInput[], passed = true) {
  const scores = fixtures.map(({ score }) => score);
  const macroAverageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const minimumProjectScore = Math.min(...scores);
  return {
    reports: fixtures.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      passed: fixture.passed ?? true,
      score: fixture.score,
      metrics: {
        capabilityRecall: fixture.capabilityRecall ?? fixture.score,
        knowledgeItemPrecision: fixture.knowledgeItemPrecision ?? fixture.score,
        evidencePrecision: fixture.evidencePrecision ?? fixture.score,
        claimStateCorrectness: fixture.claimStateCorrectness ?? fixture.score,
        inventoryHygiene: fixture.inventoryHygiene ?? fixture.score,
      },
    })),
    observations: fixtures.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      performance: {
        modelCalls: fixture.performance?.modelCalls ?? 10,
        totalTokens: fixture.performance?.totalTokens ?? 1_000,
        estimatedCostUsd: fixture.performance?.estimatedCostUsd ?? 0.1,
        durationMs: fixture.performance?.durationMs ?? 1_000,
      },
    })),
    aggregate: {
      passed,
      score: macroAverageScore * 0.7 + minimumProjectScore * 0.3,
      macroAverageScore,
      minimumProjectScore,
      passingFixtureCount: fixtures.filter((fixture) => fixture.passed ?? true).length,
      fixtureCount: fixtures.length,
    },
  };
}

describe("repository knowledge report comparison", () => {
  it("accepts a candidate within quality and operational tolerances against multiple baselines", () => {
    const baseline = evaluatorReport([
      { fixtureId: "alpha", score: 0.8 },
      { fixtureId: "beta", score: 0.7 },
    ]);
    const older = evaluatorReport([
      { fixtureId: "alpha", score: 0.72 },
      { fixtureId: "beta", score: 0.66 },
    ]);
    const candidate = evaluatorReport([
      {
        fixtureId: "alpha",
        score: 0.79,
        performance: { modelCalls: 11, totalTokens: 1_100, estimatedCostUsd: 0.11, durationMs: 1_100 },
      },
      {
        fixtureId: "beta",
        score: 0.71,
        performance: { modelCalls: 11, totalTokens: 1_100, estimatedCostUsd: 0.11, durationMs: 1_100 },
      },
      { fixtureId: "gamma", score: 0.9 },
    ]);

    const result = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [
        { name: "control", report: baseline },
        { name: "previous", report: older },
      ],
    });

    expect(result).toMatchObject({
      passed: true,
      candidate: { name: "candidate", fixtureCount: 3 },
      tolerances: DEFAULT_REPOSITORY_KNOWLEDGE_COMPARISON_TOLERANCES,
      operationalMetricSemantics: {
        modelCalls: expect.stringContaining("provider-attempt"),
      },
    });
    expect(result.comparisons).toHaveLength(2);
    expect(result.comparisons.every((comparison) => comparison.passed)).toBe(true);
    expect(result.comparisons[0]).toMatchObject({
      comparedFixtureCount: 2,
      candidateOnlyFixtureIds: ["gamma"],
      baselineOnlyFixtureIds: [],
    });
    expect(result.comparisons[0]!.aggregateOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "modelCalls",
        baseline: 20,
        candidate: 22,
        relativeDelta: 0.1,
        status: "within_tolerance",
      }),
    ]));
  });

  it("fails on missing fixtures, pass downgrades, quality drops, and excessive operations", () => {
    const baseline = evaluatorReport([
      { fixtureId: "alpha", score: 0.82 },
      { fixtureId: "beta", score: 0.75 },
    ]);
    const candidate = evaluatorReport([
      {
        fixtureId: "alpha",
        passed: false,
        score: 0.61,
        capabilityRecall: 0.55,
        performance: { modelCalls: 14, totalTokens: 1_400, estimatedCostUsd: 0.14, durationMs: 1_400 },
      },
    ], false);

    const result = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(result.passed).toBe(false);
    expect(result.comparisons[0]).toMatchObject({
      comparedFixtureCount: 1,
      candidateOnlyFixtureIds: [],
      baselineOnlyFixtureIds: ["beta"],
    });
    const regressionKeys = result.comparisons[0]!.regressions.map((regression) =>
      `${regression.fixtureId ?? "suite"}:${regression.metric}`
    );
    expect(regressionKeys).toEqual(expect.arrayContaining([
      "suite:score",
      "suite:passed",
      "alpha:score",
      "alpha:capabilityRecall",
      "alpha:modelCalls",
      "alpha:passed",
      "beta:presence",
    ]));
  });

  it("treats lost telemetry as a regression and lets callers tighten tolerances", () => {
    const baseline = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    const candidate = evaluatorReport([{ fixtureId: "alpha", score: 0.79 }]);
    const performance = candidate.observations[0]!.performance as {
      modelCalls?: number;
    };
    delete performance.modelCalls;

    const result = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
      tolerances: {
        aggregateQualityDrop: 0,
        fixtureScoreDrop: 0,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.comparisons[0]!.regressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "suite", metric: "score" }),
      expect.objectContaining({ scope: "fixture", fixtureId: "alpha", metric: "score" }),
      expect.objectContaining({ scope: "fixture", fixtureId: "alpha", metric: "modelCalls" }),
    ]));
  });
});
