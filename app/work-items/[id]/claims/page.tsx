import { generateClaimsAction } from "@/app/actions";
import { ClaimCard } from "@/components/claims/claim-card";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import { titleCase } from "@/src/lib/utils";
import { Eye, ShieldAlert, Sparkles, Stamp, Target } from "lucide-react";

export const dynamic = "force-dynamic";

function ClaimSection({
  title,
  description,
  count,
  tone,
  children,
}: {
  title: string;
  description: string;
  count: number;
  tone: "warning" | "success" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={tone}>{count} highlights</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function mapHighlightForCard(
  workItemId: string,
  highlight: Awaited<ReturnType<typeof getWorkItemForUser>>["highlights"][number],
) {
  return {
    id: highlight.id,
    workItemId,
    text: highlight.text,
    summary: highlight.summary,
    confidence: highlight.confidence,
    ownershipClarity: highlight.ownershipClarity,
    sensitivityFlag: highlight.sensitivityFlag,
    verificationStatus: highlight.verificationStatus,
    visibility: highlight.visibility,
    risksSummary: highlight.risksSummary,
    missingInfo: highlight.missingInfo,
    rejectionReason: highlight.rejectionReason,
    verificationNotes: highlight.verificationNotes,
    evidence: {
      summary: highlight.summary,
      verificationNotes: highlight.verificationNotes,
      sourceRefs: highlight.evidence.map((entry) => ({
        evidenceItemId: entry.evidenceItemId,
        sourceId: entry.evidenceItem.sourceId,
        sourceLabel: entry.evidenceItem.source.label,
        sourceType: entry.evidenceItem.source.type,
        title: entry.evidenceItem.title,
        excerpt: entry.evidenceItem.content,
      })),
    },
    tags: highlight.tags.map((tag) => ({
      dimension: tag.dimension,
      tag: tag.tag,
      score: tag.score,
    })),
  };
}

export default async function HighlightReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; result?: string }>;
}) {
  const { id } = await params;
  const { error, result } = await searchParams;
  const user = await getDemoUser();
  const workItem = await getWorkItemForUser(user.id, id);
  const generateHighlights = generateClaimsAction.bind(null, workItem.id);

  const pendingHighlights = workItem.highlights.filter(
    (highlight) =>
      highlight.verificationStatus === "draft" || highlight.verificationStatus === "flagged",
  );
  const approvedHighlights = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "approved",
  );
  const rejectedHighlights = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "rejected",
  );
  const sensitiveHighlights = workItem.highlights.filter((highlight) => highlight.sensitivityFlag);
  const generationTraces = workItem.generationRuns.filter(
    (run) =>
      run.kind === "highlight_generation" ||
      run.kind === "highlight_verification" ||
      run.kind === "artifact_retrieval" ||
      run.kind === "artifact_generation",
  );

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Highlight review"
        title={`Review highlights for ${workItem.title}`}
        description="Scan the highlight groups, edit only what needs intervention, and keep approved material clearly separated from everything still under review."
        actions={
          <form action={generateHighlights}>
            <SubmitButton pendingLabel="Refreshing highlights..." variant="primary">
              Regenerate pending highlights
            </SubmitButton>
          </form>
        }
      />

      {error === "invalid-claim" || error === "invalid-highlight" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not save that highlight. The submitted form data did not pass validation.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error === "claim-generation-failed" || error === "highlight-generation-failed" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not generate highlights from the current sources. The trace section below has the provider or validation details.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <Card className="border-emerald-200 bg-emerald-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-emerald-900">
              {result === "approved"
                ? "Highlight approved. It has moved into the approved section."
                : result === "rejected"
                  ? "Highlight rejected. It has moved into the hidden rejected section."
                  : result === "restored"
                    ? "Highlight restored to pending review."
                    : "Highlight changes saved."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-4">
          <ClaimSection
            title="Pending review"
            description="These are the active highlights that still need a human decision."
            count={pendingHighlights.length}
            tone="warning"
          >
            {pendingHighlights.length ? (
              <div className="space-y-4">
                {pendingHighlights.map((highlight, index) => (
                  <ClaimCard
                    key={highlight.id}
                    defaultOpen={index === 0}
                    claim={mapHighlightForCard(workItem.id, highlight)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No pending highlights right now.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Approved"
            description="Approved highlights remain compact here until you need to edit or remove one."
            count={approvedHighlights.length}
            tone="success"
          >
            {approvedHighlights.length ? (
              <div className="space-y-4">
                {approvedHighlights.map((highlight) => (
                  <ClaimCard
                    key={highlight.id}
                    claim={mapHighlightForCard(workItem.id, highlight)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No approved highlights yet.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Rejected"
            description="Hidden by default, but still stored so future generations can avoid repeating the same bad framing."
            count={rejectedHighlights.length}
            tone="danger"
          >
            {rejectedHighlights.length ? (
              <div className="space-y-4">
                {rejectedHighlights.map((highlight) => (
                  <ClaimCard
                    key={highlight.id}
                    claim={mapHighlightForCard(workItem.id, highlight)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No rejected highlights for this Work Item.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Generation traces"
            description="Internal records for highlight generation, verification, retrieval, and artifact runs."
            count={generationTraces.length}
            tone="neutral"
          >
            <GenerationTracePanel
              traces={generationTraces}
              title="Generation traces"
              description="Provider responses, parsed payloads, validation failures, and persisted result refs."
            />
          </ClaimSection>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <Card className="overflow-hidden bg-[color:var(--ink-strong)] text-white shadow-[0_24px_60px_rgba(16,33,43,0.18)]">
            <CardHeader>
              <CardTitle className="text-white">Review summary</CardTitle>
              <CardDescription className="text-white/72">
                Keep the workflow tight: scan, decide, and only open the highlights that need deeper edits.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-[24px] bg-white/8 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/60">Pending</p>
                  <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                    {pendingHighlights.length}
                  </p>
                </div>
                <div className="rounded-[24px] bg-white/8 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/60">Approved</p>
                  <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                    {approvedHighlights.length}
                  </p>
                </div>
              </div>
              <div className="rounded-[24px] bg-white/8 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-white/60">Sensitive</p>
                <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                  {sensitiveHighlights.length}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-[color:var(--surface)] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5 text-[color:var(--accent)]" />
                Review discipline
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-6 text-[color:var(--ink-soft)]">
              <div className="flex gap-3">
                <Stamp className="mt-1 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <p>Pending highlights are where the real work happens. Approved highlights should stay comparatively quiet.</p>
              </div>
              <div className="flex gap-3">
                <ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-[color:var(--danger)]" />
                <p>Sensitive highlights should default toward caution. The visibility control stays on the highlight, not buried in another page.</p>
              </div>
              <div className="flex gap-3">
                <Eye className="mt-1 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <p>Rejected highlights are hidden, not deleted. They still help the system avoid regenerating the same weak framing.</p>
              </div>
              <div className="flex gap-3">
                <Sparkles className="mt-1 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <p>Every verification trace stays accessible here because debugging blind is a waste of time.</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Work Item context</CardTitle>
              <CardDescription>
                The highlights on this screen are grounded in the current Work Item and its attached sources.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[24px] bg-[color:var(--panel-muted)] p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Type
                </p>
                <p className="mt-2 text-sm font-medium text-[color:var(--ink-strong)]">
                  {titleCase(workItem.type)}
                </p>
              </div>
              <div className="rounded-[24px] bg-[color:var(--panel-muted)] p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Sources
                </p>
                <p className="mt-2 text-sm font-medium text-[color:var(--ink-strong)]">
                  {workItem.sources.length} attached
                </p>
              </div>
              <div className="rounded-[24px] bg-[color:var(--panel-muted)] p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
                  Description
                </p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--ink-strong)]">
                  {workItem.description}
                </p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </section>
    </WorkbaseFrame>
  );
}
