import Link from "next/link";
import { ArrowRight, FolderGit2, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import {
  attachGithubRepoAction,
  createManualSourceAction,
  generateClaimsAction,
  toggleEvidenceInclusionAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
import { CollapsibleCard } from "@/components/ui/collapsible-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KeyValue,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import { syncManualEvidenceItemsForWorkItem } from "@/src/lib/evidence-persistence";
import { formatDateRange, formatDateTime, titleCase } from "@/src/lib/utils";
import { githubAuthService } from "@/src/services/github-auth-service";
import type { GitHubRepositorySummary } from "@/src/services/types";

export const dynamic = "force-dynamic";

function readSourceMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getSourceImportedAt(value: unknown) {
  const metadata = readSourceMetadata(value);
  return typeof metadata?.importedAt === "string" ? metadata.importedAt : null;
}

function getRepositoryFullName(value: unknown) {
  const metadata = readSourceMetadata(value);
  const repository =
    metadata?.repository && typeof metadata.repository === "object" && !Array.isArray(metadata.repository)
      ? (metadata.repository as Record<string, unknown>)
      : null;

  return typeof repository?.fullName === "string" ? repository.fullName : null;
}

function getEvidenceTypeCounts(
  evidenceItems: Awaited<ReturnType<typeof getWorkItemForUser>>["evidenceItems"],
) {
  return evidenceItems.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.type] = (accumulator[item.type] ?? 0) + 1;
    return accumulator;
  }, {});
}

function buildStatusMessage(error?: string, result?: string) {
  if (error === "invalid-note") {
    return {
      tone: "error" as const,
      message: "Workbase could not save that note. Check the label and note length and try again.",
    };
  }

  if (error === "invalid-repo") {
    return {
      tone: "error" as const,
      message:
        "Workbase could not import that repository selection. Try selecting a repo from the connected list again.",
    };
  }

  if (error === "github-config") {
    return {
      tone: "error" as const,
      message:
        "GitHub integration is not configured yet. Add the GitHub OAuth environment variables before connecting.",
    };
  }

  if (error === "github-state") {
    return {
      tone: "error" as const,
      message:
        "Workbase could not verify the GitHub callback state. Start the GitHub connection flow again.",
    };
  }

  if (error === "github-connect-failed") {
    return {
      tone: "error" as const,
      message:
        "Workbase could not complete the GitHub connection. The OAuth exchange or token storage failed.",
    };
  }

  if (error === "github-import-failed") {
    return {
      tone: "error" as const,
      message:
        "Workbase could not import bounded GitHub evidence from that repository. Existing evidence was left unchanged.",
    };
  }

  if (error === "invalid-evidence") {
    return {
      tone: "error" as const,
      message: "Workbase could not update that evidence item. Reload the page and try again.",
    };
  }

  if (result === "github-connected") {
    return {
      tone: "success" as const,
      message:
        "GitHub connected. You can now search accessible repositories and import bounded evidence into this Work Item.",
    };
  }

  if (result === "github-imported") {
    return {
      tone: "success" as const,
      message:
        "GitHub repository imported. The latest README, commits, pull requests, issues, and releases are now in the evidence pool.",
    };
  }

  if (result === "evidence-included") {
    return {
      tone: "success" as const,
      message:
        "Evidence included. It can now participate in highlight generation and artifact retrieval.",
    };
  }

  if (result === "evidence-excluded") {
    return {
      tone: "success" as const,
      message:
        "Evidence excluded. It stays persisted, but Workbase will keep it out of highlight generation and artifact retrieval.",
    };
  }

  return null;
}

function StatusBanner({ error, result }: { error?: string; result?: string }) {
  const status = buildStatusMessage(error, result);

  if (!status) {
    return null;
  }

  const isError = status.tone === "error";

  return (
    <Card
      className={
        isError
          ? "border-amber-200 bg-amber-50 shadow-none"
          : "border-emerald-200 bg-emerald-50 shadow-none"
      }
    >
      <CardContent className="py-4">
        <p className={isError ? "text-sm leading-6 text-amber-900" : "text-sm leading-6 text-emerald-900"}>
          {status.message}
        </p>
      </CardContent>
    </Card>
  );
}

