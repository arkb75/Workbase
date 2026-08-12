import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshFind: vi.fn(),
  factFind: vi.fn(),
  factUpdate: vi.fn(),
  factUpdateMany: vi.fn(),
  factUpdateManyAndReturn: vi.fn(),
  highlightFind: vi.fn(),
  highlightUpdate: vi.fn(),
  highlightUpdateMany: vi.fn(),
  highlightUpdateManyAndReturn: vi.fn(),
  evidenceFind: vi.fn(),
  evidenceUpdate: vi.fn(),
  evidenceUpdateMany: vi.fn(),
  evidenceUpdateManyAndReturn: vi.fn(),
  artifactFind: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactUpdateMany: vi.fn(),
  artifactUpdateManyAndReturn: vi.fn(),
  knowledgeChangeFind: vi.fn(),
  recordReviewableChangesBatch: vi.fn(),
  recordChange: vi.fn(),
  recordContentAddressedRevalidations: vi.fn(),
  invalidateEvidenceDependents: vi.fn(),
  invalidateStaleEvidenceDependentsInTransaction: vi.fn(),
  generationFence: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    knowledgeRefreshRun: { findUniqueOrThrow: mocks.refreshFind },
    projectFact: {
      findMany: mocks.factFind,
      update: mocks.factUpdate,
      updateMany: mocks.factUpdateMany,
      updateManyAndReturn: mocks.factUpdateManyAndReturn,
    },
    highlight: {
      findMany: mocks.highlightFind,
      update: mocks.highlightUpdate,
      updateMany: mocks.highlightUpdateMany,
      updateManyAndReturn: mocks.highlightUpdateManyAndReturn,
    },
    evidenceItem: {
      findMany: mocks.evidenceFind,
      update: mocks.evidenceUpdate,
      updateMany: mocks.evidenceUpdateMany,
      updateManyAndReturn: mocks.evidenceUpdateManyAndReturn,
    },
    artifact: {
      findMany: mocks.artifactFind,
      update: mocks.artifactUpdate,
      updateMany: mocks.artifactUpdateMany,
      updateManyAndReturn: mocks.artifactUpdateManyAndReturn,
    },
    knowledgeChange: { findMany: mocks.knowledgeChangeFind },
  },
}));

vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({ modelId: "test-model" }),
  resolveActiveTextModelIdentity: () => ({
    provider: "bedrock",
    modelId: "test-model",
  }),
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  knowledgeSimilarity: vi.fn(() => 0),
  recordChange: mocks.recordChange,
  recordContentAddressedRevalidations: mocks.recordContentAddressedRevalidations,
  STRONG_KNOWLEDGE_IDENTITY_THRESHOLD: 0.8,
  KNOWLEDGE_LIFECYCLE_POLICY_VERSION: "knowledge-lifecycle-v3",
  withKnowledgeRefreshGenerationFence: mocks.generationFence,
}));

vi.mock("@/src/services/knowledge-change-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/services/knowledge-change-service")>();
  return {
    ...actual,
    upsertReviewableKnowledgeChangesInTransaction: mocks.recordReviewableChangesBatch,
  };
});

vi.mock("@/src/services/knowledge-dependency-service", () => ({
  invalidateEvidenceDependents: mocks.invalidateEvidenceDependents,
  invalidateStaleEvidenceDependentsInTransaction: mocks.invalidateStaleEvidenceDependentsInTransaction,
}));

import { reconcileStaleKnowledge } from "@/src/services/knowledge-staleness-service";

function evidence(input: {
  id: string;
  path: string;
  blobSha: string;
  lifecycleStatus: "active" | "needs_validation" | "stale";
}) {
  return {
    id: input.id,
    workItemId: "work-1",
    sourceId: "source-1",
    externalId: input.id,
    type: "github_file_excerpt",
    title: input.path,
    content: "exact excerpt",
    searchText: "exact excerpt",
    lifecycleStatus: input.lifecycleStatus,
    validatedThroughSha: "head-old",
    repositorySnapshotId: "snapshot-old",
    purgeEligibleAt: input.lifecycleStatus === "stale" ? new Date("2026-01-01") : null,
    metadata: {
      commitSha: "head-old",
      blobSha: input.blobSha,
      path: input.path,
      startLine: 1,
      endLine: 3,
      excerptHash: `${input.id}-hash`,
    },
  };
}

