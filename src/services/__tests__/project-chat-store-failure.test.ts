import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findRun: vi.fn(),
  updateRun: vi.fn(),
  updateMessages: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (
      callback: (tx: {
        agentRun: {
          findUnique: typeof mocks.findRun;
          updateMany: typeof mocks.updateRun;
        };
        chatMessage: {
          updateMany: typeof mocks.updateMessages;
        };
      }) => Promise<unknown>,
    ) =>
      callback({
        agentRun: {
          findUnique: mocks.findRun,
          updateMany: mocks.updateRun,
        },
        chatMessage: {
          updateMany: mocks.updateMessages,
        },
      })),
  },
}));

import { failAgentRun } from "@/src/services/project-chat-store";

describe("project chat terminal message persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({
      status: "running",
      researchState: null,
      environmentSnapshot: null,
    });
    mocks.updateRun.mockResolvedValue({ count: 1 });
    mocks.updateMessages.mockResolvedValue({ count: 1 });
  });

  it("keeps an insufficient-context answer completed and therefore visible to later turns", async () => {
    await failAgentRun({
      runId: "run-insufficient",
      message: "The current project memory does not establish production request volume.",
      insufficient: true,
    });

    expect(mocks.updateRun).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "run-insufficient" }),
      data: expect.objectContaining({
        status: "insufficient_context",
      }),
    }));
    expect(mocks.updateMessages).toHaveBeenCalledWith({
      where: {
        agentRunId: "run-insufficient",
        role: "assistant",
      },
      data: expect.objectContaining({
        status: "completed",
        content: "The current project memory does not establish production request volume.",
        metadata: expect.objectContaining({
          outcome: "insufficient_context",
          operationalFailure: false,
        }),
      }),
    });
  });

  it("still excludes an operational failure from normal completed-message history", async () => {
    await failAgentRun({
      runId: "run-failed",
      message: "The model provider did not complete this request.",
      failure: {
        code: "model_provider_unavailable",
        stage: "Running project chat",
        retryable: true,
        recovery: "Retry this message.",
      },
    });

    expect(mocks.updateMessages).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({
          outcome: "failed",
          operationalFailure: true,
          retryable: true,
          failureCode: "model_provider_unavailable",
        }),
      }),
    }));
  });
});
