import type { Prisma } from "@/src/generated/prisma/client";

export const ACTIVE_REPOSITORY_IMPORT_STATUSES = ["queued", "importing"] as const;
export const ACTIVE_REPOSITORY_REFRESH_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;
export const TERMINAL_REPOSITORY_REFRESH_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type RepositoryImportStatus =
  | (typeof ACTIVE_REPOSITORY_IMPORT_STATUSES)[number]
  | "evidence_ready"
  | "retryable_failed"
  | "cancelled"
  | "superseded";

export type RepositoryImportState = {
  requestId: string;
  status: RepositoryImportStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  workflowId?: string;
  refreshRunId?: string;
  refreshWorkflowId?: string;
  evidenceCount?: number;
  newCommitCount?: number;
  error?: string;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readRepositoryImportState(metadata: unknown): RepositoryImportState | null {
  const value = record(record(metadata).repositoryImport);
  if (
    typeof value.requestId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.requestedAt !== "string"
  ) {
    return null;
  }

  if (
    ![
      ...ACTIVE_REPOSITORY_IMPORT_STATUSES,
      "evidence_ready",
      "retryable_failed",
      "cancelled",
      "superseded",
    ].includes(value.status as RepositoryImportStatus)
  ) {
    return null;
  }

  return value as RepositoryImportState;
}

export function repositoryImportIsActive(state: RepositoryImportState | null) {
  return Boolean(
    state &&
      ACTIVE_REPOSITORY_IMPORT_STATUSES.includes(
        state.status as (typeof ACTIVE_REPOSITORY_IMPORT_STATUSES)[number],
      ),
  );
}

export function repositoryRefreshIsActive(status: string | null | undefined) {
  return Boolean(
    status &&
      !TERMINAL_REPOSITORY_REFRESH_STATUSES.includes(
        status as (typeof TERMINAL_REPOSITORY_REFRESH_STATUSES)[number],
      ),
  );
}

/**
 * Keeps the Sources workspace live across the hand-off from evidence import to
 * current-head knowledge reconciliation. An evidence-ready import without an
 * attached refresh is deliberately treated as active: stopping there would
 * present imported rows as a completed automatic Highlight lifecycle.
 */
export function repositoryBackgroundLifecycleIsActive(input: {
  imports: Array<RepositoryImportState | null>;
  refreshes: Array<{ id: string; status: string }>;
}) {
  if (input.imports.some(repositoryImportIsActive)) return true;
  if (input.refreshes.some((refresh) => repositoryRefreshIsActive(refresh.status))) {
    return true;
  }

  const refreshesById = new Map(
    input.refreshes.map((refresh) => [refresh.id, refresh] as const),
  );
  return input.imports.some((state) => {
    if (state?.status !== "evidence_ready") return false;
    if (!state.refreshRunId) return true;
    const refresh = refreshesById.get(state.refreshRunId);
    return !refresh || repositoryRefreshIsActive(refresh.status);
  });
}

export function mergeRepositoryImportMetadata(
  metadata: unknown,
  repositoryImport: RepositoryImportState,
  additional: Record<string, unknown> = {},
) {
  return JSON.parse(JSON.stringify({
    ...record(metadata),
    ...additional,
    status: repositoryImport.status,
    repositoryImport,
  })) as Prisma.InputJsonValue;
}

export function repositoryImportErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 1_000);
  }
  return "Repository import failed for an unknown reason.";
}
