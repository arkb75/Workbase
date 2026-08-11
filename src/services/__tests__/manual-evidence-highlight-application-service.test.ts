import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  agentRun: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
const buildCurrentRequestMock = vi.hoisted(() => vi.fn());
const startOnceMock = vi.hoisted(() => vi.fn());
const startWorkflowMock = vi.hoisted(() => vi.fn());
const cancelWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/manual-evidence-highlight-service", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/src/services/manual-evidence-highlight-service")
  >();
  return {
    ...original,
    buildCurrentManualEvidenceHighlightRequest: buildCurrentRequestMock,
  };
});
vi.mock("@/src/services/agent-run-workflow-start-service", () => ({
  startAgentRunWorkflowOnce: startOnceMock,
}));
vi.mock("workflow/api", () => ({
  start: startWorkflowMock,
  getRun: (workflowId: string) => ({
    cancel: () => cancelWorkflowMock(workflowId),
  }),
}));
vi.mock("@/workflows/manual-evidence-highlights", () => ({
  manualEvidenceHighlightWorkflow: vi.fn(),
}));

import { buildManualEvidenceHighlightRequest } from "@/src/services/manual-evidence-highlight-service";
import {
  manualEvidenceHighlightStartSucceeded,
  retryManualEvidenceHighlights,
  shouldStartManualEvidenceHighlightsForCreate,
  startManualEvidenceHighlights,
} from "@/src/services/manual-evidence-highlight-application-service";

function request(contentHash = "a".repeat(64)) {
  return buildManualEvidenceHighlightRequest({
    workItemId: "work-1",
    trigger: "manual_source_add",
    evidenceItems: [{
      id: "evidence-1",
      sourceId: "source-1",
      externalId: "manual-1",
      title: "Initial notes",
      content: contentHash,
      parentKind: "manual_note",
      parentKey: "source-1",
    }],
  });
}

function transactionClient(lockedRuns: unknown[] = []) {
  return {
    workItem: { findFirst: vi.fn().mockResolvedValue({ id: "work-1" }) },
    highlight: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    agentRun: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({
        id: "manual-run-new",
        workflowId: null,
        result: null,
        ...data,
      })),
      update: vi.fn().mockImplementation(({ where, data }) => Promise.resolve({
        id: where.id,
        workflowId: data.workflowId ?? null,
        status: data.status,
        request: request(),
      })),
    },
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "work-1" }])
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce(lockedRuns),
  };
}

