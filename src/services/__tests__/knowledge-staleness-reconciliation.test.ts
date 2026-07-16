import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshFind: vi.fn(),
  factFind: vi.fn(),
  factUpdate: vi.fn(),
  highlightFind: vi.fn(),
  highlightUpdate: vi.fn(),
  evidenceFind: vi.fn(),
  evidenceUpdate: vi.fn(),
  artifactFind: vi.fn(),
  artifactUpdate: vi.fn(),
  recordChange: vi.fn(),
  invalidateEvidenceDependents: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    knowledgeRefreshRun: { findUniqueOrThrow: mocks.refreshFind },
    projectFact: { findMany: mocks.factFind, update: mocks.factUpdate },
    highlight: { findMany: mocks.highlightFind, update: mocks.highlightUpdate },
    evidenceItem: { findMany: mocks.evidenceFind, update: mocks.evidenceUpdate },
    artifact: { findMany: mocks.artifactFind, update: mocks.artifactUpdate },
  },
}));

vi.mock("@/src/services/knowledge-reconciliation-service", () => ({
  knowledgeSimilarity: vi.fn(() => 0),
  recordChange: mocks.recordChange,
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
    mocks.recordChange.mockResolvedValue({});
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
    expect(mocks.factUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.factUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "fact-exact" },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.highlightUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.highlightUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "highlight-exact" },
      data: expect.objectContaining({ lifecycleStatus: "active", validatedThroughSha: "head-new" }),
    }));
    expect(mocks.evidenceUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.evidenceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "evidence-exact" },
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
    expect(mocks.artifactUpdate).toHaveBeenCalledWith({
      where: { id: "artifact-exact" },
      data: { lifecycleStatus: "active", staleReason: null },
    });
    expect(mocks.factUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "fact-unresolved" } }));
  });
});
