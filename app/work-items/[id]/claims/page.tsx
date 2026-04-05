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
import { ChevronDown, Eye, ShieldAlert, Sparkles, Stamp, Target } from "lucide-react";

export const dynamic = "force-dynamic";

function ClaimSection({
  title,
  description,
  count,
  tone,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  count: number;
  tone: "warning" | "success" | "danger" | "neutral";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-[30px] border border-black/8 bg-white/88 shadow-[0_16px_48px_rgba(15,23,42,0.05)]"
    >
      <summary className="list-none cursor-pointer px-5 py-5 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-2xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]">
                {title}
              </h2>
              <Badge tone={tone}>{count} claims</Badge>
            </div>
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">{description}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2 rounded-full border border-black/8 bg-[color:var(--panel-muted)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
            Toggle
            <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
          </div>
        </div>
      </summary>

      <div className="border-t border-black/6 p-5 pt-4 sm:p-6">{children}</div>
    </details>
  );
}

export default async function ClaimReviewPage({
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
  const generateClaims = generateClaimsAction.bind(null, workItem.id);

  const pendingClaims = workItem.claims.filter(
    (claim) =>
      claim.verificationStatus === "draft" || claim.verificationStatus === "flagged",
  );
  const approvedClaims = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved",
  );
  const rejectedClaims = workItem.claims.filter(
    (claim) => claim.verificationStatus === "rejected",
  );
  const sensitiveClaims = workItem.claims.filter((claim) => claim.sensitivityFlag);
  const claimGenerationTraces = workItem.generationRuns.filter(
    (run) =>
      run.kind === "claim_research" ||
      run.kind === "claim_cluster_research" ||
      run.kind === "claim_merge" ||
      run.kind === "claim_verification" ||
      run.kind === "evidence_clustering",
  );

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Claim review"
        title={`Review claims for ${workItem.title}`}
        description="This should feel like an operating surface, not a document dump. Scan the claim groups, open only the claims you need, and keep approved material clearly separated from everything still under review."
        actions={
          <form action={generateClaims}>
            <SubmitButton pendingLabel="Refreshing claims..." variant="primary">
              Regenerate pending claims
            </SubmitButton>
          </form>
        }
      />

      {error === "invalid-claim" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not save that claim. The submitted form data did not pass validation.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error === "claim-generation-failed" ? (
        <Card className="border-amber-200 bg-amber-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-amber-900">
              Workbase could not generate claims from the current sources. The trace section below has the provider or validation details.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <Card className="border-emerald-200 bg-emerald-50 shadow-none">
          <CardContent className="py-4">
            <p className="text-sm leading-6 text-emerald-900">
              {result === "approved"
                ? "Claim approved. It has moved into the approved section."
                : result === "rejected"
                  ? "Claim rejected. It has moved into the hidden rejected section."
                  : result === "restored"
                    ? "Claim restored to pending review."
                    : "Claim changes saved."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-4">
          <ClaimSection
            title="Pending review"
            description="These are the active claims that still need a human decision."
            count={pendingClaims.length}
            tone="warning"
            defaultOpen
          >
            {pendingClaims.length ? (
              <div className="space-y-4">
                {pendingClaims.map((claim, index) => (
                  <ClaimCard
                    key={claim.id}
                    defaultOpen={index === 0}
                    claim={{
                      ...claim,
                      workItemId: workItem.id,
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No pending claims right now.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Approved"
            description="Approved claims remain compact here until you need to edit or remove one."
            count={approvedClaims.length}
            tone="success"
          >
            {approvedClaims.length ? (
              <div className="space-y-4">
                {approvedClaims.map((claim) => (
                  <ClaimCard
                    key={claim.id}
                    claim={{
                      ...claim,
                      workItemId: workItem.id,
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No approved claims yet.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Rejected"
            description="Hidden by default, but still stored so future generations can avoid repeating the same bad framing."
            count={rejectedClaims.length}
            tone="danger"
          >
            {rejectedClaims.length ? (
              <div className="space-y-4">
                {rejectedClaims.map((claim) => (
                  <ClaimCard
                    key={claim.id}
                    claim={{
                      ...claim,
                      workItemId: workItem.id,
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No rejected claims for this Work Item.
              </p>
            )}
          </ClaimSection>

          <ClaimSection
            title="Generation traces"
            description="Internal records for claim research and verification runs."
            count={claimGenerationTraces.length}
            tone="neutral"
          >
            <GenerationTracePanel
              traces={claimGenerationTraces}
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
                Keep the workflow tight: scan, decide, and only open the claims that need deeper edits.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-[24px] bg-white/8 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/60">Pending</p>
                  <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                    {pendingClaims.length}
                  </p>
                </div>
                <div className="rounded-[24px] bg-white/8 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/60">Approved</p>
                  <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                    {approvedClaims.length}
                  </p>
                </div>
              </div>
              <div className="rounded-[24px] bg-white/8 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-white/60">Sensitive</p>
                <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em]">
                  {sensitiveClaims.length}
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
                <p>Pending claims are where the real work happens. Approved claims should stay comparatively quiet.</p>
              </div>
              <div className="flex gap-3">
                <ShieldAlert className="mt-1 h-4 w-4 shrink-0 text-[color:var(--danger)]" />
                <p>Sensitive claims should default toward caution. The visibility control stays in the claim, not buried in another page.</p>
              </div>
              <div className="flex gap-3">
                <Eye className="mt-1 h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                <p>Rejected claims are hidden, not deleted. They still help the system avoid regenerating the same weak framing.</p>
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
                The claims on this screen are grounded in the current Work Item and its attached sources.
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
