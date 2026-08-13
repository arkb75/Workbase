import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evidenceItem: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  evidenceTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  highlight: {
    create: vi.fn(),
  },
  highlightEvidence: {
    createMany: vi.fn(),
  },
  highlightTag: {
    createMany: vi.fn(),
  },
  source: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  workItem: {
    findUniqueOrThrow: vi.fn(),
  },
  $transaction: vi.fn(),
}));
const invalidateEvidenceDependentsMock = vi.hoisted(() => vi.fn());
const upsertReviewableKnowledgeChangeMock = vi.hoisted(() => vi.fn());
const upsertReviewableKnowledgeChangesInTransactionMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));
vi.mock("@/src/services/knowledge-dependency-service", () => ({
  invalidateEvidenceDependents: invalidateEvidenceDependentsMock,
}));
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: upsertReviewableKnowledgeChangeMock,
  upsertReviewableKnowledgeChangesInTransaction:
    upsertReviewableKnowledgeChangesInTransactionMock,
}));

import {
  createHighlightWithRelations,
  evidenceTagsAreCurrent,
  syncManualEvidenceItemsForWorkItem,
  syncWorkItemDescriptionEvidenceForWorkItem,
  upsertEvidenceItemsForSource,
} from "@/src/lib/evidence-persistence";