describe("manual Evidence Highlight application service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    buildCurrentRequestMock.mockResolvedValue(request());
    startOnceMock.mockImplementation(async ({ startWorkflow }) => {
      await startWorkflow();
      return "workflow-new";
    });
    startWorkflowMock.mockResolvedValue({ runId: "workflow-new" });
    cancelWorkflowMock.mockResolvedValue(undefined);
    prismaMock.agentRun.findUnique.mockResolvedValue({ status: "queued" });
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 1 });
  });

  it("queues combined repository-plus-manual-note creates but leaves description-only repo ownership to refresh", () => {
    expect(shouldStartManualEvidenceHighlightsForCreate({
      hasManualNotes: true,
      repositoryQueued: true,
    })).toBe(true);
    expect(shouldStartManualEvidenceHighlightsForCreate({
      hasManualNotes: false,
      repositoryQueued: true,
    })).toBe(false);
    expect(shouldStartManualEvidenceHighlightsForCreate({
      hasManualNotes: false,
      repositoryQueued: false,
    })).toBe(true);
  });

  it("maps returned startup states to success banners without masking terminal failure", () => {
    expect(manualEvidenceHighlightStartSucceeded("queued")).toBe(true);
    expect(manualEvidenceHighlightStartSucceeded("running")).toBe(true);
    expect(manualEvidenceHighlightStartSucceeded("awaiting_review")).toBe(true);
    expect(manualEvidenceHighlightStartSucceeded("completed")).toBe(true);
    expect(manualEvidenceHighlightStartSucceeded("failed")).toBe(false);
    expect(manualEvidenceHighlightStartSucceeded("insufficient_context")).toBe(false);
    expect(manualEvidenceHighlightStartSucceeded("cancelled")).toBe(false);
  });

  it("reserves the AgentRun under Work Item and knowledge locks before starting workflow control", async () => {
    const tx = transactionClient();
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(startManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      trigger: "manual_source_add",
    })).resolves.toEqual({
      status: "queued",
      runId: "manual-run-new",
      workflowId: "workflow-new",
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.agentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        workItemId: "work-1",
        kind: "manual_evidence_highlights",
        status: "queued",
        request: expect.objectContaining({ inputFingerprint: expect.any(String) }),
      }),
    });
    expect(startOnceMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "manual-run-new",
    }));
  });

  it("terminalizes a stalled start as retryable instead of leaving a permanent queued reservation", async () => {
    vi.useFakeTimers();
    try {
      const tx = transactionClient();
      prismaMock.$transaction.mockImplementationOnce(
        async (callback: (client: typeof tx) => unknown) => callback(tx),
      );
      startOnceMock.mockReturnValueOnce(new Promise(() => undefined));
      prismaMock.agentRun.findUnique.mockResolvedValueOnce({
        status: "queued",
        workflowId: "starting:1786500000000:manual-start",
      });

      const pending = startManualEvidenceHighlights({
        userId: "user-1",
        workItemId: "work-1",
        trigger: "manual_source_add",
      });
      await vi.advanceTimersByTimeAsync(3_001);

      await expect(pending).resolves.toEqual({
        status: "failed",
        runId: "manual-run-new",
        workflowId: null,
      });
      expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith({
        where: {
          id: "manual-run-new",
          workflowId: "starting:1786500000000:manual-start",
          status: "queued",
        },
        data: expect.objectContaining({
          status: "failed",
          workflowId: null,
          error: expect.objectContaining({
            code: "manual_highlight_workflow_start_timeout",
            retryable: true,
            recovery: expect.stringContaining("Retry automatic Highlights"),
          }),
          finishedAt: expect.any(Date),
        }),
      });
      expect(startWorkflowMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes a prior active input as superseded and cancels only its attached workflow", async () => {
    const priorRequest = request("prior");
    const tx = transactionClient([{
      id: "manual-run-prior",
      status: "running",
      workflowId: "workflow-prior",
      request: priorRequest,
      result: null,
    }]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await startManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      trigger: "manual_source_add",
    });

    expect(tx.agentRun.update).toHaveBeenCalledWith({
      where: { id: "manual-run-prior" },
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ terminalOutcome: "superseded_input" }),
        finishedAt: expect.any(Date),
      }),
    });
    expect(cancelWorkflowMock).toHaveBeenCalledWith("workflow-prior");
    expect(tx.agentRun.create).toHaveBeenCalledOnce();
  });

  it("supersedes an active run without creating a replacement when no manual Evidence remains", async () => {
    buildCurrentRequestMock.mockResolvedValueOnce(null);
    const tx = transactionClient([{
      id: "manual-run-prior",
      status: "running",
      workflowId: "starting:123:reservation",
      request: request("prior"),
      result: null,
    }]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(startManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      trigger: "manual_evidence_change",
    })).resolves.toEqual({
      status: "completed",
      runId: expect.any(String),
      workflowId: null,
    });
    expect(tx.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ terminalOutcome: "superseded_input" }),
      }),
    }));
    expect(tx.agentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ terminalOutcome: "no_evidence" }),
      }),
    });
    expect(startOnceMock).not.toHaveBeenCalled();
    expect(cancelWorkflowMock).not.toHaveBeenCalled();
  });

  it("requeues a failed exact snapshot and preserves its prepared checkpoint for replay", async () => {
    const currentRequest = request();
    buildCurrentRequestMock.mockResolvedValue(currentRequest);
    const tx = transactionClient([{
      id: "manual-run-failed",
      status: "failed",
      workflowId: "workflow-failed",
      request: currentRequest,
      result: null,
    }]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(retryManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      runId: "manual-run-failed",
    })).resolves.toEqual({
      status: "queued",
      runId: "manual-run-failed",
      workflowId: "workflow-new",
    });

    expect(tx.agentRun.update).toHaveBeenCalledWith({
      where: { id: "manual-run-failed" },
      data: expect.objectContaining({
        status: "queued",
        workflowId: null,
        attemptNumber: { increment: 1 },
        startedAt: null,
        finishedAt: null,
      }),
    });
    const update = tx.agentRun.update.mock.calls[0]?.[0];
    expect(update.data).not.toHaveProperty("researchState");
    expect(startOnceMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "manual-run-failed",
    }));
  });

  it("reuses a newer exact-current run instead of reopening a crafted older retry", async () => {
    const currentRequest = request();
    buildCurrentRequestMock.mockResolvedValue(currentRequest);
    const tx = transactionClient([
      {
        id: "manual-run-old",
        status: "failed",
        workflowId: "workflow-old",
        request: currentRequest,
        result: null,
      },
      {
        id: "manual-run-current",
        status: "completed",
        workflowId: "workflow-current",
        request: currentRequest,
        result: { terminalOutcome: "ready" },
      },
    ]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(retryManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      runId: "manual-run-old",
    })).resolves.toEqual({
      status: "completed",
      runId: "manual-run-current",
      workflowId: "workflow-current",
    });
    expect(tx.agentRun.update).not.toHaveBeenCalled();
    expect(startOnceMock).not.toHaveBeenCalled();
  });

  it("reuses the durable empty-input sentinel on repeated no-Evidence reconciliation", async () => {
    buildCurrentRequestMock.mockResolvedValue(null);
    const emptyRequest = buildManualEvidenceHighlightRequest({
      workItemId: "work-1",
      trigger: "manual_evidence_change",
      evidenceItems: [],
    });
    const existing = {
      id: "manual-run-empty",
      status: "completed",
      workflowId: null,
      request: emptyRequest,
      result: { terminalOutcome: "no_evidence" },
    };
    const tx = transactionClient([existing]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(startManualEvidenceHighlights({
      userId: "user-1",
      workItemId: "work-1",
      trigger: "manual_evidence_change",
    })).resolves.toEqual({
      status: "completed",
      runId: "manual-run-empty",
      workflowId: null,
    });
    expect(tx.agentRun.create).not.toHaveBeenCalled();
    expect(tx.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "manual-run-empty" },
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ terminalOutcome: "no_evidence" }),
      }),
    }));
  });
});
