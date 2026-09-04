import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  compareRepositorySourceAuditScores,
  parseRepositorySourceAuditComparisonOptions,
} from "../../../scripts/compare-repository-source-audit-scores";
import { scoreRepositorySourceAudit } from "../../../scripts/score-repository-source-audit";
import {
  parseRepositorySourceAuditManifest,
  type RepositorySourceAuditManifest,
} from "@/src/evals/repository-source-audit";
import {
  buildRepositorySourceAuditAdjudicationPacket,
} from "@/src/evals/repository-source-audit-packet";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
} from "@/src/evals/repository-knowledge-quality";

const fixtureIds = ["alpha", "beta", "gamma", "holdout"] as const;
const exec = promisify(execFile);

function liveRun(input: {
  fixtureId: string;
  repository: string;
  snapshotCommit: string;
  workItemId: string;
}) {
  return {
    schemaVersion: "repository-knowledge-live-run-v3",
    variant: "candidate",
    runStartedAt: "2026-09-04T10:00:00.000Z",
    runFinishedAt: "2026-09-04T10:05:00.000Z",
    implementation: {
      repositoryRoot: "/workbase",
      commitSha: "f".repeat(40),
      branch: "feature/candidate",
      trackedWorkingTreeClean: true,
      untrackedPolicy: "allowlisted_inert_only",
      allowedInertUntrackedPaths: [],
    },
    fixtures: [{
      id: input.fixtureId,
      repository: input.repository,
      snapshotCommit: input.snapshotCommit,
    }],
    results: [{
      fixtureId: input.fixtureId,
      repository: input.repository,
      workItemId: input.workItemId,
      refreshRunId: `${input.fixtureId}-refresh`,
      status: "completed",
      mainPathIntegrity: { passed: true, issues: [] },
    }],
  };
}

function manifest(): RepositorySourceAuditManifest {
  return parseRepositorySourceAuditManifest({
    schemaVersion: "repository-source-audit-v1",
    auditDate: "2026-09-04",
    method: "Independent, commit-pinned source inspection.",
    repositories: fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      repository: `example/${fixtureId}`,
      commitSha: String(index + 1).repeat(40),
      sourceScope: "tracked_git_tree",
      sourceDigest: String(index + 1).repeat(64),
      knowledgeUnits: [
        {
          id: `${fixtureId}.workflow`,
          claim: `Runs the ${fixtureId} workflow.`,
          state: "implemented",
          importance: "major",
          highlightRelevance: "must",
          domain: "workflow",
          kind: "workflow",
          anchors: [{ path: "src/workflow.ts", lineStart: 1, lineEnd: 3 }],
        },
        {
          id: `${fixtureId}.no-payments`,
          claim: "Does not transfer payments.",
          state: "absent",
          importance: "major",
          highlightRelevance: "not_expected",
          domain: "payments",
          kind: "constraint",
          anchors: [{ path: "src/workflow.ts", lineStart: 4, lineEnd: 6 }],
        },
      ],
      userQuestions: [`How does ${fixtureId} work?`],
    })),
  });
}

function score(input: {
  manifest: RepositorySourceAuditManifest;
  fixtureId: string;
  grade: "full" | "partial";
  historical?: boolean;
}) {
  const repository = input.manifest.repositories.find((candidate) =>
    candidate.fixtureId === input.fixtureId
  )!;
  const historical = input.historical === true;
  const workItemId = `${input.fixtureId}-${historical ? "historical" : "current"}`;
  const observation: RepositoryKnowledgeEvaluationRun = {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: repository.fixtureId,
    repository: repository.repository,
    commitSha: repository.commitSha,
    refreshRunId: `${input.fixtureId}-refresh`,
    items: [{
      id: `${input.fixtureId}-highlight`,
      kind: "highlight",
      text: `Runs the ${input.fixtureId} workflow.`,
      summary: null,
      claimState: "implemented",
      domain: "workflow",
      evidence: [{
        path: "src/workflow.ts",
        lineStart: 1,
        lineEnd: 3,
        quote: "export async function workflow() {}",
      }],
    }],
    domains: [],
    discoveredCapabilities: [],
    inventory: {
      scannableFiles: 1,
      analyzedFiles: 1,
      semanticEligibleFiles: 1,
      semanticAnalyzedFiles: 1,
      semanticAnalyzedPaths: ["src/workflow.ts"],
    },
    coverage: { static: 1, semantic: 1, knowledge: 1 },
    performance: {
      durationMs: 1,
      modelCalls: 1,
      totalTokens: 100,
      estimatedCostUsd: 0.001,
    },
    executionIntegrity: {
      passed: !historical,
      issues: historical ? ["Predates current execution attestations."] : [],
      modelIdentities: ["semantic:provider:model"],
      policyVersions: ["repository-policy=v1"],
    },
  };
  const packet = buildRepositorySourceAuditAdjudicationPacket({
    manifest: input.manifest,
    repository,
    observation,
    workItemId,
    ...(!historical ? {
      liveRun: liveRun({
        fixtureId: input.fixtureId,
        repository: repository.repository,
        snapshotCommit: repository.commitSha,
        workItemId,
      }),
    } : {}),
  });
  const full = input.grade === "full";
  const report = scoreRepositorySourceAudit({
    packet,
    historicalControl: historical,
    adjudication: {
      unitAdjudications: [
        {
          unitId: `${input.fixtureId}.workflow`,
          knowledgeCoverage: input.grade,
          highlightCoverage: input.grade,
          evidenceSupported: true,
          stateCorrect: true,
          qualifierCoverage: null,
          contradictsAudit: false,
        },
        {
          unitId: `${input.fixtureId}.no-payments`,
          knowledgeCoverage: full ? "full" : "none",
          highlightCoverage: "none",
          evidenceSupported: full,
          stateCorrect: true,
          qualifierCoverage: null,
          contradictsAudit: false,
        },
      ],
      highlightAdjudications: [{
        highlightId: `${input.fixtureId}-highlight`,
        matchedUnitIds: [`${input.fixtureId}.workflow`],
        salience: full ? "major_operation" : "supporting_insight",
        semanticDuplicateOf: null,
      }],
      questionAdjudications: [{
        question: `How does ${input.fixtureId} work?`,
        answerability: input.grade,
        supportingUnitIds: [`${input.fixtureId}.workflow`],
        evidenceSupported: true,
        stateCorrect: true,
        contradictsAudit: false,
      }],
    },
  });
  return {
    ...report,
    certification: {
      ...report.certification,
      sourceTreeVerification: {
        status: "verified" as const,
        repositoryRoot: `/fixtures/${input.fixtureId}`,
        computedSourceDigest: repository.sourceDigest,
      },
    },
  };
}

