import Link from "next/link";
import { ArrowRight, FileText, NotebookPen, Plus, SearchCheck, ShieldCheck } from "lucide-react";
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

  const approvedHighlights = workItems.reduce(
    (count, workItem) =>
      count +
      workItem.highlights.filter((highlight) => highlight.verificationStatus === "approved").length,
    0,
  );
  const totalHighlights = workItems.reduce(
    (count, workItem) => count + workItem.highlights.length,
    0,
  );
  const pendingHighlights = totalHighlights - approvedHighlights;

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow="Dashboard"
        title="Capture work. Review the evidence. Ship only what holds up."
        description="This workspace is meant to stay operational. Add a Work Item, attach sources, review highlights, and keep approved material separate from everything still under scrutiny."
        actions={
          <Link
            href="/work-items/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)]"
          >
            <Plus className="h-4 w-4" />
            New Work Item
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="bg-[color:var(--ink-strong)] text-white shadow-[0_24px_60px_rgba(16,33,43,0.18)]">
          <CardHeader>
            <CardTitle className="text-white">Work Items</CardTitle>
            <CardDescription className="text-white/72">
              Projects and experience records in the workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-white">
              {workItems.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approved highlights</CardTitle>
            <CardDescription>Only these are eligible for artifact generation.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {approvedHighlights}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pending review</CardTitle>
            <CardDescription>Highlights still waiting on a decision.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {pendingHighlights}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Highlight inventory</CardTitle>
            <CardDescription>Current reviewed material across the whole workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-display text-5xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              {totalHighlights}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.45fr_0.55fr]">
        <section className="rounded-[32px] border border-black/8 bg-white/86 p-6 shadow-[0_18px_52px_rgba(15,23,42,0.06)]">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--ink-muted)]">
                Workspace
              </p>
              <h2 className="font-display text-2xl font-semibold tracking-[-0.04em] text-[color:var(--ink-strong)]">
                Active Work Items
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-[color:var(--ink-soft)]">
                Treat this as the operating list. Add evidence, review highlights, and move only the strong material toward artifacts.
              </p>
            </div>
            <Badge tone="accent">{workItems.length} items</Badge>
          </div>

          <div className="mt-6 space-y-3">
            {workItems.length ? (
              workItems.map((workItem) => {
                const highlightCount = workItem.highlights.length;
                const sourceCount = workItem.sources.length;
                const pendingCount = workItem.highlights.filter(
                  (highlight) =>
                    highlight.verificationStatus === "draft" ||
                    highlight.verificationStatus === "flagged",
                ).length;

                return (
                  <Link
                    key={workItem.id}
                    href={`/work-items/${workItem.id}`}
                    className="grid gap-4 rounded-[28px] border border-black/8 bg-[color:var(--panel-muted)] p-5 transition hover:-translate-y-0.5 hover:border-[color:var(--accent)]/45 hover:bg-white"
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
                    <div className="grid gap-3 sm:grid-cols-3">
                      <KeyValue label="Sources" value={`${sourceCount} attached`} />
                      <KeyValue label="Highlights" value={`${highlightCount} total`} />
                      <KeyValue label="Pending" value={`${pendingCount} in review`} />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="rounded-[28px] border border-dashed border-black/12 bg-[color:var(--panel-muted)] p-6 text-sm leading-6 text-[color:var(--ink-soft)]">
                No Work Items yet. Create one to start the capture → review → generate loop.
              </div>
            )}
          </div>
        </section>

        <Card className="bg-[color:var(--surface)] shadow-none">
          <CardHeader>
            <CardTitle>Operating loop</CardTitle>
            <CardDescription>What this prototype is optimized to do well.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex gap-3">
              <NotebookPen className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Capture sources
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Manual notes and bounded GitHub imports land in the same evidence pool.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <SearchCheck className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Review highlights
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Every highlight keeps evidence lineage, tags, visibility, and sensitivity.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <ShieldCheck className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Keep the bar high
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Sensitive, weak, or overstated highlights stay visible for review but separate from approved material.
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
                  Resume bullets, LinkedIn entries, and summaries retrieve approved highlights first, then bounded supporting evidence.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </WorkbaseFrame>
  );
}
