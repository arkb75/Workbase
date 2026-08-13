import { Badge } from "@/components/ui/badge";
import { repositoryRefreshIsActive } from "@/src/lib/github-repository-import-state";
import { titleCase } from "@/src/lib/utils";

type RepositoryRefreshSummary = {
  status: string;
  qualityStatus: string;
  progress: unknown;
  error: unknown;
};

type RepositoryRefreshProgress = {
  estimatedPercent: number;
  label: string;
  detail: string | null;
};

const ACTIVE_REFRESH_STAGE_COUNT = 6;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function statusLabel(status: string) {
  if (status === "queued") return "analysis queued";
  if (status === "inventorying") return "reading repository tree";
  if (status === "analyzing") return "checking changed files";
  if (status === "routing") return "planning semantic analysis";
  if (status === "semantic_analysis") return "analyzing implementation";
  if (status === "auditing") return "auditing coverage";
  if (status === "reconciling") return "applying automatic Highlights";
  if (status === "completed") return "analysis complete";
  if (status === "failed") return "analysis failed";
  if (status === "cancelled") return "analysis cancelled";
  return titleCase(status);
}

function statusTone(status: string) {
  if (status === "completed") return "success" as const;
  if (status === "failed" || status === "cancelled") return "danger" as const;
  if (repositoryRefreshIsActive(status)) return "warning" as const;
  return "neutral" as const;
}

function errorMessage(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const error = record(value);
  return typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : null;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function interpolateProgress(start: number, end: number, completed: number, total: number) {
  if (total <= 0) return start;
  return Math.round(start + (end - start) * Math.min(completed / total, 1));
}

export function repositoryRefreshProgress(
  refresh: Pick<RepositoryRefreshSummary, "status" | "progress">,
): RepositoryRefreshProgress | null {
  const progress = record(refresh.progress);

  if (refresh.status === "queued") {
    return { estimatedPercent: 3, label: "Preparing analysis", detail: null };
  }
  if (refresh.status === "inventorying") {
    const repositories = nonNegativeNumber(progress?.repositories);
    const inventoried = nonNegativeNumber(progress?.inventoried);
    const hasCount = repositories !== null && repositories > 0 && inventoried !== null;
    return {
      estimatedPercent: hasCount
        ? interpolateProgress(5, 18, inventoried, repositories)
        : 8,
      label: `Stage 1 of ${ACTIVE_REFRESH_STAGE_COUNT}`,
      detail: hasCount
        ? `${Math.min(inventoried, repositories)} of ${repositories} ${repositories === 1 ? "repository" : "repositories"} inventoried`
        : null,
    };
  }
  if (refresh.status === "analyzing") {
    const analyzedFiles = nonNegativeNumber(progress?.analyzedFiles);
    const remainingFiles = nonNegativeNumber(progress?.remainingFiles);
    const totalFiles = analyzedFiles !== null && remainingFiles !== null
      ? analyzedFiles + remainingFiles
      : null;
    const hasCount = analyzedFiles !== null && totalFiles !== null && totalFiles > 0;
    return {
      estimatedPercent: hasCount
        ? interpolateProgress(20, 40, analyzedFiles, totalFiles)
        : 22,
      label: `Stage 2 of ${ACTIVE_REFRESH_STAGE_COUNT}`,
      detail: hasCount
        ? `${Math.min(analyzedFiles, totalFiles)} of ${totalFiles} repository files checked`
        : null,
    };
  }
  if (refresh.status === "routing") {
    return { estimatedPercent: 48, label: `Stage 3 of ${ACTIVE_REFRESH_STAGE_COUNT}`, detail: null };
  }
  if (refresh.status === "semantic_analysis") {
    return { estimatedPercent: 66, label: `Stage 4 of ${ACTIVE_REFRESH_STAGE_COUNT}`, detail: null };
  }
  if (refresh.status === "auditing") {
    return { estimatedPercent: 82, label: `Stage 5 of ${ACTIVE_REFRESH_STAGE_COUNT}`, detail: null };
  }
  if (refresh.status === "reconciling") {
    return { estimatedPercent: 94, label: `Stage 6 of ${ACTIVE_REFRESH_STAGE_COUNT}`, detail: null };
  }
  if (refresh.status === "completed") {
    return { estimatedPercent: 100, label: "Analysis complete", detail: null };
  }
  return null;
}

function RefreshProgress({ progress, status }: {
  progress: RepositoryRefreshProgress;
  status: string;
}) {
  const progressText = [progress.label, progress.detail].filter(Boolean).join(" · ");
  return (
    <div className="mt-3" data-refresh-progress={status}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] font-semibold tracking-[0.01em] text-amber-900/75">
        <span>{progressText}</span>
        <span className="shrink-0 tabular-nums">~{progress.estimatedPercent}%</span>
      </div>
      <div
        aria-label="Repository analysis progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.estimatedPercent}
        aria-valuetext={`${progressText}, approximately ${progress.estimatedPercent}% complete`}
        className="h-1.5 overflow-hidden rounded-full bg-amber-900/10"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-amber-600 transition-[width] duration-500 ease-out"
          style={{ width: `${progress.estimatedPercent}%` }}
        />
      </div>
    </div>
  );
}

