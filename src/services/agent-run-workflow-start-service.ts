import { randomUUID } from "node:crypto";
import { getRun } from "workflow/api";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { prisma } from "@/src/lib/prisma";
import {
  cancelActiveAgentRunPersistence,
  failAgentRun,
} from "@/src/services/project-chat-store";

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const AGENT_RUN_WORKFLOW_RESERVATION_LEASE_MS = 30_000;
const AGENT_RUN_WORKFLOW_ATTACH_WAIT_MS = 10_000;
const MAX_AUTOMATIC_WORKFLOW_RECOVERIES = 1;

function workflowStartReservation(now = Date.now()) {
  return `starting:${now}:${randomUUID()}`;
}

async function waitForDisplacingWorkflow(input: {
  runId: string;
  displacedReservation: string;
}) {
  const waitStartedAt = Date.now();
  let attempt = 0;
  while (Date.now() - waitStartedAt < AGENT_RUN_WORKFLOW_ATTACH_WAIT_MS) {
    const current = await prisma.agentRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { workflowId: true, status: true, updatedAt: true },
    }).catch(() => null);
    // Work Item deletion cascades AgentRun after first terminalizing it. A
    // missing row is therefore a valid fence outcome, not a reason to keep
    // waiting for a workflow attachment that can no longer be admitted.
    if (!current) return null;
    if (current.workflowId && !current.workflowId.startsWith("starting:")) {
      return current.workflowId;
    }
    if (
      current.status !== "queued" ||
      current.workflowId == null
    ) {
      return null;
    }
    const delay = Math.min(250, 25 + attempt * 25);
    attempt += 1;
    await wait(delay);
  }
  return null;
}

export function workflowStartReservationIsStale(input: {
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
    (input.now ?? Date.now()) - timestamp >= AGENT_RUN_WORKFLOW_RESERVATION_LEASE_MS;
}

export async function startAgentRunWorkflowOnce(input: {
  runId: string;
  startWorkflow: () => Promise<{ runId: string }>;
}) {
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { workflowId: true, status: true, updatedAt: true },
  });
  if (current.workflowId && !current.workflowId.startsWith("starting:")) {
    return current.workflowId;
  }
  if (current.status !== "queued") {
    throw new Error(`Agent run cannot start from ${current.status}.`);
  }

  let reservation = workflowStartReservation();
  const claimReservation = (expectedWorkflowId: string | null) =>
    prisma.agentRun.updateMany({
      where: {
        id: input.runId,
        workflowId: expectedWorkflowId,
        status: "queued",
      },
      data: { workflowId: reservation },
    });
  let acquired = (
    current.workflowId == null ||
    workflowStartReservationIsStale(current)
      ? await claimReservation(current.workflowId)
      : { count: 0 }
  );

  if (!acquired.count) {
    const waitStartedAt = Date.now();
    let attempt = 0;
    while (Date.now() - waitStartedAt < AGENT_RUN_WORKFLOW_ATTACH_WAIT_MS) {
      const existing = await prisma.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { workflowId: true, status: true, updatedAt: true },
      });
      if (existing.workflowId && !existing.workflowId.startsWith("starting:")) {
        return existing.workflowId;
      }
      if (existing.status !== "queued") {
        throw new Error(`Agent run cannot start from ${existing.status}.`);
      }
      if (workflowStartReservationIsStale(existing)) {
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
        "Another request is still starting this durable agent run. Retry shortly to reuse the attached workflow.",
      );
    }
  }

  let startedWorkflowId: string | null = null;
  try {
    const workflow = await input.startWorkflow();
    startedWorkflowId = workflow.runId;
    const attached = await prisma.agentRun.updateMany({
      where: {
        id: input.runId,
        workflowId: reservation,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { workflowId: workflow.runId },
    });
    if (!attached.count) {
      const current = await prisma.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { workflowId: true, status: true, updatedAt: true },
      }).catch(() => null);
      if (!current) {
        throw new Error("The agent run was deleted while its workflow was starting.");
      }
      const winner =
        current.workflowId && !current.workflowId.startsWith("starting:")
          ? current.workflowId
          : current.status === "queued" && current.workflowId
            ? await waitForDisplacingWorkflow({
                runId: input.runId,
                displacedReservation: reservation,
              })
            : null;
      if (winner === workflow.runId) {
        // The workflow's pre-work ownership handshake attached itself before
        // this caller completed its post-start compare-and-swap.
        return workflow.runId;
      }
      if (winner) {
        // A concurrent workflow won. This launched workflow is the orphan, so
        // cancel only it and reuse the durable winner already on the AgentRun.
        await getRun(workflow.runId).cancel().catch(() => undefined);
        return winner;
      }
      throw new Error("The agent run became terminal while its workflow was starting.");
    }
    return workflow.runId;
  } catch (error) {
    const released = await prisma.agentRun.updateMany({
      where: { id: input.runId, workflowId: reservation, status: "queued" },
      data: { workflowId: null },
    }).catch(() => ({ count: 0 }));
    if (!released.count) {
      const winner = await waitForDisplacingWorkflow({
        runId: input.runId,
        displacedReservation: reservation,
      });
      if (winner) {
        if (startedWorkflowId && startedWorkflowId !== winner) {
          await getRun(startedWorkflowId).cancel().catch(() => undefined);
        }
        return winner;
      }
    }
    // start() returned an accepted run, but no durable active owner remains.
    // This includes Work Item deletion winning between remote acceptance and
    // the exact-ID attachment CAS. Cancel the known orphan best-effort.
    if (startedWorkflowId) {
      await getRun(startedWorkflowId).cancel().catch(() => undefined);
    }
    if (!released.count) {
      throw error;
    }
    const failure = classifyWorkflowFailure(error);
    await Promise.resolve(
      failAgentRun({
        runId: input.runId,
        message: failure.message,
        failure: {
          code: failure.code,
          stage: "workflow_start",
          retryable: failure.retryable,
          recovery: failure.recovery,
        },
      }),
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * Repairs the narrow failure mode where the durable runtime is terminal but
 * Workbase's product run is still active (for example, a local Workflow step
 * registry changed after the database commit but before the step response was
 * acknowledged). Normal application failures terminalize AgentRun inside the
 * workflow and never enter this path.
 */
export async function recoverTerminalWorkflowForActiveAgentRun(input: {
  runId: string;
  startWorkflow: () => Promise<{ runId: string }>;
}) {
  const current = await prisma.agentRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: {
      workflowId: true,
      status: true,
      workflowRecoveryCount: true,
    },
  });
  const active = ["queued", "running", "awaiting_review"].includes(current.status);
  const priorWorkflowId = attachedWorkflowId(current.workflowId);
  if (!active || !priorWorkflowId) {
    return { recovered: false as const, workflowId: priorWorkflowId };
  }
  let workflowStatus: string;
  try {
    workflowStatus = await getRun(priorWorkflowId).status;
  } catch {
    workflowStatus = "missing";
  }
  if (!["completed", "failed", "cancelled", "missing"].includes(workflowStatus)) {
    return { recovered: false as const, workflowId: priorWorkflowId };
  }
  if (current.workflowRecoveryCount >= MAX_AUTOMATIC_WORKFLOW_RECOVERIES) {
    await failAgentRun({
      runId: input.runId,
      message: "The durable run stopped before Workbase could finalize its persisted result. Retry the request to start a clean run.",
      failure: {
        code: "workflow_recovery_exhausted",
        stage: "workflow_recovery",
        retryable: true,
        recovery: "Retry the request; completed repository refresh work will be reused.",
      },
    });
    return { recovered: false as const, workflowId: priorWorkflowId };
  }

  const reservation = workflowStartReservation();
  const reserved = await prisma.agentRun.updateMany({
    where: {
      id: input.runId,
      workflowId: priorWorkflowId,
      status: { in: ["queued", "running", "awaiting_review"] },
      workflowRecoveryCount: current.workflowRecoveryCount,
    },
    data: {
      workflowId: reservation,
      workflowRecoveryCount: { increment: 1 },
    },
  });
  if (!reserved.count) {
    const winner = await prisma.agentRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { workflowId: true },
    });
    return {
      recovered: false as const,
      workflowId: attachedWorkflowId(winner.workflowId),
    };
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
      const winner = await prisma.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { workflowId: true },
      });
      return {
        recovered: false as const,
        workflowId: attachedWorkflowId(winner.workflowId),
      };
    }
    return {
      recovered: true as const,
      workflowId: workflow.runId,
      priorWorkflowId,
      priorWorkflowStatus: workflowStatus,
    };
  } catch (error) {
    await prisma.agentRun.updateMany({
      where: { id: input.runId, workflowId: reservation },
      data: { workflowId: null },
    });
    const failure = classifyWorkflowFailure(error);
    await failAgentRun({
      runId: input.runId,
      message: failure.message,
      failure: {
        code: failure.code,
        stage: "workflow_recovery",
        retryable: failure.retryable,
        recovery: failure.recovery,
      },
    }).catch(() => undefined);
    throw error;
  }
}