function GitHubRepoRow({
  repository,
  workItemId,
  attached,
}: {
  repository: GitHubRepositorySummary;
  workItemId: string;
  attached: boolean;
}) {
  return (
    <div className="rounded-[24px] border border-black/8 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={attached ? "accent" : "neutral"}>
              {attached ? "Attached" : "Available"}
            </Badge>
            <Badge>{repository.private ? "private repo" : "public repo"}</Badge>
            <Badge>{repository.defaultBranch}</Badge>
          </div>
          <div>
            <p className="text-sm font-medium text-[color:var(--ink-strong)]">
              {repository.fullName}
            </p>
            <p className="mt-1 text-sm leading-6 text-[color:var(--ink-soft)]">
              {repository.description || "No repository description provided."}
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--ink-muted)]">
            {repository.updatedAt ? `Updated ${formatDateTime(repository.updatedAt)}` : "Update time unavailable"}
          </p>
        </div>

        <form action={attachGithubRepoAction} className="shrink-0">
          <input type="hidden" name="workItemId" value={workItemId} />
          <input type="hidden" name="repositoryId" value={repository.id} />
          <input type="hidden" name="repositoryFullName" value={repository.fullName} />
          <SubmitButton
            pendingLabel={attached ? "Refreshing import..." : "Importing repo..."}
            variant={attached ? "secondary" : "primary"}
            size="sm"
          >
            {attached ? "Re-import" : "Attach & import"}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

