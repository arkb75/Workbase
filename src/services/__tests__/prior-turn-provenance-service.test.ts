import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  chatMessage: { findFirstOrThrow: vi.fn() },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { priorTurnProvenanceService } from "@/src/services/prior-turn-provenance-service";

describe("prior turn provenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports deterministic research-controller activity without exposing file content", async () => {
    prismaMock.chatMessage.findFirstOrThrow.mockResolvedValue({
      id: "assistant-previous",
      citations: [{ kind: "project_fact", label: "Approved architecture fact" }],
      agentRun: {
        result: { partial: true, fallbackUsed: false },
        environmentSnapshot: { intent: { kind: "repository_research" } },
        researchState: {
          phase: "awaiting_review",
          partial: true,
          usage: { treeLookups: 1, searches: 2, fileReads: 5, visibleBytes: 4_096 },
        },
        events: [],
        candidates: [],
      },
    });

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
    });

    expect(result.repositoryInspected).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.toolCalls).toEqual([
      { name: "list_repository_paths", count: 1 },
      { name: "search_repository", count: 2 },
      { name: "read_repository_files", count: 5 },
    ]);
    expect(result.usedSources).toEqual([{ kind: "project_fact", title: "Approved architecture fact" }]);
    expect(JSON.stringify(result)).not.toContain("file content");
  });

  it("does not report repository access for a memory-only answer", async () => {
    prismaMock.chatMessage.findFirstOrThrow.mockResolvedValue({
      id: "assistant-previous",
      citations: [{ kind: "highlight", label: "Approved accomplishment" }],
      agentRun: {
        result: { partial: false, fallbackUsed: false },
        environmentSnapshot: { intent: { kind: "direct_answer" } },
        researchState: null,
        events: [],
        candidates: [],
      },
    });

    const result = await priorTurnProvenanceService.inspect({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      assistantMessageId: "assistant-previous",
    });
    expect(result.repositoryInspected).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });
});
