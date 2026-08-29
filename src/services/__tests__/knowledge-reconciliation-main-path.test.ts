import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  knowledgeChange: {
    count: vi.fn(),
  },
}));
const synthesizeRepositoryKnowledgeMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveActiveTextModelIdentity: () => ({ modelId: "test-model" }),
}));
vi.mock("@/src/services/repository-knowledge-synthesis-service", () => ({
  materializeSynthesisCitations: vi.fn(),
  synthesisNotebookReferenceKey: vi.fn(),
  synthesizeRepositoryKnowledge: synthesizeRepositoryKnowledgeMock,
}));

import { reconcileRepositoryKnowledge } from "@/src/services/knowledge-reconciliation-service";

describe("repository reconciliation synthesis path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const target = {
      sourceId: "source-1",
      repository: "owner/project",
      branch: "main",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: null,
      resolvedAt: "2026-08-29T08:00:00.000Z",
    };
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        id: "refresh-1",
        workItemId: "work-item-1",
        status: "reconciling",
        targetHeads: [target],
        createdAt: new Date("2026-08-29T08:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "refresh-1",
        workItemId: "work-item-1",
        status: "reconciling",
        qualityStatus: "verified",
        targetHeads: [target],
        workItem: { userId: "user-1" },
      });
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([]);
    prismaMock.knowledgeChange.count.mockResolvedValue(3);
    synthesizeRepositoryKnowledgeMock.mockRejectedValue(new Error("stop after synthesis dispatch"));
  });

  it("re-enters audited synthesis on retry instead of forcing deterministic fallback", async () => {
    await expect(reconcileRepositoryKnowledge("refresh-1")).rejects.toThrow(
      "stop after synthesis dispatch",
    );

    expect(prismaMock.knowledgeChange.count).not.toHaveBeenCalled();
    expect(synthesizeRepositoryKnowledgeMock).toHaveBeenCalledOnce();
    expect(synthesizeRepositoryKnowledgeMock).toHaveBeenCalledWith("refresh-1");
  });
});
