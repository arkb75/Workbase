import { updateClaimAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  KeyValue,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { visibilityOptions } from "@/src/lib/options";

function toneForStatus(status: string) {
  if (status === "approved") {
    return "success" as const;
  }

  if (status === "flagged") {
    return "warning" as const;
  }

  if (status === "rejected") {
    return "danger" as const;
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

export function ClaimCard({
  claim,
}: {
  claim: {
    id: string;
    workItemId: string;
    text: string;
    category: string | null;
    confidence: string;
    ownershipClarity: string;
    sensitivityFlag: boolean;
    verificationStatus: string;
    visibility: string;
    risksSummary: string | null;
    missingInfo: string | null;
    evidenceCard: {
      evidenceSummary: string;
      rationaleSummary: string;
      verificationNotes: string | null;
      sourceRefs: unknown;
    } | null;
  };
}) {
  const action = updateClaimAction.bind(null, claim.id);
  const sourceRefs = Array.isArray(claim.evidenceCard?.sourceRefs)
    ? claim.evidenceCard?.sourceRefs
    : [];
  const isApproved = claim.verificationStatus === "approved";
  const isRejected = claim.verificationStatus === "rejected";
  const isPending =
    claim.verificationStatus === "draft" || claim.verificationStatus === "flagged";

  return (
    <Card className="overflow-hidden">
      <form action={action}>
        <input type="hidden" name="workItemId" value={claim.workItemId} />
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={toneForStatus(claim.verificationStatus)}>
              {claim.verificationStatus.replace("_", " ")}
            </Badge>
            <Badge tone={toneForConfidence(claim.confidence)}>
              {claim.confidence} confidence
            </Badge>
            <Badge>{claim.visibility.replace("_", " ")}</Badge>
            <Badge>{claim.ownershipClarity} ownership</Badge>
            {claim.sensitivityFlag ? <Badge tone="danger">Sensitive</Badge> : null}
          </div>
          <div className="space-y-2">
            <CardTitle>Claim</CardTitle>
            <CardDescription>
              Edit the wording, then decide whether it is ready to approve.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <label className="grid gap-2">
            <span className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
              Claim text
            </span>
            <Textarea name="text" defaultValue={claim.text} className="min-h-32" />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                Visibility
              </span>
              <Select name="visibility" defaultValue={claim.visibility}>
                {visibilityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="flex items-end gap-3 rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] px-4 py-3">
              <input
                type="checkbox"
                name="sensitivityFlag"
                defaultChecked={claim.sensitivityFlag}
                className="mt-1 h-4 w-4 rounded border-black/20 text-[color:var(--accent)]"
              />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Sensitive
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Keep this claim out of public-facing artifacts until you are sure it is safe.
                </p>
              </div>
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <Card className="border-dashed border-black/10 shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Evidence</CardTitle>
                <CardDescription>
                  What Workbase used to justify the wording.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 pt-0">
                <KeyValue
                  label="Evidence summary"
                  value={claim.evidenceCard?.evidenceSummary ?? "No evidence attached."}
                />
                <KeyValue
                  label="Rationale summary"
                  value={
                    claim.evidenceCard?.rationaleSummary ??
                    "No rationale attached."
                  }
                />
                <KeyValue
                  label="Source refs"
                  value={
                    <div className="space-y-2">
                      {sourceRefs.length ? (
                        sourceRefs.map((reference, index) => (
                          <div
                            key={`${claim.id}-ref-${index}`}
                            className="rounded-2xl bg-[color:var(--panel-muted)] px-3 py-2 text-sm"
                          >
                            {typeof reference === "object" && reference
                              ? `${String((reference as { sourceLabel?: string }).sourceLabel ?? "Source")}: ${String((reference as { excerpt?: string }).excerpt ?? "")}`
                              : String(reference)}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-[color:var(--ink-soft)]">
                          No source excerpts attached.
                        </p>
                      )}
                    </div>
                  }
                />
              </CardContent>
            </Card>

            <div className="grid gap-4">
              <Card className="border-dashed border-black/10 shadow-none">
                <CardHeader>
                  <CardTitle className="text-lg">Review notes</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <Textarea
                    name="verificationNotes"
                    defaultValue={claim.evidenceCard?.verificationNotes ?? ""}
                    className="min-h-36"
                  />
                </CardContent>
              </Card>

              <Card className="border-dashed border-black/10 shadow-none">
                <CardHeader>
                  <CardTitle className="text-lg">Uncertainty</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 pt-0">
                  <KeyValue
                    label="Risks"
                    value={claim.risksSummary ?? "No explicit risks captured yet."}
                  />
                  <KeyValue
                    label="Missing info"
                    value={claim.missingInfo ?? "No missing info captured yet."}
                  />
                  {claim.category ? (
                    <KeyValue label="Category" value={claim.category.replace("_", " ")} />
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </div>
        </CardContent>

        <CardFooter className="border-t border-black/6 bg-[color:var(--panel-muted)]">
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
              className="inline-flex h-11 items-center justify-center rounded-full bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700"
            >
              Approve claim
            </button>
          ) : null}
          {!isRejected ? (
            <button
              type="submit"
              name="intent"
              value="reject"
              className="inline-flex h-11 items-center justify-center rounded-full bg-rose-600 px-4 text-sm font-medium text-white transition hover:bg-rose-700"
            >
              {isApproved ? "Remove from approved" : "Reject claim"}
            </button>
          ) : null}
          {isApproved ? (
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              This claim is already approved and will be eligible for artifacts when visibility allows it.
            </p>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
