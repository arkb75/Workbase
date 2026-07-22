import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  evidenceItem: { findMany: vi.fn() },
  highlight: { findMany: vi.fn() },
  projectFact: { findMany: vi.fn() },
  artifact: { findMany: vi.fn() },
  knowledgeChange: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
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
  upsertReviewableKnowledgeChangesInTransaction,
} from "@/src/services/knowledge-change-service";

describe("reviewable knowledge changes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(async (task: (client: typeof prismaMock) => unknown) =>
      task(prismaMock)
    );
    prismaMock.knowledgeChange.findUnique.mockResolvedValue(null);
    prismaMock.knowledgeChange.findMany.mockResolvedValue([]);
    prismaMock.knowledgeChange.upsert.mockResolvedValue({ id: "change-new" });
    prismaMock.knowledgeChange.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.knowledgeChange.createMany.mockResolvedValue({ count: 1 });
    prismaMock.evidenceItem.findMany.mockResolvedValue([]);
    prismaMock.highlight.findMany.mockResolvedValue([]);
    prismaMock.projectFact.findMany.mockResolvedValue([]);
    prismaMock.artifact.findMany.mockResolvedValue([]);
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

  it("retries the complete review-card transition after a serializable conflict", async () => {
    prismaMock.$transaction
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockImplementationOnce(async (task: (client: typeof prismaMock) => unknown) =>
        task(prismaMock)
      );

    await upsertReviewableKnowledgeChange({
      workItemId: "work-1",
      entityKind: "project_fact",
      action: "updated",
      entityId: "fact-1",
      afterSnapshot: { id: "fact-1", statement: "Current" },
      reason: "Current-head knowledge changed.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "refresh-3:fact-1",
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(prismaMock.knowledgeChange.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledTimes(1);
  });

  it("creates and coalesces a review batch in constant database operations", async () => {
    let createdRows: Array<{ id: string; idempotencyKey: string }> = [];
    prismaMock.knowledgeChange.createMany.mockImplementation(async ({ data }) => {
      createdRows = data.map((entry: { id: string; idempotencyKey: string }) => ({
        id: entry.id,
        idempotencyKey: entry.idempotencyKey,
      }));
      return { count: createdRows.length };
    });
    prismaMock.knowledgeChange.findMany.mockImplementation(async ({ where }) =>
      where?.idempotencyKey ? createdRows : []
    );

    const result = await upsertReviewableKnowledgeChangesInTransaction(
      Array.from({ length: 20 }, (_, index) => ({
        workItemId: "work-1",
        refreshRunId: "refresh-1",
        entityKind: "evidence" as const,
        action: "updated" as const,
        entityId: `evidence-${index}`,
        afterSnapshot: { id: `evidence-${index}`, lifecycleStatus: "stale" },
        reason: "The immutable excerpt is pinned to an older head.",
        policyVersion: "knowledge-lifecycle-v3",
        idempotencyKey: `stale-${index}`,
      })),
      prismaMock as never,
    );

    expect(result).toHaveLength(20);
    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        evidenceItemId: { in: Array.from({ length: 20 }, (_, index) => `evidence-${index}`) },
      }),
    }));
  });

  it("does not retire current cards when a review batch is replayed", async () => {
    prismaMock.knowledgeChange.findMany.mockResolvedValue([{
      id: "existing-change",
      idempotencyKey: "stale-1",
    }]);

    await upsertReviewableKnowledgeChangesInTransaction([{
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      entityKind: "evidence",
      action: "updated",
      entityId: "evidence-1",
      reason: "The immutable excerpt is pinned to an older head.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "stale-1",
    }], prismaMock as never);

    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
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
    prismaMock.knowledgeChange.findMany.mockResolvedValue([{
      id: "stale-card",
      workItemId: "work-1",
      action: "updated",
      afterSnapshot: { lifecycleStatus: "needs_validation", validatedThroughSha: "sha-old" },
      evidenceItemId: "evidence-1",
      highlightId: null,
      projectFactId: null,
      artifactId: null,
    }]);
    prismaMock.evidenceItem.findMany.mockResolvedValue([{
      id: "evidence-1",
      lifecycleStatus: "active",
      validatedThroughSha: "sha-new",
      content: "unchanged",
    }]);
    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      refreshRunId: "refresh-1",
      entityKind: "evidence",
      action: "revalidated",
      entityId: "evidence-1",
      beforeSnapshot: { lifecycleStatus: "needs_validation", validatedThroughSha: "sha-old" },
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
    expect(prismaMock.knowledgeChange.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workItemId: { in: ["work-1"] },
        decision: "pending",
      }),
    }));
    expect(prismaMock.knowledgeChange.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["stale-card"] }, decision: "pending" },
      data: {
        decision: "retired",
        reviewedAt: expect.any(Date),
        feedback: expect.stringContaining("resolved automatically"),
      },
    });
  });

  it("preserves the original review-later card when active content is only revalidated", async () => {
    prismaMock.knowledgeChange.findMany.mockResolvedValue([{
      id: "created-card",
      workItemId: "work-1",
      action: "created",
      afterSnapshot: { lifecycleStatus: "active", reviewState: "pending_review" },
      evidenceItemId: null,
      highlightId: "highlight-1",
      projectFactId: null,
      artifactId: null,
    }]);
    prismaMock.highlight.findMany.mockResolvedValue([{
      id: "highlight-1",
      lifecycleStatus: "active",
      validatedThroughSha: null,
      text: "Current",
    }]);

    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      entityKind: "highlight",
      action: "revalidated",
      entityId: "highlight-1",
      reason: "The immutable Git blob is unchanged.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "highlight:content-addressed:highlight-1:sha-new",
    }]);

    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
  });

  it("does not retire a newer warning card for a replayed older revalidation", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([{
      id: "evidence-1",
      lifecycleStatus: "needs_validation",
      validatedThroughSha: "sha-new",
      content: "changed",
    }]);
    prismaMock.knowledgeChange.findMany.mockResolvedValue([{
      id: "new-warning",
      workItemId: "work-1",
      action: "updated",
      afterSnapshot: { lifecycleStatus: "needs_validation", validatedThroughSha: "sha-new" },
      evidenceItemId: "evidence-1",
      highlightId: null,
      projectFactId: null,
      artifactId: null,
    }]);

    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      entityKind: "evidence",
      action: "revalidated",
      entityId: "evidence-1",
      afterSnapshot: { lifecycleStatus: "active", validatedThroughSha: "sha-old" },
      reason: "An older refresh observed unchanged content.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "old-revalidation",
    }]);

    expect(prismaMock.knowledgeChange.createMany).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
  });

  it("records a current revalidation without retiring a warning for a different prior state", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([{
      id: "evidence-1",
      lifecycleStatus: "active",
      validatedThroughSha: "sha-current",
      content: "current",
    }]);
    prismaMock.knowledgeChange.findMany.mockResolvedValue([{
      id: "newer-warning",
      workItemId: "work-1",
      action: "updated",
      afterSnapshot: {
        lifecycleStatus: "needs_validation",
        validatedThroughSha: "sha-newer-warning",
      },
      evidenceItemId: "evidence-1",
      highlightId: null,
      projectFactId: null,
      artifactId: null,
    }]);

    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      entityKind: "evidence",
      action: "revalidated",
      entityId: "evidence-1",
      beforeSnapshot: {
        lifecycleStatus: "needs_validation",
        validatedThroughSha: "sha-prior",
      },
      afterSnapshot: {
        lifecycleStatus: "active",
        validatedThroughSha: "sha-current",
      },
      reason: "The exact prior immutable content was revalidated.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "current-revalidation",
    }]);

    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChange.updateMany).not.toHaveBeenCalled();
  });

  it("retries a serializable automatic-audit transaction after a write conflict", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([{
      id: "evidence-1",
      lifecycleStatus: "active",
      validatedThroughSha: "sha-current",
      content: "current",
    }]);
    prismaMock.$transaction
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockImplementationOnce(async (task: (client: typeof prismaMock) => unknown) =>
        task(prismaMock)
      );

    await recordAutoResolvedKnowledgeChanges([{
      workItemId: "work-1",
      entityKind: "evidence",
      action: "revalidated",
      entityId: "evidence-1",
      beforeSnapshot: {
        lifecycleStatus: "needs_validation",
        validatedThroughSha: "sha-prior",
      },
      afterSnapshot: {
        lifecycleStatus: "active",
        validatedThroughSha: "sha-current",
      },
      reason: "The exact prior immutable content was revalidated.",
      policyVersion: "knowledge-lifecycle-v3",
      idempotencyKey: "serializable-revalidation",
    }]);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(prismaMock.knowledgeChange.createMany).toHaveBeenCalledTimes(1);
  });
});
