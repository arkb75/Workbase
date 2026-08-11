import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const updateStateMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  workItem: { findFirst: vi.fn() },
  source: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock("workflow/api", () => ({ start: startMock, getRun: getRunMock }));
vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/github-repository-import-state-service", () => ({
  updateRepositoryImportStateForRequest: updateStateMock,
}));
vi.mock("@/workflows/github-repository-import", () => ({
  githubRepositoryImportWorkflow: vi.fn(),
}));

import { queueGitHubRepositoryImport } from "@/src/services/github-repository-import-application-service";

describe("queueGitHubRepositoryImport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([{ id: "work-1" }]);
    prismaMock.workItem.findFirst.mockResolvedValue({ id: "work-1" });
    prismaMock.source.findUnique.mockResolvedValue(null);
    prismaMock.source.upsert.mockResolvedValue({ id: "source-1" });
    startMock.mockResolvedValue({ runId: "workflow-1" });
    getRunMock.mockImplementation(() => ({ cancel: cancelMock }));
    cancelMock.mockResolvedValue(undefined);
    updateStateMock.mockResolvedValue({ status: "queued" });
  });

  it("persists a queued Source before starting and returns without awaiting import work", async () => {
    const result = await queueGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    });

    expect(prismaMock.source.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        workItemId: "work-1",
        externalId: "repo-1",
        label: "workbase/demo",
        metadata: expect.objectContaining({
          status: "queued",
          repository: expect.objectContaining({
            id: "repo-1",
            fullName: "workbase/demo",
          }),
          repositoryImport: expect.objectContaining({
            status: "queued",
            requestId: expect.any(String),
          }),
        }),
      }),
    }));
    expect(startMock).toHaveBeenCalledOnce();
    expect(updateStateMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source-1",
      patch: { workflowId: "workflow-1" },
    }));
    expect(result).toMatchObject({
      sourceId: "source-1",
      workflowId: "workflow-1",
      reused: false,
    });
  });

  it("coalesces a duplicate attach while the same Source import is active", async () => {
    prismaMock.source.findUnique.mockResolvedValue({
      id: "source-1",
      metadata: {
        repositoryImport: {
          requestId: "request-existing",
          status: "importing",
          requestedAt: new Date().toISOString(),
          workflowId: "workflow-existing",
        },
      },
    });

    await expect(queueGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    })).resolves.toEqual({
      sourceId: "source-1",
      requestId: "request-existing",
      workflowId: "workflow-existing",
      reused: true,
    });

    expect(prismaMock.source.upsert).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("records an explicit retryable failure if durable enqueueing fails", async () => {
    startMock.mockRejectedValue(new Error("workflow queue unavailable"));

    await expect(queueGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    })).rejects.toThrow("workflow queue unavailable");

    expect(updateStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceId: "source-1",
      patch: expect.objectContaining({
        status: "retryable_failed",
        error: "workflow queue unavailable",
      }),
    }));
  });

  it("cancels an accepted workflow when deletion removes its Source before exact-ID attachment", async () => {
    updateStateMock.mockResolvedValueOnce(null);

    await expect(queueGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    })).rejects.toThrow("cancelled or superseded");

    expect(getRunMock).toHaveBeenCalledWith("workflow-1");
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(updateStateMock).toHaveBeenCalledOnce();
    expect(updateStateMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source-1",
      patch: { workflowId: "workflow-1" },
    }));
  });
});
