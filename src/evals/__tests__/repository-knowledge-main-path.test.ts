import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  repositorySynthesisClaimContentDigest,
  repositorySynthesisCriticClaimContentDigest,
} from "@/src/domain/repository-synthesis-attestation";
import {
  evaluateRepositoryKnowledgeMainPath,
  repositoryVerifierTwoPhaseIntegrityIssues,
  type RepositoryKnowledgeGenerationAuditRecord,
} from "@/src/evals/repository-knowledge-main-path";
import { repositoryOperationCommunityMappingDigest } from "@/src/lib/repository-operation-community";

const expectedIdentities = {
  execution_routing: { provider: "bedrock", modelId: "routing-model" },
  semantic_extraction: { provider: "bedrock", modelId: "semantic-model" },
  semantic_repair: { provider: "bedrock", modelId: "semantic-model" },
  capability_synthesis: { provider: "bedrock", modelId: "synthesis-model" },
  coverage_audit: { provider: "bedrock", modelId: "verification-model" },
};
const expectedAgenticInvestigatorIdentity = {
  provider: "bedrock",
  modelId: "primary-answer-model",
};

function generation(
  kind: RepositoryKnowledgeGenerationAuditRecord["kind"],
  modelId: string,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
): RepositoryKnowledgeGenerationAuditRecord {
  const capabilitySynthesis = kind === "capability_synthesis";
  return {
    id: `generation-${kind}`,
    kind,
    status: "success",
    provider: "bedrock",
    modelId,
    inputSummary: capabilitySynthesis
      ? {
          phase: "synthesis",
          refreshRunId: "refresh-1",
          subsystemKeys: ["project_domain:payments#scope"],
        }
      : {},
    parsedOutput: capabilitySynthesis
      ? { subsystems: [{ subsystemKey: "project_domain:payments#scope", facts: [], highlights: [] }] }
      : {},
    resultRefs: {
      configuredModelId: modelId,
      requestIds: [`request-${kind}`],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
    },
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      unknownUsageAttempts: 0,
    },
    ...overrides,
  };
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function twoPhaseVerifierFixture(input: {
  sourceId: string;
  repository: string;
  commitSha: string;
  snapshotScopeDigest: string;
  notebookDigest: string;
  splitReads?: boolean;
}) {
  const discovery = {
    evidenceId: "evidence-discovery",
    command: "grep",
    args: ["workflow"],
    operationKind: "discovery",
    outputHash: "5".repeat(64),
  };
  const exactRead = {
    evidenceId: "evidence-verifier",
    command: "show",
    args: ["HEAD:src/session.ts"],
    operationKind: "exact_blob_read",
    outputHash: "4".repeat(64),
  };
  const readSet = [{
    evidenceId: "evidence-verifier",
    sourceId: input.sourceId,
    repository: input.repository,
    commitSha: input.commitSha,
    path: "src/session.ts",
    blobSha: "2".repeat(40),
    lineStart: 1,
    lineEnd: 4,
    excerptHash: "3".repeat(64),
    outputHash: "4".repeat(64),
    evidenceVersion: "repository-evidence-v1",
    redactionPolicyVersion: "repository-redaction-v1",
  }];
  if (input.splitReads) {
    readSet.push({ ...readSet[0]!, lineStart: 8, lineEnd: 10, excerptHash: "6".repeat(64) });
  }
  const sourceInspection = {
    sourceSearchTrace: [discovery, exactRead],
    readSet,
  };
  const candidateSourceInspection = {
    sourceSearchTrace: [exactRead],
    readSet,
  };
  const independentObservations = [{
    kind: "operation",
    statement: "The session workflow persists its durable state transition.",
    evidence: {
      evidenceId: "evidence-verifier",
      lineStart: 1,
      lineEnd: 4,
    },
  }];
  const checkpointPayload = {
    schemaVersion: "repository-verifier-independent-review-v1",
    sourceId: input.sourceId,
    repository: input.repository,
    commitSha: input.commitSha,
    snapshotScopeDigest: input.snapshotScopeDigest,
    sourceInspection,
    sourceInspectionDigest: digest(sourceInspection),
    independentObservations,
    independentObservationDigest: digest(independentObservations),
    inspectionToolCalls: 2,
  };
  const checkpoint = {
    ...checkpointPayload,
    checkpointDigest: digest(checkpointPayload),
  };
  const independentReview = generation("coverage_audit", "verification-model", {
    id: "generation-independent-review",
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
      configuredModelId: "verification-model",
      requestIds: ["request-independent-review"],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "agentic_tool_loop",
      resultAttestation: {
        executionMode: "agentic_investigator_verifier_independent_review",
        fallbackUsed: false,
        snapshotScopeDigest: input.snapshotScopeDigest,
        checkpointDigest: checkpoint.checkpointDigest,
        sourceInspectionDigest: checkpoint.sourceInspectionDigest,
      },
    },
  });
  const observationDigest = digest(independentObservations[0]);
  const audit = {
    status: "satisfied",
    capabilityChecks: [{
      capabilityKey: "project_domain:payments",
      findingId: "F1",
      verdict: "supported",
      reason: "The exact implementation range supports the representative claim.",
      evidence: {
        evidenceId: "evidence-verifier",
        lineStart: 1,
        lineEnd: 4,
      },
    }],
    independentObservationChecks: [{
      observationDigest,
      verdict: "covered_by_candidate",
      reason: "The candidate captures the independently observed transition.",
      matchedFindingIds: ["F1"],
      missingOperationId: "",
      evidence: {
        evidenceId: "evidence-verifier",
        lineStart: 1,
        lineEnd: 4,
      },
    }],
    missingOperations: [],
    rationale: "Central workflows are covered.",
  };
  const preDisclosureInspection = {
    sourceSearchTrace: [discovery],
    readSet,
  };
  const candidateDisclosure = {
    inspectionToolCallsAtReveal: checkpoint.inspectionToolCalls,
    preDisclosureDiscoveryEvidenceIds: [discovery.evidenceId],
    preDisclosureExactReadEvidenceIds: [readSet[0]!.evidenceId],
    preDisclosureAttestationDigest: digest(preDisclosureInspection),
    independentObservations,
    independentObservationDigest: checkpoint.independentObservationDigest,
  };
  const verifierDigest = digest(audit);
  const verifier = generation("coverage_audit", "verification-model", {
    id: "generation-investigator-verifier",
    inputSummary: {
      phase: "repository_candidate_coverage_audit",
      sourceId: input.sourceId,
      repository: input.repository,
      commitSha: input.commitSha,
      snapshotScopeDigest: input.snapshotScopeDigest,
      independentReviewGenerationRunId: independentReview.id,
      independentReviewCheckpointDigest: checkpoint.checkpointDigest,
      notebookDigest: input.notebookDigest,
      capabilityCount: 1,
      verifierToolPolicy: {
        durableBlindReview: true,
        representativeCheck: true,
      },
    },
    parsedOutput: audit,
    resultRefs: {
      configuredModelId: "verification-model",
      requestIds: ["request-investigator-verifier"],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "agentic_tool_loop",
      resultAttestation: {
        executionMode: "agentic_investigator_verifier",
        fallbackUsed: false,
        terminationReason: "verifier_complete",
        snapshotScopeDigest: input.snapshotScopeDigest,
        notebookDigest: input.notebookDigest,
        auditDigest: verifierDigest,
        independentReviewGenerationRunId: independentReview.id,
        independentReviewCheckpointDigest: checkpoint.checkpointDigest,
        preDisclosureSourceInspectionDigest: checkpoint.sourceInspectionDigest,
        preDisclosureSourceInspection: sourceInspection,
        candidateDisclosure,
        postDisclosureSourceInspectionDigest: digest(candidateSourceInspection),
        toolTrace: candidateSourceInspection.sourceSearchTrace,
        readSet,
      },
    },
  });
  return {
    independentReview,
    verifier,
    verifierDigest,
    checkpoint,
  };
}

function claimKeys(parsedOutput: unknown) {
  const subsystems = (parsedOutput as {
    subsystems: Array<{
      subsystemKey: string;
      facts: unknown[];
      highlights: unknown[];
    }>;
  }).subsystems;
  return subsystems.flatMap((subsystem) => [
    ...subsystem.facts.map((_claim, index) =>
      `${subsystem.subsystemKey}:fact:${index + 1}`
    ),
    ...subsystem.highlights.map((_claim, index) =>
      `${subsystem.subsystemKey}:highlight:${index + 1}`
    ),
  ]);
}

function synthesisGeneration(
  parsedOutput: unknown,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
) {
  const claimContentDigest = repositorySynthesisClaimContentDigest(parsedOutput);
  if (!claimContentDigest) throw new Error("Test synthesis must contain attestable claims.");
  return generation("capability_synthesis", "synthesis-model", {
    parsedOutput,
    resultRefs: {
      configuredModelId: "synthesis-model",
      requestIds: ["request-capability_synthesis"],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
      resultAttestation: { claimContentDigest },
    },
    ...overrides,
  });
}

function entailmentCritic(
  parsedSynthesis: unknown,
  revisionRound = 0,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
) {
  const expectedClaimKeys = claimKeys(parsedSynthesis);
  const claimContentDigest = repositorySynthesisClaimContentDigest(parsedSynthesis);
  if (!claimContentDigest) throw new Error("Test critic must receive attestable claims.");
  return generation("capability_synthesis", "synthesis-model", {
    id: "generation-capability-synthesis-critic",
    inputSummary: {
      phase: "entailment_critic",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      claimCount: expectedClaimKeys.length,
      claimContentDigest,
      revisionRound,
    },
    parsedOutput: {
      assessments: expectedClaimKeys.map((claimKey) => ({
        claimKey,
        supported: true,
        issues: [],
      })),
    },
    ...overrides,
  });
}

function entailmentCriticRejecting(
  parsedSynthesis: unknown,
  rejectedClaimKeys: readonly string[],
  revisionRound = 0,
) {
  const rejected = new Set(rejectedClaimKeys);
  return entailmentCritic(parsedSynthesis, revisionRound, {
    parsedOutput: {
      assessments: claimKeys(parsedSynthesis).map((claimKey) => ({
        claimKey,
        supported: !rejected.has(claimKey),
        issues: rejected.has(claimKey) ? ["unsupported_detail"] : [],
      })),
    },
  });
}

const operationCommunityParentSynthesisKey =
  "project_domain:payments#parent-scope";
const operationCommunityChildSynthesisKeys = [
  "project_domain:payments#payment-intake",
  "project_domain:payments#receipt-delivery",
] as const;

