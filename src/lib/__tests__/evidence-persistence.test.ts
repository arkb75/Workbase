import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evidenceItem: {
    findMany: vi.fn(),
    upsert: vi.fn(),
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
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

import {
  createHighlightWithRelations,
  syncManualEvidenceItemsForWorkItem,
  syncWorkItemDescriptionEvidenceForWorkItem,
  upsertEvidenceItemsForSource,
} from "@/src/lib/evidence-persistence";

describe("evidence persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("preserves included state for matching evidence items and removes stale records on re-import", async () => {
    prismaMock.evidenceItem.findMany.mockResolvedValue([
      {
        id: "existing-1",
        sourceId: "source-1",
        externalId: "commit:sha-1",
        included: false,
      },
      {
        id: "existing-2",
        sourceId: "source-1",
        externalId: "commit:old-sha",
        included: true,
      },
    ]);
    prismaMock.evidenceItem.upsert.mockResolvedValue({ id: "persisted-1" });

    await upsertEvidenceItemsForSource("source-1", [
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

    expect(prismaMock.evidenceItem.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceId: "source-1",
        externalId: {
          notIn: ["commit:sha-1", "pull:12"],
        },
      },
    });

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: expect.objectContaining({
          included: false,
          searchText: "Existing commit Updated content",
          parentKey: "source-1",
        }),
      }),
    );
    expect(prismaMock.evidenceTag.deleteMany).toHaveBeenCalledTimes(2);
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