export default async function WorkItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    result?: string;
    repoQuery?: string;
  }>;
}) {
  const { id } = await params;
  const { error, result, repoQuery = "" } = await searchParams;
  const user = await getDemoUser();

  await syncManualEvidenceItemsForWorkItem(id);

  const [workItem, githubConnection] = await Promise.all([
    getWorkItemForUser(user.id, id),
    githubAuthService.getConnection(user.id),
  ]);
  const generateHighlights = generateClaimsAction.bind(null, workItem.id);

  let repositories: GitHubRepositorySummary[] = [];
  let repositoryLookupFailed = false;

  if (githubConnection) {
    try {
      repositories = await githubAuthService.listRepositories({
        userId: user.id,
        query: repoQuery,
      });
    } catch {
      repositoryLookupFailed = true;
    }
  }

  const approvedHighlightCount = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "approved",
  ).length;
  const pendingHighlightCount = workItem.highlights.filter(
    (highlight) =>
      highlight.verificationStatus === "draft" ||
      highlight.verificationStatus === "flagged",
  ).length;
  const rejectedHighlightCount = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "rejected",
  ).length;
  const includedEvidenceItems = workItem.evidenceItems.filter((item) => item.included);
  const excludedEvidenceItems = workItem.evidenceItems.filter((item) => !item.included);
  const githubSources = workItem.sources.filter((source) => source.type === "github_repo");
  const attachedRepoIds = new Set(
    githubSources
      .map((source) => source.externalId)
      .filter((value): value is string => Boolean(value)),
  );
  const evidenceTypeCounts = getEvidenceTypeCounts(workItem.evidenceItems);

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
              Highlight review
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

      <StatusBanner error={error} result={result} />

      <section className="grid gap-4 lg:grid-cols-4">
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
            <CardTitle>Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {workItem.sources.length}
            </p>
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {githubSources.length} GitHub source{githubSources.length === 1 ? "" : "s"}, {workItem.sources.length - githubSources.length} manual
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Evidence pool</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="font-display text-4xl font-semibold tracking-[-0.05em] text-[color:var(--ink-strong)]">
              {includedEvidenceItems.length}
            </p>
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              included, {excludedEvidenceItems.length} excluded
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Highlight pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {approvedHighlightCount} approved, {pendingHighlightCount} pending, {rejectedHighlightCount} rejected
            </p>
            <form action={generateHighlights}>
              <SubmitButton pendingLabel="Generating highlights..." variant="secondary">
                Generate highlights
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <CollapsibleCard
          title="Attached sources"
          description="Manual notes and imported GitHub repositories are the upstream source records for this Work Item."
          meta={<Badge>{workItem.sources.length} attached</Badge>}
          bodyClassName="space-y-4"
        >
          {workItem.sources.length ? (
            workItem.sources.map((source) => {
              const importedAt = getSourceImportedAt(source.metadata);
              const repositoryFullName = getRepositoryFullName(source.metadata);

              return (
                <div
                  key={source.id}
                  className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={source.type === "manual_note" ? "accent" : "neutral"}>
                      {titleCase(source.type)}
                    </Badge>
                    <Badge>{source.label}</Badge>
                    {source.externalId ? <Badge>external {source.externalId}</Badge> : null}
                    {importedAt ? <Badge>imported {formatDateTime(importedAt)}</Badge> : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--ink-soft)]">
                    {source.rawContent ??
                      repositoryFullName ??
                      "Structured metadata-backed source attached to this Work Item."}
                  </p>
                </div>
              );
            })
          ) : (
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              No sources attached yet.
            </p>
          )}
        </CollapsibleCard>

        <div className="grid gap-4">
          <Card>
            <form action={createManualSourceAction}>
              <input type="hidden" name="workItemId" value={workItem.id} />
              <CardHeader>
                <CardTitle>Add manual notes</CardTitle>
                <CardDescription>
                  Notes land in the same evidence pool as imported GitHub material and stay directly retrievable.
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
                    placeholder="Example: Added a queue-backed import worker, tightened auth checks, and paired with a PM on safer public wording."
                  />
                </label>
                <SubmitButton pendingLabel="Saving note...">
                  Add note source
                </SubmitButton>
              </CardContent>
            </form>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>GitHub import</CardTitle>
              <CardDescription>
                Connect GitHub, list accessible repositories, and import bounded evidence into the same review flow.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {githubConnection ? (
                <>
                  <div className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="success">Connected</Badge>
                      <Badge>@{githubConnection.login}</Badge>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[color:var(--ink-soft)]">
                      Search the connected account’s repositories and attach one to this Work Item.
                    </p>
                  </div>

                  <form method="GET" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div className="grid gap-2">
                      <label
                        htmlFor="repoQuery"
                        className="text-sm font-medium text-[color:var(--ink-strong)]"
                      >
                        Search repositories
                      </label>
                      <Input
                        id="repoQuery"
                        name="repoQuery"
                        defaultValue={repoQuery}
                        placeholder="Filter by owner, repo, or description"
                      />
                    </div>
                    <button
                      type="submit"
                      className="inline-flex h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-[color:var(--ink-strong)] ring-1 ring-black/10 transition hover:bg-[color:var(--panel-muted)]"
                    >
                      Refresh list
                    </button>
                  </form>

                  {repositoryLookupFailed ? (
                    <p className="text-sm leading-6 text-[color:var(--danger)]">
                      Workbase could not list repositories for the current GitHub connection.
                    </p>
                  ) : repositories.length ? (
                    <div className="grid gap-3">
                      {repositories.map((repository) => (
                        <GitHubRepoRow
                          key={repository.id}
                          repository={repository}
                          workItemId={workItem.id}
                          attached={attachedRepoIds.has(repository.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                      No repositories matched this filter.
                    </p>
                  )}
                </>
              ) : (
                <div className="grid gap-4 rounded-[24px] border border-dashed border-black/10 bg-white p-5">
                  <div className="flex items-start gap-3">
                    <FolderGit2 className="mt-0.5 h-5 w-5 text-[color:var(--accent)]" />
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                        GitHub is not connected yet
                      </p>
                      <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                        Connect the demo user’s GitHub account to list accessible repositories and import bounded evidence.
                      </p>
                    </div>
                  </div>
                  <Link
                    href={`/api/github/connect?returnTo=${encodeURIComponent(`/work-items/${workItem.id}`)}`}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)]"
                  >
                    <FolderGit2 className="h-4 w-4" />
                    Connect GitHub
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <CollapsibleCard
          title="Evidence review"
          description="Included evidence can be used for highlight generation and retrieval. Excluded evidence stays persisted but out of both steps."
          meta={
            <>
              <Badge tone="accent">{includedEvidenceItems.length} included</Badge>
              <Badge>{excludedEvidenceItems.length} excluded</Badge>
            </>
          }
          bodyClassName="grid gap-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{includedEvidenceItems.length} included</Badge>
            <Badge>{excludedEvidenceItems.length} excluded</Badge>
            {Object.entries(evidenceTypeCounts).map(([type, count]) => (
              <Badge key={type}>
                {count} {titleCase(type)}
              </Badge>
            ))}
          </div>

          {workItem.evidenceItems.length ? (
            <div className="grid gap-3">
              {workItem.evidenceItems.map((item) => (
                <div key={item.id} className="rounded-[24px] border border-black/8 bg-white p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={item.included ? "success" : "neutral"}>
                          {item.included ? "Included" : "Excluded"}
                        </Badge>
                        <Badge>{titleCase(item.type)}</Badge>
                        <Badge>{item.source.label}</Badge>
                        <Badge>{formatDateTime(item.updatedAt)}</Badge>
                        {item.tags.slice(0, 3).map((tag) => (
                          <Badge key={`${item.id}-${tag.dimension}-${tag.tag}`}>
                            {titleCase(tag.tag)}
                          </Badge>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                          {item.title}
                        </p>
                        <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                          {item.content}
                        </p>
                      </div>
                    </div>

                    <form action={toggleEvidenceInclusionAction} className="shrink-0">
                      <input type="hidden" name="workItemId" value={workItem.id} />
                      <input type="hidden" name="evidenceItemId" value={item.id} />
                      <input
                        type="hidden"
                        name="included"
                        value={item.included ? "false" : "true"}
                      />
                      <SubmitButton
                        pendingLabel={item.included ? "Excluding..." : "Including..."}
                        variant={item.included ? "secondary" : "primary"}
                        size="sm"
                      >
                        {item.included ? "Exclude from pipeline" : "Include in pipeline"}
                      </SubmitButton>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              No evidence items have been materialized for this Work Item yet.
            </p>
          )}
        </CollapsibleCard>

        <div className="grid gap-4">
          <CollapsibleCard
            title="Highlight pipeline"
            description="Highlights replace the older claim-first flow. Approved highlights are the reusable units artifacts pull from."
            meta={<Badge>{workItem.highlights.length} highlights</Badge>}
            bodyClassName="grid gap-4"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <KeyValue label="Approved" value={approvedHighlightCount} />
              <KeyValue label="Pending" value={pendingHighlightCount} />
              <KeyValue label="Rejected" value={rejectedHighlightCount} />
            </div>

            <form action={generateHighlights}>
              <SubmitButton pendingLabel="Generating highlights..." variant="secondary">
                Regenerate pending highlights
              </SubmitButton>
            </form>

            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              Workbase preserves approved and rejected highlights across reruns, and only replaces draft or flagged material.
            </p>
          </CollapsibleCard>

          <CollapsibleCard
            title="Pipeline"
            description="The review bar stays local even though retrieval is now more dynamic."
            meta={<Badge>4 rules</Badge>}
            bodyClassName="grid gap-4"
          >
            <div className="flex gap-3">
              <FolderGit2 className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Atomic evidence
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  GitHub imports and manual notes stay as direct evidence records instead of being hidden behind persisted clusters.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <Sparkles className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Highlight generation
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Included evidence becomes reusable highlights with tags, ownership, sensitivity, and verification notes.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <ListChecks className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Retrieval before artifacts
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Artifacts retrieve approved highlights first, then add bounded supporting evidence without inventing new accomplishments.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <ShieldCheck className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                  Hard rules stay local
                </p>
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  Approval, sensitivity, visibility, and artifact eligibility are still enforced in application code, not delegated to the model.
                </p>
              </div>
            </div>
          </CollapsibleCard>
        </div>
      </section>
    </WorkbaseFrame>
  );
}