describe("evidence persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (task: (tx: unknown) => Promise<unknown>) => task({}),
    );
  });

  it("recognizes an unchanged Evidence tag set independent of row order", () => {
    expect(evidenceTagsAreCurrent(
      [
        { dimension: "skill", tag: "typescript", score: 0.9 },
        { dimension: "work", tag: "implementation", score: null },
      ],
      [
        { dimension: "work", tag: "implementation", score: null },
        { dimension: "skill", tag: "typescript", score: 0.9 },
      ],
    )).toBe(true);
    expect(evidenceTagsAreCurrent(
      [{ dimension: "skill", tag: "typescript", score: 0.9 }],
      [{ dimension: "skill", tag: "typescript", score: 0.8 }],
    )).toBe(false);
  });

  it("bulk-persists a max-shape cold GitHub import with stable order and retry-safe transitions", async () => {
    const inputs = Array.from({ length: 66 }, (_, index) => ({
      workItemId: "work-item-1",
      sourceId: "source-1",
      externalId: `commit:sha-${index}`,
      sourceType: "github_repo" as const,
      type: "github_commit" as const,
      title: `Commit ${index}`,
      content: `Implemented bounded import step ${index}.`,
      searchText: `Commit ${index} Implemented bounded import step ${index}.`,
      parentKind: "source",
      parentKey: "source-1",
      included: true,
      metadata: { sha: `sha-${index}` },
    }));
    const persistedRows = inputs.map((item, index) => ({
      id: `evidence-${index}`,
      externalId: item.externalId,
      type: item.type,
      title: item.title,
      content: item.content,
      included: item.included,
    }));
    prismaMock.evidenceItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([...persistedRows].reverse());
    prismaMock.evidenceItem.createMany.mockResolvedValue({ count: inputs.length });
    upsertReviewableKnowledgeChangesInTransactionMock.mockResolvedValue([]);

    const result = await upsertEvidenceItemsForSource("source-1", inputs);

    expect(prismaMock.evidenceItem.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.evidenceItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          externalId: "commit:sha-0",
          logicalKey: "commit:sha-0",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        }),
      ]),
      skipDuplicates: true,
    });
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(upsertReviewableKnowledgeChangesInTransactionMock).toHaveBeenCalledTimes(1);
    const [changes] = upsertReviewableKnowledgeChangesInTransactionMock.mock.calls[0]!;
    expect(changes).toHaveLength(66);
    expect(new Set(
      changes.map((change: { idempotencyKey: string }) => change.idempotencyKey),
    ).size).toBe(66);
    expect(changes[0]).toMatchObject({
      entityId: "evidence-0",
      action: "created",
      idempotencyKey: expect.stringMatching(
        /^github-import:evidence:evidence-0:([a-f0-9]{16}):\1$/,
      ),
    });
    expect(result.map((item) => item.externalId)).toEqual(
      inputs.map((item) => item.externalId),
    );
    expect(result.every((item) => item.wasExisting === false)).toBe(true);
  });

  it("preserves immutable GitHub evidence revisions and retires records missing from a re-import", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([
      {
        id: "existing-1",
        sourceId: "source-1",
        externalId: "commit:sha-1",
        type: "github_commit",
        title: "Existing commit",
        content: "Old content",
        included: false,
        lifecycleStatus: "active",
        logicalKey: "commit:sha-1",
        workItemId: "work-item-1",
      },
      {
        id: "existing-2",
        sourceId: "source-1",
        externalId: "commit:old-sha",
        type: "github_commit",
        title: "Old commit",
        content: "Old content",
        included: true,
        lifecycleStatus: "active",
        logicalKey: "commit:old-sha",
        workItemId: "work-item-1",
      },
      {
        id: "promoted-excerpt-1",
        sourceId: "source-1",
        externalId: "file:sha:path:1:10:hash",
        type: "github_file_excerpt",
        title: "Promoted excerpt",
        content: "Exact excerpt",
        included: true,
        lifecycleStatus: "active",
        logicalKey: "file:sha:path:1:10:hash",
        workItemId: "work-item-1",
      },
    ]);
    prismaMock.evidenceItem.upsert
      .mockResolvedValueOnce({
        id: "persisted-1",
        externalId: "commit:sha-1",
        type: "github_commit",
        included: false,
      })
      .mockResolvedValueOnce({
        id: "persisted-2",
        externalId: "pull:12",
        type: "github_pull_request",
        included: true,
      });

    const persistedItems = await upsertEvidenceItemsForSource("source-1", [
      {
        workItemId: "work-item-1",
        sourceId: "source-1",
        externalId: "commit:sha-1",
        sourceType: "github_repo",
        type: "github_commit",
        title: "Existing commit",
        content: "Updated content",
        searchText: "Existing commit Updated content",
        parentKind: "source",
        parentKey: "source-1",
        included: true,
        metadata: null,
      },
      {
        workItemId: "work-item-1",
        sourceId: "source-1",
        externalId: "pull:12",
        sourceType: "github_repo",
        type: "github_pull_request",
        title: "New pull request",
        content: "PR content",
        searchText: "New pull request PR content",
        parentKind: "pull_request",
        parentKey: "source-1:pull:12",
        included: true,
        metadata: null,
      },
    ]);

    expect(prismaMock.evidenceItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "existing-2" },
      data: expect.objectContaining({ lifecycleStatus: "retired", included: false }),
    }));
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalled();
    expect(invalidateEvidenceDependentsMock).toHaveBeenCalledWith(expect.objectContaining({
      evidenceItemId: "existing-2",
      reason: expect.stringContaining("retired"),
    }));
    expect(invalidateEvidenceDependentsMock).toHaveBeenCalledWith(expect.objectContaining({
      evidenceItemId: "existing-1",
      reason: expect.stringContaining("superseded"),
    }));

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(2);
    expect(persistedItems).toEqual([
      {
        id: "persisted-1",
        externalId: "commit:sha-1",
        type: "github_commit",
        included: false,
        wasExisting: true,
      },
      {
        id: "persisted-2",
        externalId: "pull:12",
        type: "github_pull_request",
        included: true,
        wasExisting: false,
      },
    ]);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          logicalKey: "commit:sha-1",
          supersedesEvidenceItemId: "existing-1",
          searchText: "Existing commit Updated content",
        }),
        update: expect.objectContaining({
          lifecycleStatus: "active",
          included: false,
        }),
      }),
    );
    expect(prismaMock.evidenceTag.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("creates a new review transition when previously retired repository Evidence reappears", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([{
      id: "evidence-retired",
      sourceId: "source-1",
      externalId: "commit:sha-1",
      logicalKey: "commit:sha-1",
      type: "github_commit",
      title: "Commit",
      content: "Same content",
      included: false,
      lifecycleStatus: "retired",
      workItemId: "work-1",
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    }]);
    prismaMock.evidenceItem.upsert.mockResolvedValue({
      id: "evidence-retired",
      externalId: "commit:sha-1",
      type: "github_commit",
      title: "Commit",
      content: "Same content",
      included: false,
    });

    await upsertEvidenceItemsForSource("source-1", [{
      workItemId: "work-1",
      sourceId: "source-1",
      externalId: "commit:sha-1",
      sourceType: "github_repo",
      type: "github_commit",
      title: "Commit",
      content: "Same content",
      searchText: "Commit Same content",
      parentKind: "source",
      parentKey: "source-1",
      included: true,
      metadata: null,
    }]);

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
      }),
    }));
    expect(upsertReviewableKnowledgeChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      entityKind: "evidence",
      entityId: "evidence-retired",
      action: "revalidated",
      idempotencyKey: expect.stringContaining("2026-01-02T00:00:00.000Z"),
    }));
  });

  it("creates a highlight with evidence and tag relations", async () => {
    const tx = {
      highlight: {
        create: vi.fn().mockResolvedValue({ id: "highlight-1" }),
      },
      highlightEvidence: {
        createMany: vi.fn(),
      },
      highlightTag: {
        createMany: vi.fn(),
      },
    } as const;

    await createHighlightWithRelations({
      tx: tx as never,
      workItemId: "work-item-1",
      draft: {
        text: "Built the highlight review flow.",
        summary: "Grounded in evidence.",
        confidence: "medium",
        ownershipClarity: "clear",
        sensitivityFlag: false,
        verificationStatus: "draft",
        visibility: "resume_safe",
        risksSummary: null,
        missingInfo: null,
        rejectionReason: null,
        verificationNotes: "Verified against attached evidence.",
        metadata: null,
        evidence: {
          summary: "Grounded in evidence.",
          verificationNotes: "Verified against attached evidence.",
          sourceRefs: [
            {
              evidenceItemId: "evidence-1",
              sourceId: "source-1",
              sourceLabel: "Manual notes",
              sourceType: "manual_note",
              excerpt: "Built the highlight review flow.",
            },
          ],
        },
        tags: [
          {
            dimension: "domain",
            tag: "full_stack",
            score: 0.8,
          },
        ],
      },
    });

    expect(tx.highlight.create).toHaveBeenCalled();
    expect(tx.highlightEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          highlightId: "highlight-1",
          evidenceItemId: "evidence-1",
          relevanceScore: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.highlightTag.createMany).toHaveBeenCalledWith({
      data: [
        {
          highlightId: "highlight-1",
          dimension: "domain",
          tag: "full_stack",
          score: 0.8,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("skips system-owned work item description sources during manual note sync", async () => {
    prismaMock.source.findMany.mockResolvedValue([
      {
        id: "source-description",
        workItemId: "work-item-1",
        type: "manual_note",
        label: "Work Item description",
        externalId: "work-item-1:work-item-description-source",
        rawContent: "Built a highlight-first artifact workflow.",
        metadata: {
          kind: "work_item_description",
          systemOwned: true,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "source-manual",
        workItemId: "work-item-1",
        type: "manual_note",
        label: "Manual notes",
        externalId: null,
        rawContent: "Built the review flow.\nAdded artifact retrieval.",
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prismaMock.evidenceItem.findMany.mockResolvedValue([]);
    prismaMock.evidenceItem.upsert.mockResolvedValue({ id: "persisted-evidence-1" });

    await syncManualEvidenceItemsForWorkItem("work-item-1");

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId_externalId: expect.objectContaining({
            sourceId: "source-description",
          }),
        }),
      }),
    );
  });

  it("persists the work item description as a real evidence item", async () => {
    prismaMock.workItem.findUniqueOrThrow.mockResolvedValue({
      id: "work-item-1",
      description: "Built Workbase, a full-stack app for verified career content.",
      sources: [],
    });
    prismaMock.source.create.mockResolvedValue({
      id: "source-description",
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([]);
    prismaMock.evidenceItem.upsert.mockResolvedValue({ id: "persisted-description-evidence" });

    await syncWorkItemDescriptionEvidenceForWorkItem("work-item-1");

    expect(prismaMock.source.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workItemId: "work-item-1",
        type: "manual_note",
        label: "Work Item description",
        externalId: "work-item-1:work-item-description-source",
      }),
    });
    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceId_externalId: {
            sourceId: "source-description",
            externalId: "work-item-1:work-item-description",
          },
        },
        create: expect.objectContaining({
          title: "Work Item description",
          content: "Built Workbase, a full-stack app for verified career content.",
        }),
      }),
    );
  });
});
