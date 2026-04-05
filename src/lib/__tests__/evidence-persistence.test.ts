import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evidenceItem: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  evidenceClusterItem: {
    deleteMany: vi.fn(),
  },
  source: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

import {
  persistEvidenceClusters,
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

    await upsertEvidenceItemsForSource("source-1", [
      {
        workItemId: "work-item-1",
        sourceId: "source-1",
        externalId: "commit:sha-1",
        type: "github_commit",
        title: "Existing commit",
        content: "Updated content",
        included: true,
        metadata: null,
      },
      {
        workItemId: "work-item-1",
        sourceId: "source-1",
        externalId: "pull:12",
        type: "github_pull_request",
        title: "New pull request",
        content: "PR content",
        included: true,
        metadata: null,
      },
    ]);

    expect(prismaMock.evidenceClusterItem.deleteMany).toHaveBeenCalledWith({
      where: {
        evidenceItem: {
          sourceId: "source-1",
          externalId: {
            notIn: ["commit:sha-1", "pull:12"],
          },
        },
      },
    });
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
        }),
      }),
    );
    expect(prismaMock.evidenceItem.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          externalId: "pull:12",
        }),
      }),
    );
  });

  it("replaces persisted clusters and creates new memberships in one transaction", async () => {
    const tx = {
      evidenceCluster: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };

    prismaMock.$transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    await persistEvidenceClusters("work-item-1", [
      {
        title: "Import and pipeline work",
        summary: "Commit history and pull request evidence both point to import pipeline work.",
        theme: "data_pipeline",
        confidence: "medium",
        metadata: {
          strategy: "bedrock_structured",
        },
        items: [
          {
            evidenceItemId: "evidence-1",
            relevanceScore: 0.92,
          },
        ],
      },
    ]);

    expect(tx.evidenceCluster.deleteMany).toHaveBeenCalledWith({
      where: {
        workItemId: "work-item-1",
      },
    });
    expect(tx.evidenceCluster.create).toHaveBeenCalledWith({
      data: {
        workItemId: "work-item-1",
        title: "Import and pipeline work",
        summary:
          "Commit history and pull request evidence both point to import pipeline work.",
        theme: "data_pipeline",
        confidence: "medium",
        metadata: {
          strategy: "bedrock_structured",
        },
        items: {
          create: [
            {
              evidenceItemId: "evidence-1",
              relevanceScore: 0.92,
            },
          ],
        },
      },
    });
  });
});
