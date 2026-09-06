import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agenticSemanticCoverageFromAttestations,
  modelCallsFromGenerationTelemetry,
  observedRepositoryKnowledgeClaimState,
  repositoryGenerationModelCalls,
  repositoryGenerationRunsForRefresh,
  repositoryGenerationUsageTotals,
  repositoryLimitationPersistenceIssues,
  semanticCoverageFromOrchestration,
} from "@/src/evals/repository-knowledge-database-observation";

const attempt = (requestId: string) => ({
  requestId,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
});

function verifierDigest(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function databaseTwoPhaseVerifierFixture(input: {
  sourceId: string;
  repository: string;
  commitSha: string;
  snapshotScopeDigest: string;
  notebookDigest: string;
  readSet: Array<Record<string, unknown>>;
}) {
  const exactRead = input.readSet[0]!;
  const discovery = {
    evidenceId: "verifier-discovery",
    command: "grep",
    args: ["durable"],
    operationKind: "discovery",
    outputHash: "8".repeat(64),
  };
  const exactReadTraces = input.readSet.map((entry) => ({
    evidenceId: entry.evidenceId,
    command: "show",
    args: [`HEAD:${String(entry.path)}`],
    operationKind: "exact_blob_read",
    outputHash: entry.outputHash,
  }));
  const sourceInspection = {
    sourceSearchTrace: [discovery, ...exactReadTraces],
    readSet: input.readSet,
  };
  const independentObservations = [{
    kind: "operation",
    statement: "The durable implementation performs the repository operation.",
    evidence: {
      evidenceId: exactRead.evidenceId,
      lineStart: exactRead.lineStart,
      lineEnd: exactRead.lineEnd,
    },
  }];
  const checkpointPayload = {
    schemaVersion: "repository-verifier-independent-review-v1",
    sourceId: input.sourceId,
    repository: input.repository,
    commitSha: input.commitSha,
    snapshotScopeDigest: input.snapshotScopeDigest,
    sourceInspection,
    sourceInspectionDigest: verifierDigest(sourceInspection),
    independentObservations,
    independentObservationDigest: verifierDigest(independentObservations),
    inspectionToolCalls: 1 + exactReadTraces.length,
  };
  const checkpoint = {
    ...checkpointPayload,
    checkpointDigest: verifierDigest(checkpointPayload),
  };
  const independentReview = {
    id: "independent-review-1",
    kind: "coverage_audit",
    status: "success",
    inputSummary: {
      phase: "repository_independent_review",
      sourceId: input.sourceId,
      repository: input.repository,
      commitSha: input.commitSha,
      snapshotScopeDigest: input.snapshotScopeDigest,
      candidateAvailable: false,
    },
    parsedOutput: checkpoint,
    resultRefs: {
      resultAttestation: {
        executionMode: "agentic_investigator_verifier_independent_review",
        fallbackUsed: false,
        snapshotScopeDigest: input.snapshotScopeDigest,
        checkpointDigest: checkpoint.checkpointDigest,
        sourceInspectionDigest: checkpoint.sourceInspectionDigest,
      },
    },
  };
  const observationDigest = verifierDigest(independentObservations[0]);
  const audit = {
    status: "satisfied",
    capabilityChecks: [{
      capabilityKey: "project_domain:core",
      findingId: "F1",
      verdict: "supported",
      reason: "The representative operation is supported by this exact range.",
      evidence: {
        evidenceId: exactRead.evidenceId,
        lineStart: exactRead.lineStart,
        lineEnd: exactRead.lineEnd,
      },
    }],
    independentObservationChecks: [{
      observationDigest,
      verdict: "covered_by_candidate",
      reason: "The candidate covers the independently observed operation.",
      matchedFindingIds: ["F1"],
      missingOperationId: "",
      evidence: {
        evidenceId: exactRead.evidenceId,
        lineStart: exactRead.lineStart,
        lineEnd: exactRead.lineEnd,
      },
    }],
    missingOperations: [],
    rationale: "The representative operation is covered.",
  };
  const preDisclosureInspection = {
    sourceSearchTrace: [discovery],
    readSet: input.readSet,
  };
  const candidateDisclosure = {
    inspectionToolCallsAtReveal: checkpoint.inspectionToolCalls,
    preDisclosureDiscoveryEvidenceIds: [discovery.evidenceId],
    preDisclosureExactReadEvidenceIds: input.readSet.map((entry) =>
      String(entry.evidenceId)
    ),
    preDisclosureAttestationDigest: verifierDigest(preDisclosureInspection),
    independentObservations,
    independentObservationDigest: checkpoint.independentObservationDigest,
  };
  const auditDigest = verifierDigest(audit);
  const candidateAudit = {
    id: "verifier-1",
    kind: "coverage_audit",
    status: "success",
    inputSummary: {
      phase: "repository_candidate_coverage_audit",
      sourceId: input.sourceId,
      repository: input.repository,
      commitSha: input.commitSha,
      snapshotScopeDigest: input.snapshotScopeDigest,
      independentReviewGenerationRunId: independentReview.id,
      independentReviewCheckpointDigest: checkpoint.checkpointDigest,
      notebookDigest: input.notebookDigest,
      verifierToolPolicy: {
        durableBlindReview: true,
        representativeCheck: true,
      },
    },
    parsedOutput: audit,
    resultRefs: {
      resultAttestation: {
        executionMode: "agentic_investigator_verifier",
        fallbackUsed: false,
        terminationReason: "verifier_complete",
        snapshotScopeDigest: input.snapshotScopeDigest,
        notebookDigest: input.notebookDigest,
        auditDigest,
        independentReviewGenerationRunId: independentReview.id,
        independentReviewCheckpointDigest: checkpoint.checkpointDigest,
        preDisclosureSourceInspectionDigest: checkpoint.sourceInspectionDigest,
        preDisclosureSourceInspection: sourceInspection,
        candidateDisclosure,
        postDisclosureSourceInspectionDigest: verifierDigest(sourceInspection),
        toolTrace: sourceInspection.sourceSearchTrace,
        readSet: input.readSet,
      },
    },
  };
  return {
    independentReview,
    candidateAudit,
    auditDigest,
    checkpoint,
  };
}

describe("repository knowledge claim-state observation", () => {
  const metadata = (implementationStates: string[]) => ({
    schemaVersion: "repository-knowledge-metadata-v1",
    managedBy: "repository_knowledge_sync",
    refreshRunId: "refresh-1",
    subsystemKey: "project_domain:core",
    synthesisKey: "project_domain:core#operation-start",
    knowledgeRoles: ["implementation"],
    implementationStates,
    operationKeys: ["start"],
    operationFacets: ["entrypoint"],
  });

  it.each(["implemented", "partial", "planned", "bounded_absence"])(
    "retains the exact %s state",
    (state) => {
      expect(observedRepositoryKnowledgeClaimState(metadata([state]))).toBe(state);
    },
  );

  it("reports legacy, malformed, and mixed state as unknown", () => {
    expect(observedRepositoryKnowledgeClaimState({
      managedBy: "repository_knowledge_sync",
      subsystemKey: "project_domain:core",
    })).toBe("unknown");
    expect(observedRepositoryKnowledgeClaimState(metadata([
      "implemented",
      "partial",
    ]))).toBe("unknown");
  });
});

describe("repository limitation persistence integrity", () => {
  const sourceId = "source-1";
  const commitSha = "a".repeat(40);
  const blobSha = "b".repeat(40);
  const statement = "The repository records contributions but does not transfer or settle money.";
  const files = [{
    path: "src/contributions.ts",
    blobSha,
    semanticStatus: "succeeded",
    semanticAnalysis: {
      facts: [{
        statement,
        lineStart: 10,
        lineEnd: 14,
        knowledgeRole: "limitation",
        semanticSignals: ["agentic investigation", "limitation"],
      }],
    },
  }];

  it("requires an exact durable Fact or an explicit source-critic rejection", () => {
    const base = {
      sourceId,
      repository: "owner/project",
      commitSha,
      files,
      facts: [],
      warnings: null,
    };
    expect(repositoryLimitationPersistenceIssues(base)).toEqual([
      expect.stringContaining("was neither persisted"),
    ]);
    expect(repositoryLimitationPersistenceIssues({
      ...base,
      facts: [{
        statement,
        evidence: [{
          evidenceItem: {
            sourceId,
            metadata: {
              path: "src/contributions.ts",
              startLine: 10,
              endLine: 14,
            },
          },
        }],
      }],
    })).toEqual([]);

    const identity = JSON.stringify([
      sourceId,
      commitSha,
      blobSha,
      "src/contributions.ts",
      10,
      14,
      statement.toLowerCase(),
    ]);
    const limitationDigest = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 16);
    expect(repositoryLimitationPersistenceIssues({
      ...base,
      warnings: {
        synthesisCoverageGaps: [
          `Repository owner/project could not preserve material limitation project_domain:payments#limitation-${limitationDigest}: rejected.`,
        ],
      },
    })).toEqual([]);
  });
});

