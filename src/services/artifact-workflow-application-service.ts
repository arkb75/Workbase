import { start } from "workflow/api";
import type { ArtifactWorkflowService } from "@/src/services/types";
import { prisma } from "@/src/lib/prisma";
import {
  createProjectChatRun,
  createProjectChatThread,
} from "@/src/services/project-chat-store";
import { startAgentRunWorkflowOnce } from "@/src/services/agent-run-workflow-start-service";
import { artifactGenerationWorkflow } from "@/workflows/project-chat";

export async function startArtifactWorkflow(
  input: Parameters<ArtifactWorkflowService["start"]>[0],
) {
  const existing = await prisma.agentRun.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (
      existing.workItemId !== input.workItemId ||
      existing.kind !== "artifact_workflow" ||
      !existing.threadId
    ) {
      throw new Error("The artifact idempotency key is already bound to another request.");
    }
  }

  const thread = existing?.threadId
    ? { id: existing.threadId }
    : input.threadId
    ? { id: input.threadId }
    : await createProjectChatThread({
        userId: input.userId,
        workItemId: input.workItemId,
        title: `Artifact · ${input.brief.slice(0, 56)}`,
      });
  const run =
    existing ??
    (await createProjectChatRun({
      userId: input.userId,
      workItemId: input.workItemId,
      threadId: thread.id,
      message: input.brief,
      idempotencyKey: input.idempotencyKey,
      kind: "artifact_workflow",
    }));
  if (input.supersedesArtifactId) {
    const predecessor = await prisma.artifact.findFirst({
      where: { id: input.supersedesArtifactId, userId: input.userId, workItemId: input.workItemId },
      select: { id: true },
    });
    if (!predecessor) throw new Error("The stale Artifact is not available for refresh.");
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { request: { message: input.brief, brief: input.brief, supersedesArtifactId: predecessor.id } },
    });
  }
  const workflowId = await startAgentRunWorkflowOnce({
    runId: run.id,
    startWorkflow: () => start(artifactGenerationWorkflow, [run.id]),
  });

  return {
    status: "queued" as const,
    runId: run.id,
    threadId: thread.id,
    workflowId,
  };
}

export const artifactWorkflowService: ArtifactWorkflowService = {
  start: startArtifactWorkflow,
};
