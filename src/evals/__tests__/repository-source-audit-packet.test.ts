import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRepositorySourceAuditExportOptions } from "../../../scripts/export-repository-source-audit-packet";
import {
  buildRepositorySourceAuditAdjudicationPacket,
  sourceAuditRepository,
} from "@/src/evals/repository-source-audit-packet";
import {
  parseRepositorySourceAuditManifest,
  type RepositorySourceAuditManifest,
} from "@/src/evals/repository-source-audit";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
} from "@/src/evals/repository-knowledge-quality";

function fixture(): RepositorySourceAuditManifest {
  return parseRepositorySourceAuditManifest({
    schemaVersion: "repository-source-audit-v1",
    auditDate: "2026-09-01",
    method: "Inspect the pinned tracked source and retain exact anchors.",
    repositories: [{
      fixtureId: "audited-project",
      repository: "example/audited-project",
      commitSha: "a".repeat(40),
      sourceScope: "tracked_git_tree",
      sourceDigest: "b".repeat(64),
      knowledgeUnits: [{
        id: "audited.workflow",
        claim: "Runs the audited workflow.",
        state: "implemented",
        importance: "major",
        highlightRelevance: "must",
        domain: "workflow",
        kind: "workflow",
        anchors: [{ path: "src/workflow.ts", lineStart: 4, lineEnd: 12 }],
      }],
      userQuestions: ["How does the audited workflow run?"],
    }],
  });
}

function observation(): RepositoryKnowledgeEvaluationRun {
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: "audited-project",
    repository: "example/audited-project",
    commitSha: "a".repeat(40),
    refreshRunId: "refresh-1",
    items: [
      {
        id: "fact-1",
        kind: "fact",
        text: "A saved Fact.",
        summary: null,
        claimState: "implemented",
        domain: "workflow",
        evidence: [],
      },
      {
        id: "highlight-1",
        kind: "highlight",
        text: "A saved Highlight.",
        summary: "A useful summary.",
        claimState: "implemented",
        domain: "workflow",
        evidence: [{
          path: "src/workflow.ts",
          lineStart: 4,
          lineEnd: 12,
          quote: "export function runWorkflow() {}",
        }],
      },
    ],
    domains: [],
    discoveredCapabilities: [],
    inventory: {
      scannableFiles: 2,
      analyzedFiles: 1,
      semanticEligibleFiles: 1,
      semanticAnalyzedFiles: 1,
      semanticAnalyzedPaths: ["src/workflow.ts"],
    },
    coverage: { static: 0.5, semantic: 1, knowledge: 1 },
    performance: {
      durationMs: 1_000,
      modelCalls: 2,
      totalTokens: 3_000,
      estimatedCostUsd: 0.01,
    },
    executionIntegrity: {
      passed: true,
      issues: [],
      modelIdentities: ["semantic_extraction:openrouter:model"],
      policyVersions: ["policy=v1"],
    },
  };
}

function liveRun() {
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
      allowedInertUntrackedPaths: [".agents/local.md", "skills-lock.json"],
    },
    fixtures: [{
      id: "audited-project",
      repository: "example/audited-project",
      snapshotCommit: "a".repeat(40),
    }],
    results: [{
      fixtureId: "audited-project",
      repository: "example/audited-project",
      workItemId: "work-item-1",
      refreshRunId: "refresh-1",
      status: "completed",
      mainPathIntegrity: { passed: true, issues: [] },
    }],
  };
}

