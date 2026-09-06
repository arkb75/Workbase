import { createHash } from "node:crypto";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BedrockConverseAgent,
  BedrockConverseAgentError,
  defineBedrockConverseTool,
  estimateBedrockConverseInputTokens,
  type BedrockConverseTransportResponse,
} from "@/src/lib/bedrock-converse-agent";
import {
  createProjectRepositoryRawEvidence,
  expandProjectRepositoryEvidence,
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
  MAX_REPOSITORY_VERIFIER_REPAIR_CYCLES,
  REPOSITORY_INVESTIGATION_CHECKPOINT_VERSION,
  REPOSITORY_KNOWLEDGE_INVESTIGATOR_VERSION,
  REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
  REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS,
  REPOSITORY_VERIFIER_MAX_OBSERVATIONS,
  REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
  REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
  recoverRepositoryInvestigatorAgentBudgetError,
  RepositoryInvestigationSharedBudget,
  repositoryCoverageAuditPhaseLimits,
  repositoryCoverageAuditSubmissionSchema,
  repositoryCoverageAuditSubmissionJsonSchema,
  resolveRepositoryCoverageAuditSubmission,
  repositoryCandidateAuditIdempotencyKey,
  repositoryCoverageCandidatePacket,
  repositoryCoverageReviewPhaseLimits,
  repositoryCoverageVerifierLimits,
  repositoryCoverageVerificationTargets,
  repositoryImplementationBreadthByCapability,
  repositoryInvestigationConvergenceSignature,
  repositoryInvestigationFindingAnalysisMetadata,
  repositoryInvestigationFindingKnowledgeRole,
  repositoryInvestigationFindingSemanticSignals,
  repositoryInvestigationBoundaryReviewGuidance,
  repositoryInvestigationHasMaterialProgress,
  repositoryIndependentReviewIdempotencyKey,
  repositoryInvestigationMaterialityGuidance,
  repositoryInvestigationNotebookWithoutTransientCapacityAreas,
  repositoryInvestigationPhaseInspectionAction,
  repositoryInvestigationNotebookUpdateIsTerminal,
  repositoryInspectionSegmentForModel,
  repositoryInvestigationPhaseBudget,
  repositoryInvestigationSemanticModelTokenCount,
  repositoryInvestigationSharedBudgetLimits,
  repositorySourceInspectionAttestationFromNotebook,
  repositoryUnsupportedFindingRepairGaps,
  repositoryVerifierRepairDecision,
  repositoryVerifierIndependentDiscoveryGate,
  repositoryVerifierIndependentNextAction,
  repositoryVerifierIndependentObservationDigest,
  repositoryVerifierIndependentSubmissionDiagnostics,
  repositoryVerifierNextAction,
  repositoryVerifierForcedSubmissionTool,
  repositoryVerifierRequiredExactReadGate,
  repositoryVerifierRequiredReadBatch,
  repositoryVerifierSubmissionAttemptDiagnostics,
  repositoryVerifierSubmissionNeedsSourceRepair,
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
    expect(repositoryCoverageVerifierLimits(80)).toEqual({
      maxIterations: 12,
      maxToolCalls: 10,
      maxTotalTokens: 170_000,
    });
    expect(repositoryCoverageVerifierLimits(81).maxTotalTokens).toBe(270_000);
    expect(repositoryCoverageVerifierLimits(250).maxTotalTokens).toBe(270_000);
    expect(repositoryCoverageVerifierLimits(251).maxTotalTokens).toBe(360_000);
  });

  it("gives each fresh verifier context its own raw transcript ceiling", () => {
    expect(repositoryCoverageReviewPhaseLimits(80)).toEqual({
      maxIterations: 12,
      maxToolCalls: 10,
      maxTotalTokens: 170_000,
    });
    expect(repositoryCoverageAuditPhaseLimits(80)).toEqual({
      maxIterations: 12,
      maxToolCalls: 10,
      maxTotalTokens: 230_000,
    });
    for (const limits of [
      repositoryCoverageReviewPhaseLimits(81),
      repositoryCoverageReviewPhaseLimits(250),
    ]) expect(limits.maxTotalTokens).toBe(270_000);
    for (const limits of [
      repositoryCoverageAuditPhaseLimits(81),
      repositoryCoverageAuditPhaseLimits(250),
    ]) expect(limits.maxTotalTokens).toBe(330_000);
    expect(repositoryCoverageReviewPhaseLimits(251).maxTotalTokens).toBe(360_000);
    expect(repositoryCoverageAuditPhaseLimits(251).maxTotalTokens).toBe(420_000);
  });

  it("returns indexed correction diagnostics for invalid blind-review observations", () => {
    const { state, evidence } = investigationState();
    const duplicateObservation = {
      kind: "operation" as const,
      statement: "The implementation creates and persists an authenticated session record.",
      evidence: {
        evidenceId: evidence.evidenceId,
        lineStart: 1,
        lineEnd: 4,
      },
    };
    const diagnostics = repositoryVerifierIndependentSubmissionDiagnostics({
      independentObservations: [{
        ...duplicateObservation,
        statement: "The implementation has a session operation outside the visible range.",
        evidence: {
          evidenceId: evidence.evidenceId,
          lineStart: 5,
          lineEnd: 6,
        },
      }, {
        ...duplicateObservation,
        statement: "The implementation has an operation cited to unknown evidence.",
        evidence: {
          evidenceId: "missing-evidence-0001",
          lineStart: 1,
          lineEnd: 2,
        },
      }, duplicateObservation, duplicateObservation],
      evidenceById: state.evidenceById,
      visibleEvidenceRanges: state.visibleEvidenceRanges,
      filesByPath: state.filesByPath,
      target: state.notebook,
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        submissionIndex: 0,
        code: "evidence_range_not_visible",
        evidenceId: evidence.evidenceId,
        requestedRange: { lineStart: 5, lineEnd: 6 },
        allowedVisibleRanges: [{ lineStart: 1, lineEnd: 4 }],
      }),
      expect.objectContaining({
        submissionIndex: 1,
        code: "evidence_not_inspected",
        evidenceId: "missing-evidence-0001",
        requestedRange: { lineStart: 1, lineEnd: 2 },
        allowedVisibleRanges: [],
        validExactReadRanges: [{
          evidenceId: evidence.evidenceId,
          path: "src/session.ts",
          lineStart: 1,
          lineEnd: 4,
        }],
      }),
    ]));
    expect(diagnostics.filter(
      (diagnostic) => diagnostic.code === "duplicate_observation",
    )).toEqual([
      expect.objectContaining({
        submissionIndex: 2,
        duplicateIndices: [2, 3],
      }),
      expect.objectContaining({
        submissionIndex: 3,
        duplicateIndices: [2, 3],
      }),
    ]);
    expect(diagnostics.every((diagnostic) =>
      Number.isInteger(diagnostic.submissionIndex) &&
      typeof diagnostic.instruction === "string" &&
      typeof diagnostic.evidenceId === "string" &&
      diagnostic.requestedRange.lineStart > 0 &&
      Array.isArray(diagnostic.allowedVisibleRanges)
    )).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("database.session.create");
  });

  it("offers exact-read identities when a blind observation cites discovery output", () => {
    const fixture = verifierFixture();
    const diagnostics = repositoryVerifierIndependentSubmissionDiagnostics({
      independentObservations: [{
        kind: "operation",
        statement: "The implementation creates and persists an authenticated session record.",
        evidence: {
          evidenceId: fixture.discovery.evidenceId,
          lineStart: 1,
          lineEnd: 1,
        },
      }],
      evidenceById: new Map([
        [fixture.evidence.evidenceId, fixture.evidence],
        [fixture.discovery.evidenceId, fixture.discovery],
      ]),
      visibleEvidenceRanges: [{
        evidenceId: fixture.evidence.evidenceId,
        startLine: 1,
        endLine: 4,
      }],
      filesByPath: new Map(fixture.files.map((file) => [file.path, file])),
      target: fixture.target,
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        submissionIndex: 0,
        code: "evidence_not_exact_pinned_source",
        evidenceId: fixture.discovery.evidenceId,
        validExactReadRanges: [{
          evidenceId: fixture.evidence.evidenceId,
          path: "src/session.ts",
          lineStart: 1,
          lineEnd: 4,
        }],
      }),
    ]);
    expect(repositoryVerifierIndependentSubmissionDiagnostics({
      independentObservations: [{
        kind: "operation",
        statement: "The implementation creates and persists an authenticated session record.",
        evidence: {
          evidenceId: fixture.evidence.evidenceId,
          lineStart: 1,
          lineEnd: 4,
        },
      }],
      evidenceById: new Map([
        [fixture.evidence.evidenceId, fixture.evidence],
        [fixture.discovery.evidenceId, fixture.discovery],
      ]),
      visibleEvidenceRanges: [{
        evidenceId: fixture.evidence.evidenceId,
        startLine: 1,
        endLine: 4,
      }],
      filesByPath: new Map(fixture.files.map((file) => [file.path, file])),
      target: fixture.target,
    })).toEqual([]);
  });

  it("counts schema-invalid forced submissions from the agent error event trail", async () => {
    const toolName = "submit_repository_coverage_audit";
    const executeSubmission = vi.fn(async () => ({
      status: "accepted",
    }));
    const submission = defineBedrockConverseTool({
      name: toolName,
      description: "Submit a source-grounded candidate audit.",
      inputSchema: z.object({ status: z.literal("satisfied") }),
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", enum: ["satisfied"] } },
      },
      maxRecoverableInvalidInputAttempts: 1,
      execute: executeSubmission,
    });
    let providerCall = 0;
    const transport = {
      converse: vi.fn(async (): Promise<BedrockConverseTransportResponse> => {
        providerCall += 1;
        return {
          message: {
            role: "assistant",
            content: [{
              toolUse: {
                toolUseId: `schema-invalid-forced-submit-${providerCall}`,
                name: toolName,
                input: {},
              },
            }],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          requestId: `request-schema-invalid-forced-submit-${providerCall}`,
        };
      }),
    };
    const agent = new BedrockConverseAgent(transport, {
      modelId: "test-verifier",
    });
    let error: unknown;

    try {
      await agent.run({
        messages: [{ role: "user", content: [{ text: "Submit the audit." }] }],
        tools: [submission],
        limits: { maxIterations: 3, maxToolCalls: 3, maxTotalTokens: 10_000 },
        forceTool: () => toolName,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BedrockConverseAgentError);
    expect(error).toMatchObject({ code: "protocol_error" });
    expect(transport.converse).toHaveBeenCalledTimes(2);
    expect(executeSubmission).not.toHaveBeenCalled();
    if (!(error instanceof BedrockConverseAgentError)) {
      throw new Error("Expected the agent to preserve its failed tool event trail.");
    }
    expect(error.events.filter((event) =>
      event.type === "tool_call_completed" &&
      event.toolName === toolName &&
      event.outcome === "invalid_input"
    )).toEqual([
      expect.objectContaining({
        type: "tool_call_completed",
        toolName,
        outcome: "invalid_input",
      }),
      expect.objectContaining({
        type: "tool_call_completed",
        toolName,
        outcome: "invalid_input",
      }),
    ]);
    expect(repositoryVerifierSubmissionAttemptDiagnostics({
      error,
      toolName,
    })).toEqual({
      toolCallAttemptCount: 2,
      schemaInvalidAttemptCount: 2,
      executionErrorAttemptCount: 0,
    });
  });

  it("reports the exact missing half of the independent-review provenance gate", () => {
    const { files, sourceInspection, target } = verifierFixture();
    const exactReadOnly = {
      sourceSearchTrace: sourceInspection.sourceSearchTrace.filter((entry) =>
        entry.operationKind === "exact_blob_read"
      ),
      readSet: sourceInspection.readSet,
    };
    const discoveryOnly = {
      sourceSearchTrace: sourceInspection.sourceSearchTrace.filter((entry) =>
        entry.operationKind === "discovery"
      ),
      readSet: [],
    };

    expect(repositoryVerifierIndependentDiscoveryGate({
      sourceInspection: exactReadOnly,
      files,
      target,
    })).toMatchObject({
      accepted: false,
      missingDiscovery: true,
      missingExactProductionRead: false,
    });
    expect(repositoryVerifierIndependentDiscoveryGate({
      sourceInspection: discoveryOnly,
      files,
      target,
    })).toMatchObject({
      accepted: false,
      missingDiscovery: false,
      missingExactProductionRead: true,
    });
    expect(repositoryVerifierIndependentDiscoveryGate({
      sourceInspection,
      files,
      target,
    })).toMatchObject({
      accepted: true,
      missingDiscovery: false,
      missingExactProductionRead: false,
    });
  });

  it("requires every distinct candidate target to be covered by an enclosing exact read", () => {
    const { sourceInspection, target } = verifierFixture();
    const firstRead = sourceInspection.readSet[0];
    if (!firstRead?.blobSha) throw new Error("Expected one pinned exact read.");
    const firstTarget = {
      path: firstRead.path,
      blobSha: firstRead.blobSha,
      lineStart: 2,
      lineEnd: 3,
    };
    const secondBlobSha = "d".repeat(40);
    const secondTarget = {
      path: "src/worker.ts",
      blobSha: secondBlobSha,
      lineStart: 10,
      lineEnd: 12,
    };
    const targets = [firstTarget, { ...firstTarget }, secondTarget];
    const emptyInspection = { sourceSearchTrace: [], readSet: [] };
    const secondRead = {
      ...firstRead,
      evidenceId: "worker-exact-read-evidence",
      path: secondTarget.path,
      blobSha: secondBlobSha,
      lineStart: 8,
      lineEnd: 20,
    };

    expect(repositoryVerifierRequiredExactReadGate({
      sourceInspection: emptyInspection,
      targets: [],
      target,
    })).toEqual({
      accepted: false,
      requiredReadCount: 0,
      completedReadCount: 0,
      missingReadCount: 0,
    });
    expect(repositoryVerifierRequiredExactReadGate({
      sourceInspection: emptyInspection,
      targets,
      target,
    })).toEqual({
      accepted: false,
      requiredReadCount: 2,
      completedReadCount: 0,
      missingReadCount: 2,
    });
    expect(repositoryVerifierRequiredExactReadGate({
      sourceInspection: { ...sourceInspection, readSet: [firstRead] },
      targets,
      target,
    })).toEqual({
      accepted: false,
      requiredReadCount: 2,
      completedReadCount: 1,
      missingReadCount: 1,
    });
    expect(repositoryVerifierRequiredExactReadGate({
      sourceInspection: {
        ...sourceInspection,
        readSet: [firstRead, secondRead],
      },
      targets,
      target,
    })).toEqual({
      accepted: true,
      requiredReadCount: 2,
      completedReadCount: 2,
      missingReadCount: 0,
    });

    for (const mismatchedIdentity of [
      { sourceId: "source-2" },
      { repository: "other/project" },
      { commitSha: "e".repeat(40) },
    ]) {
      expect(repositoryVerifierRequiredExactReadGate({
        sourceInspection: {
          ...sourceInspection,
          readSet: [{ ...firstRead, ...mismatchedIdentity }],
        },
        targets: [firstTarget],
        target,
      })).toEqual({
        accepted: false,
        requiredReadCount: 1,
        completedReadCount: 0,
        missingReadCount: 1,
      });
    }
  });

  it("leaves bounded verifier headroom after repository inspection", () => {
    const smallReview = repositoryCoverageReviewPhaseLimits(77);
    const smallAudit = repositoryCoverageAuditPhaseLimits(77);
    const largeReview = repositoryCoverageReviewPhaseLimits(251);

    expect(smallReview.maxToolCalls).toBeGreaterThan(
      REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS + 1,
    );
    expect(smallAudit.maxToolCalls).toBeGreaterThan(
      REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS + 1,
    );
    expect(largeReview).toMatchObject({
      maxIterations: 13,
      maxToolCalls: 12,
    });
    expect(largeReview.maxToolCalls).toBeLessThan(largeReview.maxIterations);
  });

  it("reserves one correction-capable verifier repair and re-audit", () => {
    const policies = {
      initial_investigator: {
        minimum: { modelTokens: 16_000, modelCalls: 5, inspectionOperations: 4 },
        reserve: { modelTokens: 64_000, modelCalls: 25, inspectionOperations: 28 },
      },
      independent_review: {
        minimum: { modelTokens: 12_000, modelCalls: 6, inspectionOperations: 4 },
        reserve: { modelTokens: 52_000, modelCalls: 19, inspectionOperations: 24 },
      },
      candidate_audit: {
        minimum: { modelTokens: 18_000, modelCalls: 7, inspectionOperations: 10 },
        reserve: { modelTokens: 34_000, modelCalls: 12, inspectionOperations: 14 },
      },
      verifier_repair: {
        minimum: { modelTokens: 16_000, modelCalls: 5, inspectionOperations: 4 },
        reserve: { modelTokens: 18_000, modelCalls: 7, inspectionOperations: 10 },
      },
      candidate_reaudit: {
        minimum: { modelTokens: 18_000, modelCalls: 7, inspectionOperations: 10 },
        reserve: { modelTokens: 0, modelCalls: 0, inspectionOperations: 0 },
      },
    } as const;

    for (const [phase, expected] of Object.entries(policies)) {
      const policy = repositoryInvestigationPhaseBudget(
        phase as keyof typeof policies,
      );
      expect(policy).toEqual(expected);
      const budget = new RepositoryInvestigationSharedBudget({
        maxModelTokens:
          policy.minimum.modelTokens + policy.reserve.modelTokens,
        maxModelCalls:
          policy.minimum.modelCalls + policy.reserve.modelCalls,
        maxInspectionOperations:
          policy.minimum.inspectionOperations +
          policy.reserve.inspectionOperations,
      });
      expect(budget.phaseLimits({
        maxIterations: 20,
        maxToolCalls: 20,
        maxTotalTokens: 200_000,
      }, policy.minimum.modelTokens, policy.reserve, {
        acceptTerminalToolAtIterationLimit: true,
      })).toMatchObject({
        maxIterations: policy.minimum.modelCalls,
        maxToolCalls: policy.minimum.modelCalls,
      });
    }

    expect(policies.independent_review.minimum.modelCalls).toBe(
      REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS + 2,
    );
    expect(policies.candidate_audit.minimum.modelCalls).toBe(
      REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS + 2,
    );
    expect(repositoryVerifierRepairDecision(0)).toEqual({ action: "repair" });
    expect(repositoryVerifierRepairDecision(
      MAX_REPOSITORY_VERIFIER_REPAIR_CYCLES,
    )).toEqual({
      action: "stop",
      terminationReason: "verifier_gaps_after_bounded_repair",
    });
  });

  it("forces only the tool allowed by the blind-review provenance state", () => {
    const forcedTool = (input: {
      inspectionToolCalls: number;
      readyToSubmit: boolean;
      submitted?: boolean;
    }) => repositoryVerifierForcedSubmissionTool({
      inspectionToolCalls: input.inspectionToolCalls,
      maxInspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
      maxRepairInspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS -
        REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
      readyToSubmit: input.readyToSubmit,
      submitted: input.submitted ?? false,
      toolName: "submit_repository_independent_review",
      inspectionToolName: "inspect_repository_snapshot",
    });

    expect(forcedTool({
      inspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS - 1,
      readyToSubmit: false,
    })).toBeNull();
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
      readyToSubmit: false,
    })).toBe("inspect_repository_snapshot");
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
      readyToSubmit: true,
    })).toBe("submit_repository_independent_review");
    expect(forcedTool({
      inspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
      readyToSubmit: false,
    })).toBeNull();
    expect(forcedTool({
      inspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
      readyToSubmit: true,
      submitted: true,
    })).toBeNull();
  });

  it("forces one bounded source repair without treating payload corrections as rereads", () => {
    const normalInspectionLimit =
      REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS;
    const totalInspectionLimit =
      REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS;
    const forcedTool = (input: {
      inspectionToolCalls: number;
      repairRequired: boolean;
    }) => repositoryVerifierForcedSubmissionTool({
      inspectionToolCalls: input.inspectionToolCalls,
      maxInspectionToolCalls: normalInspectionLimit,
      maxRepairInspectionToolCalls:
        totalInspectionLimit - normalInspectionLimit,
      readyToSubmit: true,
      repairRequired: input.repairRequired,
      submitted: false,
      toolName: "submit_repository_independent_review",
      inspectionToolName: "inspect_repository_snapshot",
    });
    const sourceRepairBeforeNormalLimit =
      repositoryVerifierSubmissionNeedsSourceRepair({
        codes: ["evidence_range_not_visible"],
        inspectionToolCalls: normalInspectionLimit - 1,
        maxTotalInspectionToolCalls: totalInspectionLimit,
        contractSubmissionRejectionCount: 1,
      });
    const sourceRepairAtNormalLimit =
      repositoryVerifierSubmissionNeedsSourceRepair({
        codes: ["evidence_not_inspected"],
        inspectionToolCalls: normalInspectionLimit,
        maxTotalInspectionToolCalls: totalInspectionLimit,
        contractSubmissionRejectionCount: 1,
      });

    expect(sourceRepairBeforeNormalLimit).toBe(true);
    expect(forcedTool({
      inspectionToolCalls: normalInspectionLimit - 1,
      repairRequired: sourceRepairBeforeNormalLimit,
    })).toBe("inspect_repository_snapshot");
    expect(sourceRepairAtNormalLimit).toBe(true);
    expect(forcedTool({
      inspectionToolCalls: normalInspectionLimit,
      repairRequired: sourceRepairAtNormalLimit,
    })).toBe("inspect_repository_snapshot");

    // A successful repair clears the state and makes the next bounded action submit.
    expect(forcedTool({
      inspectionToolCalls: totalInspectionLimit,
      repairRequired: false,
    })).toBe("submit_repository_independent_review");

    const payloadOnlyCorrection = repositoryVerifierSubmissionNeedsSourceRepair({
      codes: ["duplicate_observation"],
      inspectionToolCalls: normalInspectionLimit,
      maxTotalInspectionToolCalls: totalInspectionLimit,
      contractSubmissionRejectionCount: 1,
    });
    expect(payloadOnlyCorrection).toBe(false);
    expect(forcedTool({
      inspectionToolCalls: normalInspectionLimit,
      repairRequired: payloadOnlyCorrection,
    })).toBe("submit_repository_independent_review");

    const secondRejection = repositoryVerifierSubmissionNeedsSourceRepair({
      codes: ["evidence_range_not_visible"],
      inspectionToolCalls: normalInspectionLimit,
      maxTotalInspectionToolCalls: totalInspectionLimit,
      contractSubmissionRejectionCount: 2,
    });
    const noRemainingSlot = repositoryVerifierSubmissionNeedsSourceRepair({
      codes: ["evidence_range_not_visible"],
      inspectionToolCalls: totalInspectionLimit,
      maxTotalInspectionToolCalls: totalInspectionLimit,
      contractSubmissionRejectionCount: 1,
    });
    expect(secondRejection).toBe(false);
    expect(noRemainingSlot).toBe(false);
    expect(forcedTool({
      inspectionToolCalls: totalInspectionLimit,
      repairRequired: noRemainingSlot,
    })).not.toBe("inspect_repository_snapshot");
  });

  it("gives candidate audit one exact-read repair after its normal inspection allowance", () => {
    const fixture = verifierFixture();
    const targets = repositoryCoverageVerificationTargets(fixture.notebook);
    const forcedTool = (input: {
      inspectionToolCalls: number;
      readyToSubmit: boolean;
    }) => repositoryVerifierForcedSubmissionTool({
      inspectionToolCalls: input.inspectionToolCalls,
      maxInspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      maxRepairInspectionToolCalls:
        REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS -
        REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      readyToSubmit: input.readyToSubmit,
      submitted: false,
      toolName: "submit_repository_coverage_audit",
      inspectionToolName: "inspect_repository_snapshot",
    });

    expect(REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS).toBe(
      REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS + 1,
    );
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS - 1,
      readyToSubmit: false,
    })).toBeNull();
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      readyToSubmit: false,
    })).toBe("inspect_repository_snapshot");
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      sourceInspection: { sourceSearchTrace: [], readSet: [] },
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
      target: fixture.target,
    })).toContain("one bounded reread-repair inspection call");
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
      readyToSubmit: true,
    })).toBe("submit_repository_coverage_audit");
    expect(forcedTool({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS,
      readyToSubmit: false,
    })).toBeNull();
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: REPOSITORY_VERIFIER_MAX_TOTAL_INSPECTION_TOOL_CALLS,
      sourceInspection: { sourceSearchTrace: [], readSet: [] },
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
      target: fixture.target,
    })).toContain("reread-repair allowance is exhausted");
    expect(candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook: fixture.notebook,
      independentReview: fixture.checkpoint,
    }).systemPrompt).toContain("one final reread-only repair call");
  });

  it("repairs missing provenance once before forcing the blind-review submission", async () => {
    const responses: BedrockConverseTransportResponse[] = [
      ...Array.from(
        { length: REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS },
        (_, index) => ({
          message: {
            role: "assistant" as const,
            content: [{
              toolUse: {
                toolUseId: `inspect-${index + 1}`,
                name: "inspect_repository_snapshot",
                input: {},
              },
            }],
          },
          stopReason: "tool_use" as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          requestId: `request-inspect-${index + 1}`,
        }),
      ),
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "submit-ready-review",
              name: "submit_repository_independent_review",
              input: {},
            },
          }],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "request-submit-ready-review",
      },
      {
        message: { role: "assistant", content: [{ text: "Review submitted." }] },
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "request-review-complete",
      },
    ];
    let responseIndex = 0;
    const transport = {
      converse: vi.fn(async (_input: ConverseCommandInput) => {
        void _input;
        const response = responses[responseIndex++];
        if (!response) throw new Error("Unexpected verifier model turn.");
        return response;
      }),
    };
    let readyToSubmit = false;
    const executeInspection = vi.fn(async () => {
      if (
        executeInspection.mock.calls.length ===
          REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS
      ) readyToSubmit = true;
      return { status: "completed" };
    });
    const inspect = defineBedrockConverseTool({
      name: "inspect_repository_snapshot",
      description: "Inspect the pinned repository snapshot.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: executeInspection,
    });
    let submitted = false;
    const executeSubmission = vi.fn(async () => {
      submitted = true;
      return { status: "accepted" };
    });
    const submit = defineBedrockConverseTool({
      name: "submit_repository_independent_review",
      description: "Submit the blind repository review.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: executeSubmission,
    });
    const agent = new BedrockConverseAgent(transport, { modelId: "test-verifier" });

    const result = await agent.run({
      messages: [{ role: "user", content: [{ text: "Review this repository." }] }],
      tools: [inspect, submit],
      limits: repositoryCoverageReviewPhaseLimits(77),
      forceTool: () => repositoryVerifierForcedSubmissionTool({
        inspectionToolCalls: executeInspection.mock.calls.length,
        maxInspectionToolCalls:
          REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
        maxRepairInspectionToolCalls:
          REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS -
          REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
        readyToSubmit,
        submitted,
        toolName: "submit_repository_independent_review",
        inspectionToolName: "inspect_repository_snapshot",
      }),
    });

    expect(executeInspection).toHaveBeenCalledTimes(
      REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
    );
    expect(executeSubmission).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Review submitted.");
    expect(transport.converse.mock.calls[3]?.[0].toolConfig?.toolChoice).toEqual({
      tool: { name: "inspect_repository_snapshot" },
    });
    expect(transport.converse.mock.calls[4]?.[0].toolConfig?.toolChoice).toEqual({
      tool: { name: "submit_repository_independent_review" },
    });
    expect(transport.converse.mock.calls[5]?.[0].toolConfig?.toolChoice).toBeUndefined();
  });

  it("repairs source provenance between a rejected and accepted blind submission", async () => {
    const replayedUsage = {
      inputTokens: 18_000,
      outputTokens: 2_000,
      totalTokens: 20_000,
    };
    const inspectionResponses: BedrockConverseTransportResponse[] = Array.from(
      { length: REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS },
      (_, index) => ({
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: `inspect-${index + 1}`,
              name: "inspect_repository_snapshot",
              input: {},
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: `request-${index + 1}`,
      }),
    );
    const responses: BedrockConverseTransportResponse[] = [
      ...inspectionResponses,
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "submit-rejected",
              name: "submit_repository_independent_review",
              input: { corrected: false },
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: "request-submit-rejected",
      },
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "inspect-source-repair",
              name: "inspect_repository_snapshot",
              input: {},
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: "request-inspect-source-repair",
      },
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "submit-corrected",
              name: "submit_repository_independent_review",
              input: { corrected: true },
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: "request-submit-corrected",
      },
    ];
    let responseIndex = 0;
    const transport = {
      converse: vi.fn(async (_input: ConverseCommandInput) => {
        void _input;
        const response = responses[responseIndex++];
        if (!response) throw new Error("Unexpected verifier model turn.");
        return response;
      }),
    };
    let sourceRepairRequired = false;
    const executeInspection = vi.fn(async () => {
      if (sourceRepairRequired) sourceRepairRequired = false;
      return { status: "completed" };
    });
    const inspect = defineBedrockConverseTool({
      name: "inspect_repository_snapshot",
      description: "Inspect the pinned repository snapshot.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: executeInspection,
    });
    let submitted = false;
    let contractSubmissionRejectionCount = 0;
    const executeSubmission = vi.fn(async ({ corrected }: { corrected: boolean }) => {
      submitted = corrected;
      if (corrected) return { status: "accepted" };
      contractSubmissionRejectionCount += 1;
      sourceRepairRequired = repositoryVerifierSubmissionNeedsSourceRepair({
        codes: ["evidence_range_not_visible"],
        inspectionToolCalls: executeInspection.mock.calls.length,
        maxTotalInspectionToolCalls:
          REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
        contractSubmissionRejectionCount,
      });
      return {
        status: "rejected",
        instruction: "Inspect the missing exact source range, then resubmit.",
      };
    });
    const submit = defineBedrockConverseTool({
      name: "submit_repository_independent_review",
      description: "Submit the blind repository review.",
      inputSchema: z.object({ corrected: z.boolean() }),
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["corrected"],
        properties: { corrected: { type: "boolean" } },
      },
      isTerminalResult: (result) =>
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        result.status === "accepted",
      execute: executeSubmission,
    });
    const agent = new BedrockConverseAgent(transport, { modelId: "test-verifier" });

    const result = await agent.run({
      messages: [{ role: "user", content: [{ text: "Review this repository." }] }],
      tools: [inspect, submit],
      limits: repositoryCoverageReviewPhaseLimits(77),
      forceTool: () => repositoryVerifierForcedSubmissionTool({
        inspectionToolCalls: executeInspection.mock.calls.length,
        maxInspectionToolCalls:
          REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
        maxRepairInspectionToolCalls:
          REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS -
          REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS,
        readyToSubmit: true,
        repairRequired: sourceRepairRequired,
        submitted,
        toolName: "submit_repository_independent_review",
        inspectionToolName: "inspect_repository_snapshot",
      }),
    });

    expect(executeInspection).toHaveBeenCalledTimes(
      REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS,
    );
    expect(executeSubmission).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(
      REPOSITORY_VERIFIER_MAX_REVIEW_TOTAL_INSPECTION_TOOL_CALLS + 2,
    );
    expect(result.usage.totalTokens).toBe(120_000);
    expect(result.text).toBe("");
    expect(result.terminalTool?.name).toBe(
      "submit_repository_independent_review",
    );
    expect(transport.converse.mock.calls[3]?.[0].toolConfig?.toolChoice).toEqual({
      tool: { name: "submit_repository_independent_review" },
    });
    expect(transport.converse.mock.calls[4]?.[0].toolConfig?.toolChoice).toEqual({
      tool: { name: "inspect_repository_snapshot" },
    });
    expect(transport.converse.mock.calls[5]?.[0].toolConfig?.toolChoice).toEqual({
      tool: { name: "submit_repository_independent_review" },
    });
    expect(transport.converse.mock.calls[6]).toBeUndefined();
  });

  it("keeps raw transcript headroom for one candidate-audit correction", async () => {
    const replayedUsage = {
      inputTokens: 30_000,
      outputTokens: 2_000,
      totalTokens: 32_000,
    };
    const inspectionResponses: BedrockConverseTransportResponse[] = Array.from(
      { length: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS },
      (_, index) => ({
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: `candidate-inspect-${index + 1}`,
              name: "inspect_repository_snapshot",
              input: {},
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: `candidate-request-${index + 1}`,
      }),
    );
    const responses: BedrockConverseTransportResponse[] = [
      ...inspectionResponses,
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "candidate-submit-rejected",
              name: "submit_repository_coverage_audit",
              input: { corrected: false },
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: "candidate-request-submit-rejected",
      },
      {
        message: {
          role: "assistant",
          content: [{
            toolUse: {
              toolUseId: "candidate-submit-corrected",
              name: "submit_repository_coverage_audit",
              input: { corrected: true },
            },
          }],
        },
        stopReason: "tool_use",
        usage: replayedUsage,
        requestId: "candidate-request-submit-corrected",
      },
    ];
    let responseIndex = 0;
    const transport = {
      converse: vi.fn(async (_input: ConverseCommandInput) => {
        void _input;
        const response = responses[responseIndex++];
        if (!response) throw new Error("Unexpected candidate verifier turn.");
        return response;
      }),
    };
    const executeInspection = vi.fn(async () => ({ status: "completed" }));
    const inspect = defineBedrockConverseTool({
      name: "inspect_repository_snapshot",
      description: "Inspect the pinned repository snapshot.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: executeInspection,
    });
    let submitted = false;
    const executeSubmission = vi.fn(async ({ corrected }: { corrected: boolean }) => {
      submitted = corrected;
      return corrected
        ? { status: "accepted" }
        : {
            status: "rejected",
            instruction: "Correct the bounded contract diagnostic and resubmit.",
          };
    });
    const submit = defineBedrockConverseTool({
      name: "submit_repository_coverage_audit",
      description: "Submit the source-grounded candidate audit.",
      inputSchema: z.object({ corrected: z.boolean() }),
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["corrected"],
        properties: { corrected: { type: "boolean" } },
      },
      isTerminalResult: (result) =>
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        result.status === "accepted",
      execute: executeSubmission,
    });
    const agent = new BedrockConverseAgent(transport, { modelId: "test-verifier" });
    const longCandidatePacket = "candidate evidence ".repeat(2_500);

    const result = await agent.run({
      messages: [{ role: "user", content: [{ text: longCandidatePacket }] }],
      tools: [inspect, submit],
      limits: repositoryCoverageAuditPhaseLimits(77),
      forceTool: () => repositoryVerifierForcedSubmissionTool({
        inspectionToolCalls: executeInspection.mock.calls.length,
        maxInspectionToolCalls: REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
        readyToSubmit:
          executeInspection.mock.calls.length >=
            REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS,
        submitted,
        toolName: "submit_repository_coverage_audit",
        inspectionToolName: "inspect_repository_snapshot",
      }),
    });

    const correctionRequest = transport.converse.mock.calls[5]?.[0];
    expect(correctionRequest).toBeDefined();
    const correctionProjection = 5 * replayedUsage.totalTokens +
      estimateBedrockConverseInputTokens({
        messages: correctionRequest?.messages ?? [],
        tools: [inspect, submit],
      });
    expect(correctionProjection).toBeGreaterThan(170_000);
    expect(correctionProjection).toBeLessThan(230_000);
    expect(executeSubmission).toHaveBeenCalledTimes(2);
    expect(result.usage.totalTokens).toBe(192_000);
    expect(result.terminalTool?.name).toBe("submit_repository_coverage_audit");
    expect(transport.converse).toHaveBeenCalledTimes(6);
  });

  it("preserves a validated terminal notebook when the redundant model turn hits token preflight", async () => {
    const { state, evidence } = investigationState();
    const seedNotebook = structuredClone(state.notebook);
    const executeUpdate = vi.fn(async () => {
      const applied = applyRepositoryInvestigationNotebookUpdate({
        state,
        update: notebookUpdate(evidence.evidenceId),
      });
      if (!applied.accepted) throw new Error("Expected the terminal update to pass.");
      return { status: "accepted", done: true, unresolvedAreaCount: 0 };
    });
    const update = defineBedrockConverseTool({
      name: "update_repository_notebook",
      description: "Persist the validated repository notebook.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: executeUpdate,
    });
    const transport = {
      converse: vi.fn(async () => ({
        message: {
          role: "assistant" as const,
          content: [{
            toolUse: {
              toolUseId: "terminal-update",
              name: "update_repository_notebook",
              input: {},
            },
          }],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "request-terminal-update",
      })),
    };
    const agent = new BedrockConverseAgent(transport, { modelId: "test-investigator" });
    let preflightError: unknown;
    try {
      await agent.run({
        messages: [{ role: "user", content: [{ text: "Finish the notebook." }] }],
        tools: [update],
        limits: { maxIterations: 4, maxToolCalls: 3, maxTotalTokens: 20 },
      });
    } catch (error) {
      preflightError = error;
    }

    expect(executeUpdate).toHaveBeenCalledTimes(1);
    expect(transport.converse).toHaveBeenCalledTimes(1);
    expect(preflightError).toMatchObject({ code: "token_limit_exceeded" });
    expect(state.notebook).toMatchObject({ done: true, unresolvedAreas: [] });
    const recovery = recoverRepositoryInvestigatorAgentBudgetError({
      error: preflightError,
      seedNotebook,
      notebook: state.notebook,
      configuredIdentity: { provider: "openrouter", modelId: "test-investigator" },
    });
    expect(recovery).toMatchObject({
      notebook: { done: true, unresolvedAreas: [] },
      terminationReason: "investigator_done",
      capacityLimitation: null,
    });
    if (!recovery) throw new Error("Expected terminal notebook recovery.");
    const context = {
      refreshRunId: "refresh-terminal-recovery",
      snapshotId: "snapshot-terminal-recovery",
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
      notebook: recovery.notebook,
      checkpointKind: "final",
      generationRunId: "generation-terminal-recovery",
      terminationReason: recovery.terminationReason,
      capacityLimitation: recovery.capacityLimitation,
      sourceInspection: buildRepositorySourceInspectionAttestation({
        evidence: [evidence],
        visibleRanges: state.visibleEvidenceRanges,
      }),
      agentToolTrace: [{
        iteration: 1,
        toolCall: 1,
        toolName: "update_repository_notebook",
        outcome: "success",
      }],
    });

    expect(checkpoint).toMatchObject({
      checkpointKind: "final",
      terminationReason: "investigator_done",
      capacityLimitation: null,
      notebook: { done: true, unresolvedAreas: [] },
    });
    expect(recovery.result.text).toContain("validated repository notebook");

    const nonterminalRecovery = recoverRepositoryInvestigatorAgentBudgetError({
      error: preflightError,
      seedNotebook,
      notebook: { ...state.notebook, done: false },
      configuredIdentity: { provider: "openrouter", modelId: "test-investigator" },
    });
    expect(nonterminalRecovery).toMatchObject({
      notebook: { done: false },
      terminationReason: "agent_phase_budget_exhausted",
      capacityLimitation: "token_limit_exceeded",
    });
    expect(recoverRepositoryInvestigatorAgentBudgetError({
      error: preflightError,
      seedNotebook,
      notebook: { ...seedNotebook, done: true },
      configuredIdentity: { provider: "openrouter", modelId: "test-investigator" },
    })).toBeNull();
  });

  it("still shares semantic work across independent verifier contexts", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 50_000,
      maxModelCalls: 12,
      maxInspectionOperations: 40,
    });
    const review = budget.phaseLimits(
      repositoryCoverageReviewPhaseLimits(77),
      12_000,
      { modelTokens: 18_000, modelCalls: 6 },
      { preserveRawTokenLimit: true },
    );

    expect(review).toMatchObject({
      maxTotalTokens: 170_000,
      maxSemanticTokens: 32_000,
    });
    budget.consumeModelUsage({
      usage: {
        inputTokens: 38_000,
        outputTokens: 2_000,
        totalTokens: 40_000,
        cacheReadInputTokens: 14_000,
        providerAttemptCount: 5,
      },
    });

    expect(budget.phaseLimits(
      repositoryCoverageAuditPhaseLimits(77),
      18_000,
      { modelTokens: 0, modelCalls: 0 },
      { preserveRawTokenLimit: true },
    )).toMatchObject({
      maxTotalTokens: 230_000,
      maxSemanticTokens: 24_000,
    });
  });

  it("keeps repair context replay separate from its semantic allowance and re-audit reserve", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 280_000,
      maxModelCalls: 71,
      maxInspectionOperations: 110,
    }, { modelTokens: 230_000, modelCalls: 43, inspectionOperations: 67 });
    const policy = repositoryInvestigationPhaseBudget("verifier_repair");
    const limits = budget.phaseLimits({
      maxIterations: 12, maxToolCalls: 10, maxTotalTokens: 110_000,
    }, policy.minimum.modelTokens, policy.reserve, {
      preserveRawTokenLimit: true,
      acceptTerminalToolAtIterationLimit: true,
    });
    expect(limits).toMatchObject({ maxTotalTokens: 110_000, maxSemanticTokens: 32_000 });
    budget.consumeModelUsage({ usage: {
      inputTokens: 70_000, outputTokens: 5_000, totalTokens: 75_000,
      cacheReadInputTokens: 50_000, providerAttemptCount: 4,
    } });
    // A useful repair may replay more raw context than the remaining work
    // allowance, but only its 25k uncached tokens consume that allowance.
    expect(budget.snapshot().remaining.modelTokens).toBe(25_000);
    const reaudit = repositoryInvestigationPhaseBudget("candidate_reaudit");
    expect(budget.canStart({
      minimumTokens: reaudit.minimum.modelTokens,
      minimumModelCalls: reaudit.minimum.modelCalls,
      minimumInspectionOperations: reaudit.minimum.inspectionOperations,
    })).toBe(true);
    budget.consumeModelUsage({ usage: { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 } });
    expect(budget.phaseLimits({
      maxIterations: 12, maxToolCalls: 10, maxTotalTokens: 110_000,
    }, policy.minimum.modelTokens, policy.reserve, { preserveRawTokenLimit: true })).toBeNull();
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

  it.each([
    { done: true, phaseComplete: false },
    { done: false, phaseComplete: true },
  ])("ends a persisted notebook update without a handoff model call: %j", async (completion) => {
    const persist = vi.fn(async () => ({ status: "accepted", ...completion }));
    const tool = defineBedrockConverseTool({
      name: "update_repository_notebook",
      description: "Persist the notebook before completing its phase.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      isTerminalResult: repositoryInvestigationNotebookUpdateIsTerminal,
      execute: persist,
    });
    const transport = { converse: vi.fn(async () => ({
      message: { role: "assistant" as const, content: [{ toolUse: {
        toolUseId: "checkpoint", name: tool.name, input: {},
      } }] },
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      requestId: "persisted-checkpoint-request",
    })) };
    const agent = new BedrockConverseAgent(transport, { modelId: "test-investigator" });
    const result = await agent.run({
      messages: [{ role: "user", content: [{ text: "Save the investigation." }] }],
      tools: [tool],
      limits: { maxIterations: 1, maxToolCalls: 1, maxTotalTokens: 10_000 },
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(transport.converse).toHaveBeenCalledTimes(1);
    expect(result.terminalTool?.name).toBe(tool.name);
    expect(result.usage.totalTokens).toBe(15);
  });

  it.each(["intermediate", "rejected", "persistence_failure"])(
    "does not complete a phase after an %s update",
    async (firstOutcome) => {
      const persist = vi.fn(async () => {
        if (persist.mock.calls.length === 1) {
          if (firstOutcome === "persistence_failure") throw new Error("Persistence failed.");
          return { status: firstOutcome === "rejected" ? "rejected" : "accepted", done: false, phaseComplete: false };
        }
        return { status: "accepted", done: true, phaseComplete: false };
      });
      const tool = defineBedrockConverseTool({
        name: "update_repository_notebook",
        description: "Persist a validated notebook.",
        inputSchema: z.object({}),
        jsonSchema: { type: "object", properties: {} },
        isTerminalResult: repositoryInvestigationNotebookUpdateIsTerminal,
        execute: persist,
      });
      const transport = { converse: vi.fn(async () => ({
        message: { role: "assistant" as const, content: [{ toolUse: {
          toolUseId: `checkpoint-${persist.mock.calls.length}`, name: tool.name, input: {},
        } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: `checkpoint-request-${persist.mock.calls.length}`,
      })) };
      const result = await new BedrockConverseAgent(transport, { modelId: "test-investigator" }).run({
        messages: [{ role: "user", content: [{ text: "Save the investigation." }] }],
        tools: [tool],
      });
      expect(persist).toHaveBeenCalledTimes(2);
      expect(transport.converse).toHaveBeenCalledTimes(2);
      expect(result.terminalTool?.name).toBe(tool.name);
    },
  );

  it("selects the durable checkpoint tool after three inspections and ends on persistence", async () => {
    let inspections = 0;
    const inspect = defineBedrockConverseTool({
      name: "inspect_repository_snapshot", description: "Inspect pinned source.",
      inputSchema: z.object({}), jsonSchema: { type: "object", properties: {} },
      execute: () => { inspections += 1; return { status: "inspected" }; },
    });
    const checkpoint = defineBedrockConverseTool({
      name: "update_repository_notebook", description: "Persist notebook.",
      inputSchema: z.object({}), jsonSchema: { type: "object", properties: {} },
      isTerminalResult: repositoryInvestigationNotebookUpdateIsTerminal,
      execute: () => ({ status: "accepted", done: false, phaseComplete: true }),
    });
    const transport = { converse: vi.fn(async (input: ConverseCommandInput) => {
      const forced = input.toolConfig?.toolChoice?.tool?.name;
      if (inspections === 3) expect(forced).toBe(checkpoint.name);
      else expect(forced).toBeUndefined();
      return {
        message: { role: "assistant" as const, content: [{ toolUse: {
          toolUseId: `step-${inspections}`, name: forced ?? inspect.name, input: {},
        } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: `inspection-request-${inspections}`,
      };
    }) };
    const result = await new BedrockConverseAgent(transport, { modelId: "test-investigator" }).run({
      messages: [{ role: "user", content: [{ text: "Investigate pinned source." }] }],
      tools: [inspect, checkpoint],
      forceTool: () => repositoryInvestigationPhaseInspectionAction({
        inspectionToolCalls: inspections, inspectionToolCallsAtLastCheckpoint: 0,
        checkpointYieldRequested: false,
      }) === "checkpoint" ? checkpoint.name : undefined,
    });
    expect(inspections).toBe(3);
    expect(transport.converse).toHaveBeenCalledTimes(4);
    expect(result.terminalTool?.name).toBe(checkpoint.name);
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

    const original = structuredClone(result.notebook);
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
        blobSha,
      }],
    });
    expect(compact.findings[0]?.evidence[0]).toEqual({
      path: "src/session.ts", blobSha, lineStart: 1, lineEnd: 4,
    });
    expect(compact.capabilities).toEqual(original.capabilities);
    expect(compact.unresolvedAreas).toEqual(original.unresolvedAreas);
    expect(compact.findings.map((finding) => ({ ...finding, evidence: undefined }))).toEqual(
      original.findings.map((finding) => ({ ...finding, evidence: undefined })),
    );
    expect(result.notebook).toEqual(original);
    expect(result.notebook.findings[0]?.evidence[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    for (const key of ["evidenceId", "fileSnapshotId", "excerptHash", "outputHash", "evidenceVersion", "redactionPolicyVersion"]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    const oldPacket = { ...compact, findings: original.findings.map((finding) => ({
      ...finding,
      evidence: finding.evidence.map((evidence) => Object.fromEntries(
        Object.entries(evidence).filter(([key]) => key !== "excerpt"),
      )),
    })) };
    expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(JSON.stringify(oldPacket)));
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
    expect(request.systemPrompt).toContain(repositoryInvestigationMaterialityGuidance);
    expect(request.systemPrompt).toContain("8192 bytes of source");
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
    const freshSourceReads = [{ status: "completed", source: "1: freshly fetched source" }];
    const freshRequest = candidateCoverageAuditRequest({
      projectTitle: "Project", notebook, independentReview: fixture.checkpoint, freshSourceReads,
    });
    expect(JSON.parse(freshRequest.userPrompt).freshSourceReads).toEqual(freshSourceReads);
    expect(freshRequest.userPrompt).not.toContain(sourceExcerptCanary);
    expect(freshRequest.systemPrompt).toContain("do not request an identical range again");
    const candidate = repositoryCoverageCandidatePacket(notebook);
    expect(candidate.candidateClaims[0]?.sources).toEqual(
      notebook.findings[0]!.evidence.map(({ path, blobSha, lineStart, lineEnd }) => ({
        path, blobSha, lineStart, lineEnd,
      })),
    );
    expect(request.systemPrompt).toContain("Evaluate the union of related candidate findings");
    expect(request.systemPrompt).toContain("navigation pointers, not proof");
    expect(request.systemPrompt).toContain(repositoryInvestigationMaterialityGuidance);
    expect(request.systemPrompt).toContain("only incidental detail remains");
    expect(request.systemPrompt).toContain("Preserve real security, authorization, state, and data-integrity distinctions");
  });

  it("numbers source snippets at their original offsets without changing durable evidence", () => {
    const { evidence } = investigationState({
      output: ["// context", "export function run() {", "", "  return 'café';", "}"].join("\n"),
    });
    const segment = expandProjectRepositoryEvidence({
      evidence, startLine: 2, maximumLines: 4, maximumBytes: 8192,
    })!;
    const original = structuredClone(segment);
    const projected = repositoryInspectionSegmentForModel(segment);
    expect(projected.excerpt).toBe("2: export function run() {\n3: \n4:   return 'café';\n5: }");
    expect(projected.citationByteLimit).toBe(8192);
    expect(projected.evidenceId).toBe(evidence.evidenceId);
    expect(projected.startLine).toBe(2);
    expect(projected.endLine).toBe(5);
    expect(segment).toEqual(original);
    expect(evidence.output).not.toContain("2: export");
  });

  it("plans fresh required source reads once, within batch limits and without trusting another snapshot", () => {
    const { state, evidence } = investigationState();
    const target = { path: "src/session.ts", blobSha, lineStart: 1, lineEnd: 4 };
    const empty = buildRepositorySourceInspectionAttestation({ evidence: [], visibleRanges: [] });
    const input = {
      target: state.notebook, targets: [target, target, { ...target, path: "src/other.ts" }],
      evidence: [], sourceInspection: empty, attemptedRequests: new Set<string>(), maxQueries: 1, maxExpansions: 1,
    };
    const batch = repositoryVerifierRequiredReadBatch(input);
    expect(batch.repositoryQueries).toEqual([{ args: ["show", "HEAD:src/session.ts"] }]);
    expect(batch.repositoryExpansions).toEqual([]);
    expect(repositoryVerifierRequiredReadBatch({ ...input, attemptedRequests: new Set(batch.requestKeys) }).repositoryQueries)
      .toEqual([{ args: ["show", "HEAD:src/other.ts"] }]);
    const original = structuredClone(evidence);
    const expansion = repositoryVerifierRequiredReadBatch({ ...input, targets: [target, target], evidence: [evidence] });
    expect(expansion.repositoryQueries).toEqual([]);
    expect(expansion.repositoryExpansions).toEqual([{ evidenceId: evidence.evidenceId, startLine: 1, maxLines: 4 }]);
    expect(repositoryVerifierRequiredReadBatch({ ...input, evidence: [evidence], targets: [target], attemptedRequests: new Set(expansion.requestKeys) }).requestKeys).toEqual([]);
    const inspected = buildRepositorySourceInspectionAttestation({ evidence: [evidence], visibleRanges: state.visibleEvidenceRanges });
    expect(repositoryVerifierRequiredReadBatch({ ...input, targets: [target], evidence: [evidence], sourceInspection: inspected }).requestKeys).toEqual([]);
    for (const mismatched of [{ ...evidence, commitSha: "c".repeat(40) }, { ...evidence, sourceId: "other-source" }, { ...evidence, exitCode: 128 }]) {
      expect(repositoryVerifierRequiredReadBatch({ ...input, evidence: [mismatched] }).repositoryQueries).toEqual(batch.repositoryQueries);
    }
    expect(evidence).toEqual(original);
    expect(repositoryVerifierRequiredReadBatch({ ...input, evidence: [evidence], targets: [{ ...target, lineEnd: 241 }] }).requestKeys).toEqual([]);
  });

  it("explains oversized citations without admitting or silently shortening them", () => {
    const { state, evidence } = investigationState({ output: "x".repeat(9000) });
    const diagnostics = repositoryVerifierIndependentSubmissionDiagnostics({
      ...state,
      target: state.notebook,
      independentObservations: [{
        kind: "operation", statement: "A claimed operation in an oversized source line.",
        evidence: { evidenceId: evidence.evidenceId, lineStart: 1, lineEnd: 1 },
      }],
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      code: "evidence_excerpt_too_large",
      instruction: expect.stringContaining("9000 bytes, exceeding the 8192-byte citation limit"),
    })]);
    expect(diagnostics[0]?.instruction).toContain("Re-reading the same oversized range does not fix this");
  });

  it("carries compact previous decisions into re-audit without turning them into source evidence", () => {
    const fixture = verifierFixture();
    const request = candidateCoverageAuditRequest({
      projectTitle: "Project", notebook: fixture.notebook, independentReview: fixture.checkpoint,
      previousAudit: {
        status: "satisfied", rationale: "Prior assessment", capabilityChecks: [], missingOperations: [],
        independentObservationChecks: [{
          observationDigest: repositoryVerifierIndependentObservationDigest(fixture.independentObservations[0]!),
          verdict: "covered_by_candidate", matchedFindingIds: ["creates_persisted_sessions"], missingOperationId: "",
          reason: "Previous source check", evidence: { evidenceId: fixture.evidence.evidenceId, lineStart: 1, lineEnd: 4 },
        }],
      },
    });
    const previous = JSON.parse(request.userPrompt).previousAssessment;
    expect(previous.observations[0]).toEqual({ observationId: "obs_1", verdict: "covered_by_candidate", missingOperationId: "" });
    expect(previous.gaps).toEqual([]);
    expect(JSON.stringify(previous)).not.toContain("evidenceId");
    expect(JSON.stringify(previous)).not.toContain("observationDigest");
    expect(request.systemPrompt).toContain("not evidence or binding verdicts");
    expect(request.systemPrompt).toContain("still perform the required fresh reads");
    expect(request.systemPrompt).toContain("correct a prior verdict when source justifies it");
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
      target: fixture.target,
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
      target: fixture.target,
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
    const incorrectExactRange = validateRepositoryCoverageAuditContract({
      audit: {
        ...audit,
        capabilityChecks: audit.capabilityChecks.map((check) => ({
          ...check,
          evidence: { ...check.evidence, lineStart: 2 },
        })),
      },
      notebook: fixture.notebook,
      sourceInspection: candidatePhaseInspection,
      targets,
      requireDiscovery: false,
      independentReview: fixture.checkpoint,
    });
    expect(incorrectExactRange).toMatchObject({
      accepted: false,
      errors: [expect.stringContaining("set evidence exactly to")],
    });
    if (incorrectExactRange.accepted) {
      throw new Error("Expected the altered exact range to fail closed.");
    }
    expect(incorrectExactRange.errors[0]).toContain(fixture.evidence.evidenceId);
    expect(incorrectExactRange.errors[0]).toContain('"lineStart":1');
    expect(incorrectExactRange.errors[0]).toContain('"lineEnd":4');
    expect(incorrectExactRange.errors[0]).not.toContain(
      `set evidence exactly to {"evidenceId":"${fixture.evidence.evidenceId}","path"`,
    );
  });

  it("links a gap to its observation while allowing better evidence from a different file", () => {
    const fixture = verifierFixture();
    const gapSource = createProjectRepositoryRawEvidence({
      sourceId: fixture.target.sourceId,
      repository: fixture.target.repository,
      commitSha,
      args: ["show", "HEAD:src/session-consumer.ts"],
      output: "export function useSession(session) {\n  return session.userId;\n}\n",
      target: { kind: "blob", commitSha, path: "src/session-consumer.ts", blobSha: "d".repeat(40) },
      exitCode: 0,
    });
    const sourceInspection = buildRepositorySourceInspectionAttestation({
      evidence: [fixture.evidence, gapSource],
      visibleRanges: [
        { evidenceId: fixture.evidence.evidenceId, startLine: 1, endLine: 4 },
        { evidenceId: gapSource.evidenceId, startLine: 1, endLine: 3 },
      ],
    });
    const audit = {
      status: "gaps" as const,
      capabilityChecks: [],
      independentObservationChecks: [{
        observationDigest: repositoryVerifierIndependentObservationDigest(
          fixture.checkpoint.independentObservations[0]!,
        ),
        verdict: "material_gap" as const,
        reason: "Session creation is described but its consumer's validation boundary is missing.",
        matchedFindingIds: [],
        missingOperationId: "session_validation_boundary",
        evidence: fixture.checkpoint.independentObservations[0]!.evidence,
      }],
      missingOperations: [{
        id: "session_validation_boundary",
        label: "Session validation boundary",
        reason: "The consumer returns the session user ID without checking expiration.",
        importance: "major" as const,
        searchTerms: ["useSession"],
        pathHints: ["src/session-consumer.ts"],
        evidence: { evidenceId: gapSource.evidenceId, lineStart: 1, lineEnd: 3 },
      }],
      rationale: "Follow the created session into its consumer to retain the material boundary.",
    };
    const validate = (candidate = audit) => validateRepositoryCoverageAuditContract({
      audit: candidate,
      notebook: fixture.notebook,
      sourceInspection,
      targets: [],
      requireDiscovery: false,
      independentReview: fixture.checkpoint,
    });
    expect(validate()).toEqual({ accepted: true });
    expect(validate({ ...audit, missingOperations: [] })).toMatchObject({
      accepted: false,
      errors: [expect.stringContaining("does not link a submitted missing operation")],
    });
    expect(validate({
      ...audit,
      missingOperations: [{
        ...audit.missingOperations[0]!,
        evidence: { evidenceId: "uninspected-source", lineStart: 1, lineEnd: 3 },
      }],
    })).toMatchObject({
      accepted: false,
      errors: [expect.stringContaining("not tied to a visible exact pinned verifier read")],
    });
  });

  it("binds known review decisions to fresh exact citations without asking the model to copy ranges", () => {
    const fixture = verifierFixture();
    const finding = fixture.notebook.findings[0]!;
    const submission = repositoryCoverageAuditSubmissionSchema.parse({
      status: "satisfied",
      capabilityChecks: [{
        capabilityKey: finding.capabilityKeys[0],
        findingId: finding.id,
        verdict: "supported",
        reason: "The exact implementation range supports this session operation.",
      }],
      independentObservationChecks: [{
        observationId: "obs_1",
        verdict: "covered_by_candidate",
        reason: "The candidate captures the independently observed session operation.",
        matchedFindingIds: [finding.id],
        missingOperationId: "",
      }],
      missingOperations: [],
      rationale: "The independently observed operation is supported by fresh source reads.",
    });
    const sourceInspection = {
      ...fixture.sourceInspection,
      readSet: fixture.sourceInspection.readSet.map((read) => ({
        ...read,
        evidenceId: "fresh-candidate-evidence-1234",
      })),
    };
    const resolve = (overrides: Partial<Parameters<typeof resolveRepositoryCoverageAuditSubmission>[0]> = {}) =>
      resolveRepositoryCoverageAuditSubmission({
        submission,
        notebook: fixture.notebook,
        sourceInspection,
        independentReview: fixture.checkpoint,
        ...overrides,
      });
    const resolved = resolve();
    expect(resolved.accepted).toBe(true);
    if (!resolved.accepted) throw new Error(resolved.errors.join("; "));
    expect(resolved.audit.capabilityChecks[0]?.evidence).toEqual({
      evidenceId: "fresh-candidate-evidence-1234",
      lineStart: finding.evidence[0]!.lineStart,
      lineEnd: finding.evidence[0]!.lineEnd,
    });
    expect(resolved.audit.independentObservationChecks[0]?.evidence).toEqual({
      evidenceId: "fresh-candidate-evidence-1234",
      lineStart: 1,
      lineEnd: 4,
    });
    expect(resolved.audit.independentObservationChecks[0]?.observationDigest).toBe(
      repositoryVerifierIndependentObservationDigest(fixture.checkpoint.independentObservations[0]!),
    );
    expect(resolved.audit.independentObservationChecks[0]).not.toHaveProperty("observationId");
    expect(validateRepositoryCoverageAuditContract({
      audit: resolved.audit,
      notebook: fixture.notebook,
      sourceInspection,
      independentReview: fixture.checkpoint,
    })).toEqual({ accepted: true });

    for (const readSet of [
      [],
      sourceInspection.readSet.map((read) => ({ ...read, lineEnd: 3 })),
      sourceInspection.readSet.map((read) => ({ ...read, blobSha: "e".repeat(40) })),
      sourceInspection.readSet.map((read) => ({ ...read, commitSha: "f".repeat(40) })),
      sourceInspection.readSet.map((read) => ({ ...read, sourceId: "other-source" })),
    ]) {
      expect(resolve({ sourceInspection: { ...sourceInspection, readSet } })).toMatchObject({
        accepted: false,
        errors: expect.arrayContaining([expect.stringContaining("no fresh exact pinned read")]),
      });
    }
    expect(resolve({ submission: {
      ...submission,
      capabilityChecks: [{ ...submission.capabilityChecks[0]!, findingId: "unknown_finding" }],
    } })).toMatchObject({ accepted: false });
    expect(resolve({ submission: {
      ...submission,
      independentObservationChecks: [{
        ...submission.independentObservationChecks[0]!, observationId: "obs_999",
      }],
    } })).toMatchObject({ accepted: false, errors: [expect.stringContaining("Unknown independent observation obs_999")] });
    // Host enrichment must not lose the existing cross-field verdict rules.
    expect(resolve({ submission: {
      ...submission,
      capabilityChecks: [{ ...submission.capabilityChecks[0]!, verdict: "unsupported" }],
    } })).toMatchObject({ accepted: false });
    expect(resolve({ submission: {
      ...submission,
      independentObservationChecks: [{ ...submission.independentObservationChecks[0]!, matchedFindingIds: [] }],
    } })).toMatchObject({ accepted: false });
    for (const decision of [
      { verdict: "covered_by_candidate" as const, matchedFindingIds: [], missingOperationId: "" },
      { verdict: "covered_by_candidate" as const, matchedFindingIds: [finding.id], missingOperationId: "remaining_gap" },
      { verdict: "material_gap" as const, matchedFindingIds: [finding.id], missingOperationId: "remaining_gap" },
      { verdict: "material_gap" as const, matchedFindingIds: [], missingOperationId: "" },
      { verdict: "not_material" as const, matchedFindingIds: [finding.id], missingOperationId: "" },
      { verdict: "not_material" as const, matchedFindingIds: [], missingOperationId: "remaining_gap" },
    ]) {
      const rejected = resolve({ submission: {
        ...submission,
        status: "gaps",
        independentObservationChecks: [{ ...submission.independentObservationChecks[0]!, ...decision }],
      } });
      expect(rejected).toMatchObject({ accepted: false });
      if (rejected.accepted) throw new Error("Invalid link combination was accepted.");
      expect(rejected.errors.join(" ")).toContain(`obs_1 (independentObservationChecks.0): ${decision.verdict}:`);
      expect(rejected.errors.join(" ")).toContain(`matchedFindingIds=${JSON.stringify(decision.matchedFindingIds)}`);
      expect(rejected.errors.join(" ")).toContain(`missingOperationId=${JSON.stringify(decision.missingOperationId)}`);
    }
    expect(candidateCoverageAuditRequest({
      projectTitle: "Generic session service",
      notebook: fixture.notebook,
      independentReview: fixture.checkpoint,
    }).systemPrompt).toContain("If related findings leave a material clause of an observation uncovered, use material_gap");

    const properties = repositoryCoverageAuditSubmissionJsonSchema.properties as Record<string, {
      items: { required: string[]; properties: Record<string, unknown> };
    }>;
    for (const name of ["capabilityChecks", "independentObservationChecks"]) {
      expect(properties[name]!.items.required).not.toContain("evidence");
      expect(properties[name]!.items.properties).not.toHaveProperty("evidence");
    }
    expect(properties.missingOperations!.items.required).toContain("evidence");
    expect(properties.independentObservationChecks!.items.required).toContain("observationId");
    expect(properties.independentObservationChecks!.items.properties).not.toHaveProperty("observationDigest");
    const secondObservation = {
      ...fixture.checkpoint.independentObservations[0]!,
      statement: "The operation returns the newly persisted session to its caller.",
    };
    const secondResolved = resolve({
      independentReview: {
        ...fixture.checkpoint,
        independentObservations: [...fixture.checkpoint.independentObservations, secondObservation],
      },
      submission: {
        ...submission,
        independentObservationChecks: [{ ...submission.independentObservationChecks[0]!, observationId: "obs_2" }],
      },
    });
    expect(secondResolved.accepted).toBe(true);
    if (!secondResolved.accepted) throw new Error(secondResolved.errors.join("; "));
    expect(secondResolved.audit.independentObservationChecks[0]?.observationDigest).toBe(
      repositoryVerifierIndependentObservationDigest(secondObservation),
    );
    const packet = JSON.parse(candidateCoverageAuditRequest({
      projectTitle: "Project",
      notebook: fixture.notebook,
      independentReview: fixture.checkpoint,
    }).userPrompt);
    expect(packet.independentObservations[0]).toMatchObject({ observationId: "obs_1" });
    expect(packet.independentObservations[0]).not.toHaveProperty("observationDigest");
    for (const observationId of ["obs_0", "obs_01", "obs_-1", "obs_1.5", "e".repeat(64)]) {
      expect(repositoryCoverageAuditSubmissionSchema.safeParse({
        ...submission,
        independentObservationChecks: [{ ...submission.independentObservationChecks[0], observationId }],
      }).success).toBe(false);
    }
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

    const blindKey = repositoryIndependentReviewIdempotencyKey({
      refreshRunId: "refresh-1",
      sourceId: fixture.target.sourceId,
      commitSha: fixture.target.commitSha,
      snapshotScopeDigest: fixture.snapshotScopeDigest,
    });
    expect(repositoryIndependentReviewIdempotencyKey({
      refreshRunId: "refresh-1",
      sourceId: fixture.target.sourceId,
      commitSha: fixture.target.commitSha,
      snapshotScopeDigest: fixture.snapshotScopeDigest,
    })).toBe(blindKey);
    expect(repositoryIndependentReviewIdempotencyKey({
      refreshRunId: "refresh-1",
      sourceId: fixture.target.sourceId,
      commitSha: fixture.target.commitSha,
      snapshotScopeDigest: "f".repeat(64),
    })).not.toBe(blindKey);
    expect(repositoryCandidateAuditIdempotencyKey({
      refreshRunId: "refresh-1",
      sourceId: fixture.target.sourceId,
      commitSha: fixture.target.commitSha,
      wave: 1,
      notebookDigest: "1".repeat(64),
    })).not.toBe(repositoryCandidateAuditIdempotencyKey({
      refreshRunId: "refresh-1",
      sourceId: fixture.target.sourceId,
      commitSha: fixture.target.commitSha,
      wave: 2,
      notebookDigest: "2".repeat(64),
    }));
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
      `Use up to ${REPOSITORY_VERIFIER_MAX_REVIEW_INSPECTION_TOOL_CALLS} normal inspect_repository_snapshot calls`,
    );
    expect(request.systemPrompt).toContain(
      "one final provenance-only repair call",
    );
    expect(request.systemPrompt).toContain(
      'begin each args array with "grep", "ls-tree", or "show", never "git"',
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
      `Use up to ${REPOSITORY_VERIFIER_MAX_INSPECTION_TOOL_CALLS} normal inspect_repository_snapshot calls`,
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
      target,
    })).toContain("review_repository_candidate next");
    expect(repositoryVerifierNextAction({
      inspectionToolCalls: 2,
      sourceInspection,
      candidateRevealed: true,
      candidateReviewAvailable: true,
      targets,
      target,
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
      target,
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

  it("only critiques an incomplete grounded notebook at investigator closeout", async () => {
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

    await expect(runRepositoryVerificationIfCandidate({
      notebook: incomplete,
      allowGroundedCloseout: true,
      verify,
    })).resolves.toEqual({ status: "called" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(prioritizedRepositoryInvestigationGaps(
      incomplete.unresolvedAreas,
    )).toEqual(incomplete.unresolvedAreas);

    await expect(runRepositoryVerificationIfCandidate({
      notebook: { ...result.notebook, done: false },
      allowGroundedCloseout: true,
      verify,
    })).resolves.toEqual({ status: "called" });
    expect(verify).toHaveBeenCalledTimes(2);

    await expect(runRepositoryVerificationIfCandidate({
      notebook: {
        ...incomplete,
        capabilities: [],
        findings: [],
      },
      allowGroundedCloseout: true,
      verify,
    })).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(2);
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

  it("adds the protected critic tail without reducing discovery capacity", () => {
    const initialReserve = repositoryInvestigationPhaseBudget(
      "initial_investigator",
    ).reserve;
    const tiers = [
      {
        files: 80,
        limits: { maxModelTokens: 280_000, maxModelCalls: 71, maxInspectionOperations: 110 },
        legacyDiscovery: { modelTokens: 210_000, modelCalls: 46, inspectionOperations: 82 },
      },
      {
        files: 81,
        limits: { maxModelTokens: 460_000, maxModelCalls: 103, maxInspectionOperations: 194 },
        legacyDiscovery: { modelTokens: 390_000, modelCalls: 78, inspectionOperations: 166 },
      },
      {
        files: 251,
        limits: { maxModelTokens: 760_000, maxModelCalls: 155, maxInspectionOperations: 314 },
        legacyDiscovery: { modelTokens: 690_000, modelCalls: 130, inspectionOperations: 286 },
      },
    ];

    for (const tier of tiers) {
      const limits = repositoryInvestigationSharedBudgetLimits({
        repositoryCount: 1,
        analyzedFileCount: tier.files,
      });
      expect(limits).toEqual(tier.limits);
      const discovery = {
        modelTokens: limits.maxModelTokens - initialReserve.modelTokens,
        modelCalls: limits.maxModelCalls - initialReserve.modelCalls,
        inspectionOperations:
          limits.maxInspectionOperations - initialReserve.inspectionOperations,
      };
      expect(discovery.modelTokens).toBeGreaterThanOrEqual(
        tier.legacyDiscovery.modelTokens,
      );
      expect(discovery.modelCalls).toBe(tier.legacyDiscovery.modelCalls);
      expect(discovery.inspectionOperations).toBe(
        tier.legacyDiscovery.inspectionOperations,
      );
    }

    const oneRepository = repositoryInvestigationSharedBudgetLimits({
      repositoryCount: 1,
      analyzedFileCount: 80,
    });
    const twoRepositories = repositoryInvestigationSharedBudgetLimits({
      repositoryCount: 2,
      analyzedFileCount: 80,
    });
    expect({
      modelTokens: twoRepositories.maxModelTokens - oneRepository.maxModelTokens,
      modelCalls: twoRepositories.maxModelCalls - oneRepository.maxModelCalls,
      inspectionOperations:
        twoRepositories.maxInspectionOperations -
        oneRepository.maxInspectionOperations,
    }).toEqual({ modelTokens: 64_000, modelCalls: 25, inspectionOperations: 28 });
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

  it("keeps empty 429 transport attempts out of semantic model-call capacity", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 20_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    const failedAttempts = Array.from({ length: 4 }, (_, index) => ({
      requestId: `req_rate_limited_${index + 1}`,
      httpStatus: 429,
      attemptDisposition: "empty_unbilled",
      retryable: true,
    }));
    budget.consumeModelUsage({
      usage: {
        attempts: [{
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          cost: 0.001,
        }],
        failedAttempts,
        providerAttemptCount: 5,
        unknownUsageAttempts: 4,
      },
    });

    expect(budget.snapshot()).toMatchObject({
      used: { modelCalls: 1 },
      remaining: { modelCalls: 3 },
    });
    expect(budget.canStart({
      minimumTokens: 1_000,
      minimumModelCalls: 3,
      minimumInspectionOperations: 1,
    })).toBe(true);
    expect(failedAttempts).toHaveLength(4);
  });

  it("uses logical iterations when provider-attempt usage is unavailable", () => {
    const budget = new RepositoryInvestigationSharedBudget({
      maxModelTokens: 20_000,
      maxModelCalls: 4,
      maxInspectionOperations: 8,
    });
    budget.consumeModelUsage({
      usage: null,
      fallbackModelCalls: 3,
    });

    expect(budget.snapshot()).toMatchObject({
      used: { modelCalls: 3 },
      remaining: { modelCalls: 1 },
    });
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