export function RepositoryRefreshLifecycleStatus({
  attachmentPending,
  refresh,
}: {
  attachmentPending: boolean;
  refresh: RepositoryRefreshSummary | null;
}) {
  if (attachmentPending) {
    const pendingProgress: RepositoryRefreshProgress = {
      estimatedPercent: 2,
      label: "Preparing durable analysis",
      detail: null,
    };
    return (
      <div
        className="rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">Current-head analysis starting</Badge>
        </div>
        <p className="mt-2">
          Evidence is ready. Workbase is attaching the durable repository analysis that creates or reconciles automatic Highlights; this page will stay updated until that phase is terminal.
        </p>
        <RefreshProgress progress={pendingProgress} status="starting" />
      </div>
    );
  }
  if (!refresh) return null;

  const active = repositoryRefreshIsActive(refresh.status);
  const terminalOutcome = record(record(refresh.progress)?.terminalOutcome);
  const missingTerminalOutcome = refresh.status === "completed" &&
    typeof terminalOutcome?.status !== "string";
  const unsuccessful = refresh.status === "failed" ||
    refresh.status === "cancelled" ||
    missingTerminalOutcome;
  const progress = active ? repositoryRefreshProgress(refresh) : null;

  return (
    <div
      className={`rounded-[22px] border px-4 py-3 text-sm leading-6 ${
        unsuccessful
          ? "border-rose-200 bg-rose-50 text-rose-950"
          : active
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-emerald-200 bg-emerald-50 text-emerald-950"
      }`}
      aria-live={active ? "polite" : undefined}
      role={unsuccessful ? "alert" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(refresh.status)}>{statusLabel(refresh.status)}</Badge>
        <Badge>Quality: {titleCase(refresh.qualityStatus)}</Badge>
      </div>
      {active ? (
        <>
          <p className="mt-2">
            Workbase is still validating the current repository head and reconciling automatic Highlights. You can leave this page safely.
          </p>
          {progress ? <RefreshProgress progress={progress} status={refresh.status} /> : null}
        </>
      ) : refresh.status === "completed" && terminalOutcome?.status === "no_safe_candidates" ? (
        <p className="mt-2 font-medium">
          Current-head analysis completed, but the imported evidence did not safely support an automatic Highlight.
        </p>
      ) : refresh.status === "completed" && terminalOutcome?.status === "ready" ? (
        <p className="mt-2 font-medium">
          Current-head analysis completed and applied {typeof terminalOutcome.appliedHighlightCount === "number"
            ? terminalOutcome.appliedHighlightCount
            : 0} automatic Highlight{terminalOutcome.appliedHighlightCount === 1 ? "" : "s"}.
        </p>
      ) : refresh.status === "completed" ? (
        <p className="mt-2 font-medium">
          The repository refresh ended without a recorded automatic Highlight outcome. Treat this run as incomplete and retry the repository refresh.
        </p>
      ) : (
        <p className="mt-2 font-medium">
          {errorMessage(refresh.error) ?? "The current-head repository analysis did not complete. Retry the repository refresh."}
        </p>
      )}
    </div>
  );
}
