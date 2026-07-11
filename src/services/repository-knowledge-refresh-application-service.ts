import { getRun, start } from "workflow/api";
import { prisma } from "@/src/lib/prisma";
import { startKnowledgeRefresh } from "@/src/services/knowledge-refresh-service";
import { repositoryKnowledgeRefreshWorkflow } from "@/workflows/project-chat";

export async function queueRepositoryKnowledgeRefresh(input: {
  userId: string;
  workItemId: string;
  trigger: "repository_attach" | "scheduled" | "manual" | "chat_freshness" | "backfill";
  idempotencyKey?: string;
}) {
  const refresh = await startKnowledgeRefresh(input);
  const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: refresh.runId } });
  if (current.status === "completed") {
    return { runId: current.id, workflowId: current.workflowId ?? `completed:${current.id}`, status: current.status };
  }
  if (current.workflowId && !current.workflowId.startsWith("starting:")) {
    return { runId: current.id, workflowId: current.workflowId, status: current.status };
  }
  const reservation = `starting:${crypto.randomUUID()}`;
  const claimed = await prisma.knowledgeRefreshRun.updateMany({
    where: { id: current.id, workflowId: null, status: "queued" },
    data: { workflowId: reservation },
  });
  if (!claimed.count) {
    const existing = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: current.id } });
    if (existing.workflowId && !existing.workflowId.startsWith("starting:")) {
      return { runId: existing.id, workflowId: existing.workflowId, status: existing.status };
    }
    throw new Error("The repository refresh is already starting.");
  }
  try {
    const workflow = await start(repositoryKnowledgeRefreshWorkflow, [current.id]);
    const updated = await prisma.knowledgeRefreshRun.updateMany({
      where: { id: current.id, workflowId: reservation },
      data: { workflowId: workflow.runId },
    });
    if (!updated.count) {
      await getRun(workflow.runId).cancel().catch(() => undefined);
      throw new Error("The repository refresh changed state while its workflow was starting.");
    }
    return { runId: current.id, workflowId: workflow.runId, status: current.status };
  } catch (error) {
    await prisma.knowledgeRefreshRun.updateMany({
      where: { id: current.id, workflowId: reservation },
      data: { workflowId: null },
    });
    throw error;
  }
}

export const repositoryKnowledgeRefreshApplicationService = {
  start: queueRepositoryKnowledgeRefresh,
};
