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
import { githubRepositoryImportWorkflow } from "@/workflows/github-repository-import";

export const REPOSITORY_IMPORT_RESERVATION_LEASE_MS = 10 * 60 * 1_000;
export const REPOSITORY_IMPORT_WORKFLOW_START_LEASE_MS = 30_000;

export type GitHubRepositoryImportInput = {
  userId: string;
  workItemId: string;
  repositoryId: string;
  repositoryFullName: string;
};

export type GitHubRepositoryImportReservation = {
  sourceId: string;
  requestId: string;
  workflowId: string | null;
  reused: boolean;
  input: GitHubRepositoryImportInput;
};

export type GitHubRepositoryImportAcceptance = Omit<
  GitHubRepositoryImportReservation,
  "input"
>;

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

function workflowStartReservation(now = Date.now()) {
  return `starting:${now}:${randomUUID()}`;
}

function attachedWorkflowId(value: string | null | undefined) {
  return value && !value.startsWith("starting:") ? value : null;
}

function workflowStartReservationIsStale(value: string | null | undefined, now = Date.now()) {
  if (!value?.startsWith("starting:")) return false;
  const encoded = Number(value.split(":")[1]);
  return !Number.isFinite(encoded) ||
    now - encoded >= REPOSITORY_IMPORT_WORKFLOW_START_LEASE_MS;
}

function acceptanceResult(
  reservation: GitHubRepositoryImportReservation,
  workflowId = reservation.workflowId,
): GitHubRepositoryImportAcceptance {
  return {
    sourceId: reservation.sourceId,
    requestId: reservation.requestId,
    workflowId: attachedWorkflowId(workflowId),
    reused: reservation.reused,
  };
}

type WorkflowStartClaim =
  | { status: "acquired"; reservation: string }
  | { status: "attached"; workflowId: string }
  | { status: "starting" }
  | { status: "cancelled_or_superseded" };

async function claimRepositoryImportWorkflowStart(
  reservation: GitHubRepositoryImportReservation,
): Promise<WorkflowStartClaim> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Source" WHERE "id" = ${reservation.sourceId} FOR UPDATE
    `;
    if (!locked.length) return { status: "cancelled_or_superseded" as const };

    const source = await tx.source.findUnique({
      where: { id: reservation.sourceId },
      select: { id: true, metadata: true },
    });
    const current = readRepositoryImportState(source?.metadata);
    if (
      !source ||
      !current ||
      current.requestId !== reservation.requestId ||
      !repositoryImportIsActive(current)
    ) {
      return { status: "cancelled_or_superseded" as const };
    }

    const attached = attachedWorkflowId(current.workflowId);
    if (attached) return { status: "attached" as const, workflowId: attached };
    if (
      current.workflowId?.startsWith("starting:") &&
      !workflowStartReservationIsStale(current.workflowId)
    ) {
      return { status: "starting" as const };
    }

    const startReservation = workflowStartReservation();
    const next: RepositoryImportState = {
      ...current,
      workflowId: startReservation,
    };
    await tx.source.update({
      where: { id: source.id },
      data: {
        metadata: mergeRepositoryImportMetadata(source.metadata, next),
      },
    });
    return {
      status: "acquired" as const,
      reservation: startReservation,
    };
  });
}

async function transitionOwnedRepositoryImportWorkflowStart(input: {
  reservation: GitHubRepositoryImportReservation;
  expectedWorkflowId: string;
  patch: Partial<Omit<RepositoryImportState, "requestId" | "requestedAt">>;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Source" WHERE "id" = ${input.reservation.sourceId} FOR UPDATE
    `;
    if (!locked.length) return null;

    const source = await tx.source.findUnique({
      where: { id: input.reservation.sourceId },
      select: { id: true, metadata: true },
    });
    const current = readRepositoryImportState(source?.metadata);
    if (
      !source ||
      !current ||
      current.requestId !== input.reservation.requestId ||
      current.workflowId !== input.expectedWorkflowId
    ) {
      return null;
    }
    const next: RepositoryImportState = {
      ...current,
      ...input.patch,
      requestId: current.requestId,
      requestedAt: current.requestedAt,
    };
    await tx.source.update({
      where: { id: source.id },
      data: {
        metadata: mergeRepositoryImportMetadata(source.metadata, next),
      },
    });
    return next;
  });
}