describe("repository source-audit adjudication packets", () => {
  it("exports complete source truth, saved outputs, exact evidence, and blank templates", () => {
    const manifest = fixture();
    const repository = sourceAuditRepository(manifest, "audited-project");
    const packet = buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: observation(),
      workItemId: "work-item-1",
      liveRun: liveRun(),
    });

    expect(packet).toMatchObject({
      schemaVersion: "repository-source-audit-adjudication-packet-v1",
      workItemId: "work-item-1",
      sourceAudit: {
        fixtureId: "audited-project",
        knowledgeUnits: [{ id: "audited.workflow" }],
        userQuestions: ["How does the audited workflow run?"],
      },
      observation: {
        adjudicationEligible: true,
        savedOutputCounts: {
          highlights: 1,
          facts: 1,
          total: 2,
          evidenceReferences: 1,
          exactRangeAndQuoteReferences: 1,
          outputsWithoutEvidence: 1,
        },
        savedOutputs: [
          { id: "fact-1", kind: "fact", evidence: [] },
          {
            id: "highlight-1",
            kind: "highlight",
            evidence: [{
              path: "src/workflow.ts",
              lineStart: 4,
              lineEnd: 12,
              hasExactRangeAndQuote: true,
            }],
          },
        ],
      },
      adjudicationTemplate: {
        unitAdjudications: [{
          unitId: "audited.workflow",
          knowledgeCoverage: null,
        }],
        highlightAdjudications: [{
          highlightId: "highlight-1",
          salience: null,
        }],
        questionAdjudications: [{
          question: "How does the audited workflow run?",
          answerability: null,
        }],
      },
    });
  });

  it("supports any manifest fixture without a legacy repository fixture", () => {
    const manifest = fixture();
    expect(sourceAuditRepository(manifest, "audited-project")).toMatchObject({
      fixtureId: "audited-project",
      repository: "example/audited-project",
    });
    expect(() => sourceAuditRepository(manifest, "legacy-only-name"))
      .toThrow(/Unknown repository source-audit fixture/u);
  });

  it("rejects mismatched provenance and duplicate saved outputs", () => {
    const manifest = fixture();
    const repository = sourceAuditRepository(manifest, "audited-project");
    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: { ...observation(), commitSha: "c".repeat(40) },
      workItemId: "work-item-1",
    })).toThrow(/Observation identity does not match/u);
    const duplicate = observation();
    duplicate.items.push({ ...duplicate.items[0]! });
    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: duplicate,
      workItemId: "work-item-1",
    })).toThrow(/duplicate saved output ids/u);

    const reassignedAnchor = structuredClone(repository);
    reassignedAnchor.knowledgeUnits[0]!.anchors[0]!.lineStart = 5;
    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository: reassignedAnchor,
      observation: observation(),
      workItemId: "work-item-1",
      liveRun: liveRun(),
    })).toThrow(/does not match the supplied frozen manifest/u);
  });

  it("binds current packets to one exact completed live result", () => {
    const manifest = fixture();
    const repository = sourceAuditRepository(manifest, "audited-project");
    const packet = buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: observation(),
      workItemId: "work-item-1",
      liveRun: liveRun(),
    });
    expect(packet.liveRunProvenance).toMatchObject({
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      implementation: {
        commitSha: "c".repeat(40),
        branch: "feature/candidate",
        allowedInertUntrackedPaths: [".agents/local.md", "skills-lock.json"],
      },
      fixture: {
        workItemId: "work-item-1",
        refreshRunId: "refresh-1",
      },
    });

    const wrongRefresh = structuredClone(liveRun());
    wrongRefresh.results[0]!.refreshRunId = "refresh-2";
    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: observation(),
      workItemId: "work-item-1",
      liveRun: wrongRefresh,
    })).toThrow(/does not exactly match/u);

    const executableUntrackedInput = structuredClone(liveRun());
    executableUntrackedInput.implementation.allowedInertUntrackedPaths = [
      "src/untracked-runtime.ts",
    ];
    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: observation(),
      workItemId: "work-item-1",
      liveRun: executableUntrackedInput,
    })).toThrow(/non-allowlisted/u);

    expect(() => buildRepositorySourceAuditAdjudicationPacket({
      manifest,
      repository,
      observation: observation(),
      workItemId: "work-item-1",
    })).toThrow(/require a saved live-run artifact/u);
  });

  it("parses bound export and non-overwriting output paths", () => {
    expect(parseRepositorySourceAuditExportOptions([
      "--fixture", "audited-project",
      "--work-item=work-item-1",
      "--live-run", "live.json",
      "--output=packet.json",
      "--compact",
    ])).toEqual({
      compact: true,
      fixtureId: "audited-project",
      help: false,
      liveRunPath: resolve("live.json"),
      outputPath: resolve("packet.json"),
      workItemId: "work-item-1",
    });
  });
});