function operationCommunityMapping(
  parsedOutput: unknown,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
) {
  const mappingDigest = repositoryOperationCommunityMappingDigest(parsedOutput);
  if (!mappingDigest) throw new Error("Test mapping must be digestible.");
  return generation("capability_synthesis", "synthesis-model", {
    id: "generation-operation-community-mapping",
    inputSummary: {
      phase: "operation_community_mapping",
      refreshRunId: "refresh-1",
      subsystemKey: operationCommunityParentSynthesisKey,
      capabilityKey: "project_domain:payments",
      communityPolicy: "project_domain_v1",
      notebookEntries: 13,
      rawEligibleEntries: 41,
      expectedCommunityCount: 2,
    },
    parsedOutput,
    resultRefs: {
      configuredModelId: "synthesis-model",
      requestIds: ["request-operation-community-mapping"],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
      resultAttestation: { mappingDigest },
    },
    ...overrides,
  });
}

function validOperationCommunityPartition() {
  return {
    communities: [
      {
        label: "Payment intake",
        memberIndexes: [1, 2, 3, 4, 5, 6, 7],
      },
      {
        label: "Receipt delivery",
        memberIndexes: [8, 9, 10, 11, 12, 13],
      },
    ],
  };
}

type DeltaCriticClaim = {
  claimKey: string;
  kind: "fact" | "highlight";
  claim: { statement: string } | { text: string; summary: string };
  citationIndexes: number[];
};

type RevisionPatch = {
  factRevisions: Array<{
    claimKey: string;
    replacement: Record<string, unknown> | null;
  }>;
  highlightRevisions: Array<{
    claimKey: string;
    replacement: Record<string, unknown> | null;
  }>;
};

function deltaRevisionGeneration(
  priorSynthesis: unknown,
  revisedSynthesis: unknown,
  revisionPatch: RevisionPatch,
  criticClaims: DeltaCriticClaim[],
  revisionRound = 1,
  options?: {
    revisionContract?:
      | "rejected_claim_patch_v2_delta_critic"
      | "rejected_claim_patch_v3_server_slots"
      | "empty_fact_floor_patch_v1_server_slots"
      | "quality_critical_fact_patch_v1_server_slots";
    revisionEvidenceIndexesBySubsystem?: Array<{
      subsystemKey: string;
      citationIndexes: number[];
    }>;
  },
) {
  const claimContentDigest =
    repositorySynthesisClaimContentDigest(revisedSynthesis);
  const priorClaimContentDigest =
    repositorySynthesisClaimContentDigest(priorSynthesis);
  const criticClaimContentDigest =
    repositorySynthesisCriticClaimContentDigest(criticClaims);
  if (!claimContentDigest || !priorClaimContentDigest) {
    throw new Error("Test revision must contain attestable repository payloads.");
  }
  if (
    !revisedSynthesis ||
    typeof revisedSynthesis !== "object" ||
    Array.isArray(revisedSynthesis)
  ) {
    throw new Error("Test revision must be an object payload.");
  }
  const auditedRevisionPatch = [
    ...revisionPatch.factRevisions.map((entry) => ({
      claimKey: entry.claimKey,
      kind: "fact" as const,
      replacement: entry.replacement === null
        ? null
        : structuredClone(entry.replacement),
    })),
    ...revisionPatch.highlightRevisions.map((entry) => ({
      claimKey: entry.claimKey,
      kind: "highlight" as const,
      replacement: entry.replacement === null
        ? null
        : structuredClone(entry.replacement),
    })),
  ];
  return synthesisGeneration({
    ...revisedSynthesis,
    revisionPatch: auditedRevisionPatch,
  }, {
    id: "generation-capability-synthesis-revision-" + revisionRound,
    inputSummary: {
      phase: "synthesis",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      revisionRound,
      revisionContract:
        options?.revisionContract ??
        "rejected_claim_patch_v2_delta_critic",
      ...(options?.revisionContract ===
          "rejected_claim_patch_v3_server_slots" ||
          options?.revisionContract ===
          "empty_fact_floor_patch_v1_server_slots" ||
          options?.revisionContract ===
          "quality_critical_fact_patch_v1_server_slots"
        ? {
            revisionEvidenceIndexesBySubsystem:
              options.revisionEvidenceIndexesBySubsystem ?? [{
                subsystemKey: "project_domain:payments#scope",
                citationIndexes: [1],
              }],
          }
        : {}),
    },
    resultRefs: {
      configuredModelId: "synthesis-model",
      requestIds: ["request-capability_synthesis-revision-" + revisionRound],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
      resultAttestation: {
        claimContentDigest,
        priorClaimContentDigest,
        criticScope: "changed_claims",
        criticClaimCount: criticClaims.length,
        criticClaimKeys: criticClaims.map((claim) => claim.claimKey),
        criticClaimContentDigest,
      },
    },
  });
}

function deltaEntailmentCritic(
  criticClaims: DeltaCriticClaim[],
  revisionRound = 1,
) {
  const claimContentDigest =
    repositorySynthesisCriticClaimContentDigest(criticClaims);
  if (!claimContentDigest) {
    throw new Error("Test delta critic must receive at least one claim.");
  }
  return generation("capability_synthesis", "synthesis-model", {
    id: "generation-capability-synthesis-delta-critic-" + revisionRound,
    inputSummary: {
      phase: "entailment_critic",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      claimCount: criticClaims.length,
      claimContentDigest,
      revisionRound,
      criticScope: "changed_claims",
    },
    parsedOutput: {
      assessments: criticClaims.map((claim) => ({
        claimKey: claim.claimKey,
        supported: true,
        issues: [],
      })),
    },
  });
}

function evaluateGenerationRuns(
  generationRuns: RepositoryKnowledgeGenerationAuditRecord[],
) {
  return evaluateRepositoryKnowledgeMainPath({
    generationRuns,
    expectedIdentities,
    coverage: null,
    orchestration: {
      fallbackUsed: false,
      generationRunId: "generation-execution_routing",
    },
    warnings: null,
  });
}

function operationCommunityConsumptions(
  mapping: RepositoryKnowledgeGenerationAuditRecord,
) {
  const mappingAttestation = (
    mapping.resultRefs as {
      resultAttestation?: { mappingDigest?: unknown };
    }
  ).resultAttestation;
  const mappingDigest = typeof mappingAttestation?.mappingDigest === "string"
    ? mappingAttestation.mappingDigest
    : "";
  const parentSynthesisKey = (
    mapping.inputSummary as { subsystemKey?: unknown }
  ).subsystemKey;
  const communities = (
    mapping.parsedOutput as {
      communities?: Array<{ memberIndexes?: unknown }>;
    }
  ).communities ?? [];
  return communities.flatMap((community, communityIndex) => {
    const childSynthesisKey = operationCommunityChildSynthesisKeys[communityIndex];
    return childSynthesisKey &&
        typeof parentSynthesisKey === "string" &&
        Array.isArray(community.memberIndexes)
      ? [{
          childSynthesisKey,
          parentSynthesisKey,
          mappingDigest,
          communityIndex,
          memberIndexes: community.memberIndexes,
        }]
      : [];
  });
}

function evaluateOperationCommunityMapping(
  mapping: RepositoryKnowledgeGenerationAuditRecord,
  options: { operationCommunities?: unknown } = {},
) {
  const defaultOperationCommunities = operationCommunityConsumptions(mapping);
  const operationCommunities = Object.hasOwn(options, "operationCommunities")
    ? options.operationCommunities
    : defaultOperationCommunities;
  const synthesis = {
    subsystems: [
      {
        subsystemKey: operationCommunityChildSynthesisKeys[0],
        facts: [{
          statement: "The payment service validates an intake request.",
          citationIndexes: [1],
        }],
        highlights: [],
      },
      {
        subsystemKey: operationCommunityChildSynthesisKeys[1],
        facts: [{
          statement: "The payment service delivers a persisted receipt.",
          citationIndexes: [1],
        }],
        highlights: [],
      },
    ],
  };
  const synthesisRun = synthesisGeneration(synthesis, {
    inputSummary: {
      phase: "synthesis",
      revisionRound: 0,
      refreshRunId: "refresh-1",
      subsystemKeys: [...operationCommunityChildSynthesisKeys],
      operationCommunities,
    },
  });
  const criticRun = entailmentCritic(synthesis);
  criticRun.inputSummary = {
    ...(criticRun.inputSummary as Record<string, unknown>),
    subsystemKeys: [...operationCommunityChildSynthesisKeys],
  };
  return evaluateGenerationRuns([
    generation("execution_routing", "routing-model"),
    generation("semantic_extraction", "semantic-model"),
    mapping,
    synthesisRun,
    criticRun,
  ]);
}

