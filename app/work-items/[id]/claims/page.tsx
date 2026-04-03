import { generateClaimsAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { ClaimCard } from "@/components/claims/claim-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";

export const dynamic = "force-dynamic";

export default async function ClaimReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getDemoUser();
  const workItem = await getWorkItemForUser(user.id, id);
  const generateClaims = generateClaimsAction.bind(null, workItem.id);

  const approved = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved",
  ).length;
  const flagged = workItem.claims.filter(
    (claim) => claim.verificationStatus === "flagged",
  ).length;

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Claim review"
        title={`Review claims for ${workItem.title}`}
        description="This is the core Workbase surface. Every claim stays grounded in evidence, rationale, risk, visibility, and sensitivity before it can feed an artifact."
        actions={
          <form action={generateClaims}>
            <SubmitButton pendingLabel="Refreshing claims..." variant="secondary">
              Regenerate pending claims
            </SubmitButton>
          </form>
        }
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Total claims</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {workItem.claims.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approved</CardTitle>
            <CardDescription>Eligible for artifacts when visibility also matches.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {approved}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Flagged</CardTitle>
            <CardDescription>Claims needing caution on wording or sensitivity.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {flagged}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4">
        {workItem.claims.length ? (
          workItem.claims.map((claim) => (
            <ClaimCard
              key={claim.id}
              claim={{
                ...claim,
                workItemId: workItem.id,
              }}
            />
          ))
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>No claims yet</CardTitle>
              <CardDescription>
                Generate candidate claims from the attached sources before starting review.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={generateClaims}>
                <SubmitButton pendingLabel="Generating claims...">
                  Generate candidate claims
                </SubmitButton>
              </form>
            </CardContent>
          </Card>
        )}
      </section>
    </WorkbaseFrame>
  );
}
