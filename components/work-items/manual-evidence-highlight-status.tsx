import type { ReactNode } from "react";
import { retryManualEvidenceHighlightsAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type ManualEvidenceHighlightRunStatus = {
  id: string;
  status: string;
  result: unknown;
  error: unknown;
  attemptNumber: number;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function manualEvidenceHighlightRunIsActive(status: string) {
  return status === "queued" || status === "running" || status === "awaiting_review";
}

function terminalOutcome(result: unknown) {
  const value = record(result)?.terminalOutcome;
  return value === "ready" || value === "no_safe_candidates" ||
      value === "no_evidence" || value === "superseded_input"
    ? value
    : null;
}

function resultCount(result: unknown, key: string) {
  return stringArray(record(result)?.[key]).length;
}

function statusBody(run: ManualEvidenceHighlightRunStatus): {
  badge: string;
  tone: "neutral" | "success" | "warning" | "danger";
  description: ReactNode;
  retryable: boolean;
} {
  if (run.status === "queued") {
    return {
      badge: "queued",
      tone: "warning",
      description:
        "Evidence is saved. Durable automatic Highlight analysis is queued; you can leave this page safely.",
      retryable: false,
    };
  }
  if (run.status === "running" || run.status === "awaiting_review") {
    return {
      badge: "analyzing",
      tone: "warning",
      description:
        "Workbase is grounding automatic Highlights in the complete current manual Evidence snapshot. This page updates automatically.",
      retryable: false,
    };
  }
  const outcome = terminalOutcome(run.result);
  if (run.status === "completed" && outcome === "ready") {
    const persisted = resultCount(run.result, "persistedHighlightIds") ||
      resultCount(run.result, "createdHighlightIds") +
        resultCount(run.result, "replayedHighlightIds");
    const suggestions = resultCount(run.result, "suggestionIds");
    return {
      badge: "complete",
      tone: "success",
      description: [
        persisted
          ? `${persisted} grounded automatic Highlight${persisted === 1 ? " is" : "s are"} ready for review.`
          : null,
        suggestions
          ? `${suggestions} existing Highlight support suggestion${suggestions === 1 ? " is" : "s are"} ready for review.`
          : null,
      ].filter(Boolean).join(" ") || "Manual Evidence Highlight analysis completed.",
      retryable: false,
    };
  }
  if (run.status === "completed" && outcome === "no_safe_candidates") {
    return {
      badge: "complete",
      tone: "neutral",
      description:
        "Analysis completed, but the current manual Evidence did not safely support a new automatic Highlight. The Evidence remains saved and available.",
      retryable: false,
    };
  }
  if (run.status === "completed" && outcome === "no_evidence") {
    const retired = resultCount(run.result, "retiredHighlightIds");
    return {
      badge: "up to date",
      tone: "neutral",
      description: retired
        ? `No included manual Evidence remains. ${retired} stale automatic Highlight${retired === 1 ? " was" : "s were"} removed from retrieval.`
        : "No included manual Evidence remains, so no automatic Highlight analysis is pending.",
      retryable: false,
    };
  }
  if (run.status === "completed" && outcome === "superseded_input") {
    return {
      badge: "superseded",
      tone: "neutral",
      description:
        "A newer manual Evidence snapshot replaced this run before it could write knowledge. No stale Highlight was applied.",
      retryable: false,
    };
  }
  if (run.status === "failed" || run.status === "insufficient_context") {
    const error = record(run.error);
    const recovery = typeof error?.recovery === "string" ? error.recovery : null;
    return {
      badge: "needs retry",
      tone: "danger",
      description: recovery
        ? `Automatic Highlight analysis did not complete. ${recovery}`
        : "Automatic Highlight analysis did not complete. Your Evidence is intact; retry this exact snapshot.",
      retryable: true,
    };
  }
  return {
    badge: run.status,
    tone: run.status === "cancelled" ? "neutral" : "danger",
    description:
      run.status === "cancelled"
        ? "This automatic Highlight run was cancelled without applying stale output."
        : "This automatic Highlight run ended without an explicit terminal outcome. Retry if no newer run is active.",
    retryable: run.status !== "cancelled",
  };
}

export function ManualEvidenceHighlightStatus({
  run,
  workItemId,
  returnTo,
}: {
  run: ManualEvidenceHighlightRunStatus | null;
  workItemId: string;
  returnTo: string;
}) {
  if (!run) return null;
  const status = statusBody(run);
  return (
    <Card
      className={
        status.tone === "danger"
          ? "border-rose-200 bg-rose-50 shadow-none"
          : status.tone === "success"
            ? "border-emerald-200 bg-emerald-50 shadow-none"
            : "border-black/8 bg-white/86 shadow-none"
      }
      aria-live={manualEvidenceHighlightRunIsActive(run.status) ? "polite" : undefined}
    >
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle>Manual Evidence Highlights</CardTitle>
          <CardDescription>{status.description}</CardDescription>
        </div>
        <Badge tone={status.tone}>{status.badge}</Badge>
      </CardHeader>
      {status.retryable ? (
        <CardContent>
          <form action={retryManualEvidenceHighlightsAction}>
            <input type="hidden" name="workItemId" value={workItemId} />
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <SubmitButton pendingLabel="Queueing retry…">
              Retry automatic Highlights
            </SubmitButton>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
