import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  agentRun: {
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const cancel = vi.hoisted(() => vi.fn());
const workflowStatus = vi.hoisted(() => vi.fn());
const failAgentRun = vi.hoisted(() => vi.fn());
const cancelActiveAgentRunPersistence = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("workflow/api", () => ({
  getRun: (runId: string) => ({
    cancel: () => cancel(runId),
    get status() {
      return workflowStatus(runId);
    },
  }),
}));
vi.mock("@/src/services/project-chat-store", () => ({
  cancelActiveAgentRunPersistence,
  failAgentRun,
}));

import {
  cancelAgentRunWorkflowSafely,
  recoverTerminalWorkflowForActiveAgentRun,
  startAgentRunWorkflowOnce,
} from "@/src/services/agent-run-workflow-start-service";

describe("startAgentRunWorkflowOnce", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workflowStatus.mockResolvedValue("running");
  });

  it("returns an attached workflow without starting a duplicate", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({ workflowId: "wrun-existing" });
    const startWorkflow = vi.fn();

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-existing");
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("reserves the run before starting and attaches the winner", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: null,
      status: "queued",
      updatedAt: new Date(),
    });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-new" });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-new");
    expect(startWorkflow).toHaveBeenCalledOnce();
    expect(prismaMock.agentRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ workflowId: null, status: "queued" }),
        data: { workflowId: expect.stringMatching(/^starting:/) },
      }),
    );
    expect(prismaMock.agentRun.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { workflowId: "wrun-new" } }),
    );
  });

  it("waits for and reuses the workflow attached by a concurrent starter", async () => {
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: `starting:${Date.now()}:winner`,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({ workflowId: "wrun-winner", status: "running" });
    const startWorkflow = vi.fn();

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-winner");
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("accepts delayed success when the started workflow self-attached first", async () => {
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-self-attached",
        status: "queued",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({
      runId: "wrun-self-attached",
    });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-self-attached");

    expect(cancel).not.toHaveBeenCalled();
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("cancels only its orphan and reuses a concurrently self-attached winner", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-winner",
        status: "queued",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({
      runId: "wrun-orphan",
    });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-winner");

    expect(cancel).toHaveBeenCalledOnce();
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous thrown start after the remote workflow self-attaches", async () => {
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-accepted-remotely",
        status: "queued",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockRejectedValue(
      new Error("transport timed out after remote acceptance"),
    );

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-accepted-remotely");

    expect(cancel).not.toHaveBeenCalled();
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("cancels an unattached workflow when the run becomes terminal during startup", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValue({
        workflowId: null,
        status: "cancelled",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-orphan" });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).rejects.toThrow("became terminal");
    expect(cancel).toHaveBeenCalledOnce();
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("cancels late remote acceptance after the application timeout fences the reservation as failed", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValue({
        workflowId: null,
        status: "failed",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({
      runId: "wrun-late-after-manual-timeout",
    });

    await expect(startAgentRunWorkflowOnce({
      runId: "manual-run-timeout",
      startWorkflow,
    })).rejects.toThrow("became terminal");
    expect(cancel).toHaveBeenCalledWith("wrun-late-after-manual-timeout");
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("cancels an accepted workflow when Work Item deletion removes its run before attachment", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockRejectedValue(new Error("AgentRun not found"));
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-delete-orphan" });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-deleted", startWorkflow }),
    ).rejects.toThrow("deleted while its workflow was starting");

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("wrun-delete-orphan");
    expect(failAgentRun).not.toHaveBeenCalled();
  });

  it("clears its temporary reservation and terminalizes the run when workflow startup fails", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: null,
      status: "queued",
      updatedAt: new Date(),
    });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).rejects.toThrow("provider unavailable");
    expect(prismaMock.agentRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "run-1",
        workflowId: expect.stringMatching(/^starting:/),
        status: "queued",
      }),
      data: { workflowId: null },
    }));
    expect(failAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      failure: expect.objectContaining({ stage: "workflow_start" }),
    }));
  });

  it("takes over a stale reservation with a compare-and-swap before starting", async () => {
    const staleReservation = `starting:${Date.now() - 60_000}:abandoned`;
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: staleReservation,
      status: "queued",
      updatedAt: new Date(Date.now() - 60_000),
    });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-recovered" });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-stale", startWorkflow }),
    ).resolves.toBe("wrun-recovered");

    expect(prismaMock.agentRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: "run-stale",
          workflowId: staleReservation,
          status: "queued",
        },
        data: { workflowId: expect.stringMatching(/^starting:\d+:/) },
      }),
    );
    expect(startWorkflow).toHaveBeenCalledOnce();
  });

  it("does not terminalize the winner when a stale starter loses its lease", async () => {
    cancel.mockResolvedValue(undefined);
    const displacedReservation = `starting:${Date.now() - 60_000}:starter-a`;
    const winnerReservation = `starting:${Date.now()}:starter-b`;
    prismaMock.agentRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: displacedReservation,
        status: "queued",
        updatedAt: new Date(Date.now() - 60_000),
      })
      .mockResolvedValueOnce({
        workflowId: winnerReservation,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-winner",
        status: "running",
        updatedAt: new Date(),
      });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-orphan" });

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-race", startWorkflow }),
    ).resolves.toBe("wrun-winner");

    expect(cancel).toHaveBeenCalledOnce();
    expect(failAgentRun).not.toHaveBeenCalled();
  });
});

