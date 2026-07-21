import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRun: vi.fn(),
  findMessages: vi.fn(),
  findAssistant: vi.fn(),
  deleteCitations: vi.fn(),
  createCitations: vi.fn(),
  updateMessages: vi.fn(),
  updateMessage: vi.fn(),
  updateRun: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (
      callback: (tx: {
        $queryRaw: typeof mocks.queryRun;
        chatMessage: {
          findMany: typeof mocks.findMessages;
          findFirstOrThrow: typeof mocks.findAssistant;
          updateMany: typeof mocks.updateMessages;
          update: typeof mocks.updateMessage;
        };
        chatCitation: {
          deleteMany: typeof mocks.deleteCitations;
          createMany: typeof mocks.createCitations;
        };
        agentRun: { update: typeof mocks.updateRun };
      }) => Promise<unknown>,
    ) => callback({
      $queryRaw: mocks.queryRun,
      chatMessage: {
        findMany: mocks.findMessages,
        findFirstOrThrow: mocks.findAssistant,
        updateMany: mocks.updateMessages,
        update: mocks.updateMessage,
      },
      chatCitation: {
        deleteMany: mocks.deleteCitations,
        createMany: mocks.createCitations,
      },
      agentRun: { update: mocks.updateRun },
    })),
  },
}));

import {
  cancelActiveAgentRunPersistence,
  markAgentRunAwaitingReview,
  markAgentRunRunning,
} from "@/src/services/project-chat-store";

describe("project chat cancellation persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMessages.mockResolvedValue([{ id: "assistant-message" }]);
    mocks.deleteCitations.mockResolvedValue({ count: 1 });
    mocks.createCitations.mockResolvedValue({ count: 0 });
    mocks.updateMessages.mockResolvedValue({ count: 1 });
    mocks.updateMessage.mockResolvedValue({});
    mocks.updateRun.mockResolvedValue({});
  });

  it("atomically cancels an active run and removes provisional citations", async () => {
    mocks.queryRun.mockResolvedValue([{
      status: "running",
      workflowId: "wrun-1",
      knowledgeRefreshRunId: "refresh-1",
    }]);

    await expect(cancelActiveAgentRunPersistence({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    })).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
      workflowId: "wrun-1",
      knowledgeRefreshRunId: "refresh-1",
    });

    expect(mocks.deleteCitations).toHaveBeenCalledWith({
      where: { messageId: { in: ["assistant-message"] } },
    });
    expect(mocks.updateMessages).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ["assistant-message"] },
        status: { in: ["queued", "running", "awaiting_review"] },
      }),
      data: expect.objectContaining({
        status: "cancelled",
        content: "This run was cancelled.",
      }),
    }));
    expect(mocks.updateRun).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "cancelled" }),
    }));
  });

  it("cannot overwrite a completion that wins the row-lock race", async () => {
    mocks.queryRun.mockResolvedValue([{
      status: "completed",
      workflowId: "wrun-1",
      knowledgeRefreshRunId: null,
    }]);

    await expect(cancelActiveAgentRunPersistence({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    })).resolves.toEqual({
      cancelled: false,
      status: "completed",
      workflowId: "wrun-1",
      knowledgeRefreshRunId: null,
    });

    expect(mocks.findMessages).not.toHaveBeenCalled();
    expect(mocks.deleteCitations).not.toHaveBeenCalled();
    expect(mocks.updateMessages).not.toHaveBeenCalled();
    expect(mocks.updateRun).not.toHaveBeenCalled();
  });

  it("returns the authoritative cancelled status when mark-running loses the row lock", async () => {
    mocks.queryRun.mockResolvedValue([{
      status: "cancelled",
      startedAt: null,
    }]);

    await expect(markAgentRunRunning("run-1")).resolves.toEqual({
      active: false,
      status: "cancelled",
    });

    expect(mocks.updateRun).not.toHaveBeenCalled();
    expect(mocks.updateMessages).not.toHaveBeenCalled();
  });

  it("returns the authoritative cancelled status when awaiting-review persistence loses the row lock", async () => {
    mocks.queryRun.mockResolvedValue([{ status: "cancelled" }]);

    await expect(markAgentRunAwaitingReview({
      runId: "run-1",
      content: "Repository findings are ready for review.",
      result: { status: "awaiting_review" },
      citations: [],
      citationPolicy: "none",
    })).resolves.toEqual({
      persisted: false,
      status: "cancelled",
    });

    expect(mocks.findAssistant).not.toHaveBeenCalled();
    expect(mocks.deleteCitations).not.toHaveBeenCalled();
    expect(mocks.createCitations).not.toHaveBeenCalled();
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.updateRun).not.toHaveBeenCalled();
  });
});
