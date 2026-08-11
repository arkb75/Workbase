import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { prisma } from "@/src/lib/prisma";
import { startKnowledgeRefresh } from "@/src/services/knowledge-refresh-service";
import { repositoryKnowledgeRefreshWorkflow } from "@/workflows/project-chat";

const TERMINAL_REFRESH_STATUSES = ["completed", "failed", "cancelled"] as const;
const ACTIVE_REFRESH_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;

export const KNOWLEDGE_REFRESH_WORKFLOW_RESERVATION_LEASE_MS = 30_000;
const KNOWLEDGE_REFRESH_WORKFLOW_ATTACH_WAIT_MS = 10_000;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workflowStartReservation(now = Date.now()) {
  return `starting:${now}:${randomUUID()}`;
}

export function knowledgeRefreshWorkflowReservationIsStale(input: {
  workflowId: string | null;
  updatedAt?: Date | null;
  now?: number;
}) {
  if (!input.workflowId?.startsWith("starting:")) return false;
  const encoded = Number(input.workflowId.split(":")[1]);
  const timestamp = Number.isFinite(encoded) && encoded > 0
    ? encoded
    : input.updatedAt?.getTime();
  return timestamp == null ||
    (input.now ?? Date.now()) - timestamp >=
      KNOWLEDGE_REFRESH_WORKFLOW_RESERVATION_LEASE_MS;
}

function attachedWorkflowId(workflowId: string | null) {
  return workflowId && !workflowId.startsWith("starting:") ? workflowId : null;
}

function isTerminalRefreshStatus(status: string) {
  return TERMINAL_REFRESH_STATUSES.includes(
    status as (typeof TERMINAL_REFRESH_STATUSES)[number],
  );
}

async function waitForAttachedKnowledgeRefreshWorkflow(runId: string) {
  const waitStartedAt = Date.now();
  let attempt = 0;
  while (Date.now() - waitStartedAt < KNOWLEDGE_REFRESH_WORKFLOW_ATTACH_WAIT_MS) {
    const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: runId },
      select: { workflowId: true, status: true, updatedAt: true },
    }).catch(() => null);
    // Deletion cascades this row after terminalizing it, so absence is a
    // completed ownership fence rather than a workflow attachment to await.
    if (!current) return null;
    const attached = attachedWorkflowId(current.workflowId);
    if (attached) return attached;
    if (isTerminalRefreshStatus(current.status) || current.workflowId == null) {
      return null;
    }
    const delay = Math.min(250, 25 + attempt * 25);
    attempt += 1;
    await wait(delay);
  }
  return null;
}

/**
 * Starts at most one durable Workflow execution for a persisted repository
 * refresh. The temporary reservation is a renewable lease rather than a
 * permanent state: a later request can recover a process crash before start(),
 * while the workflow itself atomically attaches its exact run ID before doing
 * repository or model work.
 */