describe("recoverTerminalWorkflowForActiveAgentRun", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workflowStatus.mockResolvedValue("failed");
  });

  it("replaces one terminal Workflow while keeping the same active product run", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: "wrun-failed",
      status: "running",
      attemptNumber: 0,
      workflowRecoveryCount: 0,
    });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-recovered" });

    await expect(recoverTerminalWorkflowForActiveAgentRun({
      runId: "run-1",
      startWorkflow,
    })).resolves.toEqual(expect.objectContaining({
      recovered: true,
      workflowId: "wrun-recovered",
      priorWorkflowId: "wrun-failed",
    }));
    expect(prismaMock.agentRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          workflowId: "wrun-failed",
          workflowRecoveryCount: 0,
        }),
        data: expect.objectContaining({
          workflowId: expect.stringMatching(/^starting:/),
          workflowRecoveryCount: { increment: 1 },
        }),
      }),
    );
    expect(startWorkflow).toHaveBeenCalledOnce();
  });

  it("recovers an awaiting-review artifact run independently of its batch number", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: "wrun-artifact-review",
      status: "awaiting_review",
      attemptNumber: 2,
      workflowRecoveryCount: 0,
    });
    prismaMock.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-artifact-recovered" });

    await expect(recoverTerminalWorkflowForActiveAgentRun({
      runId: "artifact-run-1",
      startWorkflow,
    })).resolves.toEqual(expect.objectContaining({
      recovered: true,
      workflowId: "wrun-artifact-recovered",
    }));
    expect(prismaMock.agentRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          workflowRecoveryCount: 0,
        }),
        data: expect.objectContaining({
          workflowRecoveryCount: { increment: 1 },
        }),
      }),
    );
  });

  it("fails visibly after the single automatic recovery is exhausted", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: "wrun-failed-again",
      status: "running",
      attemptNumber: 1,
      workflowRecoveryCount: 1,
    });
    failAgentRun.mockResolvedValue(undefined);

    await expect(recoverTerminalWorkflowForActiveAgentRun({
      runId: "run-1",
      startWorkflow: vi.fn(),
    })).resolves.toEqual({
      recovered: false,
      workflowId: "wrun-failed-again",
    });
    expect(failAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      failure: expect.objectContaining({
        code: "workflow_recovery_exhausted",
        retryable: true,
      }),
    }));
  });
});

describe("cancelAgentRunWorkflowSafely", () => {
  beforeEach(() => vi.resetAllMocks());

  it("terminalizes a scoped run with a temporary start reservation without treating it as a workflow ID", async () => {
    prismaMock.agentRun.findFirst
      .mockResolvedValueOnce({
        workflowId: "starting:1784487600000:starter-a",
        knowledgeRefreshRunId: "refresh-1",
      })
      .mockResolvedValueOnce({
        workflowId: "starting:1784487600000:starter-a",
      });
    cancelActiveAgentRunPersistence.mockResolvedValue({
      cancelled: true,
      status: "cancelled",
      workflowId: "starting:1784487600000:starter-a",
      knowledgeRefreshRunId: "refresh-1",
    });

    await expect(cancelAgentRunWorkflowSafely({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    })).resolves.toEqual({
      cancelled: true,
      status: "cancelled",
      workflowId: "starting:1784487600000:starter-a",
      workflowIds: [],
      workflowCancellationFailedIds: [],
      knowledgeRefreshRunId: "refresh-1",
    });

    expect(cancelActiveAgentRunPersistence).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a real workflow that self-attaches concurrently with the database transition", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.agentRun.findFirst
      .mockResolvedValueOnce({
        workflowId: "starting:1784487600000:starter-a",
        knowledgeRefreshRunId: null,
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-self-attached",
      });
    cancelActiveAgentRunPersistence.mockResolvedValue({
      cancelled: true,
      status: "cancelled",
      workflowId: "wrun-self-attached",
      knowledgeRefreshRunId: null,
    });

    await expect(cancelAgentRunWorkflowSafely({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    })).resolves.toMatchObject({
      cancelled: true,
      status: "cancelled",
      workflowIds: ["wrun-self-attached"],
      workflowCancellationFailedIds: [],
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("wrun-self-attached");
  });

  it("keeps cancellation authoritative when best-effort Workflow cleanup fails", async () => {
    cancel.mockRejectedValue(new Error("workflow control plane unavailable"));
    prismaMock.agentRun.findFirst
      .mockResolvedValueOnce({
        workflowId: "wrun-before",
        knowledgeRefreshRunId: null,
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-after",
      });
    cancelActiveAgentRunPersistence.mockResolvedValue({
      cancelled: true,
      status: "cancelled",
      workflowId: "wrun-during",
      knowledgeRefreshRunId: null,
    });

    await expect(cancelAgentRunWorkflowSafely({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
    })).resolves.toMatchObject({
      cancelled: true,
      workflowIds: ["wrun-before", "wrun-during", "wrun-after"],
      workflowCancellationFailedIds: [
        "wrun-before",
        "wrun-during",
        "wrun-after",
      ],
    });
  });
});
