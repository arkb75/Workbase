import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshFind: vi.fn(),
  factFind: vi.fn(),
  factUpdate: vi.fn(),
  factUpdateMany: vi.fn(),
  highlightFind: vi.fn(),
  highlightUpdate: vi.fn(),
  highlightUpdateMany: vi.fn(),
  evidenceFind: vi.fn(),
  evidenceUpdate: vi.fn(),
  evidenceUpdateMany: vi.fn(),
  artifactFind: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactUpdateMany: vi.fn(),
  recordChange: vi.fn(),
  recordContentAddressedRevalidations: vi.fn(),
  invalidateEvidenceDependents: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    knowledgeRefreshRun: { findUniqueOrThrow: mocks.refreshFind },
    projectFact: { findMany: mocks.factFind, update: mocks.factUpdate, updateMany: mocks.factUpdateMany },
    highlight: { findMany: mocks.highlightFind, update: mocks.highlightUpdate, updateMany: mocks.highlightUpdateMany },
    evidenceItem: { findMany: mocks.evidenceFind, update: mocks.evidenceUpdate, updateMany: mocks.evidenceUpdateMany },
    artifact: { findMany: mocks.artifactFind, update: mocks.artifactUpdate, updateMany: mocks.artifactUpdateMany },
  },
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  knowledgeSimilarity: vi.fn(() => 0),
  recordChange: mocks.recordChange,
  recordContentAddressedRevalidations: mocks.recordContentAddressedRevalidations,
  STRONG_KNOWLEDGE_IDENTITY_THRESHOLD: 0.8,
}));

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
    mocks.factUpdateMany.mockResolvedValue({ count: 0 });
    mocks.highlightUpdateMany.mockResolvedValue({ count: 0 });
    mocks.evidenceUpdateMany.mockResolvedValue({ count: 0 });
    mocks.artifactUpdateMany.mockResolvedValue({ count: 0 });
    mocks.recordChange.mockResolvedValue({});
    mocks.recordContentAddressedRevalidations.mockResolvedValue({ count: 0 });
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
    expect(mocks.factUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.factUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["fact-exact"] } },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.highlightUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.highlightUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["highlight-exact"] } },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.evidenceUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["evidence-exact"] } },
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
    expect(mocks.artifactUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["artifact-exact"] } },
      data: { lifecycleStatus: "active", staleReason: null },
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

    expect(mocks.evidenceUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: excerpts.map((item) => item.id) } },
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
});
