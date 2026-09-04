import { describe, expect, it } from "vitest";
import { reconcileRepositoryCapabilityFunnelMaterialization } from "@/src/domain/repository-capability-funnel";
import {
  applySynthesisCoverageGapsToRefreshState,
  allowsCanonicalKnowledgeReplacement,
  highlightReconciliationCasWhere,
  hasPromotedReconciliationEvidence,
  isSynthesizedCandidateUnsafe,
  isNewerKnowledgeRefreshGeneration,
  isRetryableKnowledgeRefreshTransactionError,
  knowledgeRefreshStateForEmbeddingTelemetry,
  projectFactReconciliationCasWhere,
  repositoryHighlightOwnershipDecision,
  repositoryKnowledgeIdentityRelation,
  repositoryKnowledgeStateMatches,
  repositoryMayReconcileHighlight,
  repositoryHighlightPublicDisposition,
  runBoundedKnowledgeEmbeddingTasks,
  shouldQuarantineSynthesizedCandidate,
  synthesisCandidateReconciliationKey,
  synthesisCoverageLedgerGapUpdates,
  synthesisProducedEntityBuckets,
  synthesisProducedEntityLedgerWhere,
  synthesisReconciliationScopeKey,
} from "@/src/services/knowledge-reconciliation-service";

describe("repository knowledge auto-apply policy", () => {
  const repositoryMetadata = (input: {
    sourceId?: string;
    operationKey: string;
    state: "implemented" | "partial" | "planned" | "bounded_absence";
  }) => ({
    schemaVersion: "repository-knowledge-metadata-v1" as const,
    managedBy: "repository_knowledge_sync" as const,
    refreshRunId: "refresh-current",
    sourceIds: input.sourceId ? [input.sourceId] : [],
    subsystemKey: "orders",
    synthesisKey: `orders#${input.operationKey}`,
    knowledgeRoles: [input.state === "implemented" ? "implementation" as const : "limitation" as const],
    implementationStates: [input.state],
    operationKeys: [input.operationKey],
    operationFacets: ["boundary" as const],
  });

  it("never revalidates knowledge when citation promotion produced no evidence", () => {
    expect(hasPromotedReconciliationEvidence([])).toBe(false);
    expect(hasPromotedReconciliationEvidence(["evidence-1"])).toBe(true);
  });

  it("only allows canonical supersession after complete verified coverage", () => {
    expect(allowsCanonicalKnowledgeReplacement("verified")).toBe(true);
    expect(allowsCanonicalKnowledgeReplacement("degraded")).toBe(false);
    expect(allowsCanonicalKnowledgeReplacement("failed")).toBe(false);
    expect(allowsCanonicalKnowledgeReplacement(null)).toBe(false);
  });

  it("uses source and operation identity before lexical similarity", () => {
    const candidate = repositoryMetadata({
      sourceId: "source-orders",
      operationKey: "orders.persist",
      state: "implemented",
    });
    expect(repositoryKnowledgeIdentityRelation({
      priorMetadata: { ...candidate, refreshRunId: "refresh-old" },
      candidateMetadata: candidate,
    })).toBe("same_operation");
    expect(repositoryKnowledgeIdentityRelation({
      priorMetadata: {
        ...candidate,
        refreshRunId: "refresh-old",
        sourceIds: ["source-billing"],
      },
      candidateMetadata: candidate,
    })).toBe("different");
    expect(repositoryKnowledgeIdentityRelation({
      priorMetadata: {
        ...candidate,
        refreshRunId: "refresh-old",
        operationKeys: ["orders.cancel"],
      },
      candidateMetadata: candidate,
    })).toBe("different");
    expect(repositoryKnowledgeIdentityRelation({
      priorMetadata: null,
      priorEvidenceSourceIds: ["source-billing"],
      candidateMetadata: candidate,
    })).toBe("different");
  });

  it("requires an explicit repository state revision to create a successor", () => {
    const implemented = repositoryMetadata({
      sourceId: "source-orders",
      operationKey: "orders.persist",
      state: "implemented",
    });
    expect(repositoryKnowledgeStateMatches({
      priorMetadata: {
        ...implemented,
        refreshRunId: "refresh-old",
        knowledgeRoles: ["limitation"],
        implementationStates: ["planned"],
      },
      candidateMetadata: implemented,
    })).toBe(false);
    expect(repositoryKnowledgeStateMatches({
      priorMetadata: null,
      candidateMetadata: implemented,
    })).toBe(true);
  });

  it("retries Prisma and driver-adapter forms of a serializable write conflict", () => {
    expect(isRetryableKnowledgeRefreshTransactionError(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    )).toBe(true);
    expect(isRetryableKnowledgeRefreshTransactionError(
      new Error("TransactionWriteConflict"),
    )).toBe(true);
    expect(isRetryableKnowledgeRefreshTransactionError(
      Object.assign(new Error("unique constraint"), { code: "P2002" }),
    )).toBe(false);
  });

  it("keeps content safety independent from synthesis-path approval", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      confidence: "medium",
      sensitivityFlag: false,
    })).toBe(false);
  });

  it("keeps exact deterministic synthesis review-only even when its semantic citation succeeded", () => {
    const source = {
      path: "src/retry.ts",
      statement: "The service performs a bounded retry.",
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
    };

    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: false,
      candidate: {
        statement: "The service performs a bounded retry.",
        confidence: "high",
        sensitivityFlag: false,
      },
      sources: [source],
    })).toBe(true);
    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: false,
      candidate: {
        statement: "The service performs a bounded retry across every provider.",
        confidence: "high",
        sensitivityFlag: false,
      },
      sources: [source],
    })).toBe(true);
  });

  it("does not restore deterministic auto-approval through otherwise safe extra citations", () => {
    const candidate = {
      statement: "The service performs a bounded retry.",
      confidence: "high",
      sensitivityFlag: false,
    };
    const source = {
      path: "src/retry.ts",
      statement: candidate.statement,
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      confidence: "medium" as const,
      sensitivityFlag: false,
    };

    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: false,
      candidate,
      sources: [source, {
        ...source,
        path: "src/retry-policy.ts",
        statement: "The retry policy bounds provider attempts.",
      }],
    })).toBe(true);
    for (const unsafeSource of [
      { ...source, semanticStatus: "degraded" as const },
      { ...source, evidenceMode: "deterministic_anchor" as const },
      { ...source, sensitivityFlag: true },
      { ...source, confidence: "low" as const },
      { ...source, path: "README.md" },
      { ...source, path: "vendor/generated-client.ts" },
    ]) {
      expect(isSynthesizedCandidateUnsafe({
        approvalEligible: false,
        candidate,
        sources: [source, unsafeSource],
      })).toBe(true);
    }
  });

  it("keeps deterministic Highlights review-only even when text and summary preserve the finding", () => {
    const source = {
      path: "src/retry.ts",
      statement: "The service performs a bounded retry.",
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
    };
    const exact = {
      text: source.statement,
      summary: `  The service performs a bounded retry.  `,
      confidence: "high",
      sensitivityFlag: false,
    };

    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: false,
      candidate: exact,
      sources: [source],
    })).toBe(true);
    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: false,
      candidate: { ...exact, summary: "The service retries providers and guarantees recovery." },
      sources: [source],
    })).toBe(true);
  });

  it("still quarantines low-confidence or sensitive candidates", () => {
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "low", sensitivityFlag: false })).toBe(true);
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "high", sensitivityFlag: true })).toBe(true);
  });

  it("does not let synthesis clear sensitivity from a cited source", () => {
    const candidate = {
      statement: "The runtime reads a configured service credential.",
      confidence: "high",
      sensitivityFlag: false,
    };
    const sensitiveSource = {
      path: "src/runtime/config.ts",
      statement: candidate.statement,
      semanticStatus: "succeeded" as const,
      sensitivityFlag: true,
    };

    expect(shouldQuarantineSynthesizedCandidate(candidate, [sensitiveSource])).toBe(true);
    expect(isSynthesizedCandidateUnsafe({
      approvalEligible: true,
      candidate,
      sources: [sensitiveSource],
    })).toBe(true);
  });

  it("quarantines candidates whose cited semantic extraction degraded", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "The service defines a bounded retry loop.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/retry.ts",
      statement: "The service defines a bounded retry loop.",
      semanticStatus: "degraded",
    }])).toBe(true);
  });

  it("quarantines modal workflow claims supported only by documentation", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "Every repository fact is automatically approved.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "README.md",
      statement: "Every repository fact is automatically approved.",
    }])).toBe(true);
  });

  it("allows a modal workflow claim when executable code corroborates it", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "Artifacts are only generated from approved Highlights.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/services/artifact-workflow-service.ts",
      statement: "The query uses only approved Highlights before artifact generation.",
    }])).toBe(false);
  });

  it("does not mistake a hyphenated product descriptor for an absolute claim", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "The product is an invite-only lending-circle MVP.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "README.md",
      statement: "CircleFund is an invite-only lending-circle MVP.",
      semanticStatus: "succeeded",
    }])).toBe(false);
  });

  it("blocks unprovable overclaims even when code is cited", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "The fallback always produces calibrated output with tamper-evident provenance.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/services/project-chat-agent-service.ts",
      statement: "The service contains a fallback branch.",
    }])).toBe(true);
  });

  it("keeps repository-only Highlights private until ownership context is reviewed", () => {
    expect(repositoryHighlightPublicDisposition(false)).toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining("requires reviewed ownership context")],
    });
  });

  it("preserves manual ownership until verified repository coverage can create a successor", () => {
    const manual = {
      metadata: {
        managedBy: "manual_evidence_highlight_workflow",
        originatingAgentRunId: "manual-run-1",
      },
    };
    expect(repositoryMayReconcileHighlight(manual)).toBe(false);
    expect(repositoryMayReconcileHighlight({
      metadata: { managedBy: "repository_knowledge_sync" },
    })).toBe(true);
    expect(repositoryHighlightOwnershipDecision({
      highlight: manual,
      similarityScore: 1,
      unsafe: false,
      allowCanonicalReplacement: false,
    })).toBe("preserve_manual");
    expect(repositoryHighlightOwnershipDecision({
      highlight: manual,
      similarityScore: 1,
      unsafe: false,
      allowCanonicalReplacement: true,
    })).toBe("supersede_manual");
    expect(repositoryHighlightOwnershipDecision({
      highlight: manual,
      similarityScore: 0.1,
      unsafe: false,
      allowCanonicalReplacement: true,
    })).toBe("unrelated_manual");
  });

  it("expires a reconciliation selection after a concurrent user edit", () => {
    const selectedAt = new Date("2026-07-21T10:00:00.000Z");
    const editedAt = new Date("2026-07-21T10:00:01.000Z");
    const factMetadata = {
      schemaVersion: "repository-knowledge-metadata-v1",
      implementationStates: ["partial"],
    };
    expect(projectFactReconciliationCasWhere({
      id: "fact-1",
      workItemId: "work-1",
      statement: "Repository refreshes reactivate facts.",
      status: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      metadata: factMetadata,
      supersedesProjectFactId: null,
      updatedAt: selectedAt,
    })).toMatchObject({
      updatedAt: selectedAt,
      reviewState: "pending_review",
      approvalSource: "automation",
      metadata: { equals: factMetadata },
    });
    const highlightMetadata = { managedBy: "repository_knowledge_sync" };
    expect(highlightReconciliationCasWhere({
      id: "highlight-1",
      workItemId: "work-1",
      text: "Original text",
      summary: "Original summary",
      verificationStatus: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      metadata: highlightMetadata,
      supersedesHighlightId: null,
      updatedAt: selectedAt,
    })).toMatchObject({
      updatedAt: selectedAt,
      text: "Original text",
      reviewState: "pending_review",
      metadata: { equals: highlightMetadata },
    });

    // Postgres updateMany uses every field above as one compare-and-swap. A
    // user edit advances updatedAt and changes review ownership, so a refresh
    // holding the old selection can update zero rows and must skip it.
    const current = {
      updatedAt: editedAt,
      reviewState: "reviewed",
      approvalSource: "user",
      lifecycleStatus: "needs_validation",
    };
    const staleWhere = projectFactReconciliationCasWhere({
      id: "fact-1",
      workItemId: "work-1",
      statement: "Repository refreshes reactivate facts.",
      status: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      metadata: factMetadata,
      updatedAt: selectedAt,
    });
    expect(current.updatedAt).not.toEqual(staleWhere.updatedAt);
    expect(current.reviewState).not.toEqual(staleWhere.reviewState);
  });

  it("runs independent embedding writes in bounded waves without failing reconciled memory", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const tasks = Array.from({ length: 9 }, (_, index) => ({
      entityKind: index % 2 === 0 ? "project_fact" as const : "highlight" as const,
      entityId: `entity-${index}`,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        completed.push(index);
        if (index === 5) throw new Error("embedding provider unavailable");
      },
    }));

    await expect(
      runBoundedKnowledgeEmbeddingTasks(tasks, 4),
    ).resolves.toEqual({
      attempted: 9,
      attempts: 10,
      retried: 1,
      recovered: 0,
      failed: 1,
      failedTargets: [{ entityKind: "highlight", entityId: "entity-5" }],
    });
    expect(peak).toBe(4);
    expect(completed).toHaveLength(10);
  });

  it("rejects an invalid embedding concurrency before starting work", async () => {
    await expect(
      runBoundedKnowledgeEmbeddingTasks([], 0),
    ).rejects.toThrow("positive integer");
  });

  it("recovers a transient embedding failure in one bounded retry", async () => {
    let attempts = 0;
    await expect(runBoundedKnowledgeEmbeddingTasks([{
      entityKind: "project_fact",
      entityId: "fact-1",
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary throttle");
      },
    }], 1)).resolves.toEqual({
      attempted: 1,
      attempts: 2,
      retried: 1,
      recovered: 1,
      failed: 0,
      failedTargets: [],
    });
  });

  it("degrades and records failed embedding targets, then restores the prior quality after backfill", () => {
    const failed = knowledgeRefreshStateForEmbeddingTelemetry({
      warnings: { analyzerVersion: "v1" },
      qualityStatus: "verified",
      telemetry: {
        attempted: 2,
        attempts: 3,
        retried: 1,
        recovered: 0,
        failed: 1,
        failedTargets: [{ entityKind: "highlight", entityId: "highlight-1" }],
      },
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    expect(failed).toMatchObject({
      qualityStatus: "degraded",
      warnings: {
        analyzerVersion: "v1",
        embeddingBaseQuality: "verified",
        embeddingTelemetry: {
          failed: 1,
          failedTargets: [{ entityKind: "highlight", entityId: "highlight-1" }],
          updatedAt: "2026-07-19T12:00:00.000Z",
        },
      },
    });

    expect(knowledgeRefreshStateForEmbeddingTelemetry({
      warnings: failed.warnings,
      qualityStatus: "degraded",
      telemetry: {
        attempted: 1,
        attempts: 1,
        retried: 0,
        recovered: 0,
        failed: 0,
        failedTargets: [],
      },
    }).qualityStatus).toBe("verified");
  });

  it("treats a later resolved differing head as a newer knowledge generation", () => {
    const currentCreatedAt = new Date("2026-07-16T10:00:00.000Z");
    const currentTargets = [{
      sourceId: "source-1",
      commitSha: "a".repeat(40),
      resolvedAt: "2026-07-16T10:00:00.000Z",
    }];
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: [{
        ...currentTargets[0],
        commitSha: "b".repeat(40),
        resolvedAt: "2026-07-16T10:01:00.000Z",
      }],
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:01:01.000Z"),
    })).toBe(true);
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: currentTargets,
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:02:00.000Z"),
    })).toBe(false);
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: [{
        ...currentTargets[0],
        commitSha: "0".repeat(40),
        resolvedAt: "2026-07-16T09:59:00.000Z",
      }],
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:02:00.000Z"),
    })).toBe(false);
  });

  it("makes synthesis notebook overflow durable and partial for the affected repository", () => {
    const state = applySynthesisCoverageGapsToRefreshState({
      coverage: [{
        repository: "owner/repo-a",
        coverageStatus: "complete",
        capabilityCoverageStatus: "complete",
        coverageGaps: [],
      }, {
        repository: "owner/repo-b",
        coverageStatus: "complete",
        capabilityCoverageStatus: "complete",
        coverageGaps: [],
      }],
      warnings: { existingWarning: true },
      coverageGaps: [
        "Repository owner/repo-b could not fit inside the bounded 20-entry synthesis notebook.",
      ],
    });

    expect(state.coverage).toEqual([
      expect.objectContaining({
        repository: "owner/repo-a",
        coverageStatus: "complete",
      }),
      expect.objectContaining({
        repository: "owner/repo-b",
        coverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        coverageGaps: [expect.stringContaining("could not fit")],
      }),
    ]);
    expect(state.warnings).toMatchObject({
      existingWarning: true,
      synthesisCoverageGaps: [expect.stringContaining("owner/repo-b")],
    });
  });

  it("applies an anchor-only synthesis gap only to the matching repository capability ledger", () => {
    const gap = "Repository owner/repo-b produced no supported Project Facts for data_model during repository synthesis.";

    expect(synthesisCoverageLedgerGapUpdates({
      synthesis: [{
        sourceId: "source-b",
        repository: "owner/repo-b",
        subsystemKey: "data_model",
        coverageGaps: [gap],
        notebook: [],
      }],
      ledgers: [{
        id: "ledger-a",
        capabilityKey: "data_model",
        gaps: ["Existing repository A gap."],
        sourceId: "source-a",
      }, {
        id: "ledger-b",
        capabilityKey: "data_model",
        gaps: ["Existing repository B gap."],
        sourceId: "source-b",
      }],
    })).toEqual([{
      id: "ledger-b",
      gaps: ["Existing repository B gap.", gap],
    }]);
  });

  it("keeps same-capability candidates, production buckets, and ledger writes source-scoped", () => {
    const repositoryA = {
      sourceId: "source-a",
      repository: "owner/repo-a",
      subsystemKey: "data_model",
    };
    const repositoryB = {
      sourceId: "source-b",
      repository: "owner/repo-b",
      subsystemKey: "data_model",
    };

    expect(synthesisReconciliationScopeKey(repositoryA)).not.toBe(
      synthesisReconciliationScopeKey(repositoryB),
    );
    expect(synthesisCandidateReconciliationKey("fact", repositoryA, 0)).not.toBe(
      synthesisCandidateReconciliationKey("fact", repositoryB, 0),
    );
    const buckets = synthesisProducedEntityBuckets([repositoryA, repositoryB]);
    buckets.get(synthesisReconciliationScopeKey(repositoryA))?.projectFactIds.push("fact-a");
    expect(buckets.size).toBe(2);
    expect(buckets.get(synthesisReconciliationScopeKey(repositoryA))).toEqual({
      projectFactIds: ["fact-a"],
      highlightIds: [],
    });
    expect(buckets.get(synthesisReconciliationScopeKey(repositoryB))).toEqual({
      projectFactIds: [],
      highlightIds: [],
    });
    expect(synthesisProducedEntityLedgerWhere("refresh-1", repositoryB)).toEqual({
      refreshRunId: "refresh-1",
      capabilityKey: "data_model",
      snapshot: { sourceId: "source-b" },
    });
  });

  it("keeps sibling operation-community candidate keys distinct within one capability", () => {
    const first = {
      sourceId: "source-a",
      subsystemKey: "project_domain:billing",
      synthesisKey: "project_domain:billing#community-1",
    };
    const second = {
      ...first,
      synthesisKey: "project_domain:billing#community-2",
    };

    expect(synthesisCandidateReconciliationKey("fact", first, 0)).not.toBe(
      synthesisCandidateReconciliationKey("fact", second, 0),
    );
    expect(synthesisCandidateReconciliationKey("highlight", first, 0)).not.toBe(
      synthesisCandidateReconciliationKey("highlight", second, 0),
    );
  });

  it("merges capability-funnel traces instead of overwriting sibling synthesis communities", () => {
    const trace = (candidateRef: string, selected: boolean) => ({
      version: 1 as const,
      observations: { admittedToSynthesis: 3 },
      facts: { verified: 1 },
      highlights: {
        eligibleCandidates: 1,
        selected: selected ? 1 : 0,
        decisions: [{
          candidateRef,
          factIndex: 0,
          outcome: selected ? "selected" as const : "omitted" as const,
          reasons: selected ? [] : ["selector_lower_relative_salience" as const],
        }],
      },
      auditRefs: {
        selectionGenerationRunId: "selection-run",
        criticGenerationRunIds: selected ? ["critic-run"] : [],
      },
    });
    const buckets = synthesisProducedEntityBuckets([
      {
        sourceId: "source-a",
        subsystemKey: "project_domain:billing",
        capabilityFunnel: trace("candidate-a", true),
      },
      {
        sourceId: "source-a",
        subsystemKey: "project_domain:billing",
        capabilityFunnel: trace("candidate-b", false),
      },
    ]);

    expect(buckets.get(JSON.stringify(["source-a", "project_domain:billing"])))
      .toMatchObject({
        capabilityFunnel: {
          observations: { admittedToSynthesis: 6 },
          facts: { verified: 2 },
          highlights: {
            eligibleCandidates: 2,
            selected: 1,
            decisions: [
              expect.objectContaining({ candidateRef: "candidate-a", outcome: "selected" }),
              expect.objectContaining({ candidateRef: "candidate-b", reasons: ["selector_lower_relative_salience"] }),
            ],
          },
          auditRefs: {
            selectionGenerationRunId: "selection-run",
            criticGenerationRunIds: ["critic-run"],
          },
        },
      });
  });

  it("records which selected Highlights actually materialized", () => {
    const trace = {
      version: 1 as const,
      observations: { admittedToSynthesis: 2 },
      facts: { verified: 2 },
      highlights: {
        eligibleCandidates: 2,
        selected: 2,
        decisions: ["candidate-a", "candidate-b"].map((candidateRef, factIndex) => ({
          candidateRef,
          factIndex,
          outcome: "selected" as const,
          reasons: [],
        })),
      },
      auditRefs: { criticGenerationRunIds: [] },
    };

    expect(reconcileRepositoryCapabilityFunnelMaterialization(
      trace,
      new Map([["candidate-a", "highlight-a"]]),
    )).toMatchObject({
      highlights: {
        selected: 2,
        materialized: 1,
        decisions: [
          expect.objectContaining({
            candidateRef: "candidate-a",
            materialization: { status: "materialized", entityId: "highlight-a" },
          }),
          expect.objectContaining({
            candidateRef: "candidate-b",
            reasons: ["not_materialized"],
            materialization: { status: "not_materialized" },
          }),
        ],
      },
    });
  });
});
