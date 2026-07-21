import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { priorTurnProvenanceService } from "@/src/services/prior-turn-provenance-service";

describe("prior turn provenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports deterministic research-controller activity from one sanitized metadata query", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{
      messageId: "assistant-previous",
      knowledgeRefreshRunId: null,
      result: { partial: true, fallbackUsed: false },
      environmentSnapshot: { intent: { kind: "repository_research" } },
      researchState: {
        phase: "awaiting_review",
        partial: true,
        usage: { treeLookups: 1, searches: 2, fileReads: 5, visibleBytes: 4_096 },
      },
      candidatePartial: false,
      toolCallCounts: {},
      usedSources: [{ kind: "project_fact", title: "Approved architecture fact" }],
    }]);

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
    });

    expect(result.repositoryInspected).toBe(true);
    expect(result.repositoryActivity).toBe("targeted_research");
    expect(result.partial).toBe(true);
    expect(result.toolCalls).toEqual([
      { name: "list_repository_paths", count: 1 },
      { name: "search_repository", count: 2 },
      { name: "read_repository_file", count: 5 },
    ]);
    expect(result.usedSources).toEqual([{ kind: "project_fact", title: "Approved architecture fact" }]);
    expect(JSON.stringify(result)).not.toContain("file content");
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("does not report repository access for a memory-only answer", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{
      messageId: "assistant-previous",
      knowledgeRefreshRunId: null,
      result: { partial: false, fallbackUsed: false },
      environmentSnapshot: { intent: { kind: "direct_answer" } },
      researchState: null,
      candidatePartial: false,
      toolCallCounts: {},
      usedSources: [{ kind: "highlight", title: "Approved accomplishment" }],
    }]);

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
    });
    expect(result.repositoryInspected).toBe(false);
    expect(result.repositoryActivity).toBe("none");
    expect(result.toolCalls).toEqual([]);
  });

  it("uses persisted tool counts and candidate partial state without loading relation rows", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{
      messageId: "assistant-previous",
      knowledgeRefreshRunId: null,
      result: { partial: false, fallbackUsed: true },
      environmentSnapshot: { intent: { kind: "direct_answer" } },
      researchState: null,
      candidatePartial: true,
      toolCallCounts: {
        research_project: 1,
        read_repository_files: 2,
      },
      usedSources: [],
    }]);

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
    });

    expect(result).toMatchObject({
      repositoryInspected: true,
      repositoryActivity: "targeted_research",
      partial: true,
      fallbackUsed: true,
      toolCalls: [
        { name: "research_project", count: 1 },
        { name: "read_repository_files", count: 2 },
      ],
    });
  });

  it.each([
    {
      label: "the persisted refresh dossier",
      researchState: { kind: "repository_knowledge_refresh", partial: false },
      knowledgeRefreshRunId: null,
    },
    {
      label: "the linked knowledge refresh run",
      researchState: null,
      knowledgeRefreshRunId: "refresh-1",
    },
  ])("recognizes repository inspection from $label", async ({
    researchState,
    knowledgeRefreshRunId,
  }) => {
    prismaMock.$queryRaw.mockResolvedValue([{
      messageId: "assistant-previous",
      knowledgeRefreshRunId,
      result: { partial: false, fallbackUsed: false },
      environmentSnapshot: { intent: { kind: "direct_answer" } },
      researchState,
      candidatePartial: false,
      toolCallCounts: {},
      usedSources: [{ kind: "project_fact", title: "Current architecture" }],
    }]);

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
    });

    expect(result).toMatchObject({
      repositoryInspected: true,
      repositoryActivity: "knowledge_refresh",
    });
  });

  it("scopes the audit run write to the same user, work item, and thread", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{
      messageId: "assistant-previous",
      knowledgeRefreshRunId: null,
      result: { partial: false, fallbackUsed: false },
      environmentSnapshot: { intent: { kind: "direct_answer" } },
      researchState: null,
      candidatePartial: false,
      toolCallCounts: {},
      usedSources: [],
    }]);

    await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
      auditRunId: "audit-run-1",
    });

    const query = prismaMock.$queryRaw.mock.calls[0]![0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    const sql = query.sql ?? query.text ?? "";
    expect(sql).toContain('current_run."userId"');
    expect(sql).toContain('current_run."workItemId"');
    expect(sql).toContain('current_run."threadId"');
    expect(query.values).toEqual(expect.arrayContaining([
      "audit-run-1",
      "user-1",
      "work-item-1",
      "thread-1",
    ]));
  });
});
