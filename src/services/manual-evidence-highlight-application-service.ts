import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";
import {
  buildCurrentManualEvidenceHighlightRequest,
  buildManualEvidenceHighlightRequest,
  MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
  readManualEvidenceHighlightRequest,
  reconcileManualEvidenceHighlightsForInput,
  type ManualEvidenceHighlightRequest,
  type ManualEvidenceHighlightTrigger,
} from "@/src/services/manual-evidence-highlight-service";
import { startAgentRunWorkflowOnce } from "@/src/services/agent-run-workflow-start-service";
import { manualEvidenceHighlightWorkflow } from "@/workflows/manual-evidence-highlights";

const ACTIVE_RUN_STATUSES = ["queued", "running", "awaiting_review"] as const;
const RETRYABLE_RUN_STATUSES = ["failed", "insufficient_context", "cancelled"] as const;
const SUPERSEDED_CANCEL_WAIT_MS = 500;
const WORKFLOW_START_WAIT_MS = 3_000;

export function shouldStartManualEvidenceHighlightsForCreate(input: {
  hasManualNotes: boolean;
  repositoryQueued: boolean;
}) {
  return input.hasManualNotes || !input.repositoryQueued;
}

export function manualEvidenceHighlightStartSucceeded(status: string) {
  return status === "queued" ||
    status === "running" ||
    status === "awaiting_review" ||
    status === "completed";
}

type LockedManualRun = {
  id: string;
  status: string;
  workflowId: string | null;
  request: unknown;
  result: unknown;
};

function toInputJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function retiredHighlightIdsFromResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const retired = (value as Record<string, unknown>).retiredHighlightIds;
  return Array.isArray(retired)
    ? retired.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function attachedWorkflowId(value: string | null | undefined) {
  return value && !value.startsWith("starting:") && !value.startsWith("inline-agent:")
    ? value
    : null;
}

function supersededResult(runId: string, request: ManualEvidenceHighlightRequest | null) {
  return {
    agentRunId: runId,
    terminalOutcome: "superseded_input",
    createdHighlightIds: [],
    replayedHighlightIds: [],
    persistedHighlightIds: [],
    deduplicatedHighlightIds: [],
    suggestionIds: [],
    suppressedHighlightIds: [],
    generationRunIds: [],
    inputFingerprint: request?.inputFingerprint ?? null,
  };
}

function noEvidenceResult(input: {
  runId: string;
  request: ManualEvidenceHighlightRequest;
  retiredHighlightIds: string[];
}) {
  return {
    agentRunId: input.runId,
    terminalOutcome: "no_evidence",
    createdHighlightIds: [],
    replayedHighlightIds: [],
    persistedHighlightIds: [],
    deduplicatedHighlightIds: [],
    suggestionIds: [],
    suppressedHighlightIds: [],
    retiredHighlightIds: input.retiredHighlightIds,
    generationRunIds: [],
    inputFingerprint: input.request.inputFingerprint,
    managedBy: "manual_evidence_highlight_workflow",
  };
}

async function cancelSupersededWorkflows(workflowIds: string[]) {
  const cancellations = Promise.allSettled(
    Array.from(new Set(workflowIds)).map((workflowId) =>
      getRun(workflowId).cancel()
    ),
  );
  await settleWithin(cancellations, SUPERSEDED_CANCEL_WAIT_MS);
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const timeout = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function resolveTimedOutWorkflowStart(runId: string) {
  const current = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true },
  });
  if (!current) {
    return { status: "cancelled" as const, workflowId: null };
  }
  const attached = attachedWorkflowId(current.workflowId);
  if (attached || current.status !== "queued") {
    return { status: current.status, workflowId: attached };
  }

  const failure = {
    code: "manual_highlight_workflow_start_timeout",
    stage: "workflow_start",
    retryable: true,
    message:
      "Durable automatic Highlight analysis did not attach to its run within the Server Action latency budget.",
    recovery:
      "Retry automatic Highlights. Your saved Evidence and any prepared checkpoint are intact.",
  };
  const failed = await prisma.agentRun.updateMany({
    where: {
      id: runId,
      workflowId: current.workflowId,
      status: "queued",
    },
    data: {
      status: "failed",
      workflowId: null,
      error: toInputJson(failure),
      finishedAt: new Date(),
    },
  });
  if (failed.count) return { status: "failed" as const, workflowId: null };

  // The workflow may have self-attached while the timeout CAS was in flight.
  // Re-read the winner rather than overwriting its exact ownership handshake.
  const winner = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true },
  });
  return {
    status: winner?.status ?? "cancelled",
    workflowId: attachedWorkflowId(winner?.workflowId),
  };
}