function attachedWorkflowId(value: string | null | undefined) {
  return value && !value.startsWith("starting:") ? value : null;
}

/**
 * Cancellation is authoritative in Workbase's database. Workflow cancellation
 * is best-effort cleanup performed only after the scoped AgentRun has been
 * terminalized, so a temporary start reservation or unavailable Workflow API
 * cannot leave the product run active.
 */
export async function cancelAgentRunWorkflowSafely(input: {
  runId: string;
  userId: string;
  workItemId: string;
}) {
  const before = await prisma.agentRun.findFirst({
    where: {
      id: input.runId,
      userId: input.userId,
      workItemId: input.workItemId,
    },
    select: {
      workflowId: true,
      knowledgeRefreshRunId: true,
    },
  });
  if (!before) {
    return {
      cancelled: false as const,
      status: "missing",
      workflowIds: [] as string[],
      workflowCancellationFailedIds: [] as string[],
      knowledgeRefreshRunId: null,
    };
  }

  const cancellation = await cancelActiveAgentRunPersistence(input);
  if (!cancellation.cancelled) {
    return {
      ...cancellation,
      workflowIds: [] as string[],
      workflowCancellationFailedIds: [] as string[],
    };
  }

  // The row-locking transition prevents a later self-attachment because the
  // workflow ownership CAS accepts active statuses only. Re-read anyway to
  // cover an attachment that committed immediately before cancellation.
  const after = await prisma.agentRun.findFirst({
    where: {
      id: input.runId,
      userId: input.userId,
      workItemId: input.workItemId,
    },
    select: { workflowId: true },
  });
  const workflowIds = Array.from(new Set([
    attachedWorkflowId(before.workflowId),
    attachedWorkflowId(cancellation.workflowId),
    attachedWorkflowId(after?.workflowId),
  ].filter((id): id is string => Boolean(id))));
  const outcomes = await Promise.allSettled(
    workflowIds.map(async (workflowId) => {
      await getRun(workflowId).cancel();
      return workflowId;
    }),
  );
  const workflowCancellationFailedIds = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected" ? [workflowIds[index]!] : []
  );

  return {
    ...cancellation,
    workflowIds,
    workflowCancellationFailedIds,
    knowledgeRefreshRunId:
      cancellation.knowledgeRefreshRunId ?? before.knowledgeRefreshRunId,
  };
}
