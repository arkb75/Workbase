import { describe, expect, it } from "vitest";
import {
  applySynthesisCoverageGapsToRefreshState,
  allowsCanonicalKnowledgeReplacement,
  highlightReconciliationCasWhere,
  hasPromotedReconciliationEvidence,
  isNewerKnowledgeRefreshGeneration,
  knowledgeRefreshStateForEmbeddingTelemetry,
  projectFactReconciliationCasWhere,
  repositoryHighlightOwnershipDecision,
  repositoryMayReconcileHighlight,
  repositoryHighlightPublicDisposition,
  runBoundedKnowledgeEmbeddingTasks,
  shouldQuarantineSynthesizedCandidate,
} from "@/src/services/knowledge-reconciliation-service";

describe("repository knowledge auto-apply policy", () => {
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

  it("does not quarantine a supported deterministic fallback merely because model synthesis failed", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      confidence: "medium",
      sensitivityFlag: false,
    })).toBe(false);
  });

  it("still quarantines low-confidence or sensitive candidates", () => {
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "low", sensitivityFlag: false })).toBe(true);
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "high", sensitivityFlag: true })).toBe(true);
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
    expect(projectFactReconciliationCasWhere({
      id: "fact-1",
      workItemId: "work-1",
      statement: "Repository refreshes reactivate facts.",
      status: "approved",
      lifecycleStatus: "needs_validation",
      reviewState: "pending_review",
      approvalSource: "automation",
      supersedesProjectFactId: null,
      updatedAt: selectedAt,
    })).toMatchObject({
      updatedAt: selectedAt,
      reviewState: "pending_review",
      approvalSource: "automation",
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
});
