import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  agentRun: {
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const cancel = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("workflow/api", () => ({
  getRun: () => ({ cancel }),
}));

import { startAgentRunWorkflowOnce } from "@/src/services/agent-run-workflow-start-service";

describe("startAgentRunWorkflowOnce", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns an attached workflow without starting a duplicate", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({ workflowId: "wrun-existing" });
    const startWorkflow = vi.fn();

    await expect(
      startAgentRunWorkflowOnce({ runId: "run-1", startWorkflow }),
    ).resolves.toBe("wrun-existing");
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("reserves the run before starting and attaches the winner", async () => {
    prismaMock.agentRun.findUniqueOrThrow.mockResolvedValue({ workflowId: null });
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
});
