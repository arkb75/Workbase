import { Badge } from "@/components/ui/badge";
import { repositoryRefreshIsActive } from "@/src/lib/github-repository-import-state";
import { titleCase } from "@/src/lib/utils";

type RepositoryRefreshSummary = {
  status: string;
  qualityStatus: string;
  progress: unknown;
  error: unknown;
};

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

export function RepositoryRefreshLifecycleStatus({
  attachmentPending,
  refresh,
}: {
  attachmentPending: boolean;
  refresh: RepositoryRefreshSummary | null;
}) {
  if (attachmentPending) {
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
        <p className="mt-2">
          Workbase is still validating the current repository head and reconciling automatic Highlights. You can leave this page safely.
        </p>
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
