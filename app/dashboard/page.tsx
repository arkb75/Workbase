import Link from "next/link";
import { ArrowRight, FileText, Layers3, NotebookPen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { listWorkItemsForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import { formatDateRange } from "@/src/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getDemoUser();
  const workItems = await listWorkItemsForUser(user.id);

  const approvedClaims = workItems.reduce(
    (count, workItem) =>
      count +
      workItem.claims.filter((claim) => claim.verificationStatus === "approved").length,
    0,
  );
  const totalClaims = workItems.reduce(
    (count, workItem) => count + workItem.claims.length,
    0,
  );

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Dashboard"
        title="Real work in. Verified artifacts out."
        description="Workbase keeps the loop tight: capture a Work Item, attach evidence, review claims, then generate output from approved material only."
        actions={
          <Link
            href="/work-items/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--ink-strong)] px-4 text-sm font-medium text-white"
          >
            New Work Item
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Work Items</CardTitle>
            <CardDescription>Projects and experience records in the workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {workItems.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approved claims</CardTitle>
            <CardDescription>Only these are eligible for artifact generation.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {approvedClaims}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Claim inventory</CardTitle>
            <CardDescription>Current claims attached across the whole workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {totalClaims}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Start with manual notes, then progress toward claim review and artifact generation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workItems.length ? (
              workItems.map((workItem) => {
                const claimCount = workItem.claims.length;
                const sourceCount = workItem.sources.length;

                return (
                  <Link
                    key={workItem.id}
                    href={`/work-items/${workItem.id}`}
                    className="grid gap-4 rounded-[28px] border border-black/8 bg-[color:var(--panel-muted)] p-5 transition hover:border-[color:var(--accent)] hover:bg-white"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Badge tone="accent">{workItem.type}</Badge>
                          <Badge>{formatDateRange(workItem.startDate, workItem.endDate)}</Badge>
                        </div>
                        <h3 className="font-display text-2xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]">
                          {workItem.title}
                        </h3>
                        <p className="max-w-2xl text-sm leading-6 text-[color:var(--ink-soft)]">
                          {workItem.description}
                        </p>
                      </div>
                      <ArrowRight className="h-5 w-5 text-[color:var(--ink-muted)]" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <KeyValue label="Sources" value={`${sourceCount} attached`} />
                      <KeyValue label="Claims" value={`${claimCount} total`} />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="rounded-[28px] border border-dashed border-black/12 bg-[color:var(--panel-muted)] p-6 text-sm leading-6 text-[color:var(--ink-soft)]">
                No Work Items yet. Create one to start the capture → verify → generate loop.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Product loop</CardTitle>
            <CardDescription>What the v1 prototype does today.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex gap-3">
              <NotebookPen className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Capture sources
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Manual notes first, GitHub repo URLs second.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Layers3 className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Review claims
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Every claim keeps evidence, rationale, risk, visibility, and sensitivity.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <FileText className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Generate artifacts
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Resume bullets, LinkedIn entries, and summaries only use approved claims.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </WorkbaseFrame>
  );
}
