import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseRepositorySourceAuditScoreOptions,
  scoreRepositorySourceAudit,
} from "../../../scripts/score-repository-source-audit";
import {
  computeRepositorySourceAuditSourceDigest,
  parseRepositorySourceAuditManifest,
} from "@/src/evals/repository-source-audit";
import {
  buildRepositorySourceAuditAdjudicationPacket,
} from "@/src/evals/repository-source-audit-packet";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
} from "@/src/evals/repository-knowledge-quality";

const exec = promisify(execFile);

function liveRun(repository: string, commitSha: string) {
  return {
    schemaVersion: "repository-knowledge-live-run-v3",
    variant: "candidate",
    runStartedAt: "2026-09-04T10:00:00.000Z",
    runFinishedAt: "2026-09-04T10:05:00.000Z",
    implementation: {
      repositoryRoot: "/workbase",
      commitSha: "c".repeat(40),
      branch: "feature/candidate",
      trackedWorkingTreeClean: true,
      untrackedPolicy: "allowlisted_inert_only",
      allowedInertUntrackedPaths: [],
    },
    fixtures: [{ id: "audited-project", repository, snapshotCommit: commitSha }],
    results: [{
      fixtureId: "audited-project",
      repository,
      workItemId: "work-item-1",
      refreshRunId: "refresh-1",
      status: "completed",
      mainPathIntegrity: { passed: true, issues: [] },
    }],
  };
}

function packet(executionIntegrityPassed = true) {
  const manifest = parseRepositorySourceAuditManifest({
    schemaVersion: "repository-source-audit-v1",
    auditDate: "2026-09-04",
    method: "Independent source inspection at a pinned commit.",
    repositories: [{
      fixtureId: "audited-project",
      repository: "example/audited-project",
      commitSha: "a".repeat(40),
      sourceScope: "tracked_git_tree",
      sourceDigest: "b".repeat(64),
      knowledgeUnits: [
        {
          id: "audited.workflow",
          claim: "Runs the central workflow.",
          state: "implemented",
          importance: "major",
          highlightRelevance: "must",
          domain: "workflow",
          kind: "workflow",
          anchors: [{ path: "src/workflow.ts", lineStart: 1, lineEnd: 4 }],
        },
        {
          id: "audited.no-payments",
          claim: "Does not process payments.",
          state: "absent",
          importance: "major",
          highlightRelevance: "not_expected",
          domain: "payments",
          kind: "constraint",
          anchors: [{ path: "src/workflow.ts", lineStart: 5, lineEnd: 7 }],
          uncertainty: "Amounts are recorded locally but no transfer is executed.",
        },
      ],
      userQuestions: [
        "How does the central workflow run?",
        "Does the project transfer payments?",
      ],
    }],
  });
  const repository = manifest.repositories[0]!;
  const observation: RepositoryKnowledgeEvaluationRun = {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: repository.fixtureId,
    repository: repository.repository,
    commitSha: repository.commitSha,
    refreshRunId: "refresh-1",
    items: [
      {
        id: "fact-1",
        kind: "fact",
        text: "The workflow stores amounts but does not transfer funds.",
        summary: null,
        claimState: "implemented",
        domain: "payments",
        evidence: [],
      },
      {
        id: "highlight-1",
        kind: "highlight",
        text: "Runs the central workflow.",
        summary: "Executes and persists the central operation.",
        claimState: "implemented",
        domain: "workflow",
        evidence: [{
          path: "src/workflow.ts",
          lineStart: 1,
          lineEnd: 4,
          quote: "export async function runWorkflow() {}",
        }],
      },
    ],
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
      durationMs: 1_000,
      modelCalls: 2,
      totalTokens: 3_000,
      estimatedCostUsd: 0.01,
    },
    executionIntegrity: {
      passed: executionIntegrityPassed,
      issues: executionIntegrityPassed ? [] : ["Historical run lacks v2 attestation."],
      modelIdentities: ["semantic_extraction:openrouter:model"],
      policyVersions: ["repository-policy=v1"],
    },
  };
  return buildRepositorySourceAuditAdjudicationPacket({
    manifest,
    repository,
    observation,
    workItemId: "work-item-1",
    ...(executionIntegrityPassed
      ? { liveRun: liveRun(repository.repository, repository.commitSha) }
      : {}),
  });
}

function adjudication() {
  return {
    unitAdjudications: [
      {
        unitId: "audited.workflow",
        knowledgeCoverage: "full",
        highlightCoverage: "full",
        evidenceSupported: true,
        stateCorrect: true,
        qualifierCoverage: null,
        contradictsAudit: false,
      },
      {
        unitId: "audited.no-payments",
        knowledgeCoverage: "full",
        highlightCoverage: "none",
        evidenceSupported: true,
        stateCorrect: true,
        qualifierCoverage: "full",
        contradictsAudit: false,
      },
    ],
    highlightAdjudications: [{
      highlightId: "highlight-1",
      matchedUnitIds: ["audited.workflow"],
      salience: "major_operation",
      semanticDuplicateOf: null,
    }],
    questionAdjudications: [
      {
        question: "How does the central workflow run?",
        answerability: "full",
        supportingUnitIds: ["audited.workflow"],
        evidenceSupported: true,
        stateCorrect: true,
        contradictsAudit: false,
      },
      {
        question: "Does the project transfer payments?",
        answerability: "full",
        supportingUnitIds: ["audited.no-payments"],
        evidenceSupported: true,
        stateCorrect: true,
        contradictsAudit: false,
      },
    ],
  };
}