describe("repository knowledge main-path integrity", () => {
  it("accepts successful attributed model extraction and synthesis", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis),
      ],
      expectedIdentities,
      coverage: [{
        targets: [{ deterministicFallbackPathCount: 0 }],
      }],
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: { semanticOrchestrationGaps: ["One domain is thin."] },
    });

    expect(result).toEqual({
      passed: true,
      issues: [],
      metrics: {
        semanticPlanning: 1,
        semanticExtraction: 1,
        capabilitySynthesis: 1,
        entailmentCritic: 1,
        highlightSelection: 0,
        highlightTitleCritic: 0,
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 1,
        successfulGenerations: 4,
        totalGenerations: 4,
        providerAttemptCount: 4,
        schemaRepairRunCount: 0,
        deterministicSemanticPathCount: 0,
        plannerFallbackAttested: true,
        plannerFallbackUsed: false,
        deterministicSynthesis: false,
        budgetExhausted: false,
      },
    });
  });

  it("accepts an exact source-attested agentic investigation without a planner generation", () => {
    const sourceId = "source-1";
    const repository = "owner/project";
    const commitSha = "1".repeat(40);
    const snapshotScopeDigest = "a".repeat(64);
    const investigatorNotebookDigest = "b".repeat(64);
    const checkpointNotebookDigest = "d".repeat(64);
    const verifierInputNotebookDigest = investigatorNotebookDigest;
    const checkpointInvestigator = generation(
      "semantic_extraction",
      "primary-answer-model",
      {
        id: "generation-investigator-checkpoint",
        parsedOutput: {
          notebookDigest: checkpointNotebookDigest,
          capabilityCount: 2,
          findingCount: 4,
          unresolvedAreaCount: 2,
          done: false,
        },
        resultRefs: {
          configuredModelId: "primary-answer-model",
          requestIds: ["request-investigator-checkpoint"],
          usageComplete: true,
          failedProviderAttempts: [],
          providerAttemptCount: 1,
          transportMode: "agentic_tool_loop",
          resultAttestation: {
            executionMode: "agentic_investigator",
            fallbackUsed: false,
            terminationReason: "investigator_checkpoint_yield",
            snapshotScopeDigest,
            notebookDigest: checkpointNotebookDigest,
            toolTrace: [{ toolName: "inspect_repository_snapshot" }],
            readSet: [{ path: "src/session.ts", lineStart: 1, lineEnd: 4 }],
          },
        },
      },
    );
    const investigator = generation("semantic_extraction", "primary-answer-model", {
      id: "generation-investigator",
      parsedOutput: {
        notebookDigest: investigatorNotebookDigest,
        capabilityCount: 3,
        findingCount: 8,
        unresolvedAreaCount: 0,
        done: true,
      },
      resultRefs: {
        configuredModelId: "primary-answer-model",
        requestIds: ["request-investigator"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 1,
        transportMode: "agentic_tool_loop",
        resultAttestation: {
          executionMode: "agentic_investigator",
          fallbackUsed: false,
          terminationReason: "investigator_done",
          snapshotScopeDigest,
          notebookDigest: investigatorNotebookDigest,
          toolTrace: [{ toolName: "inspect_repository_snapshot" }],
          readSet: [{ path: "src/session.ts", lineStart: 1, lineEnd: 4 }],
        },
      },
    });
    const twoPhaseVerifier = twoPhaseVerifierFixture({
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      notebookDigest: verifierInputNotebookDigest,
    });
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };

    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        checkpointInvestigator,
        investigator,
        twoPhaseVerifier.independentReview,
        twoPhaseVerifier.verifier,
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis),
      ],
      expectedIdentities,
      expectedAgenticInvestigatorIdentity,
      coverage: [{ targets: [{ deterministicFallbackPathCount: 0 }] }],
      orchestration: {
        executionMode: "agentic_investigator",
        fallbackUsed: false,
        repositories: [{
          sourceId,
          repository,
          commitSha,
          snapshotScopeDigest,
          notebookDigest: investigatorNotebookDigest,
          investigatorGenerationRunIds: [checkpointInvestigator.id, investigator.id],
          verifierIndependentReviewGenerationRunId:
            twoPhaseVerifier.independentReview.id,
          verifierGenerationRunId: twoPhaseVerifier.verifier.id,
          verifierInputNotebookDigest,
          verifierDigest: twoPhaseVerifier.verifierDigest,
        }],
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metrics).toMatchObject({
      agenticInvestigation: true,
      semanticPlanning: 0,
      semanticExtraction: 2,
    });
  });

  it("authenticates multiple visible ranges from one pinned evidence blob without dropping ranges", () => {
    const context = {
      sourceId: "source-1", repository: "owner/project", commitSha: "1".repeat(40),
      snapshotScopeDigest: "a".repeat(64), notebookDigest: "b".repeat(64),
    };
    const fixture = twoPhaseVerifierFixture({ ...context, splitReads: true });
    const repositoryAttestation = {
      ...context,
      verifierIndependentReviewGenerationRunId: fixture.independentReview.id,
      verifierGenerationRunId: fixture.verifier.id,
    };
    const check = (verifier: RepositoryKnowledgeGenerationAuditRecord) =>
      repositoryVerifierTwoPhaseIntegrityIssues({
        repositoryAttestation, generationRuns: [fixture.independentReview, verifier],
      });
    expect(check(fixture.verifier)).toEqual([]);
    const refs = fixture.verifier.resultRefs as Record<string, unknown>;
    const attestation = refs.resultAttestation as Record<string, unknown>;
    const disclosure = attestation.candidateDisclosure as Record<string, unknown>;
    const changeDisclosure = (change: Record<string, unknown>) => ({
      ...fixture.verifier,
      resultRefs: { ...refs, resultAttestation: {
        ...attestation, candidateDisclosure: { ...disclosure, ...change },
      } },
    });
    for (const ids of [[], ["unread-blob"], ["evidence-verifier", "unread-blob"], ["evidence-verifier", "evidence-verifier"]]) {
      expect(check(changeDisclosure({ preDisclosureExactReadEvidenceIds: ids })))
        .toContainEqual(expect.stringMatching(/not an exact continuation/iu));
    }
    const inspection = fixture.checkpoint.sourceInspection;
    expect(check(changeDisclosure({ preDisclosureAttestationDigest: digest({
      sourceSearchTrace: inspection.sourceSearchTrace.filter((entry) => entry.operationKind === "discovery"),
      readSet: inspection.readSet.slice(0, 1),
    }) }))).toContainEqual(expect.stringMatching(/not an exact continuation/iu));
  });

  it("fails two-phase verifier integrity when blind execution or checkpoint linkage is tampered", () => {
    const sourceId = "source-1";
    const repository = "owner/project";
    const commitSha = "1".repeat(40);
    const snapshotScopeDigest = "a".repeat(64);
    const fixture = twoPhaseVerifierFixture({
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      notebookDigest: "b".repeat(64),
    });
    const repositoryAttestation = {
      sourceId,
      repository,
      commitSha,
      snapshotScopeDigest,
      verifierIndependentReviewGenerationRunId: fixture.independentReview.id,
      verifierGenerationRunId: fixture.verifier.id,
    };

    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [fixture.independentReview, fixture.verifier],
    })).toEqual([]);

    const verifierResultRefs = fixture.verifier.resultRefs as Record<string, unknown>;
    const verifierAttestation = verifierResultRefs.resultAttestation as Record<
      string,
      unknown
    >;
    const exactTrace = verifierAttestation.toolTrace as Array<
      Record<string, unknown>
    >;
    const exactReadSet = verifierAttestation.readSet as unknown[];
    const candidateWithInspection = (toolTrace: unknown[], readSet: unknown[]) => ({
      ...fixture.verifier,
      resultRefs: {
        ...verifierResultRefs,
        resultAttestation: {
          ...verifierAttestation,
          postDisclosureSourceInspectionDigest: digest({
            sourceSearchTrace: toolTrace,
            readSet,
          }),
          toolTrace,
          readSet,
        },
      },
    });
    const malformedCandidateTrace = candidateWithInspection([{
      ...exactTrace[0],
      command: "grep",
    }], exactReadSet);
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [fixture.independentReview, malformedCandidateTrace],
    })).toContainEqual(expect.stringMatching(/fresh representative exact-source reads/iu));

    const missingCandidateRereads = candidateWithInspection([], []);
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [fixture.independentReview, missingCandidateRereads],
    })).toContainEqual(expect.stringMatching(/fresh representative exact-source reads/iu));

    const candidateExposedBlindRun = {
      ...fixture.independentReview,
      inputSummary: {
        ...(fixture.independentReview.inputSummary as Record<string, unknown>),
        candidateAvailable: true,
      },
    };
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [candidateExposedBlindRun, fixture.verifier],
    })).toContainEqual(expect.stringMatching(/candidate-hidden/iu));

    const tamperedCheckpoint = {
      ...fixture.independentReview,
      parsedOutput: {
        ...(fixture.independentReview.parsedOutput as Record<string, unknown>),
        sourceInspectionDigest: "f".repeat(64),
      },
    };
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [tamperedCheckpoint, fixture.verifier],
    })).toContainEqual(expect.stringMatching(/digest or cited-read integrity/iu));

    const unlinkedCandidate = {
      ...fixture.verifier,
      inputSummary: {
        ...(fixture.verifier.inputSummary as Record<string, unknown>),
        independentReviewCheckpointDigest: "e".repeat(64),
      },
    };
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation,
      generationRuns: [fixture.independentReview, unlinkedCandidate],
    })).toContainEqual(expect.stringMatching(/exact blind checkpoint/iu));
  });

  it("reports pre-split agentic verifier history as non-current integrity without throwing", () => {
    const historicalRepository = {
      sourceId: "source-1",
      repository: "owner/project",
      commitSha: "1".repeat(40),
      snapshotScopeDigest: "a".repeat(64),
      verifierGenerationRunId: "legacy-verifier",
    };
    expect(() => repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation: historicalRepository,
      generationRuns: [],
    })).not.toThrow();
    expect(repositoryVerifierTwoPhaseIntegrityIssues({
      repositoryAttestation: historicalRepository,
      generationRuns: [],
    })).toEqual([
      expect.stringMatching(/no uniquely referenced blind independent-review generation/iu),
    ]);
  });

  it("rejects an agentic investigator that does not use the configured primary-answer identity", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [generation("semantic_extraction", "semantic-model")],
      expectedIdentities,
      expectedAgenticInvestigatorIdentity,
      coverage: null,
      orchestration: {
        executionMode: "agentic_investigator",
        fallbackUsed: false,
        repositories: [],
      },
      warnings: null,
    });

    expect(result.issues).toContain(
      "semantic_extraction generation 1 used model semantic-model; expected primary-answer-model.",
    );
  });

  it("accepts an exact adaptive Highlight partition and independently assessed titles", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const selectionOutput = {
      selections: [{ candidateId: "HC1", title: "Persists payment receipts" }],
      omissions: [{ candidateId: "HC2", reason: "routine_supporting_detail" }],
    };
    const selection = generation("capability_synthesis", "synthesis-model", {
      id: "generation-highlight-selection",
      inputSummary: {
        phase: "repository_highlight_selection",
        refreshRunId: "refresh-1",
        candidateCount: 2,
        candidateDigest: "a".repeat(64),
        maximumSelections: 2,
      },
      parsedOutput: selectionOutput,
      resultRefs: {
        configuredModelId: "synthesis-model",
        requestIds: ["request-highlight-selection"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 1,
        transportMode: "json_schema",
        rawOutputHash: "c".repeat(64),
        resultAttestation: {
          candidateDigest: "a".repeat(64),
          selectedCandidateIds: ["HC1"],
          selectedCandidateCount: 1,
          selectedCandidateDigest: createHash("sha256")
            .update(JSON.stringify(["HC1"]))
            .digest("hex"),
          selectionDigest: createHash("sha256")
            .update(JSON.stringify(selectionOutput))
            .digest("hex"),
        },
      },
    });
    const criticOutput = {
      assessments: [{ candidateId: "HC1", supported: true, issues: [] }],
    };
    const critic = generation("capability_synthesis", "synthesis-model", {
      id: "generation-highlight-critic",
      inputSummary: {
        phase: "repository_highlight_critic",
        refreshRunId: "refresh-1",
        batchIndex: 0,
        claimCount: 1,
        criticInputDigest: "b".repeat(64),
      },
      parsedOutput: criticOutput,
      resultRefs: {
        configuredModelId: "synthesis-model",
        requestIds: ["request-highlight-critic"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 1,
        transportMode: "json_schema",
        rawOutputHash: "d".repeat(64),
        resultAttestation: {
          criticInputDigest: "b".repeat(64),
          assessmentDigest: createHash("sha256")
            .update(JSON.stringify(criticOutput))
            .digest("hex"),
        },
      },
    });

    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis),
        selection,
        critic,
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metrics).toMatchObject({
      highlightSelection: 1,
      highlightTitleCritic: 1,
    });
  });

  it("requires scalar digests for sanitized large selected sets", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const selectedIds = Array.from({ length: 22 }, (_entry, index) =>
      `HC${index + 1}`
    );
    const selectionOutput = {
      selections: selectedIds.map((candidateId) => ({
        candidateId,
        title: `Capability ${candidateId}`,
      })),
      omissions: [],
    };
    const criticOutput = {
      assessments: selectedIds.map((candidateId) => ({
        candidateId,
        supported: true,
        issues: [],
      })),
    };
    const critic = generation("capability_synthesis", "synthesis-model", {
      id: "generation-highlight-critic-large",
      inputSummary: {
        phase: "repository_highlight_critic",
        refreshRunId: "refresh-1",
        batchIndex: 0,
        claimCount: selectedIds.length,
        criticInputDigest: "b".repeat(64),
      },
      parsedOutput: criticOutput,
      resultRefs: {
        configuredModelId: "synthesis-model",
        requestIds: ["request-highlight-critic-large"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 1,
        transportMode: "json_schema",
        rawOutputHash: "d".repeat(64),
        resultAttestation: {
          criticInputDigest: "b".repeat(64),
          assessmentDigest: createHash("sha256")
            .update(JSON.stringify(criticOutput))
            .digest("hex"),
        },
      },
    });
    const evaluateSelection = (resultAttestation: Record<string, unknown>) =>
      evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesis),
          entailmentCritic(synthesis),
          generation("capability_synthesis", "synthesis-model", {
            id: "generation-highlight-selection-large",
            inputSummary: {
              phase: "repository_highlight_selection",
              refreshRunId: "refresh-1",
              candidateCount: selectedIds.length,
              candidateDigest: "a".repeat(64),
              maximumSelections: selectedIds.length,
            },
            parsedOutput: selectionOutput,
            resultRefs: {
              configuredModelId: "synthesis-model",
              requestIds: ["request-highlight-selection-large"],
              usageComplete: true,
              failedProviderAttempts: [],
              providerAttemptCount: 1,
              transportMode: "json_schema",
              rawOutputHash: "c".repeat(64),
              resultAttestation,
            },
          }),
          critic,
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

    const selectedCandidateDigest = createHash("sha256")
      .update(JSON.stringify([...selectedIds].sort()))
      .digest("hex");
    const selectionOutputDigest = createHash("sha256")
      .update(JSON.stringify(selectionOutput))
      .digest("hex");
    expect(evaluateSelection({
      candidateDigest: "a".repeat(64),
      selectedCandidateIds: [...selectedIds.slice(0, 20), "[2 more items]"],
      selectedCandidateCount: selectedIds.length,
      selectedCandidateDigest,
      selectionDigest: selectionOutputDigest,
    }).passed).toBe(true);
    const legacySanitized = evaluateSelection({
      candidateDigest: "a".repeat(64),
      selectedCandidateIds: [...selectedIds.slice(0, 20), "[2 more items]"],
      selectionDigest: selectionOutputDigest,
    });
    expect(legacySanitized.passed).toBe(false);
    expect(legacySanitized.issues).toContain(
      "1 repository Highlight selection generation(s) lack an exact candidate partition and output attestation.",
    );
  });

  it("accepts an attested operation-community mapping without requiring its own critic", () => {
    const result = evaluateOperationCommunityMapping(
      operationCommunityMapping(validOperationCommunityPartition()),
    );

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metrics).toMatchObject({
      capabilitySynthesis: 1,
      entailmentCritic: 1,
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 1,
      successfulGenerations: 5,
      totalGenerations: 5,
      providerAttemptCount: 5,
    });
  });

  it("accepts an explicitly scoped seven-entry structural community mapping", () => {
    const structuralParent = "repository_area:intelligence#parent-scope";
    const mapping = operationCommunityMapping({
      communities: [
        { label: "Order records", memberIndexes: [1, 2, 3, 4] },
        { label: "Invoice records", memberIndexes: [5, 6, 7] },
      ],
    }, {
      inputSummary: {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: structuralParent,
        capabilityKey: "repository_area:intelligence",
        communityPolicy: "structural_breadth_v1",
        notebookEntries: 7,
        rawEligibleEntries: 9,
        expectedCommunityCount: 2,
      },
    });

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts an exact twenty-four-entry structural community mapping", () => {
    const structuralParent = "repository_area:intelligence#parent-scope";
    const mapping = operationCommunityMapping({
      communities: [
        {
          label: "Retrieval and synthesis",
          memberIndexes: Array.from({ length: 12 }, (_entry, index) => index + 1),
        },
        {
          label: "Review and generation",
          memberIndexes: Array.from({ length: 12 }, (_entry, index) => index + 13),
        },
      ],
    }, {
      inputSummary: {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: structuralParent,
        capabilityKey: "repository_area:intelligence",
        communityPolicy: "structural_breadth_v1",
        notebookEntries: 24,
        rawEligibleEntries: 31,
        expectedCommunityCount: 2,
      },
    });

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("does not lower the project-domain community threshold to seven entries", () => {
    const mapping = operationCommunityMapping({
      communities: [
        { label: "Payment intake", memberIndexes: [1, 2, 3, 4] },
        { label: "Receipt delivery", memberIndexes: [5, 6, 7] },
      ],
    }, {
      inputSummary: {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: operationCommunityParentSynthesisKey,
        capabilityKey: "project_domain:payments",
        communityPolicy: "project_domain_v1",
        notebookEntries: 7,
        rawEligibleEntries: 7,
        expectedCommunityCount: 2,
      },
    });

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 capability synthesis generation(s) have no valid subsystem-batch attestation.",
    );
  });

  it("rejects a valid mapper community omitted from base synthesis", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const [firstConsumption] = operationCommunityConsumptions(mapping);

    const result = evaluateOperationCommunityMapping(mapping, {
      operationCommunities: [firstConsumption],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 valid attested mapper community/communities are not consumed by initial synthesis.",
    );
  });

  it("rejects a mapper consumption whose member indexes do not match", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const [firstConsumption, secondConsumption] =
      operationCommunityConsumptions(mapping);

    const result = evaluateOperationCommunityMapping(mapping, {
      operationCommunities: [
        {
          ...firstConsumption,
          memberIndexes: [1, 2, 3, 4, 5, 6],
        },
        secondConsumption,
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community consumption record(s) do not match a valid attested mapper community.",
    );
    expect(result.issues).toContain(
      "1 valid attested mapper community/communities are not consumed by initial synthesis.",
    );
  });

  it("rejects an orphan operation-community consumption record", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const consumptions = operationCommunityConsumptions(mapping);

    const result = evaluateOperationCommunityMapping(mapping, {
      operationCommunities: [
        ...consumptions,
        {
          ...consumptions[0],
          parentSynthesisKey: "project_domain:orders#unknown-parent",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community consumption record(s) do not match a valid attested mapper community.",
    );
  });

  it("rejects duplicate mapper-community consumption", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const consumptions = operationCommunityConsumptions(mapping);

    const result = evaluateOperationCommunityMapping(mapping, {
      operationCommunities: [...consumptions, consumptions[0]],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community consumption record(s) duplicate a mapper community or child synthesis key.",
    );
  });

  it("rejects an operation-community child outside its synthesis batch", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const [firstConsumption, secondConsumption] =
      operationCommunityConsumptions(mapping);

    const result = evaluateOperationCommunityMapping(mapping, {
      operationCommunities: [
        {
          ...firstConsumption,
          childSynthesisKey: "project_domain:payments#unbatched-child",
        },
        secondConsumption,
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community consumption record(s) have invalid shape or reference a child outside their synthesis batch.",
    );
  });

  it("canonicalizes mapping object-key order and label whitespace", () => {
    const attested = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    const equivalentParsedOutputs = [
      {
        communities: [
          {
            memberIndexes: [1, 2, 3, 4, 5, 6, 7],
            label: "Payment intake",
          },
          {
            memberIndexes: [8, 9, 10, 11, 12, 13],
            label: "Receipt delivery",
          },
        ],
      },
      {
        communities: [
          {
            label: "  Payment   intake  ",
            memberIndexes: [1, 2, 3, 4, 5, 6, 7],
          },
          {
            label: "Receipt\n delivery",
            memberIndexes: [8, 9, 10, 11, 12, 13],
          },
        ],
      },
    ];

    for (const parsedOutput of equivalentParsedOutputs) {
      const result = evaluateOperationCommunityMapping({
        ...attested,
        parsedOutput,
      });
      expect(result.passed).toBe(true);
      expect(result.issues).toEqual([]);
    }
  });

  it("rejects a persisted operation-community mapping tampered after attestation", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    mapping.parsedOutput = {
      communities: [
        {
          label: "Payment capture",
          memberIndexes: [1, 2, 3, 4, 5, 6, 7],
        },
        {
          label: "Receipt delivery",
          memberIndexes: [8, 9, 10, 11, 12, 13],
        },
      ],
    };

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community mapping generation(s) do not attest their exact mapping payload.",
    );
    expect(result.issues).not.toContain(
      "1 operation-community mapping generation(s) do not contain an exact notebook partition.",
    );
  });

  it("rejects an attested operation-community partition with an omitted index", () => {
    const mapping = operationCommunityMapping({
      communities: [
        {
          label: "Payment intake",
          memberIndexes: [1, 2, 3, 4, 5, 6, 7],
        },
        {
          label: "Receipt delivery",
          memberIndexes: [8, 9, 10, 11, 12],
        },
      ],
    });

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community mapping generation(s) do not contain an exact notebook partition.",
    );
    expect(result.issues).not.toContain(
      "1 operation-community mapping generation(s) do not attest their exact mapping payload.",
    );
  });

  it("rejects an attested operation-community partition with a duplicate index", () => {
    const mapping = operationCommunityMapping({
      communities: [
        {
          label: "Payment intake",
          memberIndexes: [1, 2, 3, 4, 5, 6, 7],
        },
        {
          label: "Receipt delivery",
          memberIndexes: [7, 8, 9, 10, 11, 12, 13],
        },
      ],
    });

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community mapping generation(s) do not contain an exact notebook partition.",
    );
  });

  it("rejects duplicate community labels and communities larger than twelve entries", () => {
    const invalidMappings = [
      operationCommunityMapping({
        communities: [
          {
            label: "Payment intake",
            memberIndexes: [1, 2, 3, 4, 5, 6, 7],
          },
          {
            label: " payment   INTAKE ",
            memberIndexes: [8, 9, 10, 11, 12, 13],
          },
        ],
      }),
      operationCommunityMapping({
        communities: [
          {
            label: "Payment intake",
            memberIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
          },
          {
            label: "Receipt delivery",
            memberIndexes: [14],
          },
        ],
      }, {
        inputSummary: {
          phase: "operation_community_mapping",
          refreshRunId: "refresh-1",
          subsystemKey: operationCommunityParentSynthesisKey,
          capabilityKey: "project_domain:payments",
          communityPolicy: "project_domain_v1",
          notebookEntries: 14,
          rawEligibleEntries: 14,
          expectedCommunityCount: 2,
        },
      }),
    ];

    for (const mapping of invalidMappings) {
      const result = evaluateOperationCommunityMapping(mapping);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "1 operation-community mapping generation(s) do not contain an exact notebook partition.",
      );
    }
  });

  it("rejects an operation-community mapping without a valid SHA-256 digest", () => {
    const mapping = operationCommunityMapping(
      validOperationCommunityPartition(),
    );
    mapping.resultRefs = {
      ...(mapping.resultRefs as Record<string, unknown>),
      resultAttestation: { mappingDigest: "not-a-sha-256-digest" },
    };

    const result = evaluateOperationCommunityMapping(mapping);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 operation-community mapping generation(s) do not attest their exact mapping payload.",
    );
  });

  it("rejects incomplete operation-community mapping input summaries", () => {
    const summaries = [
      {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: operationCommunityParentSynthesisKey,
        capabilityKey: "project_domain:payments",
        communityPolicy: "project_domain_v1",
        rawEligibleEntries: 13,
        expectedCommunityCount: 2,
      },
      {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: operationCommunityParentSynthesisKey,
        capabilityKey: "project_domain:payments",
        communityPolicy: "project_domain_v1",
        notebookEntries: 13,
        rawEligibleEntries: 13,
        expectedCommunityCount: 3,
      },
      {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: " ",
        capabilityKey: "project_domain:payments",
        communityPolicy: "project_domain_v1",
        notebookEntries: 13,
        rawEligibleEntries: 13,
        expectedCommunityCount: 2,
      },
      {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: operationCommunityParentSynthesisKey,
        capabilityKey: "project_domain:payments",
        communityPolicy: "project_domain_v1",
        notebookEntries: 13,
        rawEligibleEntries: 12,
        expectedCommunityCount: 2,
      },
      {
        phase: "operation_community_mapping",
        refreshRunId: "refresh-1",
        subsystemKey: operationCommunityParentSynthesisKey,
        capabilityKey: "repository_area:data_model",
        communityPolicy: "structural_breadth_v1",
        notebookEntries: 7,
        rawEligibleEntries: 7,
        expectedCommunityCount: 2,
      },
    ];

    for (const inputSummary of summaries) {
      const result = evaluateOperationCommunityMapping(
        operationCommunityMapping(validOperationCommunityPartition(), {
          inputSummary,
        }),
      );

      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "1 capability synthesis generation(s) have no valid subsystem-batch attestation.",
      );
    }
  });

  it("certifies entailment critics against the verification model independently of synthesis", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const verificationCritic = entailmentCritic(synthesis, 0, {
      modelId: "verification-model",
      resultRefs: {
        configuredModelId: "verification-model",
        requestIds: ["request-capability-synthesis-critic"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 1,
        transportMode: "json_schema",
      },
    });
    const evaluate = (critic: RepositoryKnowledgeGenerationAuditRecord) =>
      evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesis),
          critic,
        ],
        expectedIdentities,
        expectedSynthesisCriticIdentity: {
          provider: "bedrock",
          modelId: "verification-model",
        },
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

    expect(evaluate(verificationCritic)).toMatchObject({ passed: true, issues: [] });
    expect(evaluate(entailmentCritic(synthesis))).toMatchObject({
      passed: false,
      issues: [expect.stringContaining(
        "used model synthesis-model; expected verification-model",
      )],
    });
  });

  it("requires exact fact-only limitation review claims and checks the verification model", () => {
    const subsystemKey = "project_domain:device_control#limitation-manual-start";
    const claims = [{ claimKey: `${subsystemKey}:fact:1`, kind: "fact",
      claim: { statement: "The controller waits for a local start command; it has no scheduled trigger in this handler." },
      citationIndexes: [1] }];
    const claimContentDigest = repositorySynthesisCriticClaimContentDigest(claims);
    const output = { assessments: [{ claimKey: claims[0]!.claimKey, supported: true, issues: [] }] };
    const critic = generation("capability_synthesis", "verification-model", {
      id: "limitation-review",
      inputSummary: { phase: "limitation_entailment_critic", refreshRunId: "refresh-1",
        claimCount: 1, subsystemKeys: [subsystemKey], claimContentDigest },
      parsedOutput: output,
      resultRefs: { configuredModelId: "verification-model", requestIds: ["limitation-request"],
        usageComplete: true, providerAttemptCount: 1, failedProviderAttempts: [], transportMode: "json_schema",
        resultAttestation: { claims, claimContentDigest, assessmentDigest: digest(output) } },
    });
    const evaluate = (run: RepositoryKnowledgeGenerationAuditRecord) => evaluateRepositoryKnowledgeMainPath({
      generationRuns: [generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration({ subsystems: [{ subsystemKey: "project_domain:payments#scope", facts: [], highlights: [] }] }), run],
      expectedIdentities, expectedSynthesisCriticIdentity: { provider: "bedrock", modelId: "verification-model" },
      coverage: null, orchestration: { fallbackUsed: false, generationRunId: "generation-execution_routing" }, warnings: null,
    });
    expect(evaluate(critic)).toMatchObject({ passed: true, issues: [] });
    for (const change of [
      { parsedOutput: { assessments: [] } },
      { parsedOutput: { assessments: [output.assessments[0], output.assessments[0]] } },
      { inputSummary: { ...(critic.inputSummary as object), claimCount: 2 } },
      { inputSummary: { ...(critic.inputSummary as object), subsystemKeys: ["unrelated"] } },
      { resultRefs: { ...(critic.resultRefs as object), resultAttestation: { claimContentDigest } } },
      { resultRefs: { ...(critic.resultRefs as object), resultAttestation: { claims: [{ ...claims[0],
        claim: { statement: "The controller starts autonomously." } }], claimContentDigest, assessmentDigest: digest(output) } } },
    ]) {
      expect(evaluate({ ...critic, ...change }).issues).toContainEqual(
        expect.stringContaining("lacks exact claim and assessment attestation"));
    }
    expect(evaluate({ ...critic, modelId: "synthesis-model" }).issues).toContainEqual(
      expect.stringContaining("used model synthesis-model; expected verification-model"));
  });

  it("rejects a revision round that masquerades as a full synthesis", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          { statement: "The service records request latency.", citationIndexes: [2] },
          { statement: "The service persists payment receipts.", citationIndexes: [1] },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const revision = synthesisGeneration(revised, {
      id: "generation-capability-synthesis-revision-1",
      inputSummary: {
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: ["project_domain:payments#scope"],
        revisionRound: 1,
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCritic(initial),
        revision,
        entailmentCritic(revised, 1),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("rejects synthesis content that differs from its persisted attestation", () => {
    const attested = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service persists payment receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const synthesis = synthesisGeneration(attested);
    synthesis.parsedOutput = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service deletes every customer account.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesis,
        entailmentCritic(attested),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 synthesis generation(s) do not attest their emitted claim count.",
    );
  });

  it("rejects duplicate or mislabeled synthesis subsystem batches", () => {
    const synthesisA = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service persists receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    const changedA = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service deletes receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    for (const secondSubsystemKeys of [
      ["project_domain:payments#scope"],
      ["project_domain:orders#scope"],
    ]) {
      const second = synthesisGeneration(changedA, {
        id: "generation-capability-synthesis-second",
        inputSummary: {
          phase: "synthesis",
          refreshRunId: "refresh-1",
          subsystemKeys: secondSubsystemKeys,
          revisionRound: 0,
        },
      });
      const secondCritic = entailmentCritic(changedA);
      secondCritic.inputSummary = {
        ...(secondCritic.inputSummary as Record<string, unknown>),
        subsystemKeys: secondSubsystemKeys,
      };
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesisA),
          entailmentCritic(synthesisA),
          second,
          secondCritic,
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(false);
    }
  });

  it("rejects revision-only metadata on an initial synthesis", () => {
    const parsedOutput = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service persists receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    for (const mutation of ["contract", "scope", "patch"] as const) {
      const synthesis = synthesisGeneration(parsedOutput);
      if (mutation === "contract") {
        synthesis.inputSummary = {
          ...(synthesis.inputSummary as Record<string, unknown>),
          revisionContract: "rejected_claim_patch_v2_delta_critic",
        };
      } else if (mutation === "scope") {
        const refs = synthesis.resultRefs as {
          resultAttestation: Record<string, unknown>;
        };
        refs.resultAttestation.criticScope = "changed_claims";
      } else {
        synthesis.parsedOutput = { ...parsedOutput, revisionPatch: [] };
      }
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesis,
          entailmentCritic(parsedOutput),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "1 initial synthesis generation(s) declare revision-only metadata.",
      );
    }
  });

  it("accepts a chained revision critic that verifies only changed claims", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
          {
            statement: "The service publishes a payment receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          initial.subsystems[0]!.facts[0],
          {
            statement: "The service records an idempotency key.",
            citationIndexes: [1],
          },
          initial.subsystems[0]!.facts[2],
        ],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:2",
      kind: "fact",
      claim: { statement: revised.subsystems[0]!.facts[1]!.statement },
      citationIndexes: [1],
    }];
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[1]!,
      }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          revisionPatch,
          changedClaims,
        ),
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      capabilitySynthesis: 2,
      entailmentCritic: 2,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 2,
    });
  });

  it("re-keys a later revision after an earlier positional removal", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          { statement: "The service encrypts every receipt.", citationIndexes: [1] },
          { statement: "The service records request latency.", citationIndexes: [2] },
          { statement: "The service publishes every receipt.", citationIndexes: [1] },
        ],
        highlights: [],
      }],
    };
    const firstReplacement = {
      statement: "The service publishes a payment receipt.",
      citationIndexes: [1],
    };
    const firstRevision = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[1], firstReplacement],
        highlights: [],
      }],
    };
    const firstChangedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:3",
      kind: "fact",
      claim: { statement: firstReplacement.statement },
      citationIndexes: [1],
    }];
    const firstPatch: RevisionPatch = {
      factRevisions: [
        {
          claimKey: "project_domain:payments#scope:fact:1",
          replacement: null,
        },
        {
          claimKey: "project_domain:payments#scope:fact:3",
          replacement: firstReplacement,
        },
      ],
      highlightRevisions: [],
    };
    const firstCritic = deltaEntailmentCritic(firstChangedClaims, 1);
    firstCritic.parsedOutput = {
      assessments: [{
        claimKey: firstChangedClaims[0]!.claimKey,
        supported: false,
        issues: ["unsupported_detail"],
      }],
    };
    const finalReplacement = {
      statement: "The service records an idempotency key.",
      citationIndexes: [1],
    };
    const finalRevision = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [firstRevision.subsystems[0]!.facts[0], finalReplacement],
        highlights: [],
      }],
    };

    for (const [secondPatchKey, expectedPass] of [
      ["project_domain:payments#scope:fact:2", true],
      ["project_domain:payments#scope:fact:3", false],
    ] as const) {
      const secondChangedClaims: DeltaCriticClaim[] = [{
        claimKey: secondPatchKey,
        kind: "fact",
        claim: { statement: finalReplacement.statement },
        citationIndexes: [1],
      }];
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(initial),
          entailmentCriticRejecting(initial, [
            "project_domain:payments#scope:fact:1",
            "project_domain:payments#scope:fact:3",
          ]),
          deltaRevisionGeneration(
            initial,
            firstRevision,
            firstPatch,
            firstChangedClaims,
            1,
          ),
          firstCritic,
          deltaRevisionGeneration(
            firstRevision,
            finalRevision,
            {
              factRevisions: [{
                claimKey: secondPatchKey,
                replacement: finalReplacement,
              }],
              highlightRevisions: [],
            },
            secondChangedClaims,
            2,
          ),
          deltaEntailmentCritic(secondChangedClaims, 2),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(expectedPass);
      if (!expectedPass) {
        expect(result.issues).toContain(
          "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
        );
      }
    }
  });

  it("admits only the exact server-derived Highlight cascade from a revised Fact", () => {
    const factKey = "project_domain:payments#scope:fact:1";
    const highlightKey = "project_domain:payments#scope:highlight:1";
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 4,
    };
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service encrypts every receipt.",
          category: "behavior" as const,
          reviewNotes: null,
          citationIndexes: [1],
          ...promotion,
        }],
        highlights: [{
          text: "Receipt encryption",
          summary: "The service encrypts every receipt.",
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotion,
        }],
      }],
    };

    for (const [title, expectedPass] of [
      ["Receipt encryption", true],
      ["Unreviewed accepted-title rewrite", false],
    ] as const) {
      const revisedFact = {
        statement: "The service encrypts payment receipts.",
        category: "behavior" as const,
        reviewNotes: null,
        citationIndexes: [1],
        ...promotion,
      };
      const revisedHighlight = {
        text: title,
        summary: revisedFact.statement,
        visibility: "private" as const,
        citationIndexes: [1],
        ...promotion,
      };
      const revised = {
        subsystems: [{
          subsystemKey: "project_domain:payments#scope",
          facts: [revisedFact],
          highlights: [revisedHighlight],
        }],
      };
      const changedClaims: DeltaCriticClaim[] = [
        {
          claimKey: factKey,
          kind: "fact",
          claim: { statement: revisedFact.statement },
          citationIndexes: [1],
        },
        {
          claimKey: highlightKey,
          kind: "highlight",
          claim: {
            text: revisedHighlight.text,
            summary: revisedHighlight.summary,
          },
          citationIndexes: [1],
        },
      ];
      const revisionPatch: RevisionPatch = {
        factRevisions: [{ claimKey: factKey, replacement: revisedFact }],
        highlightRevisions: [{
          claimKey: highlightKey,
          replacement: revisedHighlight,
        }],
      };
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(initial),
          entailmentCriticRejecting(initial, [factKey]),
          deltaRevisionGeneration(
            initial,
            revised,
            revisionPatch,
            changedClaims,
            1,
            {
              revisionContract: "rejected_claim_patch_v3_server_slots",
            },
          ),
          deltaEntailmentCritic(changedClaims),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(expectedPass);
    }
  });

  it.each([
    "empty_fact_floor_patch_v1_server_slots",
    "quality_critical_fact_patch_v1_server_slots",
  ] as const)("accepts a %s repair and drops its dependent Highlight", (
    revisionContract,
  ) => {
    const subsystemKey = "project_domain:payments#scope";
    const factKey = `${subsystemKey}:fact:1`;
    const highlightKey = `${subsystemKey}:highlight:1`;
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 4,
    };
    const initialFact = {
      statement: "The service encrypts every receipt.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    };
    const initial = {
      subsystems: [{
        subsystemKey,
        facts: [initialFact],
        highlights: [{
          text: "Receipt encryption",
          summary: initialFact.statement,
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotion,
        }],
      }],
    };
    const revisedFact = {
      ...initialFact,
      statement: "The service encrypts payment receipts.",
    };
    const revised = {
      subsystems: [{
        subsystemKey,
        facts: [revisedFact],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: factKey,
      kind: "fact",
      claim: { statement: revisedFact.statement },
      citationIndexes: [1],
    }];
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [factKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          {
            factRevisions: [{ claimKey: factKey, replacement: revisedFact }],
            highlightRevisions: [{ claimKey: highlightKey, replacement: null }],
          },
          changedClaims,
          1,
          { revisionContract },
        ),
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it.each([
    {
      name: "repairs the highest-ranked quality-critical rejection beside a supported Fact",
      subsystemKey: "project_domain:payments#scope",
      firstSupported: true,
      rejectedPromotion: {
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        distinctiveness: 3,
      },
      expectedPass: true,
    },
    {
      name: "rejects a supported-sibling repair below the promotion threshold",
      subsystemKey: "project_domain:payments#scope",
      firstSupported: true,
      rejectedPromotion: {
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 2,
        distinctiveness: 3,
      },
      expectedPass: false,
    },
    {
      name: "rejects a lower-ranked eligible Fact when a stronger rejection exists",
      subsystemKey: "project_domain:payments#scope",
      firstSupported: true,
      rejectedPromotion: {
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        distinctiveness: 3,
      },
      strongerRejectedPromotion: {
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 5,
        distinctiveness: 5,
      },
      expectedPass: false,
    },
    {
      name: "rejects supported-sibling refinement in a quality scope",
      subsystemKey: "repository_area:quality#scope",
      firstSupported: true,
      rejectedPromotion: {
        productImportance: 5,
        implementationBreadth: 5,
        technicalDifficulty: 5,
        distinctiveness: 5,
      },
      expectedPass: false,
    },
    {
      name: "repairs the first rejection when the subsystem has no supported Fact",
      subsystemKey: "project_domain:payments#scope",
      firstSupported: false,
      rejectedPromotion: {
        productImportance: 1,
        implementationBreadth: 1,
        technicalDifficulty: 1,
        distinctiveness: 1,
      },
      expectedPass: true,
    },
  ])("$name", ({
    subsystemKey,
    firstSupported,
    rejectedPromotion,
    strongerRejectedPromotion,
    expectedPass,
  }) => {
    const firstFactKey = `${subsystemKey}:fact:1`;
    const selectedFactKey = firstSupported
      ? `${subsystemKey}:fact:2`
      : firstFactKey;
    const basePromotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 4,
      distinctiveness: 4,
    };
    const facts = [
      {
        statement: "The service validates payment ownership before settlement.",
        category: "behavior" as const,
        reviewNotes: null,
        citationIndexes: [1],
        ...basePromotion,
      },
      {
        statement: "The service records an immutable settlement receipt.",
        category: "behavior" as const,
        reviewNotes: null,
        citationIndexes: [2],
        confidence: "high" as const,
        sensitivityFlag: false,
        ...rejectedPromotion,
      },
      ...(strongerRejectedPromotion
        ? [{
            statement: "The service reconciles settlement failures idempotently.",
            category: "behavior" as const,
            reviewNotes: null,
            citationIndexes: [2],
            confidence: "high" as const,
            sensitivityFlag: false,
            ...strongerRejectedPromotion,
          }]
        : []),
    ];
    const initial = {
      subsystems: [{ subsystemKey, facts, highlights: [] }],
    };
    const selectedIndex = firstSupported ? 1 : 0;
    const revisedFact = {
      ...facts[selectedIndex]!,
      statement: `${facts[selectedIndex]!.statement} The operation is transaction-bound.`,
    };
    const revisedFacts = facts.map((fact, index) =>
      index === selectedIndex ? revisedFact : fact
    );
    const revised = {
      subsystems: [{ subsystemKey, facts: revisedFacts, highlights: [] }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: selectedFactKey,
      kind: "fact",
      claim: { statement: revisedFact.statement },
      citationIndexes: revisedFact.citationIndexes,
    }];
    const rejectedKeys = firstSupported
      ? facts.slice(1).map((_fact, index) =>
          `${subsystemKey}:fact:${index + 2}`
        )
      : [firstFactKey, `${subsystemKey}:fact:2`];
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, rejectedKeys),
        deltaRevisionGeneration(
          initial,
          revised,
          {
            factRevisions: [{ claimKey: selectedFactKey, replacement: revisedFact }],
            highlightRevisions: [],
          },
          changedClaims,
          1,
          {
            revisionContract: "quality_critical_fact_patch_v1_server_slots",
            revisionEvidenceIndexesBySubsystem: [{
              subsystemKey,
              citationIndexes: [1, 2],
            }],
          },
        ),
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed, JSON.stringify(result.issues)).toBe(expectedPass);
  });

  it("replays full promotion binding and permits a null cascade after ambiguity", () => {
    const subsystemKey = "project_domain:payments#scope";
    const factKey = `${subsystemKey}:fact:1`;
    const highlightKey = `${subsystemKey}:highlight:1`;
    const promotionA = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 4,
    };
    const promotionB = { ...promotionA, distinctiveness: 2 };
    const evaluate = (
      initial: unknown,
      revised: unknown,
      revisionPatch: RevisionPatch,
      changedClaims: DeltaCriticClaim[],
    ) => evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [factKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          revisionPatch,
          changedClaims,
          1,
          { revisionContract: "rejected_claim_patch_v3_server_slots" },
        ),
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    const duplicateTextInitial = {
      subsystems: [{
        subsystemKey,
        facts: [
          { statement: "Records receipts.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotionA },
          { statement: "Records receipts.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotionB },
        ],
        highlights: [{
          text: "Receipt recording",
          summary: "Records receipts.",
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotionA,
        }],
      }],
    };
    const uniqueReplacement = {
      statement: "Records payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotionA,
    };
    const uniqueHighlight = {
      text: "Receipt recording",
      summary: uniqueReplacement.statement,
      visibility: "private" as const,
      citationIndexes: [1],
      ...promotionA,
    };
    const uniquelyBound = evaluate(
      duplicateTextInitial,
      {
        subsystems: [{
          subsystemKey,
          facts: [uniqueReplacement, duplicateTextInitial.subsystems[0]!.facts[1]],
          highlights: [uniqueHighlight],
        }],
      },
      {
        factRevisions: [{ claimKey: factKey, replacement: uniqueReplacement }],
        highlightRevisions: [{ claimKey: highlightKey, replacement: uniqueHighlight }],
      },
      [
        {
          claimKey: factKey,
          kind: "fact",
          claim: { statement: uniqueReplacement.statement },
          citationIndexes: [1],
        },
        {
          claimKey: highlightKey,
          kind: "highlight",
          claim: {
            text: uniqueHighlight.text,
            summary: uniqueHighlight.summary,
          },
          citationIndexes: [1],
        },
      ],
    );
    expect(uniquelyBound.passed).toBe(true);

    const ambiguityInitial = {
      subsystems: [{
        subsystemKey,
        facts: [
          { statement: "Records receipts.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotionA },
          { statement: "Stores payment receipts.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotionA },
        ],
        highlights: [{
          text: "Receipt recording",
          summary: "Records receipts.",
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotionA,
        }],
      }],
    };
    const ambiguousReplacement = {
      statement: "Stores payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotionA,
    };
    const ambiguityRemoved = evaluate(
      ambiguityInitial,
      {
        subsystems: [{
          subsystemKey,
          facts: [ambiguousReplacement, ambiguityInitial.subsystems[0]!.facts[1]],
          highlights: [],
        }],
      },
      {
        factRevisions: [{ claimKey: factKey, replacement: ambiguousReplacement }],
        highlightRevisions: [{ claimKey: highlightKey, replacement: null }],
      },
      [{
        claimKey: factKey,
        kind: "fact",
        claim: { statement: ambiguousReplacement.statement },
        citationIndexes: [1],
      }],
    );
    expect(ambiguityRemoved.passed).toBe(true);
  });

  it("rejects a Highlight-only revision that changes server-owned promotion fields", () => {
    const subsystemKey = "project_domain:payments#scope";
    const highlightKey = `${subsystemKey}:highlight:1`;
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 4,
    };
    const fact = {
      statement: "Records payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    };
    const initial = {
      subsystems: [{
        subsystemKey,
        facts: [fact],
        highlights: [{
          text: "Receipt recording",
          summary: fact.statement,
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotion,
        }],
      }],
    };
    const forgedHighlight = {
      text: "Receipt persistence",
      summary: "Publishes every receipt to an external ledger.",
      visibility: "public_safe" as const,
      citationIndexes: [2],
      ...promotion,
      confidence: "low" as const,
    };
    const revised = {
      subsystems: [{
        subsystemKey,
        facts: [fact],
        highlights: [forgedHighlight],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: highlightKey,
      kind: "highlight",
      claim: {
        text: forgedHighlight.text,
        summary: forgedHighlight.summary,
      },
      citationIndexes: [2],
    }];
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [highlightKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          {
            factRevisions: [],
            highlightRevisions: [{
              claimKey: highlightKey,
              replacement: forgedHighlight,
            }],
          },
          changedClaims,
          1,
          {
            revisionContract: "rejected_claim_patch_v3_server_slots",
          },
        ),
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("keeps unsupported-detail wording obligations after positional re-keying", () => {
    const subsystemKey = "project_domain:payments#scope";
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const initial = {
      subsystems: [{
        subsystemKey,
        facts: [
          { statement: "Encrypts every receipt.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotion },
          { statement: "Publishes every receipt globally.", category: "behavior" as const, reviewNotes: null, citationIndexes: [1], ...promotion },
        ],
        highlights: [],
      }],
    };
    const roundOneFact = {
      statement: "Publishes payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    };
    const roundOne = {
      subsystems: [{ subsystemKey, facts: [roundOneFact], highlights: [] }],
    };
    const roundOneClaims: DeltaCriticClaim[] = [{
      claimKey: `${subsystemKey}:fact:2`,
      kind: "fact",
      claim: { statement: roundOneFact.statement },
      citationIndexes: [1],
    }];
    const roundOneCritic = deltaEntailmentCritic(roundOneClaims, 1);
    roundOneCritic.parsedOutput = {
      assessments: [{
        claimKey: `${subsystemKey}:fact:2`,
        supported: false,
        issues: ["unsupported_detail"],
      }],
    };
    const citationOnlyFact = { ...roundOneFact, citationIndexes: [2] };
    const roundTwo = {
      subsystems: [{ subsystemKey, facts: [citationOnlyFact], highlights: [] }],
    };
    const roundTwoClaims: DeltaCriticClaim[] = [{
      claimKey: `${subsystemKey}:fact:1`,
      kind: "fact",
      claim: { statement: citationOnlyFact.statement },
      citationIndexes: [2],
    }];

    const result = evaluateGenerationRuns([
      generation("execution_routing", "routing-model"),
      generation("semantic_extraction", "semantic-model"),
      synthesisGeneration(initial),
      entailmentCriticRejecting(initial, [
        `${subsystemKey}:fact:1`,
        `${subsystemKey}:fact:2`,
      ]),
      deltaRevisionGeneration(
        initial,
        roundOne,
        {
          factRevisions: [
            { claimKey: `${subsystemKey}:fact:1`, replacement: null },
            { claimKey: `${subsystemKey}:fact:2`, replacement: roundOneFact },
          ],
          highlightRevisions: [],
        },
        roundOneClaims,
        1,
        {
          revisionContract: "rejected_claim_patch_v3_server_slots",
          revisionEvidenceIndexesBySubsystem: [{
            subsystemKey,
            citationIndexes: [1, 2],
          }],
        },
      ),
      roundOneCritic,
      deltaRevisionGeneration(
        roundOne,
        roundTwo,
        {
          factRevisions: [{
            claimKey: `${subsystemKey}:fact:1`,
            replacement: citationOnlyFact,
          }],
          highlightRevisions: [],
        },
        roundTwoClaims,
        2,
        {
          revisionContract: "rejected_claim_patch_v3_server_slots",
          revisionEvidenceIndexesBySubsystem: [{
            subsystemKey,
            citationIndexes: [1, 2],
          }],
        },
      ),
      deltaEntailmentCritic(roundTwoClaims, 2),
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("requires exact server-owned metadata and notebook-bounded citations in v3 revisions", () => {
    const subsystemKey = "project_domain:payments#scope";
    const factKey = `${subsystemKey}:fact:1`;
    const promotion = {
      confidence: "low" as const,
      sensitivityFlag: false,
      productImportance: 0,
      implementationBreadth: 0,
      technicalDifficulty: 0,
      distinctiveness: 0,
    };
    const initialFact = {
      statement: "Records payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    };
    const initial = {
      subsystems: [{ subsystemKey, facts: [initialFact], highlights: [] }],
    };
    const validFact = {
      ...initialFact,
      statement: "Stores payment receipt identifiers.",
    };
    const build = (
      replacement: Record<string, unknown>,
      emitted: Record<string, unknown> = replacement,
      allowedCitationIndexes = [1],
    ) => {
      const revised = {
        subsystems: [{ subsystemKey, facts: [emitted], highlights: [] }],
      };
      const changedClaims: DeltaCriticClaim[] = [{
        claimKey: factKey,
        kind: "fact",
        claim: { statement: String(replacement.statement) },
        citationIndexes: replacement.citationIndexes as number[],
      }];
      return evaluateGenerationRuns([
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [factKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          {
            factRevisions: [{ claimKey: factKey, replacement }],
            highlightRevisions: [],
          },
          changedClaims,
          1,
          {
            revisionContract: "rejected_claim_patch_v3_server_slots",
            revisionEvidenceIndexesBySubsystem: [{
              subsystemKey,
              citationIndexes: allowedCitationIndexes,
            }],
          },
        ),
        deltaEntailmentCritic(changedClaims),
      ]);
    };

    expect(build(validFact).passed).toBe(true);
    expect(build(
      validFact,
      { ...validFact, distinctiveness: 1 },
    ).passed).toBe(false);
    expect(build(
      { ...validFact, citationIndexes: [2] },
      { ...validFact, citationIndexes: [2] },
      [1],
    ).passed).toBe(false);
    const missingCategory: Record<string, unknown> = { ...validFact };
    delete missingCategory.category;
    expect(build(missingCategory).passed).toBe(false);
  });

  it("rejects v3 chains anchored to impossible subsystem cardinalities", () => {
    const subsystemKey = "project_domain:payments#scope";
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const fact = (index: number) => ({
      statement: `Records payment receipt number ${index}.`,
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    });
    const highlight = (index: number, statement: string) => ({
      text: `Payment receipt record ${index}`,
      summary: statement,
      visibility: "private" as const,
      citationIndexes: [1],
      ...promotion,
    });
    const oversizedPayloads = [
      {
        initial: {
          subsystems: [{
            subsystemKey,
            facts: [fact(1), fact(2), fact(3), fact(4)],
            highlights: [],
          }],
        },
        rejectedKey: `${subsystemKey}:fact:4`,
        revised: {
          subsystems: [{
            subsystemKey,
            facts: [fact(1), fact(2), fact(3)],
            highlights: [],
          }],
        },
        patch: {
          factRevisions: [{
            claimKey: `${subsystemKey}:fact:4`,
            replacement: null,
          }],
          highlightRevisions: [],
        } satisfies RevisionPatch,
      },
      {
        initial: {
          subsystems: [{
            subsystemKey,
            facts: [fact(1)],
            highlights: [
              highlight(1, fact(1).statement),
              highlight(2, fact(1).statement),
              highlight(3, fact(1).statement),
            ],
          }],
        },
        rejectedKey: `${subsystemKey}:highlight:3`,
        revised: {
          subsystems: [{
            subsystemKey,
            facts: [fact(1)],
            highlights: [
              highlight(1, fact(1).statement),
              highlight(2, fact(1).statement),
            ],
          }],
        },
        patch: {
          factRevisions: [],
          highlightRevisions: [{
            claimKey: `${subsystemKey}:highlight:3`,
            replacement: null,
          }],
        } satisfies RevisionPatch,
      },
    ];

    for (const sample of oversizedPayloads) {
      const result = evaluateGenerationRuns([
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(sample.initial),
        entailmentCriticRejecting(sample.initial, [sample.rejectedKey]),
        deltaRevisionGeneration(
          sample.initial,
          sample.revised,
          sample.patch,
          [],
          1,
          { revisionContract: "rejected_claim_patch_v3_server_slots" },
        ),
      ]);

      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
      );
    }
  });

  it("rejects a v3 chain anchored to an ambiguously promoted Highlight", () => {
    const subsystemKey = "project_domain:payments#scope";
    const highlightKey = `${subsystemKey}:highlight:1`;
    const promotion = {
      confidence: "high" as const,
      sensitivityFlag: false,
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const fact = {
      statement: "Records payment receipts.",
      category: "behavior" as const,
      reviewNotes: null,
      citationIndexes: [1],
      ...promotion,
    };
    const initial = {
      subsystems: [{
        subsystemKey,
        facts: [fact, { ...fact }],
        highlights: [{
          text: "Payment receipt recording",
          summary: fact.statement,
          visibility: "private" as const,
          citationIndexes: [1],
          ...promotion,
        }],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey,
        facts: [fact, { ...fact }],
        highlights: [],
      }],
    };
    const result = evaluateGenerationRuns([
      generation("execution_routing", "routing-model"),
      generation("semantic_extraction", "semantic-model"),
      synthesisGeneration(initial),
      entailmentCriticRejecting(initial, [highlightKey]),
      deltaRevisionGeneration(
        initial,
        revised,
        {
          factRevisions: [],
          highlightRevisions: [{ claimKey: highlightKey, replacement: null }],
        },
        [],
        1,
        { revisionContract: "rejected_claim_patch_v3_server_slots" },
      ),
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("rejects a missing or mismatched changed-claim critic", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service encrypts every receipt.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service records an idempotency key.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:1",
      kind: "fact",
      claim: { statement: revised.subsystems[0]!.facts[0]!.statement },
      citationIndexes: [1],
    }];
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const revision = deltaRevisionGeneration(
      initial,
      revised,
      revisionPatch,
      changedClaims,
    );
    const mismatchedCritic = deltaEntailmentCritic(changedClaims);
    mismatchedCritic.inputSummary = {
      ...(mismatchedCritic.inputSummary as Record<string, unknown>),
      claimContentDigest: "0".repeat(64),
    };
    const malformedCritic = deltaEntailmentCritic(changedClaims);
    malformedCritic.parsedOutput = {
      assessments: [{
        claimKey: changedClaims[0]!.claimKey,
        supported: false,
        issues: ["invented_issue"],
      }],
    };
    const baseRuns = [
      generation("execution_routing", "routing-model"),
      generation("semantic_extraction", "semantic-model"),
      synthesisGeneration(initial),
      entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
      revision,
    ];
    for (const criticRuns of [[], [mismatchedCritic], [malformedCritic]]) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [...baseRuns, ...criticRuns],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.metrics).toMatchObject({
        claimfulSynthesis: 2,
        criticCoveredSynthesis: 1,
      });
      expect(result.issues).toContain(
        "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
      );
    }
  });

  it("rejects a revision whose replacement differs from its delta critic payload", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service encrypts every receipt.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service records an idempotency key.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const claimKey = "project_domain:payments#scope:fact:1";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const mismatchedCriticClaims: DeltaCriticClaim[] = [{
      claimKey,
      kind: "fact",
      claim: { statement: "The service stores payment receipts." },
      citationIndexes: [1],
    }];
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [claimKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          revisionPatch,
          mismatchedCriticClaims,
        ),
        deltaEntailmentCritic(mismatchedCriticClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("rejects an all-null revision that removes a supported claim", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const removedClaimKey = "project_domain:payments#scope:fact:2";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{ claimKey: removedClaimKey, replacement: null }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCritic(initial),
        deltaRevisionGeneration(initial, revised, revisionPatch, []),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.metrics).toMatchObject({
      capabilitySynthesis: 2,
      entailmentCritic: 1,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("accepts an authorized all-null revision without an empty critic call", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const removedClaimKey = "project_domain:payments#scope:fact:2";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{ claimKey: removedClaimKey, replacement: null }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [removedClaimKey]),
        deltaRevisionGeneration(initial, revised, revisionPatch, []),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      capabilitySynthesis: 2,
      entailmentCritic: 1,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 2,
    });
  });

  it("rejects a delta revision whose prior-payload chain is not attested", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:1",
      kind: "fact",
      claim: { statement: "The service stores payment receipts." },
      citationIndexes: [1],
    }];
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service stores payment receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const revision = deltaRevisionGeneration(
      initial,
      revised,
      revisionPatch,
      changedClaims,
    );
    const refs = revision.resultRefs as {
      resultAttestation: Record<string, unknown>;
    };
    refs.resultAttestation.priorClaimContentDigest = "0".repeat(64);
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
        revision,
        deltaEntailmentCritic(changedClaims),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
  });

  it("rejects claim-emitting synthesis without a matching successful entailment critic", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [{
          text: "Built receipt storage",
          summary: "The service persists payment receipts.",
          citationIndexes: [1],
        }],
      }],
    };
    const staleSynthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(staleSynthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects a critic whose persisted assessments do not cover every synthesized claim", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis, 0, { parsedOutput: { assessments: [] } }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
  });

  it("rejects a stale critic with the same round, count, and keys but different claim content", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1, 2],
        }],
        highlights: [],
      }],
    };
    const staleSynthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service retrieves receipts.",
          citationIndexes: [1, 3],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(staleSynthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects same-count critic attestations with wrong or duplicate claim keys", () => {
    const invalidAssessmentKeys = [
      [
        "project_domain:payments#scope:fact:1",
        "project_domain:payments#scope:highlight:1",
      ],
      [
        "project_domain:payments#scope:fact:1",
        "project_domain:payments#scope:fact:1",
      ],
    ];
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The payment service persists receipts.",
            citationIndexes: [1],
          },
          {
            statement: "The payment service retrieves receipts.",
            citationIndexes: [2],
          },
        ],
        highlights: [],
      }],
    };
    for (const claimKeys of invalidAssessmentKeys) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesis),
          entailmentCritic(synthesis, 0, {
            parsedOutput: {
              assessments: claimKeys.map((claimKey) => ({
                claimKey,
                supported: true,
                issues: [],
              })),
            },
          }),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.metrics).toMatchObject({
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 0,
      });
    }
  });

  it("accepts an initial synthesis only when its critic attests the same revision round", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis, {
          inputSummary: {
            phase: "synthesis",
            refreshRunId: "refresh-1",
            subsystemKeys: ["project_domain:payments#scope"],
            revisionRound: 0,
          },
        }),
        entailmentCritic(synthesis, 0),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 1,
    });
  });

  it("requires an exact successful critic attestation", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [{
          text: "Built durable receipt storage",
          summary: "The payment service persists receipts for later retrieval.",
          citationIndexes: [1],
        }],
      }],
    };
    const synthesisRun = synthesisGeneration(synthesis, {
      inputSummary: {
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: ["project_domain:payments#scope"],
        revisionRound: 0,
      },
    });
    const matchingCritic = entailmentCritic(synthesis, 0);
    const evaluate = (critic: RepositoryKnowledgeGenerationAuditRecord) =>
      evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisRun,
          critic,
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

    const accepted = evaluate(matchingCritic);
    expect(accepted.passed).toBe(true);
    expect(accepted.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 1,
    });

    const criticSummary = matchingCritic.inputSummary as Record<string, unknown>;
    const mismatches: RepositoryKnowledgeGenerationAuditRecord[] = [
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          subsystemKeys: ["project_domain:refunds#scope"],
        },
      },
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          claimCount: 1,
        },
      },
      {
        ...matchingCritic,
        parsedOutput: {
          assessments: [
            {
              claimKey: "project_domain:payments#scope:fact:1",
              supported: true,
              issues: [],
            },
            {
              claimKey: "project_domain:payments#scope:fact:1",
              supported: true,
              issues: [],
            },
          ],
        },
      },
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          claimContentDigest: "0".repeat(64),
        },
      },
      {
        ...matchingCritic,
        status: "provider_error",
      },
    ];
    for (const mismatch of mismatches) {
      const rejected = evaluate(mismatch);
      expect(rejected.passed).toBe(false);
      expect(rejected.issues).toContain(
        "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
      );
      expect(rejected.metrics).toMatchObject({
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 0,
      });
    }
  });

  it("rejects a critic that only covers another synthesis revision round", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis, {
          inputSummary: {
            phase: "synthesis",
            refreshRunId: "refresh-1",
            subsystemKeys: ["project_domain:payments#scope"],
            revisionRound: 1,
          },
        }),
        entailmentCritic(synthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects legacy capability synthesis rows without phase attestation", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        generation("capability_synthesis", "synthesis-model", {
          inputSummary: {},
        }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "No audited capability synthesis generation ran.",
      "1 capability synthesis generation(s) have no valid synthesis-phase attestation.",
    ]));
  });

  it("counts bounded model schema repair without confusing it with deterministic fallback", () => {
    const repairedExtraction = generation("semantic_extraction", "semantic-model", {
      resultRefs: {
        configuredModelId: "semantic-model",
        requestIds: ["generate", "repair"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 2,
        transportMode: "text_repair_fallback",
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        repairedExtraction,
        synthesisGeneration({
          subsystems: [{
            subsystemKey: "project_domain:payments#scope",
            facts: [],
            highlights: [],
          }],
        }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      providerAttemptCount: 4,
      schemaRepairRunCount: 1,
      deterministicSynthesis: false,
    });
  });

  it("accepts a fully accounted same-model transient retry", () => {
    const recoveredExtraction = generation("semantic_extraction", "semantic-model", {
      resultRefs: {
        configuredModelId: "semantic-model",
        requestIds: ["failed-request", "successful-request"],
        usageComplete: true,
        failedProviderAttempts: [{
          provider: "bedrock",
          modelId: "semantic-model",
          requestId: "failed-request",
          status: "provider_error",
          retryable: true,
        }],
        providerAttemptCount: 2,
        transportMode: "json_schema",
      },
      tokenUsage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        unknownUsageAttempts: 0,
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        recoveredExtraction,
        synthesisGeneration({
          subsystems: [{
            subsystemKey: "project_domain:payments#scope",
            facts: [],
            highlights: [],
          }],
        }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics.providerAttemptCount).toBe(4);
  });

  it("rejects failed or substituted generations and deterministic completion", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("semantic_extraction", "fallback-model", {
          provider: "openrouter",
          status: "provider_error",
          resultRefs: {
            configuredModelId: "semantic-model",
            requestIds: [],
            usageComplete: false,
            failedProviderAttempts: [{ provider: "bedrock" }],
            admissionFailure: true,
          },
          tokenUsage: { unknownUsageAttempts: 1 },
        }),
      ],
      expectedIdentities,
      coverage: [{
        targets: [{ deterministicFallbackPathCount: 2 }],
      }],
      orchestration: {
        fallbackUsed: true,
        generationRunId: null,
      },
      warnings: {
        synthesisCoverageGaps: [
          "Repository acme/project used deterministic subsystem synthesis because the shared repository-synthesis budget was exhausted.",
        ],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "No audited capability synthesis generation ran.",
      "No audited semantic planning generation ran.",
      expect.stringContaining("ended with status provider_error"),
      expect.stringContaining("used provider openrouter"),
      expect.stringContaining("used model fallback-model"),
      expect.stringContaining("has no provider request ID"),
      expect.stringContaining("incomplete model-usage evidence"),
      expect.stringContaining("records failed provider attempts"),
      expect.stringContaining("stopped before a provider dispatch"),
      "2 semantic path(s) used deterministic fallback analysis.",
      "Repository semantic planning used its deterministic fallback.",
      "Repository semantic planning has no audited generation reference.",
      "At least one subsystem used deterministic synthesis.",
      "Repository generation exhausted a model budget.",
    ]));
  });

  it("fails closed when planner fallback attestation is missing or malformed", () => {
    for (const orchestration of [
      { generationRunId: "generation-execution_routing" },
      { generationRunId: "generation-execution_routing", fallbackUsed: "false" },
    ]) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          generation("capability_synthesis", "synthesis-model"),
        ],
        expectedIdentities,
        coverage: null,
        orchestration,
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "Repository semantic planning has no valid fallback attestation.",
      );
    }
  });
});