describe("repository knowledge database performance telemetry", () => {
  it("sums complete metering and keeps a genuinely empty run at zero", () => {
    const generation = {
      tokenUsage: attempt("request-1"),
      resultRefs: { usageComplete: true },
      estimatedCostUsd: 0.01,
    };
    expect(repositoryGenerationUsageTotals([generation, generation])).toEqual({
      totalTokens: 240,
      estimatedCostUsd: 0.02,
    });
    expect(repositoryGenerationUsageTotals([])).toEqual({
      totalTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("does not report known partial totals as the full cost of an unmetered retry", () => {
    expect(repositoryGenerationUsageTotals([{
      tokenUsage: { ...attempt("successful-request"), unknownUsageAttempts: 1 },
      resultRefs: { usageComplete: false },
      estimatedCostUsd: 0.01,
    }])).toEqual({ totalTokens: null, estimatedCostUsd: null });
    expect(repositoryGenerationUsageTotals([{
      tokenUsage: null,
      resultRefs: null,
      estimatedCostUsd: null,
    }])).toEqual({ totalTokens: null, estimatedCostUsd: null });
  });

  it("keeps known tokens when only the charge is missing, and accepts an explicit zero charge", () => {
    const generation = {
      tokenUsage: attempt("request-1"),
      resultRefs: { usageComplete: true },
      estimatedCostUsd: null,
    };
    expect(repositoryGenerationUsageTotals([generation])).toEqual({
      totalTokens: 120,
      estimatedCostUsd: null,
    });
    expect(repositoryGenerationUsageTotals([{ ...generation, estimatedCostUsd: 0 }])).toEqual({
      totalTokens: 120,
      estimatedCostUsd: 0,
    });
  });

  it("binds certification runs to the selected refresh instead of its time window", () => {
    const selected = repositoryGenerationRunsForRefresh([
      { id: "planner", inputSummary: { refreshRunId: "refresh-1" } },
      { id: "semantic", inputSummary: { refreshRunId: "refresh-1", path: "src/core.ts" } },
      { id: "concurrent-chat", inputSummary: { route: "repository_research" } },
      { id: "other-refresh", inputSummary: { refreshRunId: "refresh-2" } },
      { id: "malformed", inputSummary: null },
    ], "refresh-1");

    expect(selected.map((run) => run.id)).toEqual(["planner", "semantic"]);
  });

  it("counts multiple provider attempts in one generation row once each", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2"), attempt("request-3")],
      providerAttemptCount: 3,
      unknownUsageAttempts: 0,
      budget: {
        modelCalls: 3,
        inputTokens: 300,
        outputTokens: 60,
        totalTokens: 360,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(3);
    expect(repositoryGenerationModelCalls([{ tokenUsage }])).toBe(3);
  });

  it("does not add nested attempt leaves to a matching budget counter", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2")],
      synthesisBudget: {
        modelCalls: 2,
        unknownUsageCalls: 0,
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(2);
  });

  it("sums distinct generation rows and uses cumulative refresh usage only as a floor", () => {
    const generationRuns = [
      { tokenUsage: { providerAttemptCount: 2, attempts: [attempt("a"), attempt("b")] } },
      { tokenUsage: { providerAttemptCount: 3, attempts: [attempt("c"), attempt("d"), attempt("e")] } },
      { tokenUsage: null },
    ];

    expect(repositoryGenerationModelCalls(generationRuns, {
      actual: { modelCalls: 5, unknownUsageCalls: 0 },
    })).toBe(5);
    expect(repositoryGenerationModelCalls([{ tokenUsage: null }], {
      actual: { modelCalls: 4, unknownUsageCalls: 1 },
    })).toBe(4);
  });

  it("counts unmetered dispatched attempts without inventing a call for empty rows", () => {
    expect(modelCallsFromGenerationTelemetry({
      attempts: [],
      unknownUsageAttempts: 2,
    })).toBe(2);
    expect(modelCallsFromGenerationTelemetry(null)).toBe(0);
  });

  it("measures semantic coverage against the persisted pre-selection universe", () => {
    const coverage = semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: {
          fileSnapshotIds: ["catalog", "forecast-python", "client", "quality"],
          fileCount: 4,
        },
      },
      files: [
        { id: "catalog", path: "src/model/Catalog.java", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "forecast-python", path: "ml_service/forecast_service.py", disposition: "analyzed", semanticStatus: "not_selected" },
        { id: "client", path: "src/service/ForecastClient.java", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "quality", path: "src/test/CatalogTest.java", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    });

    expect(coverage).toEqual({
      semanticCoverageBasis: "legacy_semantic_universe",
      semanticEligibleFiles: 4,
      semanticAnalyzedFiles: 2,
      semanticAnalyzedPaths: ["src/model/Catalog.java", "src/service/ForecastClient.java"],
      semanticCoverage: 0.5,
    });
  });

  it("rejects missing, duplicate, or snapshot-external semantic universe metadata", () => {
    const files = [{ id: "known", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" }];
    expect(() => semanticCoverageFromOrchestration({ orchestration: {}, files }))
      .toThrow(/missing its persisted semantic evidence universe/iu);
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["known", "known"], fileCount: 2 },
      },
      files,
    })).toThrow(/inconsistent persisted semantic evidence universe/iu);
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["unknown"], fileCount: 1 },
      },
      files,
    })).toThrow(/outside its immutable snapshot/iu);
  });

  it("rejects a self-reported universe that omits an eligible analyzed file", () => {
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["selected"], fileCount: 1 },
      },
      files: [
        { id: "selected", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "omitted", path: "src/worker.py", disposition: "analyzed", semanticStatus: "not_selected" },
        { id: "readme", path: "README.md", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    })).toThrow(/does not match the independently eligible snapshot files/iu);
  });

  it("uses the same cartography exclusions when independently checking the universe", () => {
    expect(semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["core"], fileCount: 1 },
      },
      files: [
        { id: "core", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "eval", path: "src/evals/harness.ts", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    })).toEqual(expect.objectContaining({
      semanticEligibleFiles: 1,
      semanticCoverage: 1,
    }));
  });

  it("derives agentic inspected, analyzed, and cited sets from exact independent attestations", () => {
    const sourceId = "source-1";
    const repository = "owner/project";
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const coreBlobSha = "c".repeat(40);
    const otherBlobSha = "d".repeat(40);
    const numberedExcerpt = "1: export const durable = true;";
    const excerpt = "export const durable = true;";
    const excerptHash = createHash("sha256").update(numberedExcerpt).digest("hex");
    const persistedExcerptHash = createHash("sha256").update(excerpt).digest("hex");
    const files = [
      {
        id: "core",
        path: "src/core.ts",
        blobSha: coreBlobSha,
        disposition: "analyzed",
        semanticStatus: "succeeded",
        semanticAnalysis: {
          facts: [{ lineStart: 1, lineEnd: 1, evidenceExcerpt: numberedExcerpt }],
        },
      },
      {
        id: "other",
        path: "src/other.ts",
        blobSha: otherBlobSha,
        disposition: "analyzed",
        semanticStatus: "not_selected",
        semanticAnalysis: null,
      },
    ];
    const snapshotScopeDigest = createHash("sha256").update(JSON.stringify({
      sourceId,
      repository,
      commitSha,
      treeSha,
      manifest: files
        .map((file) => [file.path, file.blobSha, file.disposition])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    })).digest("hex");
    const verifierInputNotebookDigest = "f".repeat(64);
    const readSet = [{
      evidenceId: "evidence-1",
      sourceId,
      repository,
      commitSha,
      path: "src/core.ts",
      blobSha: coreBlobSha,
      lineStart: 1,
      lineEnd: 1,
      excerptHash,
      outputHash: "e".repeat(64),
      evidenceVersion: "repository-evidence-v1",
      redactionPolicyVersion: "repository-redaction-v1",
    }];
    const verifierChain = databaseTwoPhaseVerifierFixture({
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      notebookDigest: verifierInputNotebookDigest,
      readSet,
    });

    const coverage = agenticSemanticCoverageFromAttestations({
      orchestration: {
        executionMode: "agentic_investigator",
        repositories: [{
          sourceId,
          repository,
          commitSha,
          snapshotScopeDigest,
          investigatorGenerationRunIds: ["investigator-1"],
          verifierIndependentReviewGenerationRunId:
            verifierChain.independentReview.id,
          verifierGenerationRunId: "verifier-1",
          verifierInputNotebookDigest,
          verifierDigest: verifierChain.auditDigest,
        }],
      },
      snapshot: { sourceId, repository, commitSha, treeSha, files },
      generationRuns: [
        {
          id: "investigator-1",
          kind: "semantic_extraction",
          resultRefs: {
            resultAttestation: {
              executionMode: "agentic_investigator",
              fallbackUsed: false,
              snapshotScopeDigest,
              readSet,
            },
          },
        },
        verifierChain.independentReview,
        verifierChain.candidateAudit,
      ],
      evidence: [{
        sourceId,
        content: excerpt,
        metadata: {
          commitSha,
          blobSha: coreBlobSha,
          path: "src/core.ts",
          startLine: 1,
          endLine: 1,
          excerptHash: persistedExcerptHash,
        },
      }],
    });

    expect(coverage).toEqual({
      semanticCoverageBasis: "agentic_snapshot_read_set",
      semanticEligibleFiles: 2,
      semanticInspectedFiles: 1,
      semanticVerifierInspectedFiles: 1,
      semanticAnalyzedFiles: 1,
      semanticCitedFiles: 1,
      semanticInspectedPaths: ["src/core.ts"],
      semanticVerifierInspectedPaths: ["src/core.ts"],
      semanticAnalyzedPaths: ["src/core.ts"],
      semanticCitedPaths: ["src/core.ts"],
      semanticCoverage: 0.5,
    });
  });

  it("retains exact planned documentation provenance without counting it as executable coverage", () => {
    const sourceId = "source-1";
    const repository = "owner/project";
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const coreBlobSha = "c".repeat(40);
    const readmeBlobSha = "d".repeat(40);
    const coreNumberedExcerpt = "1: export const durable = true;";
    const readmeNumberedExcerpt = "1: Planned: add cross-region failover.";
    const readmeExcerpt = "Planned: add cross-region failover.";
    const files = [
      {
        id: "core",
        path: "src/core.ts",
        blobSha: coreBlobSha,
        disposition: "analyzed",
        semanticStatus: "succeeded",
        semanticAnalysis: {
          facts: [{
            lineStart: 1,
            lineEnd: 1,
            evidenceExcerpt: coreNumberedExcerpt,
            implementationState: "implemented",
          }],
        },
      },
      {
        id: "readme",
        path: "README.md",
        blobSha: readmeBlobSha,
        // Supplemental documentation may be inspected and durably retained
        // without joining the production-code coverage denominator.
        disposition: "excluded",
        semanticStatus: "succeeded",
        semanticAnalysis: {
          facts: [{
            lineStart: 1,
            lineEnd: 1,
            evidenceExcerpt: readmeNumberedExcerpt,
            knowledgeRole: "limitation",
            implementationState: "planned",
          }],
        },
      },
    ];
    const snapshotScopeDigest = createHash("sha256").update(JSON.stringify({
      sourceId,
      repository,
      commitSha,
      treeSha,
      manifest: files
        .map((file) => [file.path, file.blobSha, file.disposition])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    })).digest("hex");
    const verifierInputNotebookDigest = "f".repeat(64);
    const readSet = [
      {
        evidenceId: "evidence-core",
        sourceId,
        repository,
        commitSha,
        path: "src/core.ts",
        blobSha: coreBlobSha,
        lineStart: 1,
        lineEnd: 1,
        excerptHash: verifierDigest(coreNumberedExcerpt),
        outputHash: "e".repeat(64),
        evidenceVersion: "repository-evidence-v1",
        redactionPolicyVersion: "repository-redaction-v1",
      },
      {
        evidenceId: "evidence-readme",
        sourceId,
        repository,
        commitSha,
        path: "README.md",
        blobSha: readmeBlobSha,
        lineStart: 1,
        lineEnd: 1,
        excerptHash: verifierDigest(readmeNumberedExcerpt),
        outputHash: "9".repeat(64),
        evidenceVersion: "repository-evidence-v1",
        redactionPolicyVersion: "repository-redaction-v1",
      },
    ];
    const verifierChain = databaseTwoPhaseVerifierFixture({
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      notebookDigest: verifierInputNotebookDigest,
      readSet,
    });

    const coverage = agenticSemanticCoverageFromAttestations({
      orchestration: {
        executionMode: "agentic_investigator",
        repositories: [{
          sourceId,
          repository,
          commitSha,
          snapshotScopeDigest,
          investigatorGenerationRunIds: ["investigator-1"],
          verifierIndependentReviewGenerationRunId:
            verifierChain.independentReview.id,
          verifierGenerationRunId: verifierChain.candidateAudit.id,
          verifierInputNotebookDigest,
          verifierDigest: verifierChain.auditDigest,
        }],
      },
      snapshot: { sourceId, repository, commitSha, treeSha, files },
      generationRuns: [
        {
          id: "investigator-1",
          kind: "semantic_extraction",
          resultRefs: {
            resultAttestation: {
              executionMode: "agentic_investigator",
              fallbackUsed: false,
              snapshotScopeDigest,
              readSet,
            },
          },
        },
        verifierChain.independentReview,
        verifierChain.candidateAudit,
      ],
      evidence: [{
        sourceId,
        content: readmeExcerpt,
        metadata: {
          commitSha,
          blobSha: readmeBlobSha,
          path: "README.md",
          startLine: 1,
          endLine: 1,
          excerptHash: verifierDigest(readmeExcerpt),
        },
      }],
    });

    expect(coverage).toEqual(expect.objectContaining({
      semanticEligibleFiles: 1,
      semanticInspectedFiles: 2,
      semanticVerifierInspectedFiles: 2,
      semanticAnalyzedFiles: 2,
      semanticCitedFiles: 1,
      semanticAnalyzedPaths: ["README.md", "src/core.ts"],
      semanticCitedPaths: ["README.md"],
      semanticCoverage: 1,
    }));
    expect(coverage.semanticCoverage).toBeLessThanOrEqual(1);
  });

  it("fails closed when agentic scope, read-set, or current citation evidence is not exact", () => {
    const sourceId = "source-1";
    const repository = "owner/project";
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const blobSha = "c".repeat(40);
    const numberedExcerpt = "1: export const durable = true;";
    const content = "export const durable = true;";
    const excerptHash = createHash("sha256").update(numberedExcerpt).digest("hex");
    const persistedExcerptHash = createHash("sha256").update(content).digest("hex");
    const files = [{
      id: "core",
      path: "src/core.ts",
      blobSha,
      disposition: "analyzed",
      semanticStatus: "succeeded",
      semanticAnalysis: {
        facts: [{ lineStart: 1, lineEnd: 1, evidenceExcerpt: numberedExcerpt }],
      },
    }];
    const snapshotScopeDigest = createHash("sha256").update(JSON.stringify({
      sourceId,
      repository,
      commitSha,
      treeSha,
      manifest: [["src/core.ts", blobSha, "analyzed"]],
    })).digest("hex");
    const verifierInputNotebookDigest = "f".repeat(64);
    const readSet = [{
      evidenceId: "evidence-1",
      sourceId,
      repository,
      commitSha,
      path: "src/core.ts",
      blobSha,
      lineStart: 1,
      lineEnd: 1,
      excerptHash,
      outputHash: "e".repeat(64),
      evidenceVersion: "repository-evidence-v1",
      redactionPolicyVersion: "repository-redaction-v1",
    }];
    const verifierChain = databaseTwoPhaseVerifierFixture({
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      notebookDigest: verifierInputNotebookDigest,
      readSet,
    });
    const base = {
      orchestration: {
        executionMode: "agentic_investigator",
        repositories: [{
          sourceId,
          repository,
          commitSha,
          snapshotScopeDigest,
          investigatorGenerationRunIds: ["investigator-1"],
          verifierIndependentReviewGenerationRunId:
            verifierChain.independentReview.id,
          verifierGenerationRunId: "verifier-1",
          verifierInputNotebookDigest,
          verifierDigest: verifierChain.auditDigest,
        }],
      },
      snapshot: { sourceId, repository, commitSha, treeSha, files },
      generationRuns: [
        {
          id: "investigator-1",
          kind: "semantic_extraction",
          resultRefs: {
            resultAttestation: {
              executionMode: "agentic_investigator",
              fallbackUsed: false,
              snapshotScopeDigest,
              readSet,
            },
          },
        },
        verifierChain.independentReview,
        verifierChain.candidateAudit,
      ],
      evidence: [{
        sourceId,
        content,
        metadata: {
          commitSha,
          blobSha,
          path: "src/core.ts",
          startLine: 1,
          endLine: 1,
          excerptHash: persistedExcerptHash,
        },
      }],
    };

    expect(() => agenticSemanticCoverageFromAttestations({
      ...base,
      orchestration: {
        ...base.orchestration,
        repositories: [{
          ...base.orchestration.repositories[0],
          snapshotScopeDigest: "f".repeat(64),
        }],
      },
    })).toThrow(/exact persisted manifest/iu);
    expect(() => agenticSemanticCoverageFromAttestations({
      ...base,
      generationRuns: [
        {
          ...base.generationRuns[0],
          resultRefs: {
            resultAttestation: {
              ...base.generationRuns[0].resultRefs.resultAttestation,
              readSet: [{ ...readSet[0], blobSha: "f".repeat(40) }],
            },
          },
        },
        ...base.generationRuns.slice(1),
      ],
    })).toThrow(/read-set entry/iu);
    expect(() => agenticSemanticCoverageFromAttestations({
      ...base,
      evidence: [{
        ...base.evidence[0],
        content: "tampered",
      }],
    })).toThrow(/exact attested read-set/iu);
  });
});
