import { randomUUID } from "node:crypto";
import { getRun, start } from "workflow/api";
import { prisma } from "@/src/lib/prisma";
import {
  mergeRepositoryImportMetadata,
  readRepositoryImportState,
  repositoryImportErrorMessage,
  repositoryImportIsActive,
  type RepositoryImportState,
} from "@/src/lib/github-repository-import-state";
import { updateRepositoryImportStateForRequest } from "@/src/services/github-repository-import-state-service";
import { githubRepositoryImportWorkflow } from "@/workflows/github-repository-import";

export const REPOSITORY_IMPORT_RESERVATION_LEASE_MS = 10 * 60 * 1_000;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function activeReservationIsReusable(state: RepositoryImportState | null, now: Date) {
  if (!repositoryImportIsActive(state) || !state) return false;
  const requestedAt = Date.parse(state.requestedAt);
  return Number.isFinite(requestedAt) &&
    now.getTime() - requestedAt < REPOSITORY_IMPORT_RESERVATION_LEASE_MS;
}

export async function queueGitHubRepositoryImport(input: {
  userId: string;
  workItemId: string;
  repositoryId: string;
  repositoryFullName: string;
}) {
  const now = new Date();
  const reservation = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WorkItem" WHERE "id" = ${input.workItemId} FOR UPDATE
    `;
    if (!locked.length) throw new Error("The Work Item no longer exists.");

    const workItem = await tx.workItem.findFirst({
      where: { id: input.workItemId, userId: input.userId },
      select: { id: true },
    });
    if (!workItem) throw new Error("The Work Item is not available to this user.");

    const existing = await tx.source.findUnique({
      where: {
        workItemId_type_externalId: {
          workItemId: input.workItemId,
          type: "github_repo",
          externalId: input.repositoryId,
        },
      },
      select: { id: true, metadata: true },
    });
    const current = readRepositoryImportState(existing?.metadata);
    if (existing && activeReservationIsReusable(current, now)) {
      return {
        sourceId: existing.id,
        requestId: current!.requestId,
        workflowId: current!.workflowId ?? null,
        reused: true,
      };
    }

    const requestId = randomUUID();
    const state: RepositoryImportState = {
      requestId,
      status: "queued",
      requestedAt: now.toISOString(),
    };
    const previousRepository = record(record(existing?.metadata).repository);
    const metadata = mergeRepositoryImportMetadata(existing?.metadata, state, {
      repository: {
        ...previousRepository,
        id: input.repositoryId,
        fullName: input.repositoryFullName,
      },
    });
    const source = await tx.source.upsert({
      where: {
        workItemId_type_externalId: {
          workItemId: input.workItemId,
          type: "github_repo",
          externalId: input.repositoryId,
        },
      },
      create: {
        workItemId: input.workItemId,
        type: "github_repo",
        label: input.repositoryFullName,
        externalId: input.repositoryId,
        metadata,
      },
      update: {
        label: input.repositoryFullName,
        metadata,
      },
      select: { id: true },
    });
    return {
      sourceId: source.id,
      requestId,
      workflowId: null,
      reused: false,
    };
  }, { timeout: 10_000 });

  if (reservation.reused) return reservation;

  let startedWorkflowId: string | null = null;
  let reservationStillOwned = true;
  try {
    const run = await start(githubRepositoryImportWorkflow, [{
      userId: input.userId,
      workItemId: input.workItemId,
      sourceId: reservation.sourceId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      requestId: reservation.requestId,
    }]);
    startedWorkflowId = run.runId;
    const attached = await updateRepositoryImportStateForRequest({
      sourceId: reservation.sourceId,
      requestId: reservation.requestId,
      patch: { workflowId: run.runId },
    });
    if (!attached || ["cancelled", "superseded"].includes(attached.status)) {
      reservationStillOwned = false;
      throw new Error(
        "The repository import was cancelled or superseded while its workflow was starting.",
      );
    }
    return {
      ...reservation,
      workflowId: run.runId,
    };
  } catch (error) {
    // start() returned an accepted workflow but deletion/supersession won the
    // Source-row fence before its exact ID could be attached. Cancel the known
    // orphan; a deleted Source also makes every workflow persistence step fail
    // closed against the old Work Item identity.
    if (startedWorkflowId) {
      await getRun(startedWorkflowId).cancel().catch(() => undefined);
    }
    if (reservationStillOwned) {
      await updateRepositoryImportStateForRequest({
        sourceId: reservation.sourceId,
        requestId: reservation.requestId,
        patch: {
          status: "retryable_failed",
          finishedAt: new Date().toISOString(),
          error: repositoryImportErrorMessage(error),
        },
      });
    }
    throw error;
  }
}

export const githubRepositoryImportApplicationService = {
  start: queueGitHubRepositoryImport,
};
