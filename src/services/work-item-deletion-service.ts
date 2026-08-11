import { getRun } from "workflow/api";
import {
  mergeRepositoryImportMetadata,
  readRepositoryImportState,
  repositoryImportIsActive,
} from "@/src/lib/github-repository-import-state";
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

function cancellableWorkflowId(value: string | null | undefined) {
  if (
    !value ||
    value.startsWith("starting:") ||
    value.startsWith("inline-agent:") ||
    value.startsWith("completed:")
  ) {
    return null;
  }
  return value;
}

function repositoryWorkflowIds(metadata: unknown) {
  const state = readRepositoryImportState(metadata);
  return [state?.workflowId ?? null, state?.refreshWorkflowId ?? null];
}

export async function deleteWorkItemForUser(input: {
  userId: string;
  workItemId: string;
}) {
  // This inexpensive ownership check avoids opening a transaction for an ID
  // the caller cannot delete. Ownership is checked again behind the row lock;
  // this read is never used as the authoritative admission decision.
  const requestedWorkItem = await prisma.workItem.findFirst({
    where: {
      id: input.workItemId,
      userId: input.userId,
    },
    select: { id: true },
  });
  if (!requestedWorkItem) return { deleted: false } as const;

  const fenced = await prisma.$transaction(async (tx) => {
    // This is the admission fence. Inserts of WorkItem-owned rows need a
    // foreign-key key-share lock, so they wait until this transaction commits
    // the cascade and then fail against the deleted identity.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WorkItem" WHERE "id" = ${requestedWorkItem.id} FOR UPDATE
    `;
    if (!locked.length) {
      return { deleted: false, workflowIds: [] as string[] };
    }

    const owned = await tx.workItem.findFirst({
      where: { id: requestedWorkItem.id, userId: input.userId },
      select: { id: true },
    });
    if (!owned) {
      return { deleted: false, workflowIds: [] as string[] };
    }

    // Import workflow IDs are attached under a Source row lock. Taking the
    // same lock before observing their durable state means either the exact ID
    // is included below or a post-delete attachment observes a missing Source
    // and cancels its newly accepted workflow.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Source"
      WHERE "workItemId" = ${owned.id} AND "type" = 'github_repo'
      FOR UPDATE
    `;

    const agentRuns = await tx.agentRun.findMany({
      where: {
        workItemId: owned.id,
        status: { in: [...ACTIVE_AGENT_RUN_STATUSES] },
      },
      select: { id: true, workflowId: true },
    });
    const refreshRuns = await tx.knowledgeRefreshRun.findMany({
      where: {
        workItemId: owned.id,
        status: { in: [...ACTIVE_REFRESH_STATUSES] },
      },
      select: { id: true, workflowId: true },
    });
    const sources = await tx.source.findMany({
      where: { workItemId: owned.id, type: "github_repo" },
      select: { id: true, metadata: true },
    });

    const now = new Date();
    const agentRunIds = agentRuns.map((run) => run.id);
    if (agentRunIds.length) {
      // Terminalizing first closes both queued-without-ID and temporary
      // `starting:` reservations. Workflow attachment CAS operations accept
      // active statuses only, so they cannot become durable after this write.
      await tx.agentRun.updateMany({
        where: {
          id: { in: agentRunIds },
          status: { in: [...ACTIVE_AGENT_RUN_STATUSES] },
        },
        data: { status: "cancelled", finishedAt: now },
      });
    }

    const refreshRunIds = refreshRuns.map((run) => run.id);
    if (refreshRunIds.length) {
      await tx.knowledgeRefreshRun.updateMany({
        where: {
          id: { in: refreshRunIds },
          status: { in: [...ACTIVE_REFRESH_STATUSES] },
        },
        data: { status: "cancelled", finishedAt: now },
      });
    }

    for (const source of sources) {
      const state = readRepositoryImportState(source.metadata);
      if (!repositoryImportIsActive(state) || !state) continue;
      await tx.source.update({
        where: { id: source.id },
        data: {
          metadata: mergeRepositoryImportMetadata(source.metadata, {
            ...state,
            status: "cancelled",
            finishedAt: now.toISOString(),
            error: "The Work Item was deleted while repository import was active.",
          }),
        },
      });
    }

    // Preserve the IDs observed before fencing (a recovery can temporarily
    // replace one with `starting:`) and re-read after fencing to capture an
    // exact ID that attached immediately before the terminal transition.
    const fencedAgentRuns = agentRunIds.length
      ? await tx.agentRun.findMany({
          where: { id: { in: agentRunIds } },
          select: { workflowId: true },
        })
      : [];
    const fencedRefreshRuns = refreshRunIds.length
      ? await tx.knowledgeRefreshRun.findMany({
          where: { id: { in: refreshRunIds } },
          select: { workflowId: true },
        })
      : [];
    const fencedSources = sources.length
      ? await tx.source.findMany({
          where: { id: { in: sources.map((source) => source.id) } },
          select: { metadata: true },
        })
      : [];

    const workflowIds = Array.from(new Set([
      ...agentRuns.map((run) => run.workflowId),
      ...refreshRuns.map((run) => run.workflowId),
      ...sources.flatMap((source) => repositoryWorkflowIds(source.metadata)),
      ...fencedAgentRuns.map((run) => run.workflowId),
      ...fencedRefreshRuns.map((run) => run.workflowId),
      ...fencedSources.flatMap((source) => repositoryWorkflowIds(source.metadata)),
    ].map(cancellableWorkflowId).filter((id): id is string => Boolean(id))));

    // Artifacts intentionally allow a null Work Item for imported/global
    // history. A project deletion is explicit, so remove this project's
    // artifacts rather than letting the relation's SetNull retain them.
    // ChatCitation leaves are deleted first because the same citation graph
    // can be reached through both threads and agent runs, and PostgreSQL's
    // overlapping cascade paths otherwise fail on large, citation-heavy items.
    await tx.chatCitation.deleteMany({
      where: { message: { thread: { workItemId: owned.id } } },
    });
    await tx.artifact.deleteMany({ where: { workItemId: owned.id } });
    const result = await tx.workItem.deleteMany({
      where: { id: owned.id, userId: input.userId },
    });
    return { deleted: result.count === 1, workflowIds };
  }, { timeout: 15_000 });

  if (!fenced.deleted) return { deleted: false } as const;

  // The database transition is authoritative. Remote Workflow cancellation is
  // cleanup after commit: provider unavailability must never reopen admission
  // or roll back a completed deletion.
  await Promise.allSettled(
    fenced.workflowIds.map(async (workflowId) => {
      await getRun(workflowId).cancel();
    }),
  );

  return { deleted: true } as const;
}
