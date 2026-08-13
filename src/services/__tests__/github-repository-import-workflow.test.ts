import { beforeEach, describe, expect, it, vi } from "vitest";

const updateStateMock = vi.hoisted(() => vi.fn());
const importRepositoryMock = vi.hoisted(() => vi.fn());
const persistEvidenceMock = vi.hoisted(() => vi.fn());
const startRefreshMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  workItem: { findFirst: vi.fn() },
  source: { findUnique: vi.fn() },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/github-repository-import-state-service", () => ({
  updateRepositoryImportStateForRequest: updateStateMock,
}));
vi.mock("@/src/services/github-repo-import-service", () => ({
  githubRepoImportService: { importRepository: importRepositoryMock },
}));
vi.mock("@/src/lib/evidence-persistence", () => ({
  upsertEvidenceItemsForSource: persistEvidenceMock,
}));
vi.mock("@/src/services/repository-knowledge-refresh-application-service", () => ({
  repositoryKnowledgeRefreshApplicationService: { start: startRefreshMock },
}));

import { githubRepositoryImportWorkflow } from "@/workflows/github-repository-import";

const input = {
  userId: "user-1",
  workItemId: "work-1",
  sourceId: "source-1",
  repositoryId: "repo-1",
  repositoryFullName: "workbase/demo",
  requestId: "request-1",
};

function importState(status: "queued" | "importing" | "evidence_ready") {
  return {
    repositoryImport: {
      requestId: input.requestId,
      requestedAt: "2026-08-09T00:00:00.000Z",
      status,
    },
  };
}

describe("githubRepositoryImportWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.workItem.findFirst.mockResolvedValue({
      id: input.workItemId,
      userId: input.userId,
      title: "Demo",
      type: "project",
      description: null,
      startDate: null,
      endDate: null,
    });
    updateStateMock
      .mockResolvedValueOnce({ status: "importing" })
      .mockResolvedValueOnce({ status: "evidence_ready" })
      .mockResolvedValueOnce({ status: "evidence_ready" });
    importRepositoryMock.mockResolvedValue({
      source: { id: input.sourceId },
      importedEvidenceItems: [{
        workItemId: input.workItemId,
        sourceId: input.sourceId,
        externalId: "commit-1",
        source: { type: "github_repo" },
        type: "github_commit",
        title: "Commit",
        content: "Body",
        searchText: "Commit Body",
        parentKind: "commit",
        parentKey: "commit-1",
        included: true,
        metadata: {},
      }],
      importSummary: {
        repository: { id: input.repositoryId, fullName: input.repositoryFullName },
        importedAt: "2026-08-09T00:01:00.000Z",
        counts: { commits: 1 },
        webhook: { status: "configured" },
      },
    });
    prismaMock.source.findUnique
      .mockResolvedValueOnce({ metadata: importState("importing") })
      .mockResolvedValueOnce({ metadata: importState("evidence_ready") });
    persistEvidenceMock.mockResolvedValue([{
      id: "evidence-1",
      type: "github_commit",
      wasExisting: false,
      included: true,
    }]);
    startRefreshMock.mockResolvedValue({
      runId: "refresh-1",
      workflowId: "refresh-workflow-1",
      status: "queued",
    });
  });

  it("persists evidence before queueing exactly one current-head refresh", async () => {
    await expect(githubRepositoryImportWorkflow(input)).resolves.toEqual({
      status: "refresh_queued",
      refreshRunId: "refresh-1",
      refreshWorkflowId: "refresh-workflow-1",
    });

    expect(importRepositoryMock).toHaveBeenCalledOnce();
    expect(persistEvidenceMock).toHaveBeenCalledOnce();
    expect(startRefreshMock).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: input.workItemId,
      trigger: "repository_attach",
      idempotencyKey: `repository-import:${input.sourceId}:${input.requestId}`,
    }));
    expect(updateStateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: input.requestId,
      patch: expect.objectContaining({
        status: "evidence_ready",
        evidenceCount: 1,
        newCommitCount: 1,
      }),
    }));
    expect(updateStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: {
        refreshRunId: "refresh-1",
        refreshWorkflowId: "refresh-workflow-1",
      },
    }));
  });

  it("does not persist evidence or queue refresh after the Source is deleted", async () => {
    prismaMock.source.findUnique.mockReset().mockResolvedValueOnce(null);

    await expect(githubRepositoryImportWorkflow(input)).resolves.toEqual({
      status: "cancelled",
      reason: "source_deleted",
    });

    expect(persistEvidenceMock).not.toHaveBeenCalled();
    expect(startRefreshMock).not.toHaveBeenCalled();
  });

  it("does not persist evidence or queue refresh after a newer request supersedes it", async () => {
    prismaMock.source.findUnique.mockReset().mockResolvedValueOnce({
      metadata: {
        repositoryImport: {
          requestId: "request-newer",
          requestedAt: "2026-08-09T00:02:00.000Z",
          status: "queued",
        },
      },
    });

    await expect(githubRepositoryImportWorkflow(input)).resolves.toEqual({
      status: "superseded",
      reason: "newer_import_request",
    });

    expect(persistEvidenceMock).not.toHaveBeenCalled();
    expect(startRefreshMock).not.toHaveBeenCalled();
  });

  it("records a visible retryable failure when current-head Highlight analysis cannot start", async () => {
    startRefreshMock.mockRejectedValue(new Error("workflow control plane unavailable"));
    prismaMock.source.findUnique.mockReset().mockResolvedValueOnce({
      metadata: importState("importing"),
    }).mockResolvedValue({
      metadata: importState("evidence_ready"),
    });

    await expect(githubRepositoryImportWorkflow(input)).resolves.toEqual({
      status: "retryable_failed",
    });

    expect(updateStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceId: input.sourceId,
      requestId: input.requestId,
      patch: expect.objectContaining({
        status: "retryable_failed",
        error: expect.stringContaining(
          "Evidence import completed, but current-head automatic Highlight analysis could not start. workflow control plane unavailable",
        ),
      }),
    }));
  });
});
