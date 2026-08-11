import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  workItem: {
    findFirstOrThrow: vi.fn(),
  },
  evidenceItem: {
    count: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
  },
  highlight: {
    count: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
  },
  projectFact: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  knowledgeChange: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  knowledgeRefreshRun: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  getWorkItemChatShellForUser,
  getWorkItemForUser,
  getWorkItemWorkspaceForUser,
} from "@/src/data/workbase";

describe("getWorkItemForUser knowledge review loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (queries: Array<Promise<unknown>>) =>
      Promise.all(queries));
    prismaMock.evidenceItem.count.mockResolvedValue(0);
    prismaMock.evidenceItem.groupBy.mockResolvedValue([]);
    prismaMock.evidenceItem.findMany.mockResolvedValue([]);
    prismaMock.highlight.count.mockResolvedValue(0);
    prismaMock.highlight.groupBy.mockResolvedValue([]);
    prismaMock.highlight.findMany.mockResolvedValue([]);
    prismaMock.projectFact.count.mockResolvedValue(0);
    prismaMock.projectFact.findMany.mockResolvedValue([]);
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([]);
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

  it("loads an owner-scoped chat shell without hydrating project knowledge", async () => {
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({
      id: "work-item-1",
      userId: "user-1",
      type: "project",
      title: "Workbase",
      description: "Project chat",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      highlights: [{ id: "sensitive-highlight" }],
      projectFacts: [],
      agentRuns: [{ id: "manual-run-active", status: "running" }],
    });

    const result = await getWorkItemChatShellForUser("user-1", "work-item-1");

    expect(prismaMock.workItem.findFirstOrThrow).toHaveBeenCalledWith({
      where: {
        id: "work-item-1",
        userId: "user-1",
      },
      include: {
        highlights: {
          where: {
            lifecycleStatus: "active",
            sensitivityFlag: true,
          },
          select: {
            id: true,
          },
          take: 1,
        },
        projectFacts: {
          where: {
            lifecycleStatus: "active",
            sensitivityFlag: true,
          },
          select: {
            id: true,
          },
          take: 1,
        },
        agentRuns: {
          where: { kind: "manual_evidence_highlights" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    });
    expect(result.sensitiveContextAvailable).toBe(true);
    expect(result.workItem).toMatchObject({
      id: "work-item-1",
      title: "Workbase",
      highlights: [],
      projectFacts: [],
      evidenceItems: [],
      artifacts: [],
      knowledgeChanges: [],
      agentRuns: [{ id: "manual-run-active", status: "running" }],
    });
  });

  it("loads Sources evidence plus active or import-linked refresh state", async () => {
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({
      id: "work-item-1",
      userId: "user-1",
      type: "project",
      title: "Workbase",
      description: "Project chat",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      sources: [
        { id: "description", metadata: { kind: "work_item_description" } },
        {
          id: "repository",
          metadata: {
            repository: "owner/repo",
            repositoryImport: {
              requestId: "request-1",
              status: "evidence_ready",
              requestedAt: "2026-08-09T00:00:00.000Z",
              refreshRunId: "refresh-1",
            },
          },
        },
      ],
      agentRuns: [{ id: "manual-run-active", status: "running" }],
    });
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([{
      id: "refresh-1",
      workItemId: "work-item-1",
      status: "reconciling",
      progress: { analyzedFiles: 20 },
    }]);
    prismaMock.evidenceItem.count
      .mockResolvedValueOnce(62)
      .mockResolvedValueOnce(41);
    prismaMock.evidenceItem.groupBy.mockResolvedValue([
      { type: "github_commit", _count: { _all: 62 } },
    ]);
    prismaMock.evidenceItem.findMany.mockResolvedValue([
      { id: "included", included: true },
      { id: "excluded", included: false },
    ]);

    const result = await getWorkItemWorkspaceForUser(
      "user-1",
      "work-item-1",
      "sources",
      { evidencePage: 2 },
    );

    const query = prismaMock.workItem.findFirstOrThrow.mock.calls[0]?.[0];
    expect(query.where).toEqual({ id: "work-item-1", userId: "user-1" });
    expect(Object.keys(query.include)).toEqual(["sources", "agentRuns"]);
    expect(prismaMock.knowledgeRefreshRun.findMany).toHaveBeenCalledWith({
      where: {
        workItemId: "work-item-1",
        OR: [
          {
            status: {
              in: [
                "queued",
                "inventorying",
                "analyzing",
                "routing",
                "semantic_analysis",
                "auditing",
                "reconciling",
              ],
            },
          },
          { id: { in: ["refresh-1"] } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(result.visibleSourceCount).toBe(1);
    expect(result.includedEvidenceCount).toBe(41);
    expect(result.workItem.sources).toHaveLength(2);
    expect(result.workItem.evidenceItems).toHaveLength(2);
    expect(result.workItem.knowledgeRefreshRuns).toEqual([
      expect.objectContaining({ id: "refresh-1", status: "reconciling", snapshots: [] }),
    ]);
    expect(result.workItem.agentRuns).toEqual([
      { id: "manual-run-active", status: "running" },
    ]);
    expect(result.evidenceTypeCounts).toEqual({ github_commit: 62 });
    expect(prismaMock.evidenceItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 30, take: 30 }),
    );
    expect(result.workItem.highlights).toEqual([]);
    expect(result.workItem.knowledgeChanges).toEqual([]);
  });

  it("loads artifact history and its direct provenance without the review inbox", async () => {
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({
      id: "work-item-1",
      userId: "user-1",
      type: "project",
      title: "Workbase",
      description: "Project chat",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      highlights: [],
      evidenceItems: [],
      generationRuns: [],
      artifacts: [],
      agentRuns: [{ id: "manual-run-failed", status: "failed" }],
    });

    const result = await getWorkItemWorkspaceForUser("user-1", "work-item-1", "artifacts");

    const query = prismaMock.workItem.findFirstOrThrow.mock.calls[0]?.[0];
    expect(Object.keys(query.include)).toEqual([
      "highlights",
      "evidenceItems",
      "generationRuns",
      "artifacts",
      "agentRuns",
    ]);
    expect(query.include.generationRuns.where.kind.in).toEqual([
      "artifact_retrieval",
      "artifact_generation",
    ]);
    expect(prismaMock.knowledgeChange.findMany).not.toHaveBeenCalled();
    expect(result.workItem.projectFacts).toEqual([]);
    expect(result.workItem.knowledgeRefreshRuns).toEqual([]);
    expect(result.workItem.agentRuns).toEqual([
      { id: "manual-run-failed", status: "failed" },
    ]);
  });

  it("loads the review inbox only for the Highlights workspace", async () => {
    prismaMock.workItem.findFirstOrThrow.mockResolvedValue({
      id: "work-item-1",
      userId: "user-1",
      type: "project",
      title: "Workbase",
      description: "Project chat",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      sources: [],
      highlights: [],
      projectFacts: [],
      highlightSuggestions: [],
      generationRuns: [],
      knowledgeRefreshRuns: [],
      agentRuns: [],
      _count: { evidenceItems: 7, highlightSuggestions: 4 },
    });
    prismaMock.knowledgeChange.findMany
      .mockResolvedValueOnce([{ id: "attention" }])
      .mockResolvedValueOnce([{ id: "routine" }])
      .mockResolvedValueOnce([{ id: "provenance" }]);
    prismaMock.knowledgeChange.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prismaMock.highlight.count
      .mockResolvedValueOnce(118)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(7);
    prismaMock.projectFact.count
      .mockResolvedValueOnce(250)
      .mockResolvedValueOnce(38);
    prismaMock.highlight.groupBy.mockResolvedValue([
      {
        lifecycleStatus: "active",
        verificationStatus: "approved",
        _count: { _all: 14 },
      },
      {
        lifecycleStatus: "retired",
        verificationStatus: "approved",
        _count: { _all: 73 },
      },
    ]);

    const result = await getWorkItemWorkspaceForUser(
      "user-1",
      "work-item-1",
      "highlights",
      { knowledgePage: 3 },
    );

    const query = prismaMock.workItem.findFirstOrThrow.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.include?._count);
    expect(Object.keys(query.include)).toEqual([
      "sources",
      "highlightSuggestions",
      "generationRuns",
      "knowledgeRefreshRuns",
      "agentRuns",
      "_count",
    ]);
    expect(query.include).not.toHaveProperty("evidenceItems");
    expect(query.include).not.toHaveProperty("artifacts");
    expect(query.include).not.toHaveProperty("highlights");
    expect(query.include).not.toHaveProperty("projectFacts");
    expect(query.include.knowledgeRefreshRuns).not.toHaveProperty("include");
    expect(prismaMock.knowledgeChange.findMany).toHaveBeenCalledTimes(3);
    expect(result.includedEvidenceCount).toBe(7);
    expect(result.pendingHighlightSuggestionCount).toBe(4);
    expect(result.highlightCounts.bulkApprovable).toBe(3);
    expect(result.pagination.knowledge).toMatchObject({
      page: 3,
      totalItems: 250,
      totalPages: 13,
    });
    expect(prismaMock.highlight.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
    expect(prismaMock.projectFact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
    expect(result.workItem.knowledgeChanges).toEqual([
      { id: "attention" },
      { id: "routine" },
      { id: "provenance" },
    ]);
  });
});