describe("repository source-audit scoring", () => {
  it("emits deterministic provenance, count-neutral diagnostics, and semantic outcomes", () => {
    const input = { packet: packet(), adjudication: adjudication() };
    const first = scoreRepositorySourceAudit(input);
    const second = scoreRepositorySourceAudit(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "repository-source-audit-score-v1",
      provenance: {
        workItemId: "work-item-1",
        fixtureId: "audited-project",
        repository: "example/audited-project",
        commitSha: "a".repeat(40),
        sourceDigest: "b".repeat(64),
        liveRun: {
          implementationCommitSha: "c".repeat(40),
          implementationBranch: "feature/candidate",
          refreshRunId: "refresh-1",
        },
      },
      certification: {
        status: "current_run_eligible",
        currentRunEligible: true,
        historicalControlOverrideUsed: false,
        sourceTreeVerification: {
          status: "not_verified",
        },
        liveRunBinding: { status: "verified" },
      },
      semanticDetails: {
        units: expect.arrayContaining([
          expect.objectContaining({
            unitId: "audited.workflow",
            knowledgeCoverage: "full",
            highlightCoverage: "full",
          }),
        ]),
        questions: expect.arrayContaining([
          expect.objectContaining({
            question: "How does the central workflow run?",
            answerability: "full",
          }),
        ]),
      },
      diagnostics: {
        scoringUniverse: {
          knowledgeUnits: 2,
          userQuestions: 2,
          observedHighlights: 1,
        },
        savedOutputs: {
          highlights: 1,
          facts: 1,
          total: 2,
        },
        countNeutral: true,
      },
      outcome: {
        weightedKnowledgeRecall: 1,
        majorKnowledgeRecall: 1,
        mustHighlightRecall: 1,
        weightedHighlightRecall: 1,
        matchedUnitGrounding: 1,
        qualifierPreservation: 1,
        constraintRecall: 1,
        contradictionRate: 0,
        questionAnswerability: 1,
        fullyAnswerableQuestionRate: 1,
        highlightSalience: 1,
        majorHighlightAllocationRate: 1,
        duplicateHighlightRate: 0,
      },
    });
    expect(first.provenance.packetDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.provenance.adjudicationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.provenance.sourceAuditDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires an explicit historical-control override for ineligible runs", () => {
    const historicalPacket = packet(false);
    expect(() => scoreRepositorySourceAudit({
      packet: historicalPacket,
      adjudication: adjudication(),
    })).toThrow(/--historical-control/u);

    expect(scoreRepositorySourceAudit({
      packet: historicalPacket,
      adjudication: adjudication(),
      historicalControl: true,
    })).toMatchObject({
      certification: {
        status: "historical_control",
        currentRunEligible: false,
        historicalControlOverrideUsed: true,
        executionIntegrity: {
          passed: false,
          issues: ["Historical run lacks v2 attestation."],
        },
      },
    });
  });

  it("rejects an eligible packet without its verified live-run binding", () => {
    const unbound = structuredClone(packet()) as Record<string, unknown>;
    delete unbound.liveRunProvenance;
    expect(() => scoreRepositorySourceAudit({
      packet: unbound,
      adjudication: adjudication(),
    })).toThrow(/verified live-run binding/u);
  });

  it("enforces the exact source-unit, Highlight, and question sets", () => {
    const valid = adjudication();
    expect(() => scoreRepositorySourceAudit({
      packet: packet(),
      adjudication: {
        ...valid,
        unitAdjudications: valid.unitAdjudications.slice(0, 1),
      },
    })).toThrow(/Missing source-audit adjudications: audited\.no-payments/u);
    expect(() => scoreRepositorySourceAudit({
      packet: packet(),
      adjudication: { ...valid, highlightAdjudications: [] },
    })).toThrow(/Missing Highlight adjudications: highlight-1/u);
    expect(() => scoreRepositorySourceAudit({
      packet: packet(),
      adjudication: {
        ...valid,
        questionAdjudications: valid.questionAdjudications.slice(0, 1),
      },
    })).toThrow(/Missing user-question adjudications/u);
  });

  it("rejects packet identity, eligibility, evidence-marker, and count inconsistencies", () => {
    const identityMismatch = structuredClone(packet());
    identityMismatch.observation.commitSha = "c".repeat(40);
    expect(() => scoreRepositorySourceAudit({
      packet: identityMismatch,
      adjudication: adjudication(),
    })).toThrow(/observation does not match/u);

    const eligibilityMismatch = structuredClone(packet());
    eligibilityMismatch.observation.adjudicationEligible = false;
    expect(() => scoreRepositorySourceAudit({
      packet: eligibilityMismatch,
      adjudication: adjudication(),
      historicalControl: true,
    })).toThrow(/eligibility disagrees/u);

    const evidenceMismatch = structuredClone(packet());
    evidenceMismatch.observation.savedOutputs[1]!.evidence[0]!
      .hasExactRangeAndQuote = false;
    expect(() => scoreRepositorySourceAudit({
      packet: evidenceMismatch,
      adjudication: adjudication(),
    })).toThrow(/inconsistent exact-evidence marker/u);

    const countMismatch = structuredClone(packet());
    countMismatch.observation.savedOutputCounts.highlights = 2;
    expect(() => scoreRepositorySourceAudit({
      packet: countMismatch,
      adjudication: adjudication(),
    })).toThrow(/savedOutputCounts\.highlights/u);
  });

  it("parses CLI paths and scores JSON files through the executable", async () => {
    expect(parseRepositorySourceAuditScoreOptions([
      "--packet=packet.json",
      "--adjudication",
      "adjudication.json",
      "--historical-control",
      "--repository-root",
      "repository",
      "--output=score.json",
      "--compact",
    ])).toMatchObject({
      packetPath: resolve("packet.json"),
      adjudicationPath: resolve("adjudication.json"),
      historicalControl: true,
      outputPath: resolve("score.json"),
      repositoryRoot: resolve("repository"),
      compact: true,
    });

    const root = await mkdtemp(join(tmpdir(), "workbase-source-score-"));
    try {
      const repositoryRoot = join(root, "repository");
      await mkdir(join(repositoryRoot, "src"), { recursive: true });
      await writeFile(
        join(repositoryRoot, "src/workflow.ts"),
        [
          "export async function runWorkflow() {",
          "  return 1;",
          "}",
          "",
          "export const amount = 1;",
          "export const settlement = false;",
          "export const localOnly = true;",
          "",
        ].join("\n"),
      );
      await exec("git", ["init"], { cwd: repositoryRoot });
      await exec("git", ["config", "user.name", "Source Score Test"], {
        cwd: repositoryRoot,
      });
      await exec("git", ["config", "user.email", "source-score@example.invalid"], {
        cwd: repositoryRoot,
      });
      await exec("git", ["add", "src/workflow.ts"], { cwd: repositoryRoot });
      await exec("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot });
      const commitSha = (await exec("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
      })).stdout.trim();
      const cliPacket = structuredClone(packet()) as unknown as {
        auditDate: string;
        method: string;
        sourceAudit: {
          commitSha: string;
          sourceDigest: string;
          [key: string]: unknown;
        };
        observation: { commitSha: string; [key: string]: unknown };
        liveRunProvenance: {
          fixture: { snapshotCommit: string; [key: string]: unknown };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
      cliPacket.sourceAudit.commitSha = commitSha;
      cliPacket.observation.commitSha = commitSha;
      cliPacket.liveRunProvenance.fixture.snapshotCommit = commitSha;
      const provisionalRepository = parseRepositorySourceAuditManifest({
        schemaVersion: "repository-source-audit-v1",
        auditDate: cliPacket.auditDate,
        method: cliPacket.method,
        repositories: [cliPacket.sourceAudit],
      }).repositories[0]!;
      const computed = await computeRepositorySourceAuditSourceDigest({
        repository: provisionalRepository,
        repositoryRoot,
      });
      const canonicalRepositoryRoot = await realpath(repositoryRoot);
      cliPacket.sourceAudit.sourceDigest = computed.sourceDigest;
      const packetPath = join(root, "packet.json");
      const adjudicationPath = join(root, "adjudication.json");
      const outputPath = join(root, "score.json");
      await Promise.all([
        writeFile(packetPath, JSON.stringify(cliPacket)),
        writeFile(adjudicationPath, JSON.stringify(adjudication())),
      ]);
      const result = await exec(
        join(process.cwd(), "node_modules/.bin/tsx"),
        [
          "scripts/score-repository-source-audit.ts",
          "--packet",
          packetPath,
          "--adjudication",
          adjudicationPath,
          "--repository-root",
          repositoryRoot,
          "--output",
          outputPath,
          "--compact",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: "repository-source-audit-score-v1",
        provenance: { fixtureId: "audited-project" },
        certification: {
          sourceTreeVerification: {
            status: "verified",
            repositoryRoot: canonicalRepositoryRoot,
            computedSourceDigest: computed.sourceDigest,
          },
        },
        outcome: { weightedKnowledgeRecall: 1 },
      });
      expect(await readFile(outputPath, "utf8")).toBe(result.stdout);
      await expect(exec(
        join(process.cwd(), "node_modules/.bin/tsx"),
        [
          "scripts/score-repository-source-audit.ts",
          "--packet",
          packetPath,
          "--adjudication",
          adjudicationPath,
          "--repository-root",
          repositoryRoot,
          "--output",
          outputPath,
          "--compact",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      )).rejects.toMatchObject({
        stderr: expect.stringMatching(/EEXIST|file already exists/u),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
