import { getRun } from "workflow/api";
import { prisma } from "@/src/lib/prisma";

const ACTIVE_AGENT_RUN_STATUSES = ["queued", "running", "awaiting_review"] as const;
const ACTIVE_REFRESH_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;

export async function deleteWorkItemForUser(input: {
  userId: string;
  workItemId: string;
}) {
  const workItem = await prisma.workItem.findFirst({
    where: {
      id: input.workItemId,
      userId: input.userId,
    },
    select: {
      id: true,
      agentRuns: {
        where: { status: { in: [...ACTIVE_AGENT_RUN_STATUSES] } },
        select: { workflowId: true },
      },
      knowledgeRefreshRuns: {
        where: { status: { in: [...ACTIVE_REFRESH_STATUSES] } },
        select: { workflowId: true },
      },
    },
  });

  if (!workItem) return { deleted: false } as const;

  const workflowIds = Array.from(new Set([
    ...workItem.agentRuns.map((run) => run.workflowId),
    ...workItem.knowledgeRefreshRuns.map((run) => run.workflowId),
  ].filter((workflowId): workflowId is string => Boolean(workflowId))));

  if (workflowIds.some((workflowId) => workflowId.startsWith("starting:"))) {
    throw new Error("A workflow is still starting for this Work Item. Wait a moment and try deleting it again.");
  }

  for (const workflowId of workflowIds) {
    try {
      await getRun(workflowId).cancel();
    } catch (error) {
      throw new Error(
        `Work Item deletion stopped because an active workflow could not be cancelled. ${
          error instanceof Error ? error.message : "Try again shortly."
        }`,
      );
    }
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const owned = await tx.workItem.findFirst({
      where: { id: workItem.id, userId: input.userId },
      select: { id: true },
    });
    if (!owned) return false;

    // Artifacts intentionally allow a null Work Item for imported/global
    // history. A project deletion is explicit, so remove this project's
    // artifacts instead of silently leaving detached records behind.
    // Delete citations explicitly before the Work Item cascade. Chat messages
    // can be reached through both threads and agent runs, and PostgreSQL's
    // overlapping cascade paths otherwise fail on large, citation-heavy items.
    await tx.chatCitation.deleteMany({
      where: { message: { thread: { workItemId: owned.id } } },
    });
    await tx.artifact.deleteMany({ where: { workItemId: owned.id } });
    const result = await tx.workItem.deleteMany({
      where: { id: owned.id, userId: input.userId },
    });
    return result.count === 1;
  });

  return { deleted } as const;
}