async function currentRepositoryImportWorkflow(
  reservation: GitHubRepositoryImportReservation,
) {
  const source = await prisma.source.findUnique({
    where: { id: reservation.sourceId },
    select: { metadata: true },
  });
  const current = readRepositoryImportState(source?.metadata);
  if (!current || current.requestId !== reservation.requestId) return null;
  return attachedWorkflowId(current.workflowId);
}

export async function reserveGitHubRepositoryImport(
  input: GitHubRepositoryImportInput,
): Promise<GitHubRepositoryImportReservation> {
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

  return {
    ...reservation,
    workflowId: attachedWorkflowId(reservation.workflowId),
    input,
  };
}

export async function acceptGitHubRepositoryImport(
  reservation: GitHubRepositoryImportReservation,
): Promise<GitHubRepositoryImportAcceptance> {
  const claim = await claimRepositoryImportWorkflowStart(reservation);
  if (claim.status === "attached") {
    return acceptanceResult(reservation, claim.workflowId);
  }
  if (claim.status === "starting") {
    return acceptanceResult(reservation, null);
  }
  if (claim.status === "cancelled_or_superseded") {
    throw new Error(
      "The repository import was cancelled or superseded before its workflow could start.",
    );
  }

  let startedWorkflowId: string | null = null;
  try {
    const run = await start(githubRepositoryImportWorkflow, [{
      userId: reservation.input.userId,
      workItemId: reservation.input.workItemId,
      sourceId: reservation.sourceId,
      repositoryId: reservation.input.repositoryId,
      repositoryFullName: reservation.input.repositoryFullName,
      requestId: reservation.requestId,
    }]);
    startedWorkflowId = run.runId;
    const attached = await transitionOwnedRepositoryImportWorkflowStart({
      reservation,
      expectedWorkflowId: claim.reservation,
      patch: { workflowId: run.runId },
    });
    if (attached) {
      return acceptanceResult(reservation, run.runId);
    }

    const winner = await currentRepositoryImportWorkflow(reservation);
    if (winner === run.runId) return acceptanceResult(reservation, winner);
    await getRun(run.runId).cancel().catch(() => undefined);
    startedWorkflowId = null;
    if (winner) return acceptanceResult(reservation, winner);
    throw new Error(
      "The repository import was cancelled or superseded while its workflow was starting.",
    );
  } catch (error) {
    // start() returned an accepted workflow but deletion/supersession won the
    // Source-row fence before its exact ID could be attached. Cancel the known
    // orphan; a deleted Source also makes every workflow persistence step fail
    // closed against the old Work Item identity.
    if (startedWorkflowId) {
      await getRun(startedWorkflowId).cancel().catch(() => undefined);
    }
    await transitionOwnedRepositoryImportWorkflowStart({
      reservation,
      expectedWorkflowId: claim.reservation,
      patch: {
        status: "retryable_failed",
        workflowId: undefined,
        finishedAt: new Date().toISOString(),
        error: repositoryImportErrorMessage(error),
      },
    }).catch(() => undefined);
    throw error;
  }
}

export async function queueGitHubRepositoryImport(
  input: GitHubRepositoryImportInput,
) {
  const reservation = await reserveGitHubRepositoryImport(input);
  return acceptGitHubRepositoryImport(reservation);
}

export const githubRepositoryImportApplicationService = {
  reserve: reserveGitHubRepositoryImport,
  accept: acceptGitHubRepositoryImport,
  start: queueGitHubRepositoryImport,
};
