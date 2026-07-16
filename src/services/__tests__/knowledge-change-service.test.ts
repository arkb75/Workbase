import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  knowledgeChange: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  recordAutoResolvedKnowledgeChanges,
  reviewSnapshotMatchesEntity,
  upsertReviewableKnowledgeChange,
} from "@/src/services/knowledge-change-service";

describe("reviewable knowledge changes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.knowledgeChange.findUnique.mockResolvedValue(null);
    prismaMock.knowledgeChange.upsert.mockResolvedValue({ id: "change-new" });
    prismaMock.knowledgeChange.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.knowledgeChange.createMany.mockResolvedValue({ count: 1 });
  });

  it("returns a previously resolved transition without reopening it on retry", async () => {
    prismaMock.knowledgeChange.findUnique.mockResolvedValue({
      id: "change-existing",
      decision: "kept",
    });

    const result = await upsertReviewableKnowledgeChange({
      workItemId: "work-1",
      entityKind: "project_fact",
      action: "revalidated",
      entityId: "fact-1",
      reason: "Revalidated.",
      policyVersion: "knowledge-lifecycle-v2",
      idempotencyKey: "refresh-1:fact-1",
    });

    expect(result).toEqual({ id: "change-existing", decision: "kept" });
    expect(prismaMock.knowledgeChange.upsert).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
  });

  it("coalesces pending cards for both the current entity and its immutable predecessor", async () => {
    await upsertReviewableKnowledgeChange({
      workItemId: "work-1",
      entityKind: "highlight",
      action: "updated",
      entityId: "highlight-new",
      beforeSnapshot: { id: "highlight-old", text: "Old" },
      afterSnapshot: { id: "highlight-new", text: "New" },
      reason: "A current-head successor replaced the old Highlight.",
      policyVersion: "knowledge-lifecycle-v2",
      idempotencyKey: "refresh-2:highlight-new",
    });

    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        workItemId: "work-1",
        decision: "pending",
        id: { not: "change-new" },
        highlightId: "highlight-new",
      },
      data: expect.objectContaining({ decision: "retired" }),
    });
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        workItemId: "work-1",
        decision: "pending",
        highlightId: "highlight-old",
      },
      data: expect.objectContaining({ decision: "retired" }),
    });
  });

  it("rejects a review snapshot after the canonical entity has moved to another head", () => {
    expect(reviewSnapshotMatchesEntity({
      entityId: "fact-1",
      afterSnapshot: {
        id: "fact-1",
        statement: "Original",
        lifecycleStatus: "active",
        validatedThroughSha: "sha-old",
      },
      entity: {
        id: "fact-1",
        statement: "Original",
        lifecycleStatus: "active",
        validatedThroughSha: "sha-new",
      },
    })).toBe(false);
  });

  it("bulk-records unchanged-blob revalidation as resolved audit history, not pending review cards", async () => {
    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      entityKind: "evidence",
      action: "revalidated",
      entityId: "evidence-1",
      beforeSnapshot: { lifecycleStatus: "stale", validatedThroughSha: "sha-old" },
      afterSnapshot: { lifecycleStatus: "active", validatedThroughSha: "sha-new" },
      reason: "The immutable Git blob is unchanged.",
      provenance: { blobSha: "blob-1", automatic: true },
      policyVersion: "knowledge-lifecycle-v3",
      modelId: "model-1",
      idempotencyKey: "evidence:content-addressed:evidence-1:sha-new:blob-1",
    }]);

    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        evidenceItemId: "evidence-1",
        decision: "kept",
        reviewedAt: expect.any(Date),
        idempotencyKey: "evidence:content-addressed:evidence-1:sha-new:blob-1",
      })],
      skipDuplicates: true,
    });
    expect(prismaMock.knowledgeChange.upsert).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
  });
});
