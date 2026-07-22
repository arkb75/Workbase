import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evidenceItem: { findMany: vi.fn() },
  projectFact: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  highlight: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  artifact: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
const upsertReviewableKnowledgeChangeMock = vi.hoisted(() => vi.fn());
const upsertReviewableKnowledgeChangesInTransactionMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: upsertReviewableKnowledgeChangeMock,
  upsertReviewableKnowledgeChangesInTransaction: upsertReviewableKnowledgeChangesInTransactionMock,
}));

import {
  invalidateEvidenceDependents,
  invalidateHighlightDependents,
  invalidateStaleEvidenceDependentsInTransaction,
} from "@/src/services/knowledge-dependency-service";

describe("knowledge dependency invalidation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    upsertReviewableKnowledgeChangeMock.mockResolvedValue({ id: "change" });
    upsertReviewableKnowledgeChangesInTransactionMock.mockResolvedValue([]);
    prismaMock.projectFact.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.highlight.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.artifact.updateMany.mockResolvedValue({ count: 0 });
  });

  it("propagates an Evidence transition to Facts, Highlights, and direct or transitive Artifacts", async () => {
    prismaMock.projectFact.findMany.mockResolvedValue([{
      id: "fact-1",
      statement: "The repository implements durable workflows.",
      lifecycleStatus: "active",
      validatedThroughSha: "old-sha",
      validationHeads: { "source-1": "old-sha" },
    }]);
    prismaMock.highlight.findMany.mockResolvedValue([{
      id: "highlight-1",
      text: "Built durable workflows.",
      lifecycleStatus: "active",
      validatedThroughSha: "old-sha",
      validationHeads: { "source-1": "old-sha" },
    }]);
    prismaMock.artifact.findMany.mockResolvedValue([{
      id: "artifact-1",
      content: "Built durable workflows.",
      lifecycleStatus: "active",
      staleReason: null,
    }]);

    const result = await invalidateEvidenceDependents({
      workItemId: "work-1",
      evidenceItemId: "evidence-1",
      reason: "The supporting excerpt is stale.",
      idempotencyScope: "refresh-1:evidence-1",
      refreshRunId: "refresh-1",
    });

    expect(prismaMock.projectFact.update).toHaveBeenCalledWith({
      where: { id: "fact-1" },
      data: expect.objectContaining({
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        lastValidatedAt: null,
      }),
    });
    expect(prismaMock.highlight.update).toHaveBeenCalledWith({
      where: { id: "highlight-1" },
      data: expect.objectContaining({
        lifecycleStatus: "needs_validation",
        validatedThroughSha: null,
        lastValidatedAt: null,
      }),
    });
    expect(prismaMock.artifact.update).toHaveBeenCalledWith({
      where: { id: "artifact-1" },
      data: {
        lifecycleStatus: "stale",
        staleReason: "The supporting excerpt is stale.",
      },
    });
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      projectFactIds: ["fact-1"],
      highlightIds: ["highlight-1"],
      artifactIds: ["artifact-1"],
    });
  });

  it("does not invalidate a dependent after a refresh generation loses its mutation fence", async () => {
    prismaMock.projectFact.findMany.mockResolvedValue([{
      id: "fact-fenced",
      statement: "Current fact",
      lifecycleStatus: "active",
      validatedThroughSha: "old-sha",
      validationHeads: { "source-1": "old-sha" },
    }]);
    prismaMock.highlight.findMany.mockResolvedValue([]);
    const mutationFence = vi.fn().mockRejectedValue(
      new Error("The refresh generation was superseded."),
    );

    await expect(invalidateEvidenceDependents({
      workItemId: "work-1",
      evidenceItemId: "evidence-1",
      reason: "The supporting excerpt is stale.",
      idempotencyScope: "refresh-old:evidence-1",
      refreshRunId: "refresh-old",
      mutationFence,
    })).rejects.toThrow("superseded");

    expect(mutationFence).toHaveBeenCalledOnce();
    expect(prismaMock.projectFact.update).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangeMock).not.toHaveBeenCalled();
  });

  it("makes a Highlight dependency transition reviewable when it stales an Artifact", async () => {
    prismaMock.artifact.findMany.mockResolvedValue([{
      id: "artifact-2",
      content: "Prior artifact",
      lifecycleStatus: "active",
      staleReason: null,
    }]);

    await invalidateHighlightDependents({
      workItemId: "work-1",
      highlightId: "highlight-2",
      reason: "The Highlight was edited.",
      idempotencyScope: "edit-1",
    });

    expect(prismaMock.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "artifact-2" },
      data: expect.objectContaining({ lifecycleStatus: "stale" }),
    }));
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      entityKind: "artifact",
      action: "updated",
      entityId: "artifact-2",
    }));
  });

  it("invalidates a stale Evidence batch and records its dependents in constant operations", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([{ id: "evidence-1" }]);
    prismaMock.projectFact.findMany.mockResolvedValue([{
      id: "fact-1",
      statement: "Current fact",
      lifecycleStatus: "active",
      validatedThroughSha: "sha-old",
      validationHeads: { "source-1": "sha-old" },
      evidence: [{ evidenceItemId: "evidence-1" }],
    }]);
    prismaMock.highlight.findMany.mockResolvedValue([{
      id: "highlight-1",
      text: "Current Highlight",
      lifecycleStatus: "active",
      validatedThroughSha: "sha-old",
      validationHeads: { "source-1": "sha-old" },
      evidence: [{ evidenceItemId: "evidence-1" }],
    }]);
    prismaMock.artifact.findMany.mockResolvedValue([{
      id: "artifact-1",
      content: "Current artifact",
      lifecycleStatus: "active",
      staleReason: null,
      evidenceProvenance: [{ evidenceItemId: "evidence-1" }],
      highlightProvenance: [{ highlightId: "highlight-1" }],
    }]);

    const result = await invalidateStaleEvidenceDependentsInTransaction({
      workItemId: "work-1",
      evidenceItemIds: ["evidence-1", "evidence-restored"],
      reason: "Repository evidence changed.",
      idempotencyScope: "refresh:refresh-1:stale-evidence-batch",
      refreshRunId: "refresh-1",
    }, prismaMock as never);

    expect(prismaMock.evidenceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lifecycleStatus: "stale" }),
    }));
    expect(prismaMock.projectFact.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.highlight.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.artifact.updateMany).toHaveBeenCalledTimes(1);
    expect(upsertReviewableKnowledgeChangesInTransactionMock).toHaveBeenCalledTimes(1);
    expect(upsertReviewableKnowledgeChangesInTransactionMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "project_fact", entityId: "fact-1" }),
        expect.objectContaining({ entityKind: "highlight", entityId: "highlight-1" }),
        expect.objectContaining({ entityKind: "artifact", entityId: "artifact-1" }),
      ]),
      prismaMock,
    );
    expect(result).toEqual({
      evidenceItemIds: ["evidence-1"],
      projectFactIds: ["fact-1"],
      highlightIds: ["highlight-1"],
      artifactIds: ["artifact-1"],
    });
  });

  it("does nothing when Evidence was restored before the guarded invalidation transaction", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([]);

    const result = await invalidateStaleEvidenceDependentsInTransaction({
      workItemId: "work-1",
      evidenceItemIds: ["evidence-restored"],
      reason: "Repository evidence changed.",
      idempotencyScope: "refresh:refresh-1:stale-evidence-batch",
      refreshRunId: "refresh-1",
    }, prismaMock as never);

    expect(prismaMock.projectFact.findMany).not.toHaveBeenCalled();
    expect(prismaMock.highlight.findMany).not.toHaveBeenCalled();
    expect(prismaMock.artifact.findMany).not.toHaveBeenCalled();
    expect(upsertReviewableKnowledgeChangesInTransactionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      evidenceItemIds: [],
      projectFactIds: [],
      highlightIds: [],
      artifactIds: [],
    });
  });
});
