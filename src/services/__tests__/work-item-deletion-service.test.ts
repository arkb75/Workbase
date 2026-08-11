import { beforeEach, describe, expect, it, vi } from "vitest";

const getRun = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  workItem: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
  },
  agentRun: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  knowledgeRefreshRun: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  source: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  artifact: {
    deleteMany: vi.fn(),
  },
  chatCitation: {
    deleteMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("workflow/api", () => ({ getRun }));
vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { deleteWorkItemForUser } from "@/src/services/work-item-deletion-service";

function repositoryImportMetadata(input: {
  status?: "queued" | "importing" | "cancelled";
  workflowId?: string;
  refreshWorkflowId?: string;
} = {}) {
  return {
    repositoryImport: {
      requestId: "request-1",
      status: input.status ?? "importing",
      requestedAt: "2026-08-09T00:00:00.000Z",
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.refreshWorkflowId
        ? { refreshWorkflowId: input.refreshWorkflowId }
        : {}),
    },
  };
}

describe("deleteWorkItemForUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRun.mockImplementation(() => ({ cancel }));
    cancel.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([{ id: "work-1" }]);
    prismaMock.workItem.findFirst.mockResolvedValue({ id: "work-1" });
    prismaMock.agentRun.findMany.mockResolvedValue([]);
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([]);
    prismaMock.knowledgeRefreshRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.source.findMany.mockResolvedValue([]);
    prismaMock.source.update.mockResolvedValue({ id: "source-1" });
    prismaMock.chatCitation.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.artifact.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.workItem.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("does not expose whether another user's Work Item exists", async () => {
    prismaMock.workItem.findFirst.mockResolvedValueOnce(null);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: false });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
  });

  it("fences chat, artifact, refresh, and import admissions before deleting, then cancels every exact workflow ID", async () => {
    prismaMock.agentRun.findMany
      .mockResolvedValueOnce([
        { id: "agent-chat", workflowId: "workflow-chat" },
        { id: "agent-artifact", workflowId: "workflow-artifact" },
        { id: "agent-starting", workflowId: "starting:reservation" },
      ])
      .mockResolvedValueOnce([
        { workflowId: "workflow-chat" },
        { workflowId: "workflow-artifact" },
        { workflowId: "workflow-late-attachment" },
      ]);
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.knowledgeRefreshRun.findMany
      .mockResolvedValueOnce([
        { id: "refresh-1", workflowId: "workflow-refresh" },
        { id: "refresh-inline", workflowId: "inline-agent:agent-chat" },
      ])
      .mockResolvedValueOnce([
        { workflowId: "workflow-refresh" },
        { workflowId: "inline-agent:agent-chat" },
      ]);
    prismaMock.knowledgeRefreshRun.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.source.findMany
      .mockResolvedValueOnce([{
        id: "source-1",
        metadata: repositoryImportMetadata({
          workflowId: "workflow-import",
          refreshWorkflowId: "workflow-import-refresh",
        }),
      }])
      .mockResolvedValueOnce([{
        metadata: repositoryImportMetadata({
          status: "cancelled",
          workflowId: "workflow-import",
          refreshWorkflowId: "workflow-import-refresh",
        }),
      }]);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: true });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[1])
      .toBeLessThan(prismaMock.source.findMany.mock.invocationCallOrder[0]!);
    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["agent-chat", "agent-artifact", "agent-starting"] },
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { status: "cancelled", finishedAt: expect.any(Date) },
    });
    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ["refresh-1", "refresh-inline"] },
      }),
      data: { status: "cancelled", finishedAt: expect.any(Date) },
    });
    expect(prismaMock.source.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        metadata: expect.objectContaining({
          status: "cancelled",
          repositoryImport: expect.objectContaining({
            requestId: "request-1",
            status: "cancelled",
            finishedAt: expect.any(String),
          }),
        }),
      },
    });
    expect(getRun.mock.calls.map(([workflowId]) => workflowId)).toEqual([
      "workflow-chat",
      "workflow-artifact",
      "workflow-refresh",
      "workflow-import",
      "workflow-import-refresh",
      "workflow-late-attachment",
    ]);
    expect(cancel).toHaveBeenCalledTimes(6);
    expect(prismaMock.workItem.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(getRun.mock.invocationCallOrder[0]!);
    expect(prismaMock.chatCitation.deleteMany).toHaveBeenCalledWith({
      where: { message: { thread: { workItemId: "work-1" } } },
    });
    expect(prismaMock.artifact.deleteMany).toHaveBeenCalledWith({
      where: { workItemId: "work-1" },
    });
  });

  it("terminalizes queued-without-workflow-ID and temporary reservations instead of blocking deletion", async () => {
    prismaMock.agentRun.findMany
      .mockResolvedValueOnce([
        { id: "agent-queued", workflowId: null },
        { id: "agent-starting", workflowId: "starting:reservation" },
      ])
      .mockResolvedValueOnce([
        { workflowId: null },
        { workflowId: "starting:reservation" },
      ]);
    prismaMock.knowledgeRefreshRun.findMany
      .mockResolvedValueOnce([{ id: "refresh-queued", workflowId: null }])
      .mockResolvedValueOnce([{ workflowId: null }]);
    prismaMock.source.findMany
      .mockResolvedValueOnce([{
        id: "source-queued",
        metadata: repositoryImportMetadata({ status: "queued" }),
      }])
      .mockResolvedValueOnce([{
        metadata: repositoryImportMetadata({ status: "cancelled" }),
      }]);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: true });

    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledOnce();
    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenCalledOnce();
    expect(prismaMock.source.update).toHaveBeenCalledOnce();
    expect(getRun).not.toHaveBeenCalled();
    expect(prismaMock.workItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "work-1", userId: "user-1" },
    });
  });

  it("keeps deletion authoritative when remote workflow cancellation fails", async () => {
    prismaMock.agentRun.findMany
      .mockResolvedValueOnce([{ id: "agent-1", workflowId: "workflow-agent" }])
      .mockResolvedValueOnce([{ workflowId: "workflow-agent" }]);
    cancel.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: true });

    expect(getRun).toHaveBeenCalledWith("workflow-agent");
    expect(prismaMock.workItem.deleteMany).toHaveBeenCalledOnce();
  });

  it("does not affect a newly added Work Item when the originally requested identity disappears before fencing", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: false });

    expect(getRun).not.toHaveBeenCalled();
    expect(prismaMock.agentRun.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeRefreshRun.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.source.update).not.toHaveBeenCalled();
    expect(prismaMock.chatCitation.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.artifact.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.workItem.deleteMany).not.toHaveBeenCalled();
  });

  it("rechecks ownership after acquiring the identity lock", async () => {
    prismaMock.workItem.findFirst
      .mockResolvedValueOnce({ id: "work-1" })
      .mockResolvedValueOnce(null);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: false });

    expect(prismaMock.$queryRaw).toHaveBeenCalledOnce();
    expect(prismaMock.workItem.deleteMany).not.toHaveBeenCalled();
  });
});