export async function startKnowledgeRefreshWorkflowOnce(input: {
  runId: string;
  startWorkflow: () => Promise<{ runId: string }>;
}) {
  const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { workflowId: true, status: true, updatedAt: true },
  });
  if (isTerminalRefreshStatus(current.status)) {
    throw new Error(`Repository refresh cannot start from ${current.status}.`);
  }
  const currentAttached = attachedWorkflowId(current.workflowId);
  if (currentAttached) return currentAttached;
  if (current.status !== "queued") {
    throw new Error(
      `Repository refresh ${input.runId} is ${current.status} without an attached execution.`,
    );
  }

  let reservation = workflowStartReservation();
  const claimReservation = (expectedWorkflowId: string | null) =>
    prisma.knowledgeRefreshRun.updateMany({
      where: {
        id: input.runId,
        workflowId: expectedWorkflowId,
        status: "queued",
      },
      data: { workflowId: reservation },
    });
  let acquired = (
    current.workflowId == null || knowledgeRefreshWorkflowReservationIsStale(current)
      ? await claimReservation(current.workflowId)
      : { count: 0 }
  );

  if (!acquired.count) {
    const waitStartedAt = Date.now();
    let attempt = 0;
    while (Date.now() - waitStartedAt < KNOWLEDGE_REFRESH_WORKFLOW_ATTACH_WAIT_MS) {
      const existing = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { workflowId: true, status: true, updatedAt: true },
      });
      const existingAttached = attachedWorkflowId(existing.workflowId);
      if (existingAttached) return existingAttached;
      if (isTerminalRefreshStatus(existing.status)) {
        throw new Error(`Repository refresh cannot start from ${existing.status}.`);
      }
      if (existing.status !== "queued") {
        throw new Error(
          `Repository refresh ${input.runId} is ${existing.status} without an attached execution.`,
        );
      }
      if (knowledgeRefreshWorkflowReservationIsStale(existing)) {
        reservation = workflowStartReservation();
        acquired = await claimReservation(existing.workflowId);
        if (acquired.count) break;
      }
      const delay = Math.min(250, 25 + attempt * 25);
      attempt += 1;
      await wait(delay);
    }
    if (!acquired.count) {
      throw new Error(
        "Another request is still starting this repository refresh. Retry shortly to reuse the attached workflow.",
      );
    }
  }

  let startedWorkflowId: string | null = null;
  try {
    const workflow = await input.startWorkflow();
    startedWorkflowId = workflow.runId;
    const attached = await prisma.knowledgeRefreshRun.updateMany({
      where: {
        id: input.runId,
        workflowId: reservation,
        status: { in: [...ACTIVE_REFRESH_STATUSES] },
      },
      data: { workflowId: workflow.runId },
    });
    if (attached.count) return workflow.runId;

    const winner = await waitForAttachedKnowledgeRefreshWorkflow(input.runId);
    if (winner === workflow.runId) {
      // The workflow's pre-work handshake attached itself before start()
      // returned to this process.
      return workflow.runId;
    }
    if (winner) {
      await getRun(workflow.runId).cancel().catch(() => undefined);
      return winner;
    }
    throw new Error(
      "The repository refresh became terminal while its workflow was starting.",
    );
  } catch (error) {
    const released = await prisma.knowledgeRefreshRun.updateMany({
      where: {
        id: input.runId,
        workflowId: reservation,
        status: "queued",
      },
      data: { workflowId: null },
    }).catch(() => ({ count: 0 }));
    if (!released.count) {
      // start() may throw after the control plane accepted the run. The
      // workflow's exact-ID handshake is the durable acknowledgement.
      const winner = await waitForAttachedKnowledgeRefreshWorkflow(input.runId);
      if (winner) {
        if (startedWorkflowId && startedWorkflowId !== winner) {
          await getRun(startedWorkflowId).cancel().catch(() => undefined);
        }
        return winner;
      }
    }
    // If start() returned an exact ID but the active refresh owner disappeared
    // (including a Work Item deletion), the accepted run is now an orphan.
    if (startedWorkflowId) {
      await getRun(startedWorkflowId).cancel().catch(() => undefined);
    }
    throw error;
  }
}

export async function queueRepositoryKnowledgeRefresh(input: {
  userId: string;
  workItemId: string;
  trigger: "repository_attach" | "webhook_push" | "scheduled" | "manual" | "chat_freshness" | "backfill";
  idempotencyKey?: string;
}) {
  const refresh = await startKnowledgeRefresh(input);
  const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: refresh.runId },
    select: { id: true, status: true, workflowId: true },
  });
  if (current.status === "completed") {
    return {
      runId: current.id,
      workflowId: current.workflowId ?? `completed:${current.id}`,
      status: current.status,
    };
  }
  const workflowId = await startKnowledgeRefreshWorkflowOnce({
    runId: current.id,
    startWorkflow: () => start(repositoryKnowledgeRefreshWorkflow, [current.id]),
  });
  const latest = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: current.id },
    select: { status: true },
  });
  return { runId: current.id, workflowId, status: latest.status };
}

export const repositoryKnowledgeRefreshApplicationService = {
  start: queueRepositoryKnowledgeRefresh,
};
