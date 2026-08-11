import { prisma } from "@/src/lib/prisma";
import {
  readRepositoryImportState,
  repositoryImportErrorMessage,
} from "@/src/lib/github-repository-import-state";
import { upsertEvidenceItemsForSource } from "@/src/lib/evidence-persistence";
import { githubRepoImportService } from "@/src/services/github-repo-import-service";
import { updateRepositoryImportStateForRequest } from "@/src/services/github-repository-import-state-service";
import { repositoryKnowledgeRefreshApplicationService } from "@/src/services/repository-knowledge-refresh-application-service";

export type GitHubRepositoryImportWorkflowInput = {
  userId: string;
  workItemId: string;
  sourceId: string;
  repositoryId: string;
  repositoryFullName: string;
  requestId: string;
};

async function executeGitHubRepositoryImport(input: GitHubRepositoryImportWorkflowInput) {
  "use step";

  const claimed = await updateRepositoryImportStateForRequest({
    sourceId: input.sourceId,
    requestId: input.requestId,
    patch: {
      status: "importing",
      startedAt: new Date().toISOString(),
      error: undefined,
    },
  });
  if (!claimed) {
    return { status: "cancelled" as const, reason: "source_deleted_or_superseded" };
  }

  const workItem = await prisma.workItem.findFirst({
    where: { id: input.workItemId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      title: true,
      type: true,
      description: true,
      startDate: true,
      endDate: true,
    },
  });
  if (!workItem) {
    return { status: "cancelled" as const, reason: "work_item_deleted" };
  }

  try {
    const imported = await githubRepoImportService.importRepository({
      userId: input.userId,
      workItem,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
    });
    if (imported.source.id !== input.sourceId) {
      throw new Error("The durable import resolved a different repository Source.");
    }

    const currentSource = await prisma.source.findUnique({
      where: { id: input.sourceId },
      select: { metadata: true },
    });
    const currentState = readRepositoryImportState(currentSource?.metadata);
    if (!currentSource) {
      return { status: "cancelled" as const, reason: "source_deleted" };
    }
    if (!currentState || currentState.requestId !== input.requestId) {
      return { status: "superseded" as const, reason: "newer_import_request" };
    }

    const persistedEvidenceItems = await upsertEvidenceItemsForSource(
      imported.source.id,
      imported.importedEvidenceItems.map((item) => ({
        workItemId: item.workItemId,
        sourceId: item.sourceId,
        externalId: item.externalId,
        sourceType: item.source.type,
        type: item.type,
        title: item.title,
        content: item.content,
        searchText: item.searchText,
        parentKind: item.parentKind,
        parentKey: item.parentKey,
        included: item.included,
        metadata: item.metadata,
      })),
    );
    const newCommitCount = persistedEvidenceItems.filter(
      (item) => item.type === "github_commit" && !item.wasExisting && item.included,
    ).length;
    const finishedAt = new Date().toISOString();
    const completed = await updateRepositoryImportStateForRequest({
      sourceId: input.sourceId,
      requestId: input.requestId,
      patch: {
        status: "evidence_ready",
        finishedAt,
        evidenceCount: persistedEvidenceItems.length,
        newCommitCount,
        error: undefined,
      },
      additionalMetadata: {
        repository: imported.importSummary.repository,
        importedAt: imported.importSummary.importedAt,
        counts: imported.importSummary.counts,
        webhook: imported.importSummary.webhook,
      },
    });
    if (!completed) {
      return { status: "superseded" as const, reason: "newer_import_request" };
    }
    return {
      status: "evidence_ready" as const,
      sourceId: input.sourceId,
      evidenceCount: persistedEvidenceItems.length,
      newCommitCount,
    };
  } catch (error) {
    const source = await prisma.source.findUnique({
      where: { id: input.sourceId },
      select: { metadata: true },
    });
    if (!source) {
      return { status: "cancelled" as const, reason: "source_deleted" };
    }
    const state = readRepositoryImportState(source.metadata);
    if (!state || state.requestId !== input.requestId) {
      return { status: "superseded" as const, reason: "newer_import_request" };
    }
    await updateRepositoryImportStateForRequest({
      sourceId: input.sourceId,
      requestId: input.requestId,
      patch: {
        status: "retryable_failed",
        finishedAt: new Date().toISOString(),
        error: repositoryImportErrorMessage(error),
      },
    });
    throw error;
  }
}
executeGitHubRepositoryImport.maxRetries = 2;

async function queueImportedRepositoryRefresh(input: GitHubRepositoryImportWorkflowInput) {
  "use step";

  const source = await prisma.source.findUnique({
    where: { id: input.sourceId },
    select: { metadata: true },
  });
  const state = readRepositoryImportState(source?.metadata);
  if (!state || state.requestId !== input.requestId || state.status !== "evidence_ready") {
    return { status: source ? "superseded" as const : "cancelled" as const };
  }
  const refresh = await repositoryKnowledgeRefreshApplicationService.start({
    userId: input.userId,
    workItemId: input.workItemId,
    trigger: "repository_attach",
    idempotencyKey: `repository-import:${input.sourceId}:${input.requestId}`,
  });
  await updateRepositoryImportStateForRequest({
    sourceId: input.sourceId,
    requestId: input.requestId,
    patch: {
      refreshRunId: refresh.runId,
      refreshWorkflowId: refresh.workflowId,
    },
  });
  return {
    status: "refresh_queued" as const,
    refreshRunId: refresh.runId,
    refreshWorkflowId: refresh.workflowId,
  };
}
queueImportedRepositoryRefresh.maxRetries = 2;

async function recordRepositoryRefreshQueueFailure(input: {
  sourceId: string;
  requestId: string;
  error: string;
}) {
  "use step";

  const source = await prisma.source.findUnique({
    where: { id: input.sourceId },
    select: { metadata: true },
  });
  const state = readRepositoryImportState(source?.metadata);
  if (!state || state.requestId !== input.requestId || state.status !== "evidence_ready") {
    return { status: source ? "superseded" as const : "cancelled" as const };
  }
  await updateRepositoryImportStateForRequest({
    sourceId: input.sourceId,
    requestId: input.requestId,
    patch: {
      status: "retryable_failed",
      finishedAt: new Date().toISOString(),
      error: `Evidence import completed, but current-head automatic Highlight analysis could not start. ${input.error}`,
    },
  });
  return { status: "retryable_failed" as const };
}
recordRepositoryRefreshQueueFailure.maxRetries = 1;

export async function githubRepositoryImportWorkflow(
  input: GitHubRepositoryImportWorkflowInput,
) {
  "use workflow";

  const imported = await executeGitHubRepositoryImport(input);
  if (imported.status !== "evidence_ready") return imported;
  try {
    return await queueImportedRepositoryRefresh(input);
  } catch (error) {
    return recordRepositoryRefreshQueueFailure({
      sourceId: input.sourceId,
      requestId: input.requestId,
      error: repositoryImportErrorMessage(error),
    });
  }
}
