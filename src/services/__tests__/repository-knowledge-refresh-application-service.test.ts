import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  knowledgeRefreshRun: {
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const cancel = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("workflow/api", () => ({
  getRun: (runId: string) => ({ cancel: () => cancel(runId) }),
  start: vi.fn(),
}));
vi.mock("@/src/services/knowledge-refresh-service", () => ({
  startKnowledgeRefresh: vi.fn(),
}));
vi.mock("@/workflows/project-chat", () => ({
  repositoryKnowledgeRefreshWorkflow: vi.fn(),
}));

import {
  knowledgeRefreshWorkflowReservationIsStale,
  startKnowledgeRefreshWorkflowOnce,
} from "@/src/services/repository-knowledge-refresh-application-service";

describe("startKnowledgeRefreshWorkflowOnce", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns an attached workflow without starting duplicate repository work", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: "wrun-existing",
      status: "analyzing",
      updatedAt: new Date(),
    });
    const startWorkflow = vi.fn();

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-1",
      startWorkflow,
    })).resolves.toBe("wrun-existing");

    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("protects terminal refreshes even when they retain a historical workflow ID", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: "wrun-completed-history",
      status: "cancelled",
      updatedAt: new Date(),
    });
    const startWorkflow = vi.fn();

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-cancelled",
      startWorkflow,
    })).rejects.toThrow("cannot start from cancelled");

    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("reserves before start and attaches the resulting workflow", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: null,
      status: "queued",
      updatedAt: new Date(),
    });
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-new" });

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-1",
      startWorkflow,
    })).resolves.toBe("wrun-new");

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "refresh-1", workflowId: null, status: "queued" },
        data: { workflowId: expect.stringMatching(/^starting:\d+:/) },
      }),
    );
    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { workflowId: "wrun-new" } }),
    );
  });

  it("reuses the workflow attached by a concurrent starter", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: `starting:${Date.now()}:winner`,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-winner",
        status: "inventorying",
        updatedAt: new Date(),
      });
    const startWorkflow = vi.fn();

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-race",
      startWorkflow,
    })).resolves.toBe("wrun-winner");

    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("takes over an expired start reservation instead of leaving it permanent", async () => {
    const staleReservation = `starting:${Date.now() - 60_000}:abandoned`;
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow.mockResolvedValue({
      workflowId: staleReservation,
      status: "queued",
      updatedAt: new Date(Date.now() - 60_000),
    });
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-recovered" });

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-stale",
      startWorkflow,
    })).resolves.toBe("wrun-recovered");

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: "refresh-stale",
          workflowId: staleReservation,
          status: "queued",
        },
      }),
    );
  });

  it("recovers when start throws after the accepted workflow self-attaches", async () => {
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
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
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockRejectedValue(
      new Error("transport timed out after remote acceptance"),
    );

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-ambiguous",
      startWorkflow,
    })).resolves.toBe("wrun-accepted-remotely");

    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels only its orphan when another workflow wins attachment", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        workflowId: "wrun-winner",
        status: "inventorying",
        updatedAt: new Date(),
      });
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-orphan" });

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-race",
      startWorkflow,
    })).resolves.toBe("wrun-winner");

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("wrun-orphan");
  });

  it("cancels a launched orphan when cancellation wins before attachment", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
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
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({ runId: "wrun-orphan" });

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-cancelled",
      startWorkflow,
    })).rejects.toThrow("became terminal");

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("wrun-orphan");
  });

  it("cancels an accepted workflow when Work Item deletion removes the refresh before attachment", async () => {
    cancel.mockResolvedValue(undefined);
    prismaMock.knowledgeRefreshRun.findUniqueOrThrow
      .mockResolvedValueOnce({
        workflowId: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .mockRejectedValue(new Error("KnowledgeRefreshRun not found"));
    prismaMock.knowledgeRefreshRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const startWorkflow = vi.fn().mockResolvedValue({
      runId: "wrun-delete-orphan",
    });

    await expect(startKnowledgeRefreshWorkflowOnce({
      runId: "refresh-deleted",
      startWorkflow,
    })).rejects.toThrow("became terminal");

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("wrun-delete-orphan");
  });

  it("uses updatedAt to age legacy reservations that lack an encoded timestamp", () => {
    expect(knowledgeRefreshWorkflowReservationIsStale({
      workflowId: "starting:legacy-reservation",
      updatedAt: new Date(Date.now() - 60_000),
    })).toBe(true);
    expect(knowledgeRefreshWorkflowReservationIsStale({
      workflowId: "starting:legacy-reservation",
      updatedAt: new Date(),
    })).toBe(false);
  });
});