async function reserveManualEvidenceHighlightRun(input: {
  userId: string;
  workItemId: string;
  trigger: ManualEvidenceHighlightTrigger;
}) {
  return prisma.$transaction(async (tx) => {
    // Authorization is a non-locking read. Every knowledge writer then uses
    // WorkItem -> advisory -> child rows. The shared helper repeats the parent
    // lock before taking the advisory lock so all callers follow one order.
    const workItem = await tx.workItem.findFirst({
      where: { id: input.workItemId, userId: input.userId },
      select: { id: true },
    });
    if (!workItem) {
      throw new Error("The Work Item is not available to this user.");
    }
    const lockedWorkItems = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WorkItem"
      WHERE "id" = ${input.workItemId}
      FOR UPDATE
    `;
    if (!lockedWorkItems.length) {
      throw new Error("The Work Item no longer exists.");
    }
    await lockKnowledgeWorkItemMutation(tx, input.workItemId);
    const currentRequest = await buildCurrentManualEvidenceHighlightRequest({
      db: tx,
      workItemId: input.workItemId,
      trigger: input.trigger,
    });
    const reconciled = await reconcileManualEvidenceHighlightsForInput({
      tx,
      workItemId: input.workItemId,
      request: currentRequest,
    });
    const effectiveRequest = currentRequest ?? buildManualEvidenceHighlightRequest({
      workItemId: input.workItemId,
      trigger: input.trigger,
      evidenceItems: [],
    });
    const lockedRuns = await tx.$queryRaw<LockedManualRun[]>`
      SELECT "id", "status"::text AS "status", "workflowId", "request", "result"
      FROM "AgentRun"
      WHERE "workItemId" = ${input.workItemId}
        AND "userId" = ${input.userId}
        AND "kind" = 'manual_evidence_highlights'
      FOR UPDATE
    `;
    const parsedRuns = lockedRuns.map((run) => ({
      ...run,
      parsedRequest: readManualEvidenceHighlightRequest(run.request),
    }));
    const exact = parsedRuns.find((run) =>
      run.parsedRequest?.executionKey === effectiveRequest.executionKey
    ) ?? null;
    const superseded = parsedRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(
        run.status as (typeof ACTIVE_RUN_STATUSES)[number],
      ) && (!exact || run.id !== exact.id)
    );
    if (superseded.length) {
      const now = new Date();
      for (const run of superseded) {
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: "completed",
            result: toInputJson(supersededResult(run.id, run.parsedRequest)),
            error: Prisma.JsonNull,
            finishedAt: now,
          },
        });
      }
    }
    const supersededWorkflowIds = superseded.flatMap((run) => {
      const workflowId = attachedWorkflowId(run.workflowId);
      return workflowId ? [workflowId] : [];
    });

    if (!currentRequest) {
      const now = new Date();
      if (exact) {
        const completed = await tx.agentRun.update({
          where: { id: exact.id },
          data: {
            status: "completed",
            request: toInputJson(effectiveRequest),
            result: toInputJson(noEvidenceResult({
              runId: exact.id,
              request: effectiveRequest,
              retiredHighlightIds: Array.from(new Set([
                ...retiredHighlightIdsFromResult(exact.result),
                ...reconciled.retiredHighlightIds,
              ])),
            })),
            error: Prisma.JsonNull,
            workflowId: null,
            finishedAt: now,
          },
        });
        return {
          status: "completed" as const,
          run: completed,
          supersededWorkflowIds,
        };
      }
      const runId = randomUUID();
      const completed = await tx.agentRun.create({
        data: {
          id: runId,
          userId: input.userId,
          workItemId: input.workItemId,
          idempotencyKey: effectiveRequest.executionKey,
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          status: "completed",
          request: toInputJson(effectiveRequest),
          result: toInputJson(noEvidenceResult({
            runId,
            request: effectiveRequest,
            retiredHighlightIds: reconciled.retiredHighlightIds,
          })),
          finishedAt: now,
        },
      });
      return {
        status: "completed" as const,
        run: completed,
        supersededWorkflowIds,
      };
    }
    if (exact) {
      return {
        status: exact.status,
        run: exact,
        supersededWorkflowIds,
      };
    }

    const run = await tx.agentRun.create({
      data: {
        userId: input.userId,
        workItemId: input.workItemId,
        idempotencyKey: currentRequest.executionKey,
        kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
        status: "queued",
        request: toInputJson(currentRequest),
      },
    });
    return {
      status: "queued" as const,
      run,
      supersededWorkflowIds,
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10_000,
  });
}

export type ManualEvidenceHighlightReservation = {
  status: string;
  runId: string | null;
  workflowId: string | null;
  supersededWorkflowIds: string[];
};

export async function reserveManualEvidenceHighlights(input: {
  userId: string;
  workItemId: string;
  trigger: ManualEvidenceHighlightTrigger;
}): Promise<ManualEvidenceHighlightReservation> {
  const reservation = await reserveManualEvidenceHighlightRun(input);
  if (!reservation.run) {
    return {
      status: "no_evidence",
      runId: null,
      workflowId: null,
      supersededWorkflowIds: reservation.supersededWorkflowIds,
    };
  }
  return {
    status: reservation.run.status,
    runId: reservation.run.id,
    workflowId: attachedWorkflowId(reservation.run.workflowId),
    supersededWorkflowIds: reservation.supersededWorkflowIds,
  };
}

export async function acceptManualEvidenceHighlights(
  reservation: ManualEvidenceHighlightReservation,
) {
  await cancelSupersededWorkflows(reservation.supersededWorkflowIds);
  if (!reservation.runId) {
    return { status: reservation.status, runId: null, workflowId: null };
  }
  if (!ACTIVE_RUN_STATUSES.includes(
    reservation.status as (typeof ACTIVE_RUN_STATUSES)[number],
  )) {
    return {
      status: reservation.status,
      runId: reservation.runId,
      workflowId: reservation.workflowId,
    };
  }
  const started = await settleWithin(startAgentRunWorkflowOnce({
    runId: reservation.runId,
    startWorkflow: () => start(manualEvidenceHighlightWorkflow, [reservation.runId!]),
  }), WORKFLOW_START_WAIT_MS);
  if (started.status === "rejected") throw started.error;
  if (started.status === "timeout") {
    const timedOut = await resolveTimedOutWorkflowStart(reservation.runId);
    return {
      status: timedOut.status,
      runId: reservation.runId,
      workflowId: timedOut.workflowId,
    };
  }
  const workflowId = started.value;
  const latest = await prisma.agentRun.findUnique({
    where: { id: reservation.runId },
    select: { status: true },
  });
  return {
    status: latest?.status ?? "cancelled",
    runId: reservation.runId,
    workflowId,
  };
}

export async function startManualEvidenceHighlights(input: {
  userId: string;
  workItemId: string;
  trigger: ManualEvidenceHighlightTrigger;
}) {
  return acceptManualEvidenceHighlights(
    await reserveManualEvidenceHighlights(input),
  );
}

export async function retryManualEvidenceHighlights(input: {
  userId: string;
  workItemId: string;
  runId: string;
}) {
  const retry = await prisma.$transaction(async (tx) => {
    const workItem = await tx.workItem.findFirst({
      where: { id: input.workItemId, userId: input.userId },
      select: { id: true },
    });
    if (!workItem) throw new Error("The Work Item is not available to this user.");
    const lockedWorkItems = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WorkItem"
      WHERE "id" = ${input.workItemId}
      FOR UPDATE
    `;
    if (!lockedWorkItems.length) throw new Error("The Work Item no longer exists.");
    await lockKnowledgeWorkItemMutation(tx, input.workItemId);
    const lockedRuns = await tx.$queryRaw<LockedManualRun[]>`
      SELECT "id", "status"::text AS "status", "workflowId", "request", "result"
      FROM "AgentRun"
      WHERE "workItemId" = ${input.workItemId}
        AND "userId" = ${input.userId}
        AND "kind" = 'manual_evidence_highlights'
      FOR UPDATE
    `;
    const run = lockedRuns.find((candidate) => candidate.id === input.runId);
    if (!run) throw new Error("The manual Highlight run no longer exists.");
    const request = readManualEvidenceHighlightRequest(run.request);
    const current = await buildCurrentManualEvidenceHighlightRequest({
      db: tx,
      workItemId: input.workItemId,
      trigger: "manual_evidence_change",
    });
    await reconcileManualEvidenceHighlightsForInput({
      tx,
      workItemId: input.workItemId,
      request: current,
    });
    const currentExact = current
      ? lockedRuns.find((candidate) =>
          candidate.id !== run.id &&
          readManualEvidenceHighlightRequest(candidate.request)?.executionKey ===
            current.executionKey
        ) ?? null
      : null;
    if (currentExact) {
      return {
        action: ACTIVE_RUN_STATUSES.includes(
          currentExact.status as (typeof ACTIVE_RUN_STATUSES)[number],
        ) ? "reuse" as const : "terminal" as const,
        run: currentExact,
      };
    }
    if (ACTIVE_RUN_STATUSES.includes(
      run.status as (typeof ACTIVE_RUN_STATUSES)[number],
    )) {
      return { action: "reuse" as const, run };
    }
    if (!RETRYABLE_RUN_STATUSES.includes(
      run.status as (typeof RETRYABLE_RUN_STATUSES)[number],
    )) {
      return { action: "terminal" as const, run };
    }
    if (!request || !current || request.inputFingerprint !== current.inputFingerprint) {
      return { action: "current_input" as const, run };
    }
    const updated = await tx.agentRun.update({
      where: { id: run.id },
      data: {
        status: "queued",
        workflowId: null,
        attemptNumber: { increment: 1 },
        result: Prisma.JsonNull,
        error: Prisma.JsonNull,
        startedAt: null,
        finishedAt: null,
      },
    });
    return { action: "retry" as const, run: updated };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10_000,
  });

  if (retry.action === "current_input") {
    return startManualEvidenceHighlights({
      userId: input.userId,
      workItemId: input.workItemId,
      trigger: "manual_evidence_change",
    });
  }
  if (retry.action === "terminal") {
    return {
      status: retry.run.status,
      runId: retry.run.id,
      workflowId: attachedWorkflowId(retry.run.workflowId),
    };
  }
  const started = await settleWithin(startAgentRunWorkflowOnce({
    runId: retry.run.id,
    startWorkflow: () => start(manualEvidenceHighlightWorkflow, [retry.run.id]),
  }), WORKFLOW_START_WAIT_MS);
  if (started.status === "rejected") throw started.error;
  if (started.status === "timeout") {
    const timedOut = await resolveTimedOutWorkflowStart(retry.run.id);
    return {
      status: timedOut.status,
      runId: retry.run.id,
      workflowId: timedOut.workflowId,
    };
  }
  const workflowId = started.value;
  return {
    status: "queued" as const,
    runId: retry.run.id,
    workflowId,
  };
}

export const manualEvidenceHighlightApplicationService = {
  reserve: reserveManualEvidenceHighlights,
  accept: acceptManualEvidenceHighlights,
  start: startManualEvidenceHighlights,
  retry: retryManualEvidenceHighlights,
};
