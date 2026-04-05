import Link from "next/link";
import {
  ArrowRight,
  FolderGit2,
  ListChecks,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  attachGithubRepoAction,
  createManualSourceAction,
  generateClaimsAction,
  reclusterEvidenceAction,
  toggleEvidenceInclusionAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Badge } from "@/components/ui/badge";
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
import { evidenceClustersAreStale } from "@/src/lib/evidence-items";
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
      message: "Workbase could not import that repository selection. Try selecting a repo from the connected list again.",
    };
  }

  if (error === "github-config") {
    return {
      tone: "error" as const,
      message: "GitHub integration is not configured yet. Add the GitHub OAuth environment variables before connecting.",
    };
  }

  if (error === "github-state") {
    return {
      tone: "error" as const,
      message: "Workbase could not verify the GitHub callback state. Start the GitHub connection flow again.",
    };
  }

  if (error === "github-connect-failed") {
    return {
      tone: "error" as const,
      message: "Workbase could not complete the GitHub connection. The OAuth exchange or token storage failed.",
    };
  }

  if (error === "github-import-failed") {
    return {
      tone: "error" as const,
      message: "Workbase could not import bounded GitHub evidence from that repository. Existing evidence was left unchanged.",
    };
  }

  if (error === "invalid-evidence") {
    return {
      tone: "error" as const,
      message: "Workbase could not update that evidence item. Reload the page and try again.",
    };
  }

  if (error === "invalid-cluster") {
    return {
      tone: "error" as const,
      message: "Workbase could not start reclustering because the request was invalid.",
    };
  }

  if (error === "clustering-failed") {
    return {
      tone: "error" as const,
      message: "Workbase could not cluster the included evidence. Claims and existing clusters were left unchanged.",
    };
  }

  if (result === "github-connected") {
    return {
      tone: "success" as const,
      message: "GitHub connected. You can now search accessible repositories and import bounded evidence into this Work Item.",
    };
  }

  if (result === "github-imported") {
    return {
      tone: "success" as const,
      message: "GitHub repository imported. The latest README, commits, pull requests, issues, and releases are now in the evidence pool.",
    };
  }

  if (result === "evidence-included") {
    return {
      tone: "success" as const,
      message: "Evidence included. It will participate in clustering and future claim generation.",
    };
  }

  if (result === "evidence-excluded") {
    return {
      tone: "success" as const,
      message: "Evidence excluded. It will stay out of clustering and future claim generation.",
    };
  }

  if (result === "reclustered") {
    return {
      tone: "success" as const,
      message: "Evidence reclustered. Claim generation will now use the latest included evidence themes.",
    };
  }

  if (result === "clusters-current") {
    return {
      tone: "success" as const,
      message: "Clusters were already current, so Workbase kept the latest cluster set.",
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
    <Card className={isError ? "border-amber-200 bg-amber-50 shadow-none" : "border-emerald-200 bg-emerald-50 shadow-none"}>
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
  const generateClaims = generateClaimsAction.bind(null, workItem.id);
  const reclusterEvidence = reclusterEvidenceAction.bind(null);

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

  const approvedClaimCount = workItem.claims.filter(
    (claim) => claim.verificationStatus === "approved",
  ).length;
  const pendingClaimCount = workItem.claims.filter(
    (claim) => claim.verificationStatus === "draft" || claim.verificationStatus === "flagged",
  ).length;
  const rejectedClaimCount = workItem.claims.filter(
    (claim) => claim.verificationStatus === "rejected",
  ).length;
  const includedEvidenceItems = workItem.evidenceItems.filter((item) => item.included);
  const excludedEvidenceItems = workItem.evidenceItems.filter((item) => !item.included);
  const latestClusterUpdatedAt = workItem.evidenceClusters[0]?.updatedAt ?? null;
  const clustersStale =
    includedEvidenceItems.length > 0 &&
    evidenceClustersAreStale(
      includedEvidenceItems.map((item) => ({
        id: item.id,
        workItemId: item.workItemId,
        sourceId: item.sourceId,
        externalId: item.externalId,
        type: item.type,
        title: item.title,
        content: item.content,
        included: item.included,
        metadata: item.metadata as never,
        source: {
          id: item.source.id,
          label: item.source.label,
          type: item.source.type,
          externalId: item.source.externalId ?? null,
        },
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      latestClusterUpdatedAt,
    );
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
            <CardTitle>Claim pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
              {approvedClaimCount} approved, {pendingClaimCount} pending, {rejectedClaimCount} rejected
            </p>
            <form action={generateClaims}>
              <SubmitButton pendingLabel="Generating claims..." variant="secondary">
                Generate candidate claims
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <Card>
          <CardHeader>
            <CardTitle>Attached sources</CardTitle>
            <CardDescription>
              Manual notes and imported GitHub repositories are the upstream source records for this Work Item.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <form action={createManualSourceAction}>
              <input type="hidden" name="workItemId" value={workItem.id} />
              <CardHeader>
                <CardTitle>Add manual notes</CardTitle>
                <CardDescription>
                  Notes still land in the same evidence pool, but now they are materialized into evidence items before clustering and claim generation.
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
                Connect GitHub, list accessible repositories, and import bounded evidence into the existing review flow.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
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
                <div className="grid gap-4 rounded-[24px] border border-dashed border-black/10 bg-[color:var(--panel-muted)] p-5">
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
        <Card>
          <CardHeader>
            <CardTitle>Evidence review</CardTitle>
            <CardDescription>
              Included evidence feeds clustering and claim generation. Excluded evidence stays persisted but out of both steps.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
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
                  <div
                    key={item.id}
                    className="rounded-[24px] border border-black/8 bg-white p-4"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={item.included ? "success" : "neutral"}>
                            {item.included ? "Included" : "Excluded"}
                          </Badge>
                          <Badge>{titleCase(item.type)}</Badge>
                          <Badge>{item.source.label}</Badge>
                          <Badge>{formatDateTime(item.updatedAt)}</Badge>
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
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Evidence clusters</CardTitle>
              <CardDescription>
                Persisted work themes keep claim generation from seeing a flat pile of notes and GitHub records.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <KeyValue label="Clusters" value={workItem.evidenceClusters.length} />
                <KeyValue
                  label="Status"
                  value={
                    includedEvidenceItems.length === 0
                      ? "No included evidence"
                      : clustersStale
                        ? "Stale"
                        : "Current"
                  }
                />
              </div>

              <form action={reclusterEvidence}>
                <input type="hidden" name="workItemId" value={workItem.id} />
                <SubmitButton pendingLabel="Reclustering evidence..." variant="secondary">
                  Recluster evidence
                </SubmitButton>
              </form>

              {workItem.evidenceClusters.length ? (
                <div className="grid gap-3">
                  {workItem.evidenceClusters.map((cluster) => (
                    <div
                      key={cluster.id}
                      className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{cluster.theme}</Badge>
                        <Badge>{cluster.confidence}</Badge>
                        <Badge>{cluster.items.length} evidence items</Badge>
                      </div>
                      <p className="mt-3 text-sm font-medium text-[color:var(--ink-strong)]">
                        {cluster.title}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                        {cluster.summary}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                  No clusters persisted yet. Workbase will cluster included evidence before the next claim-generation run.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
              <CardDescription>
                The business rules stay the same even with GitHub import and clustering layered in.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex gap-3">
                <FolderGit2 className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Bounded GitHub evidence
                  </p>
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    Repo metadata, README, recent commits, PRs, issues, and releases are imported without cloning or deep code parsing.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <Sparkles className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Clustering before claims
                  </p>
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    Included evidence is grouped into coherent work themes before claim research runs.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <ListChecks className="mt-1 h-5 w-5 text-[color:var(--accent)]" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                    Claim review unchanged
                  </p>
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    Approved and rejected claims are still preserved across regeneration, while draft and flagged claims can be replaced.
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
            </CardContent>
          </Card>
        </div>
      </section>
    </WorkbaseFrame>
  );
}
