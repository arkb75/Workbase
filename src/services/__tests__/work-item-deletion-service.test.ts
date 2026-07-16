import { beforeEach, describe, expect, it, vi } from "vitest";

const cancel = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn(() => ({ cancel })));
const prismaMock = vi.hoisted(() => ({
  workItem: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
  },
  artifact: {
    deleteMany: vi.fn(),
  },
  chatCitation: {
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("workflow/api", () => ({ getRun }));
vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { deleteWorkItemForUser } from "@/src/services/work-item-deletion-service";

describe("deleteWorkItemForUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRun.mockImplementation(() => ({ cancel }));
    cancel.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.chatCitation.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.artifact.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.workItem.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("does nothing when the Work Item does not belong to the user", async () => {
    prismaMock.workItem.findFirst.mockResolvedValueOnce(null);

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: false });

    expect(getRun).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("cancels active workflows once and deletes citation leaves and artifacts before the owned Work Item", async () => {
    prismaMock.workItem.findFirst
      .mockResolvedValueOnce({
        id: "work-1",
        agentRuns: [{ workflowId: "workflow-agent" }],
        knowledgeRefreshRuns: [
          { workflowId: "workflow-agent" },
          { workflowId: "workflow-refresh" },
        ],
      })
      .mockResolvedValueOnce({ id: "work-1" });

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .resolves.toEqual({ deleted: true });

    expect(getRun).toHaveBeenCalledTimes(2);
    expect(getRun).toHaveBeenNthCalledWith(1, "workflow-agent");
    expect(getRun).toHaveBeenNthCalledWith(2, "workflow-refresh");
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(prismaMock.chatCitation.deleteMany).toHaveBeenCalledWith({
      where: { message: { thread: { workItemId: "work-1" } } },
    });
    expect(prismaMock.artifact.deleteMany).toHaveBeenCalledWith({ where: { workItemId: "work-1" } });
    expect(prismaMock.workItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "work-1", userId: "user-1" },
    });
    expect(prismaMock.chatCitation.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.artifact.deleteMany.mock.invocationCallOrder[0]!);
    expect(prismaMock.artifact.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.workItem.deleteMany.mock.invocationCallOrder[0]!);
  });

  it("stops without deleting when workflow cancellation fails", async () => {
    prismaMock.workItem.findFirst.mockResolvedValueOnce({
      id: "work-1",
      agentRuns: [{ workflowId: "workflow-agent" }],
      knowledgeRefreshRuns: [],
    });
    cancel.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .rejects.toThrow("active workflow could not be cancelled");

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("requires a retry while a workflow reservation is still starting", async () => {
    prismaMock.workItem.findFirst.mockResolvedValueOnce({
      id: "work-1",
      agentRuns: [{ workflowId: "starting:reservation" }],
      knowledgeRefreshRuns: [],
    });

    await expect(deleteWorkItemForUser({ userId: "user-1", workItemId: "work-1" }))
      .rejects.toThrow("still starting");

    expect(getRun).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
