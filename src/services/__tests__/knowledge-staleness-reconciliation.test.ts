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

  it("marks changed excerpts in one guarded batch and invalidates only excerpts with live dependents", async () => {
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
    mocks.evidenceFind
      .mockResolvedValueOnce(excerpts)
      .mockResolvedValueOnce([{ id: "changed-7" }]);
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
    expect(mocks.invalidateEvidenceDependents).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateEvidenceDependents).toHaveBeenCalledWith(expect.objectContaining({
      evidenceItemId: "changed-7",
    }));
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
});
