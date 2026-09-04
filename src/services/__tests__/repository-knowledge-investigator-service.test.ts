import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectRepositoryRawEvidence,
} from "@/src/services/project-chat-repository-evidence-service";
import {
  applyRepositoryInvestigationNotebookUpdate,
  buildRepositoryVerifierIndependentReviewCheckpoint,
  buildCompactRepositoryInvestigationMap,
  buildRepositoryInvestigationCheckpoint,
  buildRepositorySourceInspectionAttestation,
  buildRepositoryInvestigationTerminalState,
  compactRepositoryInvestigationNotebook,
  candidateCoverageAuditRequest,
  independentCoverageReviewRequest,
  mergeRepositorySourceInspectionAttestations,
  prioritizedRepositoryInvestigationGaps,
  REPOSITORY_INVESTIGATION_CHECKPOINT_VERSION,
  REPOSITORY_KNOWLEDGE_INVESTIGATOR_VERSION,
  REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
  REPOSITORY_VERIFIER_MAX_OBSERVATIONS,
  REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
  RepositoryInvestigationSharedBudget,
  repositoryCoverageCandidatePacket,
  repositoryCoverageVerifierLimits,
  repositoryCoverageVerificationTargets,
  repositoryImplementationBreadthByCapability,
  repositoryInvestigationConvergenceSignature,
  repositoryInvestigationFindingAnalysisMetadata,
  repositoryInvestigationFindingKnowledgeRole,
  repositoryInvestigationFindingSemanticSignals,
  repositoryInvestigationBoundaryReviewGuidance,
  repositoryInvestigationHasMaterialProgress,
  repositoryInvestigationMaterialityGuidance,
  repositoryInvestigationNotebookWithoutTransientCapacityAreas,
  repositoryInvestigationPhaseInspectionAction,
  repositoryInvestigationSemanticModelTokenCount,
  repositoryInvestigationSharedBudgetLimits,
  repositorySourceInspectionAttestationFromNotebook,
  repositoryUnsupportedFindingRepairGaps,
  repositoryVerifierIndependentDiscoveryGate,
  repositoryVerifierIndependentNextAction,
  repositoryVerifierIndependentObservationDigest,
  repositoryVerifierNextAction,
  restoreRepositoryInvestigationCheckpoint,
  runRepositoryVerificationIfCandidate,
  validateRepositoryVerifierCandidateDisclosure,
  validateRepositoryVerifierIndependentReviewCheckpoint,
  validateRepositoryCoverageAuditContract,
  type RepositoryInvestigationNotebook,
} from "@/src/services/repository-knowledge-investigator-service";

const commitSha = "a".repeat(40);
const blobSha = "b".repeat(40);

function investigationState(input?: {
  path?: string;
  args?: string[];
  sourceId?: string;
  repository?: string;
  output?: string;
}) {
  const path = input?.path ?? "src/session.ts";
  const sourceId = input?.sourceId ?? "source-1";
  const repository = input?.repository ?? "owner/project";
  const output = input?.output ?? [
    "export async function createSession(userId: string) {",
    "  const session = await database.session.create({ data: { userId } });",
    "  return session;",
    "}",
  ].join("\n");
  const evidence = createProjectRepositoryRawEvidence({
    sourceId,
    repository,
    commitSha,
    args: input?.args ?? ["show", `HEAD:${path}`],
    output,
    target: { kind: "blob", commitSha, path, blobSha },
  });
  const notebook: RepositoryInvestigationNotebook = {
    schemaVersion: REPOSITORY_KNOWLEDGE_INVESTIGATOR_VERSION,
    sourceId: "source-1",
    repository: "owner/project",
    commitSha,
    capabilities: [],
    findings: [],
    unresolvedAreas: [],
    done: false,
  };
  return {
    evidence,
    state: {
      notebook,
      evidenceById: new Map([[evidence.evidenceId, evidence]]),
      visibleEvidenceRanges: [{
        evidenceId: evidence.evidenceId,
        startLine: 1,
        endLine: evidence.totalLines,
      }],
      filesByPath: new Map([[path, {
        id: "file-1",
        path,
        blobSha,
        sizeBytes: Buffer.byteLength(output),
        disposition: "analyzed",
        analysis: null,
      }]]),
    },
  };
}

function notebookUpdate(evidenceId: string) {
  return {
    removeCapabilityKeys: [],
    removeFindingIds: [],
    capabilities: [{
      key: "project_domain:session_management",
      label: "Session management",
      description: "Creates and persists authenticated user sessions.",
      centrality: "major" as const,
    }],
    findings: [{
      id: "creates_persisted_sessions",
      operationKey: "session_creation",
      implementationState: "implemented" as const,
      facet: "persistence" as const,
      statement: "The application persists a session record for an authenticated user.",
      kind: "user_capability" as const,
      capabilityKeys: ["project_domain:session_management"],
      confidence: "high" as const,
      sensitivityFlag: false,
      evidence: [{ evidenceId, lineStart: 1, lineEnd: 4 }],
    }],
    unresolvedAreas: [],
    done: true,
  };
}

function verifierFixture() {
  const { state, evidence } = investigationState();
  const result = applyRepositoryInvestigationNotebookUpdate({
    state,
    update: notebookUpdate(evidence.evidenceId),
  });
  if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
  const target = {
    sourceId: result.notebook.sourceId,
    repository: result.notebook.repository,
    commitSha: result.notebook.commitSha,
  };
  const discovery = createProjectRepositoryRawEvidence({
    sourceId: target.sourceId,
    repository: target.repository,
    commitSha: target.commitSha,
    args: ["ls-tree", "-r", "--name-only", "HEAD"],
    output: "src/session.ts",
    target: { kind: "commit", commitSha: target.commitSha },
    exitCode: 0,
  });
  const sourceInspection = buildRepositorySourceInspectionAttestation({
    evidence: [evidence, discovery],
    visibleRanges: state.visibleEvidenceRanges,
  });
  const independentObservations = [{
    kind: "operation" as const,
    statement: "The implementation creates and persists an authenticated session record.",
    evidence: {
      evidenceId: evidence.evidenceId,
      lineStart: 1,
      lineEnd: 4,
    },
  }];
  const snapshotScopeDigest = "c".repeat(64);
  const checkpoint = buildRepositoryVerifierIndependentReviewCheckpoint({
    target,
    snapshotScopeDigest,
    sourceInspection,
    independentObservations,
    inspectionToolCalls: 2,
  });
  return {
    checkpoint,
    discovery,
    evidence,
    files: Array.from(state.filesByPath.values()),
    independentObservations,
    notebook: result.notebook,
    snapshotScopeDigest,
    sourceInspection,
    target,
  };
}

