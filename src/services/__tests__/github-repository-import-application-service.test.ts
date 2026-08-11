import { beforeEach, describe, expect, it, vi } from "vitest";

const startMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  workItem: { findFirst: vi.fn() },
  source: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("workflow/api", () => ({ start: startMock, getRun: getRunMock }));
vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/workflows/github-repository-import", () => ({
  githubRepositoryImportWorkflow: vi.fn(),
}));

import {
  acceptGitHubRepositoryImport,
  queueGitHubRepositoryImport,
  reserveGitHubRepositoryImport,
} from "@/src/services/github-repository-import-application-service";

type SourceState = { id: string; metadata: Record<string, unknown> } | null;
let sourceState: SourceState;

function importState() {
  return sourceState?.metadata.repositoryImport as Record<string, unknown> | undefined;
}

describe("GitHub repository import application service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sourceState = null;
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([{ id: "work-1" }]);
    prismaMock.workItem.findFirst.mockResolvedValue({ id: "work-1" });
    prismaMock.source.findUnique.mockImplementation(async () => sourceState);
    prismaMock.source.upsert.mockImplementation(async ({ create, update }) => {
      sourceState = {
        id: "source-1",
        metadata: (sourceState ? update.metadata : create.metadata) as Record<string, unknown>,
      };
      return { id: sourceState.id };
    });
    prismaMock.source.update.mockImplementation(async ({ data }) => {
      if (!sourceState) throw new Error("Source missing");
      sourceState = {
        ...sourceState,
        metadata: data.metadata as Record<string, unknown>,
      };
      return sourceState;
    });
    startMock.mockResolvedValue({ runId: "workflow-1" });
    getRunMock.mockImplementation(() => ({ cancel: cancelMock }));
    cancelMock.mockResolvedValue(undefined);
  });

  it("persists the durable Source reservation before workflow acceptance", async () => {
    const reservation = await reserveGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    });

    expect(startMock).not.toHaveBeenCalled();
    expect(sourceState?.metadata).toEqual(expect.objectContaining({
      status: "queued",
      repository: expect.objectContaining({
        id: "repo-1",
        fullName: "workbase/demo",
      }),
      repositoryImport: expect.objectContaining({
        status: "queued",
        requestId: reservation.requestId,
      }),
    }));

    await expect(acceptGitHubRepositoryImport(reservation)).resolves.toEqual({
      sourceId: "source-1",
      requestId: reservation.requestId,
      workflowId: "workflow-1",
      reused: false,
    });
    expect(startMock).toHaveBeenCalledOnce();
    expect(importState()).toEqual(expect.objectContaining({
      workflowId: "workflow-1",
      status: "queued",
    }));
  });

  it("coalesces a duplicate attach onto the exact active workflow", async () => {
    sourceState = {
      id: "source-1",
      metadata: {
        repositoryImport: {
          requestId: "request-existing",
          status: "importing",
          requestedAt: new Date().toISOString(),
          workflowId: "workflow-existing",
        },
      },
    };

    const reservation = await reserveGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    });
    await expect(acceptGitHubRepositoryImport(reservation)).resolves.toEqual({
      sourceId: "source-1",
      requestId: "request-existing",
      workflowId: "workflow-existing",
      reused: true,
    });
    expect(prismaMock.source.upsert).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("records a retryable terminal state when deferred workflow acceptance fails", async () => {
    startMock.mockRejectedValue(new Error("workflow queue unavailable"));
    const reservation = await reserveGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    });

    await expect(acceptGitHubRepositoryImport(reservation)).rejects.toThrow(
      "workflow queue unavailable",
    );
    expect(importState()).toEqual(expect.objectContaining({
      status: "retryable_failed",
      error: "workflow queue unavailable",
      finishedAt: expect.any(String),
    }));
    expect(importState()).not.toHaveProperty("workflowId");
  });

  it("cancels an accepted orphan if deletion wins before exact-ID attachment", async () => {
    const reservation = await reserveGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    });
    startMock.mockImplementationOnce(async () => {
      sourceState = null;
      return { runId: "workflow-1" };
    });
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: "source-1" }])
      .mockResolvedValue([]);

    await expect(acceptGitHubRepositoryImport(reservation)).rejects.toThrow(
      "cancelled or superseded",
    );
    expect(getRunMock).toHaveBeenCalledWith("workflow-1");
    expect(cancelMock).toHaveBeenCalledOnce();
  });

  it("keeps the compatibility API as an explicit reserve-then-accept sequence", async () => {
    await expect(queueGitHubRepositoryImport({
      userId: "user-1",
      workItemId: "work-1",
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo",
    })).resolves.toMatchObject({ workflowId: "workflow-1", reused: false });
    expect(prismaMock.source.upsert).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
  });
});
