import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  projectFact: { findMany: vi.fn(), update: vi.fn() },
  highlight: { findMany: vi.fn(), update: vi.fn() },
  artifact: { findMany: vi.fn(), update: vi.fn() },
}));
const upsertReviewableKnowledgeChangeMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: upsertReviewableKnowledgeChangeMock,
}));

import {
  invalidateEvidenceDependents,
  invalidateHighlightDependents,
} from "@/src/services/knowledge-dependency-service";

describe("knowledge dependency invalidation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    upsertReviewableKnowledgeChangeMock.mockResolvedValue({ id: "change" });
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
});
