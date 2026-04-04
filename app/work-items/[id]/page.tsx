import Link from "next/link";
import { ArrowRight, FolderGit2, ListChecks, Sparkles } from "lucide-react";
import {
  createGithubSourceAction,
  createManualSourceAction,
  generateClaimsAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KeyValue } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import { formatDateRange } from "@/src/lib/utils";

export const dynamic = "force-dynamic";

export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getDemoUser();
  const workItem = await getWorkItemForUser(user.id, id);
  const generateClaims = generateClaimsAction.bind(null, workItem.id);

  const approvedClaimCount = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved",
  ).length;
  const flaggedClaimCount = workItem.claims.filter(
    (claim) => claim.verificationStatus === "flagged",
  ).length;

  return (
    <WorkbaseFrame>
      <PageHeader
        eyebrow={workItem.type === "project" ? "Project" : "Experience"}
        title={workItem.title}
        description={workItem.description}
        actions={
          <>
            <Link
              href={`/work-items/${workItem.id}/claims`}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-[color:var(--ink-strong)] ring-1 ring-black/8"
            >
              Claim review
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href={`/work-items/${workItem.id}/artifacts/new`}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)] [color:white] [&_svg]:text-white"
            >
              Artifact generator
              <ArrowRight className="h-4 w-4" />
            </Link>
          </>
        }
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {formatDateRange(workItem.startDate, workItem.endDate)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Source coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {workItem.sources.length}
            </p>
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              notes and repo placeholders attached
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Claim status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {approvedClaimCount} approved, {flaggedClaimCount} flagged,{" "}
              {workItem.claims.length} total
            </p>
            <form action={generateClaims}>
              <SubmitButton pendingLabel="Generating claims..." variant="secondary">
                Generate candidate claims
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Attached sources</CardTitle>
            <CardDescription>
              Manual notes drive the full v1 loop. GitHub repo fields are stored as placeholders.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {workItem.sources.length ? (
              workItem.sources.map((source) => (
                <div
                  key={source.id}
                  className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={source.type === "manual_note" ? "accent" : "neutral"}>
                      {source.type.replace("_", " ")}
                    </Badge>
                    <Badge>{source.label}</Badge>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--ink-soft)]">
                    {source.rawContent ??
                      (typeof source.metadata === "object" &&
                      source.metadata &&
                      "repoUrl" in source.metadata
                        ? String(source.metadata.repoUrl)
                        : "Stored placeholder source")}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                No sources attached yet.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <form action={createManualSourceAction}>
              <input type="hidden" name="workItemId" value={workItem.id} />
              <CardHeader>
                <CardTitle>Add manual notes</CardTitle>
                <CardDescription>
                  Capture implementation details, scope, collaborators, and anything that still needs verification.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Label
                  </span>
                  <Input name="label" defaultValue="Manual notes" />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Notes
                  </span>
                  <Textarea
                    name="rawContent"
                    placeholder="Example: Implemented a Next.js admin surface, normalized import jobs, and collaborated with a PM on user-safe wording."
                  />
                </label>
                <SubmitButton pendingLabel="Saving note...">
                  Add note source
                </SubmitButton>
              </CardContent>
            </form>
          </Card>

          <Card>
            <form action={createGithubSourceAction}>
              <input type="hidden" name="workItemId" value={workItem.id} />
              <CardHeader>
                <CardTitle>Add GitHub repo placeholder</CardTitle>
                <CardDescription>
                  Store the repo URL now. Live ingestion can be swapped in later behind the same service boundary.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Label
                  </span>
                  <Input name="label" defaultValue="GitHub repo" />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Repo URL
                  </span>
                  <Input
                    name="repoUrl"
                    placeholder="https://github.com/username/repository"
                  />
                </label>
                <SubmitButton pendingLabel="Saving repo...">
                  Add repo placeholder
                </SubmitButton>
              </CardContent>
            </form>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Where this Work Item stands right now.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex gap-3">
              <Sparkles className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Claim generation
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Replaces only draft and flagged claims, while keeping approved claims intact.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <ListChecks className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Claim review
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Every claim stays editable with evidence, risks, visibility, and sensitivity controls.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <FolderGit2 className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Artifact generation
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Artifacts only consume approved, non-sensitive claims that match the selected visibility.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current inventory</CardTitle>
            <CardDescription>
              Quick scan of claims and artifacts attached to this Work Item.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <KeyValue
              label="Claims"
              value={`${workItem.claims.length} total / ${approvedClaimCount} approved`}
            />
            <KeyValue
              label="Artifacts"
              value={`${workItem.artifacts.length} generated`}
            />
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/work-items/${workItem.id}/claims`}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white"
              >
                Open claim review
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href={`/work-items/${workItem.id}/artifacts/new`}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-[color:var(--ink-strong)] ring-1 ring-black/8"
              >
                Open artifact generator
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>
    </WorkbaseFrame>
  );
}