describe("monotonic repository staleness reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.factUpdate.mockResolvedValue({});
    mocks.highlightUpdate.mockResolvedValue({});
    mocks.evidenceUpdate.mockResolvedValue({});
    mocks.artifactUpdate.mockResolvedValue({});
    mocks.factUpdateMany.mockResolvedValue({ count: 1 });
    mocks.highlightUpdateMany.mockResolvedValue({ count: 1 });
    mocks.evidenceUpdateMany.mockResolvedValue({ count: 1 });
    mocks.artifactUpdateMany.mockResolvedValue({ count: 1 });
    const returnCasWinners = async (args: { where?: { OR?: Array<{ id?: string }> } }) =>
      (args.where?.OR ?? []).flatMap((entry) =>
        typeof entry.id === "string" ? [{ id: entry.id }] : []
      );
    mocks.factUpdateManyAndReturn.mockImplementation(returnCasWinners);
    mocks.highlightUpdateManyAndReturn.mockImplementation(returnCasWinners);
    mocks.evidenceUpdateManyAndReturn.mockImplementation(returnCasWinners);
    mocks.artifactUpdateManyAndReturn.mockImplementation(returnCasWinners);
    mocks.recordChange.mockResolvedValue({});
    mocks.recordContentAddressedRevalidations.mockResolvedValue({ count: 0 });
    mocks.recordReviewableChangesBatch.mockResolvedValue([]);
    mocks.invalidateStaleEvidenceDependentsInTransaction.mockResolvedValue({
      evidenceItemIds: [],
      projectFactIds: [],
      highlightIds: [],
      artifactIds: [],
    });
    mocks.knowledgeChangeFind.mockResolvedValue([]);
    mocks.generationFence.mockImplementation(async (
      _runId: string,
      operation: (client: unknown) => Promise<unknown>,
    ) => operation({
      projectFact: {
        updateMany: mocks.factUpdateMany,
        updateManyAndReturn: mocks.factUpdateManyAndReturn,
      },
      highlight: {
        updateMany: mocks.highlightUpdateMany,
        updateManyAndReturn: mocks.highlightUpdateManyAndReturn,
      },
      evidenceItem: {
        updateMany: mocks.evidenceUpdateMany,
        updateManyAndReturn: mocks.evidenceUpdateManyAndReturn,
      },
      artifact: {
        updateMany: mocks.artifactUpdateMany,
        updateManyAndReturn: mocks.artifactUpdateManyAndReturn,
      },
    }));
  });

  it("does not apply a staleness mutation after the generation fence is lost", async () => {
    const supportingEvidence = {
      ...evidence({
        id: "evidence-fenced",
        path: "src/current.ts",
        blobSha: "blob-current",
        lifecycleStatus: "active",
      }),
      reviewState: "pending_review",
      approvalSource: "automation",
      lastValidatedAt: null,
      updatedAt: new Date("2026-07-16T10:00:00.000Z"),
    };
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-old",
      workItemId: "work-1",
      status: "reconciling",
      qualityStatus: "verified",
      coverage: [{
        repository: "owner/repo",
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{
        sourceId: "source-1",
        repository: "owner/repo",
        commitSha: "head-new",
      }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: [{ path: "src/current.ts", blobSha: "blob-current" }],
      }],
    });
    mocks.factFind
      .mockResolvedValueOnce([{
        id: "fact-fenced",
        statement: "The current service persists durable state.",
        subsystemKey: "workflow",
        status: "approved",
        lifecycleStatus: "stale",
        reviewState: "pending_review",
        approvalSource: "automation",
        rejectionReason: null,
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "head-old",
        validationHeads: { "source-1": "head-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        updatedAt: new Date("2026-07-16T10:00:00.000Z"),
        evidence: [{
          evidenceItemId: supportingEvidence.id,
          evidenceItem: supportingEvidence,
        }],
      }])
      .mockResolvedValueOnce([]);
    mocks.highlightFind.mockResolvedValue([]);
    mocks.evidenceFind.mockResolvedValue([]);
    mocks.artifactFind.mockResolvedValue([]);
    mocks.generationFence.mockRejectedValueOnce(
      new Error("Repository refresh refresh-old was superseded."),
    );

    await expect(reconcileStaleKnowledge({
      runId: "refresh-old",
      appliedFactIds: [],
      appliedHighlightIds: [],
    })).rejects.toThrow("superseded");
    expect(mocks.factUpdateManyAndReturn).not.toHaveBeenCalled();
    expect(mocks.recordContentAddressedRevalidations).not.toHaveBeenCalled();
  });

  it("repairs exact stale provenance and its artifact but leaves unresolved knowledge untouched in a degraded refresh", async () => {
    const exactEvidence = evidence({
      id: "evidence-exact",
      path: "src/unchanged.ts",
      blobSha: "blob-unchanged",
      lifecycleStatus: "stale",
    });
    const unresolvedEvidence = evidence({
      id: "evidence-unresolved",
      path: "src/changed.ts",
      blobSha: "blob-old",
      lifecycleStatus: "active",
    });
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-1",
      qualityStatus: "degraded",
      coverage: [{
        repository: "owner/repo",
        coverageStatus: "partial",
        semanticCoverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        coverageGaps: ["One semantic package failed."],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: false,
        files: [
          { path: "src/unchanged.ts", blobSha: "blob-unchanged" },
          { path: "src/changed.ts", blobSha: "blob-new" },
        ],
      }],
    });
    mocks.factFind
      .mockResolvedValueOnce([
        {
          id: "fact-exact",
          statement: "The unchanged service persists durable runs.",
          subsystemKey: "workflow",
          status: "approved",
          lifecycleStatus: "stale",
          reviewState: "pending_review",
          approvalSource: "automation",
          publicSafetyStatus: "not_eligible",
          validatedThroughSha: "head-old",
          validationHeads: { "source-1": "head-old" },
          lastValidatedAt: null,
          autoAppliedAt: null,
          evidence: [{ evidenceItemId: exactEvidence.id, evidenceItem: exactEvidence }],
        },
        {
          id: "fact-unresolved",
          statement: "The changed service applies a routing policy.",
          subsystemKey: "routing",
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
          publicSafetyStatus: "not_eligible",
          validatedThroughSha: "head-old",
          validationHeads: { "source-1": "head-old" },
          lastValidatedAt: null,
          autoAppliedAt: null,
          evidence: [{ evidenceItemId: unresolvedEvidence.id, evidenceItem: unresolvedEvidence }],
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.highlightFind
      .mockResolvedValueOnce([{
        id: "highlight-exact",
        text: "Built durable workflows",
        summary: "The unchanged implementation persists durable workflow runs.",
        metadata: { subsystemKey: "workflow" },
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "head-old",
        validationHeads: { "source-1": "head-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: exactEvidence.id, evidenceItem: exactEvidence }],
      }])
      .mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue([exactEvidence, unresolvedEvidence]);
    mocks.artifactFind.mockResolvedValue([{
      id: "artifact-exact",
      content: "A grounded artifact.",
      lifecycleStatus: "stale",
      staleReason: "This immutable repository excerpt was pinned to an older repository head.",
      highlightProvenance: [{
        highlightId: "highlight-exact",
        highlight: { id: "highlight-exact", lifecycleStatus: "active" },
      }],
      evidenceProvenance: [{
        evidenceItemId: "evidence-exact",
        evidenceItem: { id: "evidence-exact", lifecycleStatus: "active" },
      }],
    }]);

    const result = await reconcileStaleKnowledge({
      runId: "refresh-1",
      appliedFactIds: [],
      appliedHighlightIds: [],
    });

    expect(result).toEqual({ retiredFactIds: [], retiredHighlightIds: [], staleArtifactIds: [] });
    expect(mocks.factUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mocks.factUpdateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [expect.objectContaining({ id: "fact-exact" })],
      },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.highlightUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mocks.highlightUpdateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [expect.objectContaining({ id: "highlight-exact" })],
      },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [expect.objectContaining({ id: "evidence-exact" })],
      },
      data: expect.objectContaining({
        lifecycleStatus: "active",
        validatedThroughSha: "head-new",
        repositorySnapshotId: "snapshot-new",
        purgeEligibleAt: null,
      }),
    }));
    expect(mocks.invalidateEvidenceDependents).not.toHaveBeenCalled();
    expect(mocks.artifactFind).toHaveBeenCalledWith(expect.objectContaining({
      where: { workItemId: "work-1", lifecycleStatus: "stale" },
    }));
    expect(mocks.artifactUpdateManyAndReturn).toHaveBeenCalledWith({
      where: {
        OR: [expect.objectContaining({ id: "artifact-exact" })],
      },
      data: { lifecycleStatus: "active", staleReason: null },
      select: { id: true },
    });
    expect(mocks.factUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "fact-unresolved" } }));
    expect(mocks.recordContentAddressedRevalidations).toHaveBeenCalledTimes(1);
    expect(mocks.recordContentAddressedRevalidations).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ entityKind: "project_fact", entityId: "fact-exact", action: "revalidated" }),
      expect.objectContaining({ entityKind: "highlight", entityId: "highlight-exact", action: "revalidated" }),
      expect.objectContaining({ entityKind: "evidence", entityId: "evidence-exact", action: "revalidated" }),
      expect.objectContaining({ entityKind: "artifact", entityId: "artifact-exact", action: "revalidated" }),
    ]));
    expect(mocks.recordChange).not.toHaveBeenCalledWith(expect.objectContaining({ action: "revalidated" }));
  });

  it("advances a large unchanged excerpt set with one grouped write and no pending review cards", async () => {
    const excerpts = Array.from({ length: 70 }, (_, index) => evidence({
      id: `evidence-${index}`,
      path: `src/file-${index}.ts`,
      blobSha: `blob-${index}`,
      lifecycleStatus: "stale",
    }));
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-bulk",
      workItemId: "work-1",
      qualityStatus: "degraded",
      coverage: [{
        coverageStatus: "partial",
        semanticCoverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        coverageGaps: ["A semantic package failed."],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: false,
        files: excerpts.map((item) => ({
          path: (item.metadata as { path: string }).path,
          blobSha: (item.metadata as { blobSha: string }).blobSha,
        })),
      }],
    });
    mocks.factFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.highlightFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue(excerpts);
    mocks.artifactFind.mockResolvedValue([]);

    await reconcileStaleKnowledge({
      runId: "refresh-bulk",
      appliedFactIds: [],
      appliedHighlightIds: [],
    });

    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: expect.arrayContaining(
          excerpts.map((item) => expect.objectContaining({ id: item.id })),
        ),
      },
    }));
    expect(mocks.evidenceUpdate).not.toHaveBeenCalled();
    expect(mocks.recordChange).not.toHaveBeenCalled();
    expect(mocks.recordContentAddressedRevalidations).toHaveBeenCalledTimes(1);
    const recorded = mocks.recordContentAddressedRevalidations.mock.calls[0]?.[0] as unknown[];
    expect(recorded).toHaveLength(70);
    expect(recorded.every((entry) =>
      (entry as { action: string }).action === "revalidated"
    )).toBe(true);
  });

  it("marks changed excerpts and delegates dependent invalidation in one guarded batch", async () => {
    const excerpts = Array.from({ length: 20 }, (_, index) => evidence({
      id: `changed-${index}`,
      path: `src/changed-${index}.ts`,
      blobSha: `blob-old-${index}`,
      lifecycleStatus: "active",
    }));
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-stale-bulk",
      workItemId: "work-1",
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: excerpts.map((item) => ({
          path: (item.metadata as { path: string }).path,
          blobSha: `${(item.metadata as { blobSha: string }).blobSha}-changed`,
        })),
      }],
    });
    mocks.factFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.highlightFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValueOnce(excerpts);
    mocks.artifactFind.mockResolvedValue([]);

    await reconcileStaleKnowledge({
      runId: "refresh-stale-bulk",
      appliedFactIds: [],
      appliedHighlightIds: [],
    });

    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: expect.arrayContaining(
          excerpts.map((item) => expect.objectContaining({ id: item.id })),
        ),
      },
      data: expect.objectContaining({ lifecycleStatus: "stale", purgeEligibleAt: expect.any(Date) }),
    }));
    expect(mocks.recordReviewableChangesBatch).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewableChangesBatch).toHaveBeenCalledWith(
      expect.arrayContaining(excerpts.map((item) => expect.objectContaining({
        entityKind: "evidence",
        entityId: item.id,
        idempotencyKey: `refresh-stale-bulk:evidence:updated:${item.id}:stale:refresh-stale-bulk`,
      }))),
      expect.any(Object),
    );
    expect(mocks.invalidateStaleEvidenceDependentsInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateStaleEvidenceDependentsInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceItemIds: excerpts.map((item) => item.id),
        idempotencyScope: "refresh:refresh-stale-bulk:stale-evidence-batch",
      }),
      expect.any(Object),
    );
    expect(mocks.invalidateEvidenceDependents).not.toHaveBeenCalled();
  });

  it("retries the complete stale-evidence transaction after dependent invalidation fails", async () => {
    const changed = evidence({
      id: "changed-retry",
      path: "src/changed-retry.ts",
      blobSha: "blob-old",
      lifecycleStatus: "active",
    });
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-retry-stale",
      workItemId: "work-1",
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: [{ path: "src/changed-retry.ts", blobSha: "blob-new" }],
      }],
    });
    mocks.factFind.mockResolvedValue([]);
    mocks.highlightFind.mockResolvedValue([]);
    mocks.evidenceFind.mockResolvedValue([changed]);
    mocks.artifactFind.mockResolvedValue([]);
    mocks.invalidateStaleEvidenceDependentsInTransaction
      .mockRejectedValueOnce(new Error("injected dependent invalidation failure"))
      .mockResolvedValueOnce({
        evidenceItemIds: [changed.id],
        projectFactIds: ["fact-1"],
        highlightIds: [],
        artifactIds: [],
      });

    await expect(reconcileStaleKnowledge({
      runId: "refresh-retry-stale",
      appliedFactIds: [],
      appliedHighlightIds: [],
    })).rejects.toThrow("injected dependent invalidation failure");

    await expect(reconcileStaleKnowledge({
      runId: "refresh-retry-stale",
      appliedFactIds: [],
      appliedHighlightIds: [],
    })).resolves.toEqual({ retiredFactIds: [], retiredHighlightIds: [], staleArtifactIds: [] });

    expect(mocks.evidenceUpdateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(mocks.recordReviewableChangesBatch).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateStaleEvidenceDependentsInTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not replace review cards when unresolved knowledge is already awaiting validation", async () => {
    const changedEvidence = evidence({
      id: "evidence-changed",
      path: "src/changed.ts",
      blobSha: "blob-old",
      lifecycleStatus: "active",
    });
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-current",
      workItemId: "work-1",
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: [{ path: "src/changed.ts", blobSha: "blob-new" }],
      }],
    });
    mocks.factFind
      .mockResolvedValueOnce([{
        id: "fact-pending",
        statement: "The changed service applies a routing policy.",
        subsystemKey: "routing",
        status: "approved",
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "head-old",
        validationHeads: { "source-1": "head-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: changedEvidence.id, evidenceItem: changedEvidence }],
      }])
      .mockResolvedValueOnce([]);
    mocks.highlightFind
      .mockResolvedValueOnce([{
        id: "highlight-pending",
        text: "Applied a routing policy",
        summary: "The changed service applies a routing policy.",
        metadata: { subsystemKey: "routing" },
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "head-old",
        validationHeads: { "source-1": "head-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: changedEvidence.id, evidenceItem: changedEvidence }],
      }])
      .mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue([]);
    mocks.artifactFind.mockResolvedValue([]);
    mocks.knowledgeChangeFind.mockResolvedValue([
      {
        projectFactId: "fact-pending",
        highlightId: null,
        action: "updated",
        afterSnapshot: {
          statement: "The changed service applies a routing policy.",
          lifecycleStatus: "needs_validation",
        },
      },
      {
        projectFactId: null,
        highlightId: "highlight-pending",
        action: "updated",
        afterSnapshot: {
          text: "Applied a routing policy",
          lifecycleStatus: "needs_validation",
        },
      },
    ]);

    await reconcileStaleKnowledge({
      runId: "refresh-current",
      appliedFactIds: [],
      appliedHighlightIds: [],
    });

    expect(mocks.factUpdate).not.toHaveBeenCalled();
    expect(mocks.highlightUpdate).not.toHaveBeenCalled();
    expect(mocks.recordChange).not.toHaveBeenCalled();
  });

  it("repairs a missing needs-validation review card without rewriting entity state", async () => {
    const changedEvidence = evidence({
      id: "evidence-changed",
      path: "src/changed.ts",
      blobSha: "blob-old",
      lifecycleStatus: "active",
    });
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-retry",
      workItemId: "work-1",
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "owner/repo", commitSha: "head-new" }],
      snapshots: [{
        id: "snapshot-new",
        sourceId: "source-1",
        commitSha: "head-new",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: [{ path: "src/changed.ts", blobSha: "blob-new" }],
      }],
    });
    mocks.factFind
      .mockResolvedValueOnce([{
        id: "fact-missing-card",
        statement: "The changed service applies a routing policy.",
        subsystemKey: "routing",
        status: "approved",
        lifecycleStatus: "needs_validation",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        validatedThroughSha: "head-old",
        validationHeads: { "source-1": "head-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: changedEvidence.id, evidenceItem: changedEvidence }],
      }])
      .mockResolvedValueOnce([]);
    mocks.highlightFind.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue([]);
    mocks.artifactFind.mockResolvedValue([]);
    mocks.knowledgeChangeFind.mockResolvedValue([
      {
        projectFactId: "fact-missing-card",
        highlightId: null,
        action: "created",
        afterSnapshot: {
          lifecycleStatus: "active",
          reviewState: "pending_review",
        },
      },
      {
        projectFactId: "fact-missing-card",
        highlightId: null,
        action: "updated",
        afterSnapshot: {
          statement: "An obsolete version of the routing policy.",
          lifecycleStatus: "needs_validation",
        },
      },
    ]);

    await reconcileStaleKnowledge({
      runId: "refresh-retry",
      appliedFactIds: [],
      appliedHighlightIds: [],
    });

    expect(mocks.factUpdate).not.toHaveBeenCalled();
    expect(mocks.recordChange).toHaveBeenCalledWith(expect.objectContaining({
      entityKind: "project_fact",
      entityId: "fact-missing-card",
      action: "updated",
    }));
  });

  it("retires mis-scoped Workbase deterministic memory before unchanged Resume blobs can revalidate it", async () => {
    const statement = "Workbase's documented product flow connects Work Items and attached sources to repository knowledge refresh, automatically applies safe facts and Highlights for later review, quarantines unsafe candidates, and generates career artifacts from approved non-sensitive Highlights.";
    const highlightText = "Connected Work Items, repository knowledge, review-later memory, and approved career artifacts in one product workflow";
    const unchanged = evidence({
      id: "resume-unchanged",
      path: "README.md",
      blobSha: "resume-readme-blob",
      lifecycleStatus: "active",
    });
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-resume",
      workItemId: "work-resume",
      qualityStatus: "verified",
      coverage: [{
        repository: "arkb75/Resume",
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [{ sourceId: "source-1", repository: "arkb75/Resume", commitSha: "resume-head" }],
      snapshots: [{
        id: "resume-snapshot",
        sourceId: "source-1",
        commitSha: "resume-head",
        inventoryComplete: true,
        analysisComplete: true,
        coverageComplete: true,
        files: [{ path: "README.md", blobSha: "resume-readme-blob" }],
      }],
    });
    mocks.factFind
      .mockResolvedValueOnce([{
        id: "fact-mis-scoped",
        statement,
        subsystemKey: "product_surface",
        status: "approved",
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        rejectionReason: null,
        validatedThroughSha: "resume-old",
        validationHeads: { "source-1": "resume-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: unchanged.id, evidenceItem: unchanged }],
      }])
      .mockResolvedValueOnce([]);
    mocks.highlightFind
      .mockResolvedValueOnce([{
        id: "highlight-mis-scoped",
        text: highlightText,
        summary: statement,
        metadata: { subsystemKey: "product_surface", managedBy: "repository_knowledge_sync" },
        verificationStatus: "approved",
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        rejectionReason: null,
        validatedThroughSha: "resume-old",
        validationHeads: { "source-1": "resume-old" },
        lastValidatedAt: null,
        autoAppliedAt: null,
        evidence: [{ evidenceItemId: unchanged.id, evidenceItem: unchanged }],
      }])
      .mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue([unchanged]);
    mocks.artifactFind.mockResolvedValue([]);

    await expect(reconcileStaleKnowledge({
      runId: "refresh-resume",
      appliedFactIds: [],
      appliedHighlightIds: [],
    })).resolves.toEqual({
      retiredFactIds: ["fact-mis-scoped"],
      retiredHighlightIds: ["highlight-mis-scoped"],
      staleArtifactIds: [],
    });

    expect(mocks.factUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "fact-mis-scoped",
        evidence: expect.objectContaining({ some: {}, every: expect.any(Object) }),
      }),
      data: expect.objectContaining({ lifecycleStatus: "retired", status: "rejected" }),
    }));
    expect(mocks.highlightUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "highlight-mis-scoped",
        metadata: { equals: { subsystemKey: "product_surface", managedBy: "repository_knowledge_sync" } },
        evidence: expect.objectContaining({ some: {}, every: expect.any(Object) }),
      }),
      data: expect.objectContaining({ lifecycleStatus: "retired" }),
    }));
    expect(mocks.recordChange).toHaveBeenCalledWith(expect.objectContaining({
      entityKind: "project_fact",
      entityId: "fact-mis-scoped",
      action: "retired",
      provenance: expect.objectContaining({
        remediation: "mis_scoped_workbase_deterministic_definition",
        repositories: ["arkb75/Resume"],
      }),
    }));
    expect(mocks.recordChange).toHaveBeenCalledWith(expect.objectContaining({
      entityKind: "highlight",
      entityId: "highlight-mis-scoped",
      action: "retired",
    }));
    const revalidations = mocks.recordContentAddressedRevalidations.mock.calls
      .flatMap((call) => call[0] as Array<{ entityId: string }>);
    expect(revalidations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: "fact-mis-scoped" }),
      expect.objectContaining({ entityId: "highlight-mis-scoped" }),
    ]));
  });

  it("preserves user-owned, reviewed, Workbase-sourced, missing-source, and non-sync deterministic memory", async () => {
    const statement = "Workbase's documented product flow connects Work Items and attached sources to repository knowledge refresh, automatically applies safe facts and Highlights for later review, quarantines unsafe candidates, and generates career artifacts from approved non-sensitive Highlights.";
    const highlightText = "Connected Work Items, repository knowledge, review-later memory, and approved career artifacts in one product workflow";
    const sourceEvidence = (id: string, sourceId: string, blobSha: string) => ({
      ...evidence({ id, path: `${id}.md`, blobSha, lifecycleStatus: "active" }),
      sourceId,
    });
    const resumeEvidence = sourceEvidence("resume", "source-resume", "resume-blob");
    const workbaseEvidence = sourceEvidence("workbase", "source-workbase", "workbase-blob");
    const missingEvidence = sourceEvidence("missing", "source-missing", "missing-blob");
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-protected",
      workItemId: "work-mixed",
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      targetHeads: [
        { sourceId: "source-resume", repository: "arkb75/Resume", commitSha: "resume-head" },
        { sourceId: "source-workbase", repository: "arkb75/Workbase", commitSha: "workbase-head" },
      ],
      snapshots: [
        {
          id: "resume-snapshot",
          sourceId: "source-resume",
          commitSha: "resume-head",
          inventoryComplete: true,
          analysisComplete: true,
          coverageComplete: true,
          files: [{ path: "resume.md", blobSha: "resume-blob" }],
        },
        {
          id: "workbase-snapshot",
          sourceId: "source-workbase",
          commitSha: "workbase-head",
          inventoryComplete: true,
          analysisComplete: true,
          coverageComplete: true,
          files: [{ path: "workbase.md", blobSha: "workbase-blob" }],
        },
        {
          id: "missing-snapshot",
          sourceId: "source-missing",
          commitSha: "missing-head",
          inventoryComplete: true,
          analysisComplete: true,
          coverageComplete: true,
          files: [{ path: "missing.md", blobSha: "missing-blob" }],
        },
      ],
    });
    const fact = (
      id: string,
      approvalSource: "automation" | "user",
      reviewState: "pending_review" | "reviewed",
      evidenceItem: typeof resumeEvidence,
    ) => ({
      id,
      statement,
      subsystemKey: "product_surface",
      status: "approved",
      lifecycleStatus: "active",
      reviewState,
      approvalSource,
      publicSafetyStatus: "not_eligible",
      rejectionReason: null,
      validatedThroughSha: evidenceItem.sourceId === "source-resume" ? "resume-head" : evidenceItem.sourceId === "source-workbase" ? "workbase-head" : "missing-head",
      validationHeads: {},
      lastValidatedAt: null,
      autoAppliedAt: null,
      evidence: [{ evidenceItemId: evidenceItem.id, evidenceItem }],
    });
    mocks.factFind
      .mockResolvedValueOnce([
        fact("fact-user", "user", "pending_review", resumeEvidence),
        fact("fact-reviewed", "automation", "reviewed", resumeEvidence),
        fact("fact-workbase", "automation", "pending_review", workbaseEvidence),
        fact("fact-missing-source", "automation", "pending_review", missingEvidence),
      ])
      .mockResolvedValueOnce([]);
    const highlight = (
      id: string,
      approvalSource: "automation" | "user",
      reviewState: "pending_review" | "reviewed",
      evidenceItem: typeof resumeEvidence,
      managedBy = "repository_knowledge_sync",
    ) => ({
      id,
      text: highlightText,
      summary: statement,
      metadata: { subsystemKey: "product_surface", managedBy },
      verificationStatus: "approved",
      lifecycleStatus: "active",
      reviewState,
      approvalSource,
      publicSafetyStatus: "not_eligible",
      rejectionReason: null,
      validatedThroughSha: evidenceItem.sourceId === "source-resume" ? "resume-head" : evidenceItem.sourceId === "source-workbase" ? "workbase-head" : "missing-head",
      validationHeads: {},
      lastValidatedAt: null,
      autoAppliedAt: null,
      evidence: [{ evidenceItemId: evidenceItem.id, evidenceItem }],
    });
    mocks.highlightFind
      .mockResolvedValueOnce([
        highlight("highlight-user", "user", "pending_review", resumeEvidence),
        highlight("highlight-reviewed", "automation", "reviewed", resumeEvidence),
        highlight("highlight-workbase", "automation", "pending_review", workbaseEvidence),
        highlight("highlight-missing-source", "automation", "pending_review", missingEvidence),
        highlight("highlight-other-manager", "automation", "pending_review", resumeEvidence, "manual_evidence_highlight_workflow"),
      ])
      .mockResolvedValueOnce([]);
    mocks.evidenceFind.mockResolvedValue([resumeEvidence, workbaseEvidence, missingEvidence]);
    mocks.artifactFind.mockResolvedValue([]);

    await expect(reconcileStaleKnowledge({
      runId: "refresh-protected",
      appliedFactIds: [],
      appliedHighlightIds: [],
    })).resolves.toEqual({ retiredFactIds: [], retiredHighlightIds: [], staleArtifactIds: [] });

    const factRetirements = mocks.factUpdateMany.mock.calls.filter((call) =>
      call[0]?.data?.lifecycleStatus === "retired"
    );
    const highlightRetirements = mocks.highlightUpdateMany.mock.calls.filter((call) =>
      call[0]?.data?.lifecycleStatus === "retired"
    );
    expect(factRetirements).toHaveLength(0);
    expect(highlightRetirements).toHaveLength(0);
    expect(mocks.recordChange).not.toHaveBeenCalledWith(expect.objectContaining({
      provenance: expect.objectContaining({ remediation: "mis_scoped_workbase_deterministic_definition" }),
    }));
  });
});
