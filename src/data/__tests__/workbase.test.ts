import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  workItem: {
    findFirstOrThrow: vi.fn(),
  },
  knowledgeChange: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { getWorkItemForUser } from "@/src/data/workbase";

describe("getWorkItemForUser knowledge review loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (queries: Array<Promise<unknown>>) =>
      Promise.all(queries));
  });

  it("loads only bounded full review records while returning exact pending counts", async () => {
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({ id: "work-item-1" });
    prismaMock.knowledgeChange.findMany
      .mockResolvedValueOnce([{ id: "attention" }])
      .mockResolvedValueOnce([{ id: "routine" }])
      .mockResolvedValueOnce([{ id: "provenance" }]);
    prismaMock.knowledgeChange.count
      .mockResolvedValueOnce(73)
      .mockResolvedValueOnce(65)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(33);

    const result = await getWorkItemForUser("user-1", "work-item-1");

    expect(prismaMock.knowledgeChange.findMany).toHaveBeenCalledTimes(3);
    expect(prismaMock.knowledgeChange.findMany.mock.calls.map(([query]) => query.take)).toEqual([24, 24, 8]);
    expect(result.knowledgeChanges).toEqual([
      { id: "attention" },
      { id: "routine" },
      { id: "provenance" },
    ]);
    expect(result.knowledgeChangeCounts).toEqual({
      totalKnowledgeCount: 73,
      totalProvenanceCount: 65,
      newOrUpdatedKnowledgeCount: 40,
      needsAttentionCount: 33,
    });
  });
});
