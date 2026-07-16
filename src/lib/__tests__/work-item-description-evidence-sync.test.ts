import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  workItem: {
    findUniqueOrThrow: vi.fn(),
  },
  source: {
    create: vi.fn(),
    update: vi.fn(),
  },
  evidenceItem: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  evidenceTag: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChange: vi.fn(),
}));

vi.mock("@/src/services/knowledge-dependency-service", () => ({
  invalidateEvidenceDependents: vi.fn(),
}));

import { syncWorkItemDescriptionEvidenceForWorkItem } from "@/src/lib/evidence-persistence";
import { buildEvidenceSearchText } from "@/src/lib/highlight-tags";

describe("Work Item description evidence synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.evidenceTag.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.evidenceTag.createMany.mockResolvedValue({ count: 0 });
  });

  it("reuses the system-owned source and updates its evidence on every synchronization", async () => {
    const descriptionSource = {
      id: "source-description",
      workItemId: "work-item-1",
      type: "manual_note",
      label: "Work Item description",
      externalId: "work-item-1:work-item-description-source",
      rawContent: "Built the original project.",
      metadata: {
        kind: "work_item_description",
        systemOwned: true,
      },
      createdAt: new Date("2026-07-12T20:00:00.000Z"),
      updatedAt: new Date("2026-07-12T20:00:00.000Z"),
    };

    prismaMock.workItem.findUniqueOrThrow
      .mockResolvedValueOnce({
        id: "work-item-1",
        description: "Built the original project.",
        sources: [],
      })
      .mockResolvedValueOnce({
        id: "work-item-1",
        description: "Built the current project with grounded chat and artifact workflows.",
        sources: [descriptionSource],
      });
    prismaMock.source.create.mockResolvedValue(descriptionSource);
    prismaMock.source.update.mockResolvedValue({
      ...descriptionSource,
      rawContent: "Built the current project with grounded chat and artifact workflows.",
    });
    prismaMock.evidenceItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "evidence-description",
        workItemId: "work-item-1",
        sourceId: descriptionSource.id,
        externalId: "work-item-1:work-item-description",
        logicalKey: "work-item-1:work-item-description",
        type: "manual_note_excerpt",
        title: "Work Item description",
        content: "Built the original project.",
        included: true,
        lifecycleStatus: "active",
      }]);
    prismaMock.evidenceItem.upsert
      .mockResolvedValueOnce({
        id: "evidence-description",
        externalId: "work-item-1:work-item-description",
        type: "manual_note_excerpt",
        included: true,
      })
      .mockResolvedValueOnce({
        id: "evidence-description",
        externalId: "work-item-1:work-item-description",
        type: "manual_note_excerpt",
        included: true,
      });

    await syncWorkItemDescriptionEvidenceForWorkItem("work-item-1");
    await syncWorkItemDescriptionEvidenceForWorkItem("work-item-1");

    expect(prismaMock.source.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.source.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.source.update).toHaveBeenCalledWith({
      where: { id: descriptionSource.id },
      data: expect.objectContaining({
        rawContent: "Built the current project with grounded chat and artifact workflows.",
      }),
    });

    expect(prismaMock.evidenceItem.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.evidenceItem.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        sourceId_externalId: {
          sourceId: descriptionSource.id,
          externalId: "work-item-1:work-item-description",
        },
      },
      update: expect.objectContaining({
        content: "Built the current project with grounded chat and artifact workflows.",
        included: true,
      }),
    }));
  });

  it("does not rewrite an unchanged description source, evidence row, or tags", async () => {
    const content = "Built grounded project chat.";
    prismaMock.workItem.findUniqueOrThrow.mockResolvedValue({
      id: "work-item-1",
      description: content,
      sources: [{
        id: "source-description",
        workItemId: "work-item-1",
        type: "manual_note",
        label: "Work Item description",
        externalId: "work-item-1:work-item-description-source",
        rawContent: content,
        metadata: { kind: "work_item_description", systemOwned: true },
        createdAt: new Date("2026-07-12T20:00:00.000Z"),
        updatedAt: new Date("2026-07-12T20:00:00.000Z"),
        evidenceItems: [{
          id: "evidence-description",
          externalId: "work-item-1:work-item-description",
          type: "manual_note_excerpt",
          title: "Work Item description",
          content,
          searchText: buildEvidenceSearchText({
            title: "Work Item description",
            content,
            metadata: { kind: "work_item_description", systemOwned: true },
          }),
          parentKind: "work_item",
          parentKey: "work-item-1",
          included: true,
          lifecycleStatus: "active",
        }],
      }],
    });

    await syncWorkItemDescriptionEvidenceForWorkItem("work-item-1");

    expect(prismaMock.source.create).not.toHaveBeenCalled();
    expect(prismaMock.source.update).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.findMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceItem.upsert).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.evidenceTag.createMany).not.toHaveBeenCalled();
  });
});
