import { randomUUID } from "node:crypto";
import { getRun } from "workflow/api";
import { prisma } from "@/src/lib/prisma";

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startAgentRunWorkflowOnce(input: {
  runId: string;
  startWorkflow: () => Promise<{ runId: string }>;
}) {
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { workflowId: true },
  });
  if (current.workflowId && !current.workflowId.startsWith("starting:")) {
    return current.workflowId;
  }

  const reservation = `starting:${randomUUID()}`;
  const acquired = await prisma.agentRun.updateMany({
    where: {
      id: input.runId,
      workflowId: null,
      status: "queued",
    },
    data: { workflowId: reservation },
  });

  if (!acquired.count) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const existing = await prisma.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { workflowId: true, status: true },
      });
      if (existing.workflowId && !existing.workflowId.startsWith("starting:")) {
        return existing.workflowId;
      }
      if (existing.status !== "queued") {
        throw new Error(`Agent run cannot start from ${existing.status}.`);
      }
      await wait(25);
    }
    throw new Error("Another request is still starting this durable agent run.");
  }

  try {
    const workflow = await input.startWorkflow();
    const attached = await prisma.agentRun.updateMany({
      where: {
        id: input.runId,
        workflowId: reservation,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { workflowId: workflow.runId },
    });
    if (!attached.count) {
      await getRun(workflow.runId).cancel().catch(() => undefined);
      throw new Error("The agent run became terminal while its workflow was starting.");
    }
    return workflow.runId;
  } catch (error) {
    await prisma.agentRun.updateMany({
      where: { id: input.runId, workflowId: reservation, status: "queued" },
      data: { workflowId: null },
    });
    throw error;
  }
}