describe("repository knowledge investigator", () => {
  it("defines completion around material operations rather than exhaustive surfaces", () => {
    expect(repositoryInvestigationMaterialityGuidance).toContain(
      "not an inventory of every uninspected surface",
    );
    expect(repositoryInvestigationMaterialityGuidance).toContain(
      "not exhaustive file, route, or interface coverage",
    );
    expect(repositoryInvestigationMaterialityGuidance).toContain(
      "bounded positive constraint",
    );
  });

  it("uses a repository-general contrastive boundary review", () => {
    expect(repositoryInvestigationBoundaryReviewGuidance).toContain(
      "contrastive boundary pass",
    );
    expect(repositoryInvestigationBoundaryReviewGuidance).toContain(
      "concrete mutators or external side effects",
    );
    expect(repositoryInvestigationBoundaryReviewGuidance).not.toMatch(
      /circle|loan|membership|payment|workbase/iu,
    );
  });

  it("budgets the delayed-disclosure verifier for its required source walk", () => {
    expect(repositoryCoverageVerifierLimits(77)).toEqual({
      maxIterations: 12,
      maxToolCalls: 10,
      maxTotalTokens: 170_000,
    });
    expect(repositoryCoverageVerifierLimits(251).maxTotalTokens).toBe(360_000);
  });

  it("accepts only a visible exact pinned production-source range", () => {
    const { state, evidence } = investigationState();

    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    expect(result.notebook.findings[0]?.evidence[0]).toMatchObject({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      fileSnapshotId: "file-1",
      path: "src/session.ts",
      blobSha,
      lineStart: 1,
      lineEnd: 4,
    });
    expect(result.notebook.findings[0]?.evidence[0]?.excerpt).toContain(
      "database.session.create",
    );
  });

  it("rejects bare generic operation keys before they can conflate domains", () => {
    for (const operationKey of ["create", "update", "delete"]) {
      const { state, evidence } = investigationState();
      const original = notebookUpdate(evidence.evidenceId);
      const result = applyRepositoryInvestigationNotebookUpdate({
        state,
        update: {
          ...original,
          findings: [{ ...original.findings[0]!, operationKey }],
        },
      });

      expect(result).toMatchObject({ accepted: false });
      if (result.accepted) {
        throw new Error(`Expected generic operation key ${operationKey} to be rejected.`);
      }
      expect(result.errors.join(" ")).toContain(
        `operationKey ${operationKey} is too generic`,
      );
    }

    const qualified = investigationState();
    expect(applyRepositoryInvestigationNotebookUpdate({
      state: qualified.state,
      update: notebookUpdate(qualified.evidence.evidenceId),
    })).toMatchObject({ accepted: true });
  });

  it("requires an explicit atomic removal before a finding ID changes operations", () => {
    const { state, evidence } = investigationState();
    const initial = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!initial.accepted) throw new Error("Expected the initial notebook update to succeed.");
    const original = notebookUpdate(evidence.evidenceId);
    const replacement = {
      ...original,
      findings: [{
        ...original.findings[0]!,
        operationKey: "session_revocation",
      }],
    };

    const implicit = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: replacement,
    });
    expect(implicit).toMatchObject({ accepted: false });
    if (implicit.accepted) {
      throw new Error("Expected implicit operation identity replacement to fail.");
    }
    expect(implicit.errors.join(" ")).toContain(
      "requires explicitly removing that finding ID",
    );

    const explicit = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: {
        ...replacement,
        removeFindingIds: ["creates_persisted_sessions"],
      },
    });
    expect(explicit).toMatchObject({ accepted: true });
    if (!explicit.accepted) {
      throw new Error("Expected explicit atomic operation identity replacement to succeed.");
    }
    expect(explicit.notebook.findings[0]?.operationKey).toBe(
      "session_revocation",
    );
  });

  it("allows explicit future-facing documentation only for planned findings", () => {
    const planned = investigationState({
      path: "ROADMAP.md",
      output: [
        "# Roadmap",
        "## Planned identity work",
        "We will add organization-scoped single sign-on.",
      ].join("\n"),
    });
    planned.state.filesByPath.get("ROADMAP.md")!.disposition = "excluded";
    const original = notebookUpdate(planned.evidence.evidenceId);
    const update = {
      ...original,
      findings: [{
        ...original.findings[0]!,
        operationKey: "organization_sso",
        implementationState: "planned" as const,
        facet: "boundary" as const,
        statement:
          "The roadmap explicitly plans organization-scoped single sign-on.",
        evidence: [{
          evidenceId: planned.evidence.evidenceId,
          lineStart: 2,
          lineEnd: 3,
        }],
      }],
    };

    const accepted = applyRepositoryInvestigationNotebookUpdate({
      state: planned.state,
      update,
    });

    expect(accepted).toMatchObject({ accepted: true });
    if (!accepted.accepted) throw new Error("Expected planned documentation to be accepted.");
    expect(accepted.notebook.findings[0]).toMatchObject({
      operationKey: "organization_sso",
      implementationState: "planned",
      facet: "boundary",
      evidence: [{ path: "ROADMAP.md", lineStart: 2, lineEnd: 3 }],
    });

    for (const implementationState of [
      "implemented",
      "partial",
      "bounded_absence",
    ] as const) {
      const next = investigationState({
        path: "ROADMAP.md",
        output: planned.evidence.output,
      });
      next.state.filesByPath.get("ROADMAP.md")!.disposition = "excluded";
      const invalidOriginal = notebookUpdate(next.evidence.evidenceId);
      const invalid = {
        ...invalidOriginal,
        findings: [{
          ...update.findings[0]!,
          implementationState,
          evidence: [{
            evidenceId: next.evidence.evidenceId,
            lineStart: 2,
            lineEnd: 3,
          }],
        }],
      };
      const rejected = applyRepositoryInvestigationNotebookUpdate({
        state: next.state,
        update: invalid,
      });
      expect(rejected).toMatchObject({ accepted: false });
      if (rejected.accepted) {
        throw new Error(`Expected ${implementationState} documentation to be rejected.`);
      }
      expect(rejected.errors.join(" ")).toContain(
        "valid only for a finding whose implementationState is planned",
      );
    }
  });

  it("requires production source to explicitly establish a planned state", () => {
    const current = investigationState();
    const original = notebookUpdate(current.evidence.evidenceId);
    const plannedCurrentBehavior = applyRepositoryInvestigationNotebookUpdate({
      state: current.state,
      update: {
        ...original,
        findings: [{
          ...original.findings[0]!,
          implementationState: "planned",
        }],
      },
    });
    expect(plannedCurrentBehavior).toMatchObject({ accepted: false });
    if (plannedCurrentBehavior.accepted) {
      throw new Error("Expected current implementation source to be rejected as planned.");
    }
    expect(plannedCurrentBehavior.errors.join(" ")).toContain(
      "does not explicitly establish future intent",
    );

    const future = investigationState({
      output: [
        "// TODO: support remote session revocation.",
        "export const sessionRevocationPlanned = true;",
      ].join("\n"),
    });
    const futureOriginal = notebookUpdate(future.evidence.evidenceId);
    const futureUpdate = {
      ...futureOriginal,
      findings: [{
        ...futureOriginal.findings[0]!,
        operationKey: "session_revocation",
        implementationState: "planned" as const,
        facet: "boundary" as const,
        kind: "limitation" as const,
        statement: "The implementation explicitly leaves remote session revocation as future work.",
        evidence: [{
          evidenceId: future.evidence.evidenceId,
          lineStart: 1,
          lineEnd: 2,
        }],
      }],
    };
    expect(applyRepositoryInvestigationNotebookUpdate({
      state: future.state,
      update: futureUpdate,
    })).toMatchObject({ accepted: true });
  });

  it("preserves every numbered source line in a broad exact citation without elision", () => {
    const output = Array.from({ length: 80 }, (_, index) =>
      `export const operation${index + 1} = () => persistTransition(${index + 1});`
    ).join("\n");
    const { state, evidence } = investigationState({ output });
    const update = notebookUpdate(evidence.evidenceId);
    update.findings[0]!.evidence[0]!.lineEnd = 80;

    const result = applyRepositoryInvestigationNotebookUpdate({ state, update });

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) throw new Error("Expected the broad exact range to be accepted.");
    const excerpt = result.notebook.findings[0]!.evidence[0]!.excerpt;
    expect(excerpt.length).toBeGreaterThan(1_600);
    expect(excerpt).not.toContain("cited lines omitted");
    expect(excerpt.split("\n")).toHaveLength(80);
    expect(excerpt).toContain("1: export const operation1");
    expect(excerpt).toContain("80: export const operation80");
  });

  it("rejects an elided durable evidence excerpt before checkpoint persistence", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const malformedNotebook = structuredClone(result.notebook);
    malformedNotebook.findings[0]!.evidence[0]!.excerpt = [
      "1: export async function createSession(userId: string) {",
      "[... cited lines omitted ...]",
      "4: }",
    ].join("\n");

    expect(() => repositoryInvestigationNotebookWithoutTransientCapacityAreas(
      malformedNotebook,
    )).toThrow(/contiguous numbered source line/u);
  });

  it.each([
    { label: "search output", args: ["grep", "createSession", "HEAD"] },
    { label: "transformed show output", args: ["show", "--stat", "HEAD:src/session.ts"] },
  ])("rejects $label as durable claim evidence", ({ args }) => {
    const { state, evidence } = investigationState({ args });

    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });

    expect(result).toMatchObject({ accepted: false });
    if (result.accepted) throw new Error("Expected the notebook update to be rejected.");
    expect(result.errors.join(" ")).toContain("not exact source");
  });

  it("rejects evidence from another source and test-only proof", () => {
    const foreign = investigationState({ sourceId: "source-2" });
    const foreignResult = applyRepositoryInvestigationNotebookUpdate({
      state: foreign.state,
      update: notebookUpdate(foreign.evidence.evidenceId),
    });
    expect(foreignResult).toMatchObject({ accepted: false });

    const testOnly = investigationState({ path: "src/session.test.ts" });
    const testResult = applyRepositoryInvestigationNotebookUpdate({
      state: testOnly.state,
      update: notebookUpdate(testOnly.evidence.evidenceId),
    });
    expect(testResult).toMatchObject({ accepted: false });
    if (testResult.accepted) throw new Error("Expected test-only evidence to be rejected.");
    expect(testResult.errors.join(" ")).toContain("tests alone");
  });

  it("treats unresolved areas as a replaceable current set", () => {
    const { state, evidence } = investigationState();
    state.notebook.unresolvedAreas = [{
      id: "unknown_revocation",
      label: "Session revocation",
      reason: "No production revocation path has been inspected yet.",
      importance: "major",
      searchTerms: ["revoke", "delete session"],
      pathHints: ["src/session.ts"],
    }];

    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    expect(result.notebook.unresolvedAreas).toEqual([]);
  });

  it("keeps transient phase capacity out of repository knowledge and progress", () => {
    const { state, evidence } = investigationState();
    const capacityOnly: RepositoryInvestigationNotebook = {
      ...state.notebook,
      unresolvedAreas: [{
        id: "investigator_phase_budget_exhausted",
        label: "Investigator phase budget exhausted",
        reason: "The prior bounded process reached its local token allowance.",
        importance: "major",
        searchTerms: [],
        pathHints: [],
      }],
    };

    expect(repositoryInvestigationNotebookWithoutTransientCapacityAreas(
      capacityOnly,
    ).unresolvedAreas).toEqual([]);
    expect(repositoryInvestigationHasMaterialProgress({
      previous: state.notebook,
      next: capacityOnly,
    })).toBe(false);

    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: { ...notebookUpdate(evidence.evidenceId), done: false },
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    expect(repositoryInvestigationHasMaterialProgress({
      previous: capacityOnly,
      next: result.notebook,
    })).toBe(true);
  });

  it("prioritizes major source questions and excludes runtime capacity markers", () => {
    const gaps = prioritizedRepositoryInvestigationGaps([{
      id: "supporting_route_polish",
      label: "Route presentation",
      reason: "The supporting presentation route has not yet been read in exact source.",
      importance: "supporting",
      searchTerms: ["route"],
      pathHints: ["src/routes"],
    }, {
      id: "investigator_phase_budget_exhausted",
      label: "Investigator phase budget exhausted",
      reason: "The prior bounded process reached its local token allowance.",
      importance: "major",
      searchTerms: [],
      pathHints: [],
    }, {
      id: "major_constraint_boundary",
      label: "Major constraint boundary",
      reason: "A declared central operation may be intentionally unsupported.",
      importance: "major",
      searchTerms: ["unsupported"],
      pathHints: ["src"],
    }]);

    expect(gaps.map((gap) => gap.id)).toEqual([
      "major_constraint_boundary",
      "supporting_route_polish",
    ]);
  });

  it("requires a durable checkpoint before a fourth inspection and then yields", () => {
    expect(repositoryInvestigationPhaseInspectionAction({
      inspectionToolCalls: 1,
      inspectionToolCallsAtLastCheckpoint: 0,
      checkpointYieldRequested: false,
    })).toBe("inspect");
    expect(repositoryInvestigationPhaseInspectionAction({
      inspectionToolCalls: 2,
      inspectionToolCallsAtLastCheckpoint: 0,
      checkpointYieldRequested: false,
    })).toBe("inspect");
    expect(repositoryInvestigationPhaseInspectionAction({
      inspectionToolCalls: 3,
      inspectionToolCallsAtLastCheckpoint: 0,
      checkpointYieldRequested: false,
    })).toBe("checkpoint");
    expect(repositoryInvestigationPhaseInspectionAction({
      inspectionToolCalls: 3,
      inspectionToolCallsAtLastCheckpoint: 3,
      checkpointYieldRequested: true,
    })).toBe("yield");
  });

  it("builds a bounded navigation map from analyzed files without claiming coverage", () => {
    const map = buildCompactRepositoryInvestigationMap({
      maxBytes: 220,
      files: [
        {
          id: "file-session",
          path: "src/session.ts",
          blobSha,
          sizeBytes: 100,
          disposition: "analyzed",
          analysis: {
            path: "src/session.ts",
            facts: [],
            symbols: ["createSession"],
            responsibilities: ["Persists sessions"],
            userFacingCapabilities: ["Signs users in"],
          },
        },
        {
          id: "file-unread",
          path: "src/unread.ts",
          blobSha,
          sizeBytes: 100,
          disposition: "eligible",
          analysis: null,
        },
      ],
    });

    expect(Buffer.byteLength(map, "utf8")).toBeLessThanOrEqual(220);
    expect(map).toContain("src/session.ts");
    expect(map).not.toContain("src/unread.ts");
    expect(map).toContain("navigation hints only");
  });

  it("keeps continuation state compact without embedding retained excerpts", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");

    const compact = compactRepositoryInvestigationNotebook(result.notebook);
    const serialized = JSON.stringify(compact);

    expect(serialized).not.toContain("database.session.create");
    expect(compact.findings[0]).toMatchObject({
      id: "creates_persisted_sessions",
      operationKey: "session_creation",
      implementationState: "implemented",
      facet: "persistence",
      evidence: [{
        path: "src/session.ts",
        lineStart: 1,
        lineEnd: 4,
        excerptHash: result.notebook.findings[0]?.evidence[0]?.excerptHash,
      }],
    });
  });

  it("round-trips a snapshot-bound durable candidate checkpoint and rejects drift", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const sourceInspection = buildRepositorySourceInspectionAttestation({
      evidence: [evidence],
      visibleRanges: state.visibleEvidenceRanges,
    });
    const context = {
      refreshRunId: "refresh-1",
      snapshotId: "snapshot-1",
      target: {
        sourceId: "source-1",
        repository: "owner/project",
        commitSha,
        treeSha: "c".repeat(40),
      },
      files: Array.from(state.filesByPath.values()),
      wave: 1,
      investigationInputDigest: "d".repeat(64),
      seedNotebookDigest: null,
    };
    const checkpoint = buildRepositoryInvestigationCheckpoint({
      context,
      notebook: result.notebook,
      generationRunId: "generation-1",
      terminationReason: "investigator_done",
      capacityLimitation: null,
      sourceInspection,
      agentToolTrace: [{
        iteration: 1,
        toolCall: 1,
        toolName: "update_repository_notebook",
        inputHash: "e".repeat(64),
      }],
    });

    expect(checkpoint).toMatchObject({
      schemaVersion: REPOSITORY_INVESTIGATION_CHECKPOINT_VERSION,
      checkpointKind: "final",
      snapshotId: "snapshot-1",
      sourceId: "source-1",
      generationRunId: "generation-1",
    });
    expect(checkpoint.notebook.findings[0]).toMatchObject({
      operationKey: "session_creation",
      implementationState: "implemented",
      facet: "persistence",
      statement: "The application persists a session record for an authenticated user.",
      evidence: [{ path: "src/session.ts", blobSha }],
    });
    expect(restoreRepositoryInvestigationCheckpoint({ value: checkpoint, context }))
      .toEqual(checkpoint);

    const tampered = structuredClone(checkpoint);
    tampered.notebook.findings[0]!.statement =
      "A different claim was inserted after the checkpoint was persisted.";
    expect(() => restoreRepositoryInvestigationCheckpoint({
      value: tampered,
      context,
    })).toThrow("does not match its pinned execution context");
    expect(() => restoreRepositoryInvestigationCheckpoint({
      value: checkpoint,
      context: {
        ...context,
        files: context.files.map((file) => ({ ...file, blobSha: "f".repeat(40) })),
      },
    })).toThrow();
  });

  it("distinguishes resumable partial checkpoints from terminal replay", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: { ...notebookUpdate(evidence.evidenceId), done: false },
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const context = {
      refreshRunId: "refresh-partial",
      snapshotId: "snapshot-partial",
      target: {
        sourceId: "source-1",
        repository: "owner/project",
        commitSha,
        treeSha: "c".repeat(40),
      },
      files: Array.from(state.filesByPath.values()),
      wave: 1,
      investigationInputDigest: "d".repeat(64),
      seedNotebookDigest: null,
    };
    const notebookWithTransientCapacity: RepositoryInvestigationNotebook = {
      ...result.notebook,
      unresolvedAreas: [{
        id: "investigator_phase_budget_exhausted",
        label: "Investigator phase budget exhausted",
        reason: "The prior bounded process reached its local token allowance.",
        importance: "major",
        searchTerms: [],
        pathHints: [],
      }],
    };
    const partial = buildRepositoryInvestigationCheckpoint({
      context,
      notebook: notebookWithTransientCapacity,
      checkpointKind: "partial",
      generationRunId: null,
      terminationReason: null,
      capacityLimitation: null,
      sourceInspection: buildRepositorySourceInspectionAttestation({
        evidence: [evidence],
        visibleRanges: state.visibleEvidenceRanges,
      }),
      agentToolTrace: [{
        iteration: 2,
        toolCall: 3,
        toolName: "update_repository_notebook",
        outcome: "success",
      }],
    });

    expect(partial).toMatchObject({
      checkpointKind: "partial",
      generationRunId: null,
      terminationReason: null,
      capacityLimitation: null,
    });
    expect(partial.notebook.unresolvedAreas).toEqual([]);
    expect(restoreRepositoryInvestigationCheckpoint({ value: partial, context }))
      .toEqual(partial);
    expect(() => buildRepositoryInvestigationCheckpoint({
      context,
      notebook: result.notebook,
      checkpointKind: "partial",
      generationRunId: "generation-must-not-exist",
      terminationReason: "investigator_done",
      capacityLimitation: null,
      sourceInspection: partial.sourceInspection,
      agentToolTrace: [],
    })).toThrow("Partial repository checkpoints cannot claim a terminal generation");
  });

  it("carries exact seed evidence into a later-wave checkpoint", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const seedSourceInspection = repositorySourceInspectionAttestationFromNotebook(
      result.notebook,
    );
    const context = {
      refreshRunId: "refresh-wave-2",
      snapshotId: "snapshot-wave-2",
      target: {
        sourceId: "source-1",
        repository: "owner/project",
        commitSha,
        treeSha: "c".repeat(40),
      },
      files: Array.from(state.filesByPath.values()),
      wave: 2,
      investigationInputDigest: "d".repeat(64),
      seedNotebookDigest: "e".repeat(64),
    };
    const laterWave = buildRepositoryInvestigationCheckpoint({
      context,
      notebook: result.notebook,
      checkpointKind: "final",
      generationRunId: "generation-wave-2",
      terminationReason: "investigator_done",
      capacityLimitation: null,
      sourceInspection: mergeRepositorySourceInspectionAttestations(
        seedSourceInspection,
        { sourceSearchTrace: [], readSet: [] },
      ),
      agentToolTrace: [],
    });

    expect(laterWave.sourceInspection.readSet).toHaveLength(1);
    expect(laterWave.sourceInspection.readSet[0]).toMatchObject({
      path: "src/session.ts",
      blobSha,
      excerptHash: result.notebook.findings[0]?.evidence[0]?.excerptHash,
    });
    expect(restoreRepositoryInvestigationCheckpoint({ value: laterWave, context }))
      .toEqual(laterWave);

    const drifted = structuredClone(result.notebook);
    drifted.findings[0]!.evidence[0]!.blobSha = "f".repeat(40);
    expect(() => buildRepositoryInvestigationCheckpoint({
      context,
      notebook: drifted,
      checkpointKind: "partial",
      generationRunId: null,
      terminationReason: null,
      capacityLimitation: null,
      sourceInspection: repositorySourceInspectionAttestationFromNotebook(drifted),
      agentToolTrace: [],
    })).toThrow("stale exact read identity");
  });

  it("canonicalizes equivalent pinned exact reads while rejecting true identity conflicts", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const fresh = buildRepositorySourceInspectionAttestation({
      evidence: [evidence],
      visibleRanges: state.visibleEvidenceRanges,
    });
    const legacySeed = repositorySourceInspectionAttestationFromNotebook(result.notebook);
    legacySeed.sourceSearchTrace[0]!.args = [`${commitSha}:src/session.ts`];

    const merged = mergeRepositorySourceInspectionAttestations(legacySeed, fresh);

    expect(merged.sourceSearchTrace).toEqual([
      expect.objectContaining({
        evidenceId: evidence.evidenceId,
        args: ["HEAD:src/session.ts"],
        outputHash: evidence.outputHash,
      }),
    ]);
    expect(merged.readSet).toHaveLength(1);

    const conflictingPath = structuredClone(fresh);
    conflictingPath.sourceSearchTrace[0]!.args = ["HEAD:src/other.ts"];
    expect(() => mergeRepositorySourceInspectionAttestations(
      legacySeed,
      conflictingPath,
    )).toThrow("conflicting durable identity");

    const conflictingOutput = structuredClone(fresh);
    conflictingOutput.sourceSearchTrace[0]!.outputHash = "f".repeat(64);
    expect(() => mergeRepositorySourceInspectionAttestations(
      legacySeed,
      conflictingOutput,
    )).toThrow("conflicting durable identity");
  });

  it("persists terminal diagnostics without exposing unverified candidate claims", () => {
    const terminal = buildRepositoryInvestigationTerminalState({
      rootAgentRunId: "root-1",
      priorWarnings: { retained: true },
      priorBudgetUsage: { retained: true },
      completedRepositories: [],
      activeRepository: {
        repository: "owner/project",
        sourceId: "source-1",
        commitSha,
        snapshotId: "snapshot-1",
        snapshotScopeDigest: "a".repeat(64),
        wave: 1,
        stage: "verifier",
        checkpoint: {
          available: true,
          workerAgentRunId: "worker-1",
          generationRunId: "generation-1",
          notebookDigest: "b".repeat(64),
          capabilityCount: 1,
          findingCount: 1,
          unresolvedAreaCount: 0,
          terminationReason: "investigator_done",
        },
      },
      sharedBudget: {
        limits: { maxModelTokens: 100, maxModelCalls: 10, maxInspectionOperations: 20 },
        used: {
          modelTokens: 20,
          modelCalls: 2,
          inspectionOperations: 4,
          reportedCostUsd: 0.01,
        },
        remaining: { modelTokens: 80, modelCalls: 8, inspectionOperations: 16 },
      },
      error: new Error("provider failed"),
    });
    const serialized = JSON.stringify(terminal);

    expect(terminal.warnings).toMatchObject({
      retained: true,
      repositoryInvestigation: { interrupted: true },
    });
    expect(terminal.budgetUsage).toMatchObject({
      retained: true,
      repositoryInvestigation: { state: "interrupted" },
    });
    expect(serialized).not.toContain("provider failed");
    expect(serialized).not.toContain("candidate claim");
  });

  it("persists a safe source-search trace and content-addressed exact read set", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const secret = `sk-proj-${"x".repeat(28)}`;
    const discovery = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["grep", secret, "HEAD"],
      output: "src/session.ts:1:createSession",
      target: { kind: "commit", commitSha },
      exitCode: 0,
    });
    const failedDiscovery = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["grep", "missing", "HEAD"],
      output: "fatal: invalid search",
      exitCode: 128,
    });
    const failedExactRead = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["show", "HEAD:src/missing.ts"],
      output: "fatal: path does not exist",
      target: {
        kind: "blob",
        commitSha,
        path: "src/missing.ts",
        blobSha: "c".repeat(40),
      },
      exitCode: 128,
    });

    const attestation = buildRepositorySourceInspectionAttestation({
      evidence: [evidence, discovery, failedDiscovery, failedExactRead],
      visibleRanges: [
        ...state.visibleEvidenceRanges,
        {
          evidenceId: failedExactRead.evidenceId,
          startLine: 1,
          endLine: failedExactRead.totalLines,
        },
      ],
    });

    expect(JSON.stringify(attestation)).not.toContain(secret);
    expect(attestation.sourceSearchTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "grep", operationKind: "discovery" }),
      expect.objectContaining({ command: "show", operationKind: "exact_blob_read" }),
    ]));
    expect(attestation.sourceSearchTrace).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: failedDiscovery.evidenceId }),
    ]));
    expect(attestation.readSet).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: failedExactRead.evidenceId }),
    ]));
    expect(attestation.readSet).toEqual([expect.objectContaining({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      path: "src/session.ts",
      blobSha,
      lineStart: 1,
      lineEnd: 4,
      excerptHash: result.notebook.findings[0]?.evidence[0]?.excerptHash,
      outputHash: evidence.outputHash,
    })]);
  });

  it("keeps the blind verifier request structurally free of candidate data", () => {
    const candidateCanaries = [
      "candidate-only-finding",
      "project_domain:candidate_only",
      "src/candidate-only.ts",
    ];
    const request = independentCoverageReviewRequest({
      projectTitle: "Project",
      target: { repository: "owner/project", commitSha },
      repositoryMap:
        "fileSnapshotId\tpath\tstatic symbols/responsibilities (navigation hints only)\nfile-1\tsrc/session.ts\tcreateSession",
    });
    const userPrompt = JSON.parse(request.userPrompt) as Record<string, unknown>;
    const serializedRequest = JSON.stringify(request);

    expect(Object.keys(userPrompt).sort()).toEqual([
      "commitSha",
      "instruction",
      "projectTitle",
      "repository",
      "repositoryMap",
    ]);
    expect(request.systemPrompt).toContain("No candidate notebook is available");
    expect(request.systemPrompt).toContain(
      `bounded safety ceiling of ${REPOSITORY_VERIFIER_MAX_OBSERVATIONS}`,
    );
    expect(request.systemPrompt).toContain("This ceiling is not a target");
    expect(request.systemPrompt).toContain("observationCapacityReached true");
    expect(userPrompt).not.toHaveProperty("candidate");
    expect(userPrompt).not.toHaveProperty("independentReviewCheckpointDigest");
    expect(userPrompt).not.toHaveProperty("requiredRepresentativeChecks");
    expect(userPrompt).not.toHaveProperty("candidateClaims");
    for (const canary of candidateCanaries) {
      expect(serializedRequest).not.toContain(canary);
    }
  });

  it("rejects independent-review checkpoint tampering and pinned-snapshot drift", () => {
    const fixture = verifierFixture();
    const validate = (value: unknown, overrides?: {
      files?: typeof fixture.files;
      snapshotScopeDigest?: string;
      target?: typeof fixture.target;
    }) => validateRepositoryVerifierIndependentReviewCheckpoint({
      value,
      files: overrides?.files ?? fixture.files,
      target: overrides?.target ?? fixture.target,
      snapshotScopeDigest:
        overrides?.snapshotScopeDigest ?? fixture.snapshotScopeDigest,
    });

    expect(validate(fixture.checkpoint)).toBe(true);
    expect(validate(fixture.checkpoint, {
      snapshotScopeDigest: "d".repeat(64),
    })).toBe(false);
    expect(validate(fixture.checkpoint, {
      target: { ...fixture.target, commitSha: "e".repeat(40) },
    })).toBe(false);
    expect(validate(fixture.checkpoint, {
      files: fixture.files.map((file) => ({
        ...file,
        blobSha: "f".repeat(40),
      })),
    })).toBe(false);
    expect(validate({
      ...fixture.checkpoint,
      independentObservations: fixture.checkpoint.independentObservations.map(
        (observation) => ({
          ...observation,
          statement: "A post-persistence edit replaced the blind observation.",
        }),
      ),
    })).toBe(false);
    expect(validate({
      ...fixture.checkpoint,
      sourceInspection: {
        ...fixture.checkpoint.sourceInspection,
        readSet: fixture.checkpoint.sourceInspection.readSet.map((read) => ({
          ...read,
          lineEnd: read.lineEnd - 1,
        })),
      },
    })).toBe(false);

    const citationOutsideRead = buildRepositoryVerifierIndependentReviewCheckpoint({
      target: fixture.target,
      snapshotScopeDigest: fixture.snapshotScopeDigest,
      sourceInspection: fixture.sourceInspection,
      independentObservations: fixture.independentObservations.map((observation) => ({
        ...observation,
        evidence: { ...observation.evidence, lineStart: 5, lineEnd: 5 },
      })),
      inspectionToolCalls: 2,
    });
    expect(validate(citationOutsideRead)).toBe(false);
  });

  it("sends only a compact blind checkpoint and candidate packet to comparison", () => {
    const fixture = verifierFixture();
    const sourceExcerptCanary = "RAW_SOURCE_EXCERPT_MUST_NOT_CROSS_THE_PHASE_BOUNDARY";
    const notebook = {
      ...fixture.notebook,
      findings: fixture.notebook.findings.map((finding) => ({
        ...finding,
        evidence: finding.evidence.map((entry) => ({
          ...entry,
          excerpt: sourceExcerptCanary,
        })) as typeof finding.evidence,
      })),
    };
    const request = candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook,
      independentReview: fixture.checkpoint,
    });
    const payload = JSON.parse(request.userPrompt) as Record<string, unknown>;
    const serialized = JSON.stringify(payload);

    expect(Object.keys(payload).sort()).toEqual([
      "candidate",
      "commitSha",
      "independentObservations",
      "independentReviewCheckpointDigest",
      "projectTitle",
      "repository",
    ]);
    expect(payload.independentReviewCheckpointDigest).toBe(
      fixture.checkpoint.checkpointDigest,
    );
    expect(serialized).toContain("creates_persisted_sessions");
    expect(serialized).toContain("src/session.ts");
    expect(serialized).not.toContain(sourceExcerptCanary);
    expect(serialized).not.toContain("sourceInspection");
    expect(serialized).not.toContain("sourceSearchTrace");
    expect(serialized).not.toContain("readSet");
    expect(serialized).not.toContain("evidenceId");
    expect(serialized).not.toContain("ls-tree");
    expect(serialized.length).toBeLessThan(8_000);
  });

  it("requires fresh exact representative reads in the candidate-comparison phase", () => {
    const fixture = verifierFixture();
    const targets = repositoryCoverageVerificationTargets(fixture.notebook);
    const observation = fixture.checkpoint.independentObservations[0]!;
    const audit = {
      status: "satisfied" as const,
      capabilityChecks: [{
        capabilityKey: "project_domain:session_management",
        findingId: "creates_persisted_sessions",
        verdict: "supported" as const,
        reason: "A fresh exact read directly confirms persisted session creation.",
        evidence: {
          evidenceId: fixture.evidence.evidenceId,
          lineStart: 1,
          lineEnd: 4,
        },
      }],
      independentObservationChecks: [{
        observationDigest:
          repositoryVerifierIndependentObservationDigest(observation),
        verdict: "covered_by_candidate" as const,
        reason:
          "The candidate finding covers the independently observed session operation.",
        matchedFindingIds: ["creates_persisted_sessions"],
        missingOperationId: "",
        evidence: {
          evidenceId: fixture.evidence.evidenceId,
          lineStart: 1,
          lineEnd: 4,
        },
      }],
      missingOperations: [],
      rationale: "The representative candidate claim remains directly supported.",
    };

    expect(candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook: fixture.notebook,
      independentReview: fixture.checkpoint,
    }).systemPrompt).toContain("in this fresh phase");
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: 0,
      sourceInspection: { sourceSearchTrace: [], readSet: [] },
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
    })).toMatch(/re-read/iu);
    expect(validateRepositoryCoverageAuditContract({
      audit,
      notebook: fixture.notebook,
      sourceInspection: { sourceSearchTrace: [], readSet: [] },
      targets,
      requireDiscovery: false,
      independentReview: fixture.checkpoint,
    })).toMatchObject({
      accepted: false,
      errors: expect.arrayContaining([
        expect.stringContaining("exact pinned source range"),
        expect.stringContaining("visible exact pinned verifier read"),
      ]),
    });
    const candidatePhaseInspection = buildRepositorySourceInspectionAttestation({
      evidence: [fixture.evidence],
      visibleRanges: [{
        evidenceId: fixture.evidence.evidenceId,
        startLine: 1,
        endLine: 4,
      }],
    });
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: 1,
      sourceInspection: candidatePhaseInspection,
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
    })).toContain("required candidate checks are complete");
    expect(validateRepositoryCoverageAuditContract({
      audit: { ...audit, independentObservationChecks: [] },
      notebook: fixture.notebook,
      sourceInspection: candidatePhaseInspection,
      targets,
      requireDiscovery: false,
      independentReview: fixture.checkpoint,
    })).toMatchObject({
      accepted: false,
      errors: expect.arrayContaining([
        expect.stringContaining("exactly 1 independent observations"),
        expect.stringContaining("omitted independent observation"),
      ]),
    });
    expect(validateRepositoryCoverageAuditContract({
      audit,
      notebook: fixture.notebook,
      sourceInspection: candidatePhaseInspection,
      targets,
      requireDiscovery: false,
      independentReview: fixture.checkpoint,
    })).toEqual({ accepted: true });
  });

  it("keeps the blind checkpoint reusable while later notebook waves change", () => {
    const fixture = verifierFixture();
    const nextWaveNotebook: RepositoryInvestigationNotebook = {
      ...fixture.notebook,
      findings: fixture.notebook.findings.map((finding) => ({
        ...finding,
        statement:
          "The application transactionally persists an authenticated user session record.",
      })),
    };
    const firstRequest = JSON.parse(candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook: fixture.notebook,
      independentReview: fixture.checkpoint,
    }).userPrompt) as Record<string, unknown>;
    const nextRequest = JSON.parse(candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook: nextWaveNotebook,
      independentReview: fixture.checkpoint,
    }).userPrompt) as Record<string, unknown>;

    expect(validateRepositoryVerifierIndependentReviewCheckpoint({
      value: fixture.checkpoint,
      files: fixture.files,
      target: fixture.target,
      snapshotScopeDigest: fixture.snapshotScopeDigest,
    })).toBe(true);
    expect(fixture.checkpoint).not.toHaveProperty("wave");
    expect(fixture.checkpoint).not.toHaveProperty("notebookDigest");
    expect(firstRequest.independentReviewCheckpointDigest).toBe(
      fixture.checkpoint.checkpointDigest,
    );
    expect(nextRequest.independentReviewCheckpointDigest).toBe(
      fixture.checkpoint.checkpointDigest,
    );
    expect(nextRequest.independentObservations).toEqual(
      firstRequest.independentObservations,
    );
    expect(nextRequest.candidate).not.toEqual(firstRequest.candidate);
  });

  it("directs the independent verifier to submit before its tool cap", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const notebook = result.notebook;
    const targets = repositoryCoverageVerificationTargets(notebook);
    const target = {
      sourceId: notebook.sourceId,
      repository: notebook.repository,
      commitSha: notebook.commitSha,
    };
    const discovery = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["ls-tree", "-r", "--name-only", "HEAD"],
      output: "src/session.ts",
      target: { kind: "commit", commitSha },
      exitCode: 0,
    });
    const sourceInspection = buildRepositorySourceInspectionAttestation({
      evidence: [evidence, discovery],
      visibleRanges: state.visibleEvidenceRanges,
    });
    const request = independentCoverageReviewRequest({
      projectTitle: "Project",
      target,
      repositoryMap: [
        "fileSnapshotId\tpath\tstatic symbols/responsibilities (navigation hints only)",
        "file-1\tsrc/session.ts\tcreateSession",
      ].join("\n"),
    });
    const candidate = repositoryCoverageCandidatePacket(notebook);

    expect(request.systemPrompt).toContain(
      `Use at most ${REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS} inspect_repository_snapshot calls`,
    );
    expect(request.systemPrompt).toContain(
      "No candidate notebook is available",
    );
    expect(request.systemPrompt).toContain(
      "candidate-independent navigation only",
    );
    expect(request.userPrompt).not.toContain("requiredRepresentativeChecks");
    expect(request.userPrompt).not.toContain("candidateClaims");
    expect(request.userPrompt).not.toContain("creates_persisted_sessions");
    expect(request.userPrompt).toContain("src/session.ts");
    expect(request.userPrompt).not.toContain("compactNotebook");
    expect(request.userPrompt).toContain("repositoryMap");
    expect(JSON.stringify(candidate)).toContain("creates_persisted_sessions");
    expect(JSON.stringify(candidate)).toContain("src/session.ts");
    expect(candidate.candidateClaims[0]).toMatchObject({
      operationKey: "session_creation",
      implementationState: "implemented",
      facet: "persistence",
    });
    const gate = repositoryVerifierIndependentDiscoveryGate({
      sourceInspection,
      files: Array.from(state.filesByPath.values()),
      target,
    });
    expect(gate.accepted).toBe(true);
    expect(repositoryVerifierIndependentNextAction({
      completedInspectionToolCalls: 1,
      sourceInspection,
      files: Array.from(state.filesByPath.values()),
      target,
    })).toContain("that alone is not coverage");
    expect(repositoryVerifierIndependentNextAction({
      completedInspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
      sourceInspection,
      files: Array.from(state.filesByPath.values()),
      target,
    })).toContain("bounded blind-review allowance is complete");
    const independentObservations = [{
      kind: "operation" as const,
      statement: "The implementation creates and persists an authenticated session record.",
      evidence: {
        evidenceId: evidence.evidenceId,
        lineStart: 1,
        lineEnd: 4,
      },
    }];
    const snapshotScopeDigest = "c".repeat(64);
    const checkpoint = buildRepositoryVerifierIndependentReviewCheckpoint({
      target,
      snapshotScopeDigest,
      sourceInspection,
      independentObservations,
      inspectionToolCalls: 2,
    });
    expect(validateRepositoryVerifierIndependentReviewCheckpoint({
      value: checkpoint,
      files: Array.from(state.filesByPath.values()),
      target,
      snapshotScopeDigest,
    })).toBe(true);
    expect(validateRepositoryVerifierIndependentReviewCheckpoint({
      value: { ...checkpoint, checkpointDigest: "0".repeat(64) },
      files: Array.from(state.filesByPath.values()),
      target,
      snapshotScopeDigest,
    })).toBe(false);
    const maximumObservations = Array.from(
      { length: REPOSITORY_VERIFIER_MAX_OBSERVATIONS },
      (_, index) => ({
        ...independentObservations[0]!,
        statement:
          `Material repository operation ${index + 1} persists an authenticated session record.`,
      }),
    );
    const capacityCheckpoint = buildRepositoryVerifierIndependentReviewCheckpoint({
      target,
      snapshotScopeDigest,
      sourceInspection,
      independentObservations: maximumObservations,
      observationCapacityReached: true,
      inspectionToolCalls: 2,
    });
    expect(capacityCheckpoint.observationCapacityReached).toBe(true);
    expect(validateRepositoryVerifierIndependentReviewCheckpoint({
      value: capacityCheckpoint,
      files: Array.from(state.filesByPath.values()),
      target,
      snapshotScopeDigest,
    })).toBe(true);
    expect(() => buildRepositoryVerifierIndependentReviewCheckpoint({
      target,
      snapshotScopeDigest,
      sourceInspection,
      independentObservations: [
        ...maximumObservations,
        {
          ...independentObservations[0]!,
          statement:
            "One additional material repository operation exceeds the bounded safety ceiling.",
        },
      ],
      observationCapacityReached: true,
      inspectionToolCalls: 2,
    })).toThrow();
    const oversizedEvidenceMarker = "oversized-source-body".repeat(1_000);
    const candidateRequest = candidateCoverageAuditRequest({
      projectTitle: "Project",
      independentReview: checkpoint,
      notebook: {
        ...notebook,
        findings: notebook.findings.map((finding) => ({
          ...finding,
          evidence: finding.evidence.map((entry) => ({
            ...entry,
            excerpt: oversizedEvidenceMarker,
          })) as typeof finding.evidence,
        })),
      },
    });
    expect(candidateRequest.systemPrompt).toContain(
      `Use at most ${REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS} inspect_repository_snapshot calls`,
    );
    expect(candidateRequest.userPrompt).toContain("creates_persisted_sessions");
    expect(candidateRequest.userPrompt).toContain("src/session.ts");
    expect(candidateRequest.userPrompt).not.toContain(oversizedEvidenceMarker);
    expect(candidateRequest.userPrompt.length).toBeLessThan(8_000);
    const digest = (value: unknown) => createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    const disclosure = {
      inspectionToolCallsAtReveal: 2,
      preDisclosureDiscoveryEvidenceIds: gate.discoveryEvidenceIds,
      preDisclosureExactReadEvidenceIds: gate.exactReadEvidenceIds,
      preDisclosureAttestationDigest: gate.attestationDigest,
      independentObservations,
      independentObservationDigest: digest(independentObservations),
    };
    expect(validateRepositoryVerifierCandidateDisclosure({
      value: disclosure,
      sourceInspection,
      files: Array.from(state.filesByPath.values()),
      target: {
        sourceId: notebook.sourceId,
        repository: notebook.repository,
        commitSha: notebook.commitSha,
      },
    })).toBe(true);
    expect(validateRepositoryVerifierCandidateDisclosure({
      value: { ...disclosure, independentObservationDigest: "0".repeat(64) },
      sourceInspection,
      files: Array.from(state.filesByPath.values()),
      target: {
        sourceId: notebook.sourceId,
        repository: notebook.repository,
        commitSha: notebook.commitSha,
      },
    })).toBe(false);
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: 2,
      sourceInspection,
      candidateRevealed: false,
      candidateReviewAvailable: gate.accepted,
      targets: [],
    })).toContain("review_repository_candidate next");
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: 2,
      sourceInspection,
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
    })).toContain("required candidate checks are complete");
    expect(
      REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS + 1,
    ).toBeLessThan(8);
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      sourceInspection: { sourceSearchTrace: [], readSet: [] },
      candidateRevealed: false,
      candidateReviewAvailable: false,
      targets,
    })).toContain("cannot be certified");
  });

  it("keeps candidate disclosure locked for discovery-only and test-only source reads", () => {
    const { state, evidence } = investigationState({ path: "src/session.test.ts" });
    const discovery = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["ls-tree", "-r", "--name-only", "HEAD"],
      output: "src/session.test.ts",
      target: { kind: "commit", commitSha },
      exitCode: 0,
    });
    const target = {
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
    };
    const discoveryOnly = buildRepositorySourceInspectionAttestation({
      evidence: [discovery],
      visibleRanges: [],
    });
    expect(repositoryVerifierIndependentDiscoveryGate({
      sourceInspection: discoveryOnly,
      files: Array.from(state.filesByPath.values()),
      target,
    }).accepted).toBe(false);
    const testRead = buildRepositorySourceInspectionAttestation({
      evidence: [discovery, evidence],
      visibleRanges: state.visibleEvidenceRanges,
    });
    expect(repositoryVerifierIndependentDiscoveryGate({
      sourceInspection: testRead,
      files: Array.from(state.filesByPath.values()),
      target,
    }).accepted).toBe(false);
  });

  it("does not call the verifier for an incomplete investigator notebook", async () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const verify = vi.fn(async () => ({ status: "called" }));
    const incomplete: RepositoryInvestigationNotebook = {
      ...result.notebook,
      done: false,
      unresolvedAreas: [{
        id: "unresolved_boundary",
        label: "Unresolved boundary",
        reason: "A material implementation boundary still needs investigation.",
        importance: "major",
        searchTerms: ["boundary"],
        pathHints: ["src"],
      }],
    };

    await expect(runRepositoryVerificationIfCandidate({
      notebook: incomplete,
      verify,
    })).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("cannot certify a completed repository notebook with no grounded knowledge", () => {
    expect(() => repositoryInvestigationNotebookWithoutTransientCapacityAreas({
      schemaVersion: REPOSITORY_KNOWLEDGE_INVESTIGATOR_VERSION,
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      capabilities: [],
      findings: [],
      unresolvedAreas: [],
      done: true,
    })).toThrow(/at least one source-grounded capability and finding/iu);
  });

  it("binds satisfied checks and verifier gaps to exact pinned reads", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const discovery = createProjectRepositoryRawEvidence({
      sourceId: "source-1",
      repository: "owner/project",
      commitSha,
      args: ["grep", "-n", "createSession", "--", "src"],
      output: "src/session.ts:1:export async function createSession(userId: string) {",
      target: { kind: "commit", commitSha },
      exitCode: 0,
    });
    const sourceInspection = buildRepositorySourceInspectionAttestation({
      evidence: [discovery, evidence],
      visibleRanges: state.visibleEvidenceRanges,
    });
    const audit = {
      status: "satisfied" as const,
      capabilityChecks: [{
        capabilityKey: "project_domain:session_management",
        findingId: "creates_persisted_sessions",
        verdict: "supported" as const,
        reason: "The independently read range directly persists the session record.",
        evidence: {
          evidenceId: evidence.evidenceId,
          lineStart: 1,
          lineEnd: 4,
        },
      }],
      independentObservationChecks: [],
      missingOperations: [],
      rationale: "The representative major capability remains directly supported.",
    };

    expect(validateRepositoryCoverageAuditContract({
      audit,
      notebook: result.notebook,
      sourceInspection,
    })).toEqual({ accepted: true });
    expect(validateRepositoryCoverageAuditContract({
      audit: {
        ...audit,
        status: "gaps",
        capabilityChecks: [{
          ...audit.capabilityChecks[0]!,
          verdict: "unsupported",
          evidence: { ...audit.capabilityChecks[0]!.evidence, lineStart: 2 },
        }],
      },
      notebook: result.notebook,
      sourceInspection,
    })).toMatchObject({
      accepted: false,
      errors: [expect.stringContaining("exact source range")],
    });
    const missingOperation = {
      id: "session_revocation_missing",
      label: "Session revocation",
      reason: "No externally effective session revocation transition is represented.",
      importance: "major" as const,
      searchTerms: ["revoke session"],
      pathHints: ["src/session.ts"],
      evidence: {
        evidenceId: evidence.evidenceId,
        lineStart: 1,
        lineEnd: 4,
      },
    };
    expect(validateRepositoryCoverageAuditContract({
      audit: {
        ...audit,
        status: "gaps",
        missingOperations: [missingOperation, missingOperation],
      },
      notebook: result.notebook,
      sourceInspection,
    })).toMatchObject({
      accepted: false,
      errors: expect.arrayContaining([
        "Duplicate missing operation session_revocation_missing.",
      ]),
    });
  });

  it("shares model and inspection budgets across adaptive phases and fails admission closed", () => {
    const limits = repositoryInvestigationSharedBudgetLimits({
      repositoryCount: 2,
      analyzedFileCount: 60,
    });
    const budget = new RepositoryInvestigationSharedBudget(limits);

    expect(budget.reserveInspectionOperations(90)).toBe(true);
    expect(budget.reserveInspectionOperations(limits.maxInspectionOperations)).toBe(false);
    budget.consumeModelUsage({
      usage: {
        totalTokens: limits.maxModelTokens - 9_000,
        inputTokens: limits.maxModelTokens - 10_000,
        outputTokens: 1_000,
        providerAttemptCount: limits.maxModelCalls - 1,
      },
    });

    expect(budget.canStart({
      minimumTokens: 10_000,
      minimumModelCalls: 2,
      minimumInspectionOperations: 1,
    })).toBe(false);
    expect(budget.phaseLimits({
      maxIterations: 10,
      maxToolCalls: 8,
      maxTotalTokens: 50_000,
    }, 10_000)).toBeNull();
  });

  it("does not charge cached input replay to the refresh-wide semantic token allowance", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 20_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    budget.consumeModelUsage({
      usage: {
        totalTokens: 12_000,
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadInputTokens: 8_000,
        providerAttemptCount: 1,
      },
    });

    expect(budget.snapshot()).toMatchObject({
      tokenAccountingMode: "total_minus_cache_read_input_floor_output",
      used: { modelTokens: 4_000 },
      remaining: { modelTokens: 16_000 },
    });
    expect(repositoryInvestigationSemanticModelTokenCount({
      totalTokens: 12_000,
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 20_000,
    })).toBe(2_000);
  });

  it("charges uncached and cache-unaware provider usage as semantic work", () => {
    const uncached = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 30_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    uncached.consumeModelUsage({
      usage: {
        totalTokens: 12_000,
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadInputTokens: 0,
      },
    });
    uncached.consumeModelUsage({
      usage: {
        totalTokens: 5_000,
        inputTokens: 4_000,
        outputTokens: 1_000,
      },
    });

    expect(uncached.snapshot()).toMatchObject({
      used: { modelTokens: 17_000 },
      remaining: { modelTokens: 13_000 },
    });
  });

  it("preserves verifier reserve after cached raw context replay", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 26_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    budget.consumeModelUsage({
      usage: {
        totalTokens: 30_000,
        inputTokens: 28_000,
        outputTokens: 2_000,
        cacheReadInputTokens: 14_000,
        providerAttemptCount: 2,
      },
    });

    expect(budget.canStart({
      minimumTokens: 10_000,
      minimumModelCalls: 2,
      minimumInspectionOperations: 4,
    })).toBe(true);
    expect(budget.phaseLimits({
      maxIterations: 10,
      maxToolCalls: 8,
      maxTotalTokens: 50_000,
    }, 10_000)).toEqual({
      maxIterations: 2,
      maxToolCalls: 1,
      maxTotalTokens: 10_000,
    });
    expect(budget.phaseLimits({
      maxIterations: 10,
      maxToolCalls: 8,
      maxTotalTokens: 50_000,
    }, 10_000, { modelTokens: 0, modelCalls: 0 }, {
      preserveRawTokenLimit: true,
    })).toEqual({
      maxIterations: 2,
      maxToolCalls: 1,
      maxTotalTokens: 50_000,
      maxSemanticTokens: 10_000,
    });
  });

  it("reserves independently usable verifier capacity across every shared budget axis", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 26_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    const investigatorLimits = budget.phaseLimits({
      maxIterations: 10,
      maxToolCalls: 8,
      maxTotalTokens: 50_000,
    }, 16_000, {
      modelTokens: 10_000,
      modelCalls: 2,
    });

    expect(investigatorLimits).toEqual({
      maxIterations: 2,
      maxToolCalls: 1,
      maxTotalTokens: 16_000,
    });
    expect(budget.reserveInspectionOperations(4, 4)).toBe(true);
    expect(budget.reserveInspectionOperations(1, 4)).toBe(false);
    budget.consumeModelUsage({
      usage: {
        totalTokens: 16_000,
        inputTokens: 15_000,
        outputTokens: 1_000,
        providerAttemptCount: 2,
      },
    });
    expect(budget.canStart({
      minimumTokens: 10_000,
      minimumModelCalls: 2,
      minimumInspectionOperations: 4,
    })).toBe(true);

    const insufficient = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 25_999,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    expect(insufficient.phaseLimits({
      maxIterations: 10,
      maxToolCalls: 8,
      maxTotalTokens: 50_000,
    }, 16_000, {
      modelTokens: 10_000,
      modelCalls: 2,
    })).toBeNull();
  });

  it("derives capability breadth from unique supporting implementation files", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const first = result.notebook.findings[0]!;
    const secondEvidence = {
      ...first.evidence[0]!,
      evidenceId: "evidence-second-file",
      fileSnapshotId: "file-2",
      path: "src/session-store.ts",
      blobSha: "c".repeat(40),
      excerptHash: "d".repeat(64),
      outputHash: "e".repeat(64),
    };
    const notebook: RepositoryInvestigationNotebook = {
      ...result.notebook,
      findings: [first, {
        ...first,
        id: "stores_session_in_second_file",
        evidence: [secondEvidence],
      }],
    };

    expect(repositoryImplementationBreadthByCapability(notebook).get(
      "project_domain:session_management",
    )).toBe(2);
  });

  it("uses notebook and audit state to detect adaptive no-progress", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const satisfied = {
      status: "satisfied" as const,
      capabilityChecks: [],
      independentObservationChecks: [],
      missingOperations: [],
      rationale: "Independent inspection found the central workflow covered.",
    };
    const signature = repositoryInvestigationConvergenceSignature({
      notebook: result.notebook,
      audit: satisfied,
    });

    expect(repositoryInvestigationConvergenceSignature({
      notebook: result.notebook,
      audit: satisfied,
    })).toBe(signature);
    expect(repositoryInvestigationConvergenceSignature({
      notebook: { ...result.notebook, done: false },
      audit: satisfied,
    })).not.toBe(signature);
    for (const relationChange of [{
      operationKey: "session_revocation",
    }, {
      implementationState: "partial" as const,
    }, {
      facet: "transition" as const,
    }]) {
      expect(repositoryInvestigationConvergenceSignature({
        notebook: {
          ...result.notebook,
          findings: result.notebook.findings.map((finding) => ({
            ...finding,
            ...relationChange,
          })),
        },
        audit: satisfied,
      })).not.toBe(signature);
    }
    expect(repositoryInvestigationConvergenceSignature({
      notebook: {
        ...result.notebook,
        capabilities: result.notebook.capabilities.map((capability) => ({
          ...capability,
          label: `${capability.label} rephrased`,
          description: `${capability.description} rephrased without new source`,
        })),
        findings: result.notebook.findings.map((finding) => ({
          ...finding,
          statement: `${finding.statement} Rephrased without new evidence.`,
        })),
      },
      audit: {
        ...satisfied,
        rationale: "The same conclusion in different prose.",
      },
    })).toBe(signature);
  });

  it("retains actionable operation context when an unsupported claim is removed", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");

    const gaps = repositoryUnsupportedFindingRepairGaps({
      notebook: result.notebook,
      findingIds: ["creates_persisted_sessions"],
    });

    expect(gaps).toEqual([expect.objectContaining({
      label: "Revalidate session creation",
      importance: "major",
      searchTerms: expect.arrayContaining(["session_creation", "session", "creation"]),
      pathHints: ["src/session.ts"],
    })]);
    expect(gaps[0]?.reason).toContain("creates_persisted_sessions");
    expect(gaps[0]?.reason).toContain("persists a session record");
  });

  it("keeps material implementation boundaries as dedicated limitation findings", () => {
    const { state, evidence } = investigationState();
    const original = notebookUpdate(evidence.evidenceId);
    const update = {
      ...original,
      findings: [{
        ...original.findings[0]!,
        kind: "limitation" as const,
        implementationState: "bounded_absence" as const,
        facet: "boundary" as const,
        statement:
          "This handler persists the session locally and exposes no remote provider call in this implementation range.",
      }],
    };

    const result = applyRepositoryInvestigationNotebookUpdate({ state, update });

    expect(result).toMatchObject({ accepted: true });
    if (!result.accepted) throw new Error("Expected the limitation finding to be accepted.");
    expect(result.notebook.findings[0]?.kind).toBe("limitation");
    expect(result.notebook.findings[0]?.implementationState).toBe(
      "bounded_absence",
    );
  });

  it("projects operation relations and non-implemented states as non-Highlight knowledge", () => {
    const { state, evidence } = investigationState();
    const result = applyRepositoryInvestigationNotebookUpdate({
      state,
      update: notebookUpdate(evidence.evidenceId),
    });
    if (!result.accepted) throw new Error("Expected the notebook update to be accepted.");
    const implemented = result.notebook.findings[0]!;

    expect(repositoryInvestigationFindingKnowledgeRole(implemented)).toBe(
      "implementation",
    );
    expect(repositoryInvestigationFindingSemanticSignals(implemented)).toEqual(
      expect.arrayContaining([
        "operation:session_creation",
        "implementation_state:implemented",
        "facet:persistence",
      ]),
    );
    expect(repositoryInvestigationFindingAnalysisMetadata(implemented)).toMatchObject({
      operationKey: "session_creation",
      implementationState: "implemented",
      operationFacet: "persistence",
      knowledgeRole: "implementation",
    });

    for (const implementationState of [
      "partial",
      "planned",
      "bounded_absence",
    ] as const) {
      const qualified = { ...implemented, implementationState };
      expect(repositoryInvestigationFindingKnowledgeRole(qualified)).toBe(
        "limitation",
      );
      expect(repositoryInvestigationFindingSemanticSignals(qualified)).toEqual(
        expect.arrayContaining([
          `operation:${implemented.operationKey}`,
          `implementation_state:${implementationState}`,
          `facet:${implemented.facet}`,
          "limitation",
        ]),
      );
    }
  });

  it("does not allow unresolved areas to masquerade as a completed notebook", () => {
    const { state, evidence } = investigationState();
    const original = notebookUpdate(evidence.evidenceId);
    const update = {
      ...original,
      unresolvedAreas: [{
        id: "unresolved_remote_revocation",
        label: "Remote revocation",
        reason: "The remote session revocation path has not been independently inspected.",
        importance: "major" as const,
        searchTerms: ["revoke"],
        pathHints: ["src"],
      }],
    };

    const result = applyRepositoryInvestigationNotebookUpdate({ state, update });

    expect(result).toMatchObject({ accepted: false });
    if (result.accepted) throw new Error("Expected unresolved completion to be rejected.");
    expect(result.errors.join(" ")).toContain("cannot retain unresolved areas");
  });
});