describe("repository source-audit score comparison", () => {
  it("compares the complete current suite to source truth and matched controls", () => {
    const audit = manifest();
    const currentScores = fixtureIds.map((fixtureId) => score({
      manifest: audit,
      fixtureId,
      grade: "full",
    }));
    const historicalScores = fixtureIds.slice(0, 3).map((fixtureId) => score({
      manifest: audit,
      fixtureId,
      grade: "partial",
      historical: true,
    }));
    const comparison = compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: [...currentScores].reverse(),
      historicalScores: [...historicalScores].reverse(),
      requiredHistoricalFixtureIds: ["gamma", "alpha", "beta"],
    });

    expect(comparison.provenance).toMatchObject({
      currentFixtureIds: ["alpha", "beta", "gamma", "holdout"],
      matchedHistoricalFixtureIds: ["alpha", "beta", "gamma"],
      currentOnlyHoldoutFixtureIds: ["holdout"],
      requiredHistoricalFixtureIds: ["alpha", "beta", "gamma"],
    });
    expect(comparison.sourceTruth.repositories.every((repository) =>
      repository.unitGaps.length === 0 && repository.questionGaps.length === 0
    )).toBe(true);
    expect(comparison.historicalComparison.repositories.every((repository) =>
      repository.passed &&
      repository.metrics.every((metric) => metric.status !== "regressed")
    )).toBe(true);
    expect(comparison.holdouts).toEqual([{
      fixtureId: "holdout",
      comparison: "source_truth_only",
      reason: "No historical control was supplied for this audited repository.",
    }]);
    expect(comparison.acceptance).toMatchObject({
      passed: true,
      comparableThresholdFailures: [],
      historicalRegressions: [],
      missingRequiredHistoricalFixtureIds: [],
    });
    expect(comparison.diagnostics).toMatchObject({
      countNeutral: true,
      savedOutputCounts: expect.arrayContaining([
        expect.objectContaining({ fixtureId: "alpha", highlights: 1 }),
      ]),
    });
  });

  it("detects direction-sensitive aggregate, unit, and question regressions", () => {
    const audit = manifest();
    const currentScores = fixtureIds.map((fixtureId) => score({
      manifest: audit,
      fixtureId,
      grade: fixtureId === "alpha" ? "partial" : "full",
    }));
    const historical = score({
      manifest: audit,
      fixtureId: "alpha",
      grade: "full",
      historical: true,
    });
    const comparison = compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores,
      historicalScores: [historical],
      requiredHistoricalFixtureIds: ["alpha"],
    });
    const alpha = comparison.historicalComparison.repositories[0]!;

    expect(alpha.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "weightedKnowledgeRecall",
        direction: "higher",
        status: "regressed",
      }),
      expect.objectContaining({
        metric: "contradictionRate",
        direction: "lower",
        status: "equal",
      }),
    ]));
    expect(alpha.semanticRegressions.units).toEqual(expect.arrayContaining([
      expect.objectContaining({
        unitId: "alpha.workflow",
        field: "knowledgeCoverage",
      }),
    ]));
    expect(alpha.semanticRegressions.questions).toEqual([
      expect.objectContaining({
        question: "How does alpha work?",
        baselineEffectiveAnswerability: 1,
        currentEffectiveAnswerability: 0.5,
      }),
    ]);
    expect(comparison.acceptance.passed).toBe(false);
    expect(comparison.acceptance.historicalRegressions.length).toBeGreaterThan(0);
    expect(comparison.sourceTruth.repositories.find((entry) =>
      entry.fixtureId === "alpha"
    )).toMatchObject({
      unitGaps: expect.arrayContaining([
        expect.objectContaining({
          unitId: "alpha.workflow",
          knowledgeGapToFull: 0.5,
          highlightGapToFull: 0.5,
        }),
      ]),
      questionGaps: [expect.objectContaining({ gapToFull: 0.5 })],
    });
  });

  it("fails closed on incomplete suites, unverified source trees, and tampered outcomes", () => {
    const audit = manifest();
    const currentScores = fixtureIds.map((fixtureId) => score({
      manifest: audit,
      fixtureId,
      grade: "full",
    }));
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: currentScores.slice(1),
    })).toThrow(/Current score fixture set/u);

    const unverified = structuredClone(currentScores) as unknown[];
    const unverifiedFirst = unverified[0] as {
      certification: { sourceTreeVerification: unknown };
    };
    unverifiedFirst.certification.sourceTreeVerification = {
      status: "not_verified",
      repositoryRoot: null,
      computedSourceDigest: null,
    };
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: unverified,
    })).toThrow(/lacks matching clean-checkout source verification/u);

    const tampered = structuredClone(currentScores);
    tampered[0]!.outcome.weightedKnowledgeRecall = 0;
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: tampered,
    })).toThrow(/outcome does not match its semantic details/u);

    const tamperedAuditDigest = currentScores.map((score, index) => index
      ? score
      : {
          ...score,
          provenance: {
            ...score.provenance,
            sourceAuditDigest: "f".repeat(64),
          },
        });
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: tamperedAuditDigest,
    })).toThrow(/complete frozen repository audit/u);

    const missingHighlightAdjudication = currentScores.map((score, index) => index
      ? score
      : {
          ...score,
          semanticDetails: { ...score.semanticDetails, highlights: [] },
          outcome: {
            ...score.outcome,
            highlightSalience: null,
            majorHighlightAllocationRate: null,
            duplicateHighlightRate: null,
          },
        });
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: missingHighlightAdjudication,
    })).toThrow(/Highlight adjudications do not match its saved-output count/u);

    const unbound = structuredClone(currentScores) as Array<Record<string, unknown>>;
    delete (unbound[0]!.certification as Record<string, unknown>).liveRunBinding;
    expect(() => compareRepositorySourceAuditScores({
      manifest: audit,
      currentScores: unbound,
    })).toThrow(/live-run-bound/u);
  });

  it("parses repeatable CLI inputs without assigning quality to output counts", () => {
    expect(parseRepositorySourceAuditComparisonOptions([
      "--manifest=manifest.json",
      "--current-score",
      "current-a.json",
      "--current-score=current-b.json",
      "--historical-score=historical-a.json",
      "--require-historical",
      "alpha",
      "--output=comparison.json",
      "--compact",
    ])).toEqual({
      compact: true,
      currentScorePaths: [
        resolve("current-a.json"),
        resolve("current-b.json"),
      ],
      help: false,
      historicalScorePaths: [resolve("historical-a.json")],
      manifestPath: resolve("manifest.json"),
      outputPath: resolve("comparison.json"),
      requiredHistoricalFixtureIds: ["alpha"],
    });
  });

  it("writes a comparison artifact once while retaining stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "workbase-source-compare-"));
    try {
      const audit = manifest();
      const currentScores = fixtureIds.map((fixtureId) => score({
        manifest: audit,
        fixtureId,
        grade: "full",
      }));
      const manifestPath = join(root, "manifest.json");
      const currentScorePaths = currentScores.map((_, index) =>
        join(root, `current-${index + 1}.json`)
      );
      const outputPath = join(root, "comparison.json");
      await Promise.all([
        writeFile(manifestPath, JSON.stringify(audit)),
        ...currentScores.map((currentScore, index) =>
          writeFile(currentScorePaths[index]!, JSON.stringify(currentScore))
        ),
      ]);
      const args = [
        "scripts/compare-repository-source-audit-scores.ts",
        "--manifest",
        manifestPath,
        ...currentScorePaths.flatMap((path) => ["--current-score", path]),
        "--output",
        outputPath,
        "--compact",
      ];

      const result = await exec(
        join(process.cwd(), "node_modules/.bin/tsx"),
        args,
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: "repository-source-audit-comparison-v1",
        acceptance: { passed: true },
      });
      expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
      await expect(exec(
        join(process.cwd(), "node_modules/.bin/tsx"),
        args,
        { cwd: process.cwd(), encoding: "utf8" },
      )).rejects.toMatchObject({
        stderr: expect.stringMatching(/EEXIST|file already exists/u),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
