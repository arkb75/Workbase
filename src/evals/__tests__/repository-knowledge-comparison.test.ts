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
  majorCapabilityRecall?: number;
  highlightCapabilityRecall?: number;
  domainRecall?: number;
  knowledgeItemPrecision?: number;
  evidencePrecision?: number;
  claimStateCorrectness?: number;
  inventoryHygiene?: number;
  duplicateRate?: number;
  coverageCalibration?: number;
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
        majorCapabilityRecall: fixture.majorCapabilityRecall ?? fixture.score,
        highlightCapabilityRecall: fixture.highlightCapabilityRecall ?? fixture.score,
        domainRecall: fixture.domainRecall ?? fixture.score,
        knowledgeItemPrecision: fixture.knowledgeItemPrecision ?? fixture.score,
        evidencePrecision: fixture.evidencePrecision ?? fixture.score,
        claimStateCorrectness: fixture.claimStateCorrectness ?? fixture.score,
        inventoryHygiene: fixture.inventoryHygiene ?? fixture.score,
        duplicateRate: fixture.duplicateRate ?? 0,
        coverageCalibration: fixture.coverageCalibration ?? fixture.score,
      },
    })),
    observations: fixtures.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      executionIntegrity: {
        passed: true,
        issues: [] as string[],
        modelIdentities: [
          "capability_synthesis:bedrock:synthesis-model",
          "execution_routing:bedrock:routing-model",
          "semantic_extraction:bedrock:semantic-model",
        ],
        policyVersions: ["orchestration.policyVersion=repository-orchestration-test"],
      },
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
      candidate: {
        name: "candidate",
        fixtureCount: 3,
        executionIntegrityPassed: true,
      },
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
      evaluatorPolicyCompatibility: {
        baseline: null,
        candidate: null,
        compatible: true,
        diagnostic: expect.stringContaining("legacy compatibility"),
      },
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

  it("rejects explicitly different evaluator policies and accepts equal policies", () => {
    const baseline = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    const candidate = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    Object.assign(baseline, {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v1",
    });
    Object.assign(candidate, {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v2",
    });

    const mismatch = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(mismatch.passed).toBe(false);
    expect(mismatch.comparisons[0]).toMatchObject({
      evaluatorPolicyCompatibility: {
        baseline: "repository-knowledge-evaluator-v1",
        candidate: "repository-knowledge-evaluator-v2",
        compatible: false,
        diagnostic: "Candidate and baseline declare different evaluator policy versions.",
      },
      regressions: expect.arrayContaining([
        expect.objectContaining({
          scope: "suite",
          metric: "evaluatorPolicyVersion",
        }),
      ]),
    });

    Object.assign(baseline, {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v2",
    });
    const compatible = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(compatible.passed).toBe(true);
    expect(compatible.comparisons[0]!.evaluatorPolicyCompatibility).toEqual({
      baseline: "repository-knowledge-evaluator-v2",
      candidate: "repository-knowledge-evaluator-v2",
      compatible: true,
      diagnostic: null,
    });
  });

  it("derives nested evaluator policy attestations and rejects inconsistent reports", () => {
    const baseline = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    const candidate = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    Object.assign(baseline.aggregate, {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v2",
    });
    Object.assign(candidate.reports[0], {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v2",
    });

    const compatible = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(compatible.candidate.evaluatorPolicyVersion).toBe(
      "repository-knowledge-evaluator-v2",
    );
    expect(compatible.comparisons[0]!.evaluatorPolicyCompatibility).toMatchObject({
      baseline: "repository-knowledge-evaluator-v2",
      candidate: "repository-knowledge-evaluator-v2",
      compatible: true,
    });

    Object.assign(candidate, {
      evaluatorPolicyVersion: "repository-knowledge-evaluator-v1",
    });
    expect(() => compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    })).toThrow(/evaluator policy declarations disagree/u);
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
        majorCapabilityRecall: 0.4,
        highlightCapabilityRecall: 0.45,
        domainRecall: 0.5,
        duplicateRate: 0.2,
        coverageCalibration: 0.5,
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
      "alpha:majorCapabilityRecall",
      "alpha:highlightCapabilityRecall",
      "alpha:domainRecall",
      "alpha:duplicateRate",
      "alpha:coverageCalibration",
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

  it("applies the documented absolute quality tolerance to duplicate rate", () => {
    const baseline = evaluatorReport([{
      fixtureId: "alpha",
      score: 0.8,
      duplicateRate: 0,
    }]);
    const candidate = evaluatorReport([{
      fixtureId: "alpha",
      score: 0.8,
      duplicateRate: 0.04,
    }]);

    const result = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(result.comparisons[0]!.fixtures[0]!.quality).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "duplicateRate",
        delta: 0.04,
        status: "within_tolerance",
      }),
    ]));
  });

  it("rejects fallback, missing, or provider-mismatched comparison evidence", () => {
    const baseline = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    const candidate = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    candidate.observations[0]!.executionIntegrity = {
      passed: false,
      issues: ["Repository semantic planning used its deterministic fallback."],
      modelIdentities: ["execution_routing:bedrock:routing-model"],
      policyVersions: ["orchestration.policyVersion=repository-orchestration-test"],
    };

    const fallbackResult = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });
    expect(fallbackResult.passed).toBe(false);
    expect(fallbackResult.comparisons[0]!.regressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "executionIntegrity" }),
      expect.objectContaining({ metric: "modelIdentity" }),
    ]));

    delete (baseline.observations[0] as { executionIntegrity?: unknown }).executionIntegrity;
    const unattestedResult = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]) },
      baselines: [{ name: "control", report: baseline }],
    });
    expect(unattestedResult.passed).toBe(false);
    expect(unattestedResult.comparisons[0]!.regressions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "executionIntegrity",
        reason: "Baseline has no main-path execution attestation.",
      }),
    ]));
  });

  it("rejects incomplete attestations on candidate-only fixtures", () => {
    const baseline = evaluatorReport([{ fixtureId: "alpha", score: 0.8 }]);
    const candidate = evaluatorReport([
      { fixtureId: "alpha", score: 0.8 },
      { fixtureId: "new-project", score: 0.8 },
    ]);
    candidate.observations[1]!.executionIntegrity = {
      passed: true,
      issues: [],
      modelIdentities: [],
      policyVersions: ["orchestration.policyVersion=repository-orchestration-test"],
    };

    const result = compareRepositoryKnowledgeReports({
      candidate: { name: "candidate", report: candidate },
      baselines: [{ name: "control", report: baseline }],
    });

    expect(result.passed).toBe(false);
    expect(result.candidate.executionIntegrityPassed).toBe(false);
    expect(result.comparisons[0]!.regressions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "suite",
        metric: "executionIntegrity",
        reason: expect.stringContaining("new-project"),
      }),
    ]));
  });
});
