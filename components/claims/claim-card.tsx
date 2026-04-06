"use client";

import { updateClaimAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { visibilityOptions } from "@/src/lib/options";
import { titleCase } from "@/src/lib/utils";
import { ChevronDown, Info, ShieldAlert } from "lucide-react";

function toneForStatus(status: string) {
  if (status === "approved") {
    return "success" as const;
  }

  if (status === "rejected") {
    return "danger" as const;
  }

  if (status === "flagged") {
    return "warning" as const;
  }

  return "neutral" as const;
}

function toneForConfidence(confidence: string) {
  if (confidence === "high") {
    return "accent" as const;
  }

  if (confidence === "medium") {
    return "neutral" as const;
  }

  return "warning" as const;
}

function summarizeSignal(claim: {
  verificationStatus: string;
  risksSummary: string | null;
  missingInfo: string | null;
  summary: string;
}) {
  if (claim.verificationStatus === "approved") {
    return "Approved and available for retrieval-driven artifact generation when visibility allows it.";
  }

  if (claim.verificationStatus === "rejected") {
    return claim.risksSummary ?? "Rejected highlights stay hidden from the main workflow but still guide future generations.";
  }

  return (
    claim.risksSummary ??
    claim.missingInfo ??
    claim.summary ??
    "Review the evidence and decide whether this wording should survive."
  );
}

function FieldLabel({
  label,
  tooltip,
}: {
  label: string;
  tooltip?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
        {label}
      </p>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[color:var(--ink-muted)] transition hover:text-[color:var(--ink-strong)]"
              aria-label={`${label} help`}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function ClaimCard({
  claim,
  defaultOpen = false,
}: {
  claim: {
    id: string;
    workItemId: string;
    text: string;
    summary: string;
    confidence: string;
    ownershipClarity: string;
    sensitivityFlag: boolean;
    verificationStatus: string;
    visibility: string;
    risksSummary: string | null;
    missingInfo: string | null;
    rejectionReason: string | null;
    verificationNotes: string | null;
    evidence: {
      summary: string;
      verificationNotes: string | null;
      sourceRefs: unknown;
    };
    tags: Array<{
      dimension: string;
      tag: string;
      score: number | null;
    }>;
  };
  defaultOpen?: boolean;
}) {
  const action = updateClaimAction.bind(null, claim.id);
  const sensitivityInputId = `highlight-sensitive-${claim.id}`;
  const sourceRefs = Array.isArray(claim.evidence?.sourceRefs)
    ? claim.evidence?.sourceRefs
    : [];
  const isApproved = claim.verificationStatus === "approved";
  const isRejected = claim.verificationStatus === "rejected";
  const isPending =
    claim.verificationStatus === "draft" || claim.verificationStatus === "flagged";
  const summaryCopy = summarizeSignal(claim);
  const compactSourceRefs = sourceRefs.slice(0, 3);
  const compactTags = claim.tags.slice(0, 4);

  return (
    <details
      open={defaultOpen}
      className={[
        "group rounded-[28px] border bg-white shadow-[0_16px_40px_rgba(15,23,42,0.05)]",
        isApproved
          ? "border-emerald-200/80"
          : isRejected
            ? "border-rose-200/80 bg-rose-50/55"
            : claim.verificationStatus === "flagged"
              ? "border-amber-200/80"
              : "border-black/8",
      ].join(" ")}
    >
      <summary className="list-none cursor-pointer p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={toneForStatus(claim.verificationStatus)}>
                {titleCase(claim.verificationStatus)}
              </Badge>
              <Badge tone={toneForConfidence(claim.confidence)}>
                {titleCase(claim.confidence)} confidence
              </Badge>
              <Badge>{titleCase(claim.visibility)}</Badge>
              <Badge>{titleCase(claim.ownershipClarity)} ownership</Badge>
              {compactTags.map((tag) => (
                <Badge key={`${claim.id}-${tag.dimension}-${tag.tag}`}>
                  {titleCase(tag.tag)}
                </Badge>
              ))}
              {claim.sensitivityFlag ? (
                <Badge tone="danger">
                  <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                  Sensitive
                </Badge>
              ) : null}
            </div>

            <div className="space-y-2">
              <h3 className="font-display text-xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]">
                {claim.text}
              </h3>
              <p className="line-clamp-2 max-w-4xl text-sm leading-6 text-[color:var(--ink-soft)]">
                {summaryCopy}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 rounded-full border border-black/8 bg-[color:var(--panel-muted)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
            Open
            <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
          </div>
        </div>
      </summary>

      <form action={action} className="border-t border-black/6">
        <input type="hidden" name="workItemId" value={claim.workItemId} />

        <div className="grid gap-4 p-5 sm:p-6 xl:grid-cols-[1.1fr_0.9fr]">
          <section className="space-y-4">
            <div className="space-y-2">
              <FieldLabel label="Highlight text" />
              <Textarea name="text" defaultValue={claim.text} className="min-h-28 bg-white" />
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-[24px] border border-black/8 bg-[color:var(--surface)] px-4 py-3">
              <label className="flex min-w-[12rem] items-center gap-3">
                <FieldLabel label="Visibility" />
                <Select
                  name="visibility"
                  defaultValue={claim.visibility}
                  className="h-10 min-w-[10rem] w-auto rounded-full bg-white"
                >
                  {visibilityOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>

              <div className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-white px-3 py-2">
                <input
                  id={sensitivityInputId}
                  type="checkbox"
                  name="sensitivityFlag"
                  defaultChecked={claim.sensitivityFlag}
                  className="h-4 w-4 rounded border-black/20 text-[color:var(--accent)]"
                />
                <label
                  htmlFor={sensitivityInputId}
                  className="text-sm font-medium text-[color:var(--ink-strong)]"
                >
                  Sensitive
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[color:var(--ink-muted)] transition hover:text-[color:var(--ink-strong)]"
                      aria-label="Sensitive help"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p>Keep this highlight out of public artifacts until you are confident it is safe to share.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <section className="grid gap-2 rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
              <FieldLabel
                label="Review notes"
                tooltip="Short reviewer context for this highlight. Keep only what helps the next decision."
              />
              <Textarea
                name="verificationNotes"
                defaultValue={claim.verificationNotes ?? ""}
                className="min-h-24 bg-white"
              />
            </section>

            <section className="grid gap-2 rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
              <FieldLabel
                label="Rejection reason"
                tooltip="Optional. Stored rejected highlights use this as future negative guidance."
              />
              <Textarea
                name="rejectionReason"
                defaultValue={claim.rejectionReason ?? ""}
                className="min-h-24 bg-white"
                placeholder="Example: Overstates impact, unclear ownership, or still too sensitive."
              />
            </section>
          </section>

          <section className="space-y-4">
            <div className="rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
              <FieldLabel label="Evidence summary" />
              <p className="mt-2 text-sm leading-6 text-[color:var(--ink-strong)]">
                {claim.evidence?.summary ?? "No evidence attached."}
              </p>
            </div>

            <div className="rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
              <FieldLabel label="Verification notes" />
              <p className="mt-2 text-sm leading-6 text-[color:var(--ink-strong)]">
                {claim.verificationNotes ?? "No verification notes attached."}
              </p>
            </div>

            <div className="rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
              <FieldLabel
                label="Source refs"
                tooltip="Quick evidence excerpts. Open the Work Item if you need the full source list."
              />
              <div className="mt-3 space-y-2">
                {compactSourceRefs.length ? (
                  compactSourceRefs.map((reference, index) => (
                    <div
                      key={`${claim.id}-ref-${index}`}
                      className="rounded-2xl bg-white px-3 py-2 text-sm leading-6 text-[color:var(--ink-strong)]"
                    >
                      {typeof reference === "object" && reference
                        ? `${String((reference as { sourceLabel?: string }).sourceLabel ?? "Source")}: ${String((reference as { excerpt?: string }).excerpt ?? "")}`
                        : String(reference)}
                    </div>
                  ))
                ) : (
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    No source excerpts attached.
                  </p>
                )}
                {sourceRefs.length > compactSourceRefs.length ? (
                  <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                    +{sourceRefs.length - compactSourceRefs.length} more refs
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
                <FieldLabel label="Risks" />
                <p className="mt-2 text-sm leading-6 text-[color:var(--ink-strong)]">
                  {claim.risksSummary ?? "No explicit risks captured yet."}
                </p>
              </div>

              <div className="rounded-[24px] border border-black/8 bg-[color:var(--surface)] p-4">
                <FieldLabel label="Missing info" />
                <p className="mt-2 text-sm leading-6 text-[color:var(--ink-strong)]">
                  {claim.missingInfo ?? "No missing info captured yet."}
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-black/6 bg-[color:var(--panel-muted)] p-5 sm:p-6">
          {isRejected ? (
            <>
              <label className="grid min-w-[15rem] gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Rejected highlight action
                </span>
                <Select
                  name="intent"
                  defaultValue="save"
                  className="h-10 min-w-[12rem] rounded-full bg-white"
                >
                  <option value="save">Save edits</option>
                  <option value="approve">Approve highlight</option>
                  <option value="restore">Restore to review</option>
                </Select>
              </label>
              <button
                type="submit"
                className="inline-flex h-11 items-center justify-center rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)] [color:white]"
              >
                Apply action
              </button>
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                Rejected highlights stay off artifacts but remain useful as guidance.
              </p>
            </>
          ) : (
            <>
              <button
                type="submit"
                name="intent"
                value="save"
                className="inline-flex h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-[color:var(--ink-strong)] ring-1 ring-black/10 transition hover:bg-[color:var(--surface)]"
              >
                Save edits
              </button>
              {isPending ? (
              <button
                type="submit"
                name="intent"
                value="approve"
                className="inline-flex h-11 items-center justify-center rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white transition hover:bg-[color:var(--accent-strong)] [color:white]"
              >
                Approve highlight
              </button>
              ) : null}
              <button
                type="submit"
                name="intent"
                value="reject"
                className="inline-flex h-11 items-center justify-center rounded-full bg-rose-600 px-4 text-sm font-medium text-white transition hover:bg-rose-700"
              >
                {isApproved ? "Move to rejected" : "Reject highlight"}
              </button>
            </>
          )}
        </div>
      </form>
    </details>
  );
}
