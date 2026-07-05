import Link from "next/link";
import type { ReactNode } from "react";
import {
  FolderGit2,
} from "lucide-react";
import {
  approveAllPendingHighlightsAction,
  attachGithubRepoAction,
  createManualSourceAction,
  generateArtifactAction,
  generateClaimsAction,
  toggleEvidenceInclusionAction,
} from "@/app/actions";
import { ArtifactFallbackToast } from "@/components/artifacts/artifact-fallback-toast";
import {
  ArtifactHistoryPanel,
  type ArtifactHistoryEntry,
} from "@/components/artifacts/artifact-history-panel";
import { ClaimCard } from "@/components/claims/claim-card";
import { HighlightSuggestionCard } from "@/components/claims/highlight-suggestion-card";
import { HighlightSuggestionToast } from "@/components/claims/highlight-suggestion-toast";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SourceAddControl } from "@/components/work-items/source-add-control";
import { WorkItemWorkspace } from "@/components/work-items/work-item-workspace";
import { PageHeader, WorkbaseFrame } from "@/components/workbase-frame";
import { getWorkItemForUser } from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import {
  isWorkItemDescriptionSourceMetadata,
} from "@/src/lib/evidence-persistence";
import {
  artifactToneOptions,
  artifactTypeOptions,
  targetAngleOptions,
} from "@/src/lib/options";
import { formatDateTime, titleCase } from "@/src/lib/utils";
import { githubAuthService } from "@/src/services/github-auth-service";
import { ensureHighlightsForWorkItem } from "@/src/services/highlight-bootstrap-service";
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

function buildStatusMessage(params: {
  error?: string;
  result?: string;
  generatedHighlights?: string;
  updatedHighlights?: string;
  highlightSuggestions?: string;
}) {
  const { error, result, generatedHighlights, updatedHighlights, highlightSuggestions } = params;
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

  if (error === "highlight-automation-failed") {
    return {
      tone: "error" as const,
      message:
        "Evidence was saved, but automatic highlight generation failed. Check the generation traces or database migration state before retrying.",
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
    const generatedCount = Number(generatedHighlights ?? 0);
    const updatedCount = Number(updatedHighlights ?? 0);
    const suggestionCount = Number(highlightSuggestions ?? 0);
    const automationSummary = [
      generatedCount ? `${generatedCount} new highlight${generatedCount === 1 ? "" : "s"}` : null,
      updatedCount ? `${updatedCount} draft update${updatedCount === 1 ? "" : "s"}` : null,
      suggestionCount
        ? `${suggestionCount} suggested update${suggestionCount === 1 ? "" : "s"}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    return {
      tone: "success" as const,
      message:
        automationSummary
          ? `GitHub repository imported. Workbase also prepared ${automationSummary}.`
          : "GitHub repository imported. The latest README, commits, pull requests, issues, and releases are now in the evidence pool.",
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

function StatusBanner({
  error,
  result,
  generatedHighlights,
  updatedHighlights,
  highlightSuggestions,
}: {
  error?: string;
  result?: string;
  generatedHighlights?: string;
  updatedHighlights?: string;
  highlightSuggestions?: string;
}) {
  const status = buildStatusMessage({
    error,
    result,
    generatedHighlights,
    updatedHighlights,
    highlightSuggestions,
  });

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
  returnTo,
}: {
  repository: GitHubRepositorySummary;
  workItemId: string;
  attached: boolean;
  returnTo: string;
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
          <input type="hidden" name="returnTo" value={returnTo} />
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

function readArtifactResultRefs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const artifactId =
    typeof objectValue.artifactId === "string" && objectValue.artifactId.length
      ? objectValue.artifactId
      : null;
  const usedHighlightIds = Array.isArray(objectValue.usedHighlightIds)
    ? objectValue.usedHighlightIds.filter(
        (highlightId: unknown): highlightId is string => typeof highlightId === "string",
      )
    : Array.isArray(objectValue.usedClaimIds)
      ? objectValue.usedClaimIds.filter(
          (highlightId: unknown): highlightId is string => typeof highlightId === "string",
        )
      : [];
  const supportingEvidenceItemIds = Array.isArray(objectValue.supportingEvidenceItemIds)
    ? objectValue.supportingEvidenceItemIds.filter(
        (evidenceItemId: unknown): evidenceItemId is string => typeof evidenceItemId === "string",
      )
    : [];
  const fallbackUsed = objectValue.fallbackUsed === true;
  const fallbackNote =
    typeof objectValue.fallbackNote === "string" && objectValue.fallbackNote.length
      ? objectValue.fallbackNote
      : null;
  const unreviewedFallbackHighlights = Array.isArray(objectValue.unreviewedFallbackHighlights)
    ? objectValue.unreviewedFallbackHighlights.filter(
        (
          highlight,
        ): highlight is {
          id: string;
          text: string;
          summary: string;
          confidence: string;
          ownershipClarity: string;
        } =>
          Boolean(highlight) &&
          typeof highlight === "object" &&
          !Array.isArray(highlight) &&
          typeof (highlight as Record<string, unknown>).id === "string" &&
          typeof (highlight as Record<string, unknown>).text === "string" &&
          typeof (highlight as Record<string, unknown>).summary === "string" &&
          typeof (highlight as Record<string, unknown>).confidence === "string" &&
          typeof (highlight as Record<string, unknown>).ownershipClarity === "string",
      )
    : [];

  if (!artifactId) {
    return null;
  }

  return {
    artifactId,
    usedHighlightIds,
    supportingEvidenceItemIds,
    fallbackUsed,
    fallbackNote,
    unreviewedFallbackHighlights,
  };
}

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
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge tone={tone}>{count} highlights</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
    tab?: string;
    artifactId?: string;
    generatedHighlights?: string;
    updatedHighlights?: string;
    highlightSuggestions?: string;
  }>;
}) {
  const { id } = await params;
  const {
    error,
    result,
    repoQuery = "",
    tab,
    artifactId,
    generatedHighlights,
    updatedHighlights,
    highlightSuggestions,
  } = await searchParams;
  const user = await getDemoUser();

  await ensureHighlightsForWorkItem({
    userId: user.id,
    workItemId: id,
  });

  const [workItem, githubConnection] = await Promise.all([
    getWorkItemForUser(user.id, id),
    githubAuthService.getConnection(user.id),
  ]);
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
  const visibleSources = workItem.sources.filter(
    (source) => !isWorkItemDescriptionSourceMetadata(source.metadata),
  );
  const includedEvidenceItems = workItem.evidenceItems.filter((item) => item.included);
  const excludedEvidenceItems = workItem.evidenceItems.filter((item) => !item.included);
  const githubSources = visibleSources.filter((source) => source.type === "github_repo");
  const attachedRepoIds = new Set(
    githubSources
      .map((source) => source.externalId)
      .filter((value): value is string => Boolean(value)),
  );
  const evidenceTypeCounts = getEvidenceTypeCounts(workItem.evidenceItems);
  const pendingSuggestionCount = workItem.highlightSuggestions.length;
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
  const approvedRetrievalHighlights = workItem.highlights.filter(
    (highlight) => highlight.verificationStatus === "approved" && !highlight.sensitivityFlag,
  );
  const highlightTraces = workItem.generationRuns.filter(
    (run) =>
      run.kind === "highlight_generation" ||
      run.kind === "highlight_verification" ||
      run.kind === "artifact_retrieval" ||
      run.kind === "artifact_generation",
  );
  const artifactTraces = workItem.generationRuns.filter(
    (run) => run.kind === "artifact_retrieval" || run.kind === "artifact_generation",
  );
  const artifactTraceById = new Map(
    artifactTraces
      .map((trace) => {
        const resultRefs = readArtifactResultRefs(trace.resultRefs);

        if (!resultRefs?.artifactId) {
          return null;
        }

        return [resultRefs.artifactId, trace] as const;
      })
      .filter((entry): entry is readonly [string, (typeof artifactTraces)[number]] => Boolean(entry)),
  );
  const selectedArtifact =
    workItem.artifacts.find((artifact) => artifact.id === artifactId) ?? workItem.artifacts[0] ?? null;
  const artifactHistoryEntries: ArtifactHistoryEntry[] = workItem.artifacts.map((artifact) => {
    const trace = artifactTraceById.get(artifact.id) ?? null;
    const resultRefs = trace ? readArtifactResultRefs(trace.resultRefs) : null;
    const usedHighlightIds = resultRefs?.usedHighlightIds ?? [];
    const supportingEvidenceItemIds = resultRefs?.supportingEvidenceItemIds ?? [];
    const usedHighlights = usedHighlightIds
      .map((highlightId) => workItem.highlights.find((highlight) => highlight.id === highlightId))
      .filter((highlight): highlight is (typeof workItem.highlights)[number] => Boolean(highlight))
      .map((highlight) => ({
        id: highlight.id,
        text: highlight.text,
        summary: highlight.summary,
        visibility: highlight.visibility,
        confidence: highlight.confidence,
      }));
    const fallbackHighlights = resultRefs?.unreviewedFallbackHighlights ?? [];
    const supportingEvidence = supportingEvidenceItemIds
      .map((evidenceItemId) => workItem.evidenceItems.find((item) => item.id === evidenceItemId))
      .filter((item): item is (typeof workItem.evidenceItems)[number] => Boolean(item))
      .map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        type: item.type,
        sourceLabel: item.source.label,
      }));

    return {
      id: artifact.id,
      type: artifact.type,
      targetAngle: artifact.targetAngle,
      tone: artifact.tone,
      content: artifact.content,
      createdAt:
        artifact.createdAt instanceof Date ? artifact.createdAt.toISOString() : String(artifact.createdAt),
      highlightCount: usedHighlights.length || fallbackHighlights.length,
      evidenceCount: supportingEvidence.length,
      fallbackUsed: resultRefs?.fallbackUsed ?? false,
      fallbackNote: resultRefs?.fallbackNote ?? null,
      hasTrace: Boolean(trace),
      usedHighlights,
      fallbackHighlights,
      supportingEvidence,
    };
  });
  const sourcesReturnTo = `/work-items/${workItem.id}?tab=sources`;
  const highlightsReturnTo = `/work-items/${workItem.id}?tab=highlights`;
  const artifactsReturnTo = `/work-items/${workItem.id}?tab=artifacts`;
  const generateHighlights = generateClaimsAction.bind(null, workItem.id, highlightsReturnTo);
  const manualNoteForm = (
    <form action={createManualSourceAction} className="grid gap-4">
      <input type="hidden" name="workItemId" value={workItem.id} />
      <input type="hidden" name="returnTo" value={sourcesReturnTo} />
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
    </form>
  );

  return (
    <WorkbaseFrame>
      <HighlightSuggestionToast
        workItemId={workItem.id}
        suggestionCount={Number(highlightSuggestions ?? 0)}
      />
      <PageHeader
        eyebrow={workItem.type === "project" ? "Project" : "Experience"}
        title={workItem.title}
        description={workItem.description}
      />

      <StatusBanner
        error={error}
        result={result}
        generatedHighlights={generatedHighlights}
        updatedHighlights={updatedHighlights}
        highlightSuggestions={highlightSuggestions}
      />

      <WorkItemWorkspace
        initialTab={tab}
        sourcesPanel={
          <section className="grid gap-5">
            <div className="grid gap-4 rounded-[30px] border border-black/8 bg-white/86 p-5 shadow-[0_18px_54px_rgba(15,23,42,0.05)] lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="grid gap-4 sm:grid-cols-3">
                <KeyValue label="Sources" value={`${visibleSources.length} attached`} />
                <KeyValue label="Evidence" value={`${includedEvidenceItems.length} included`} />
                <KeyValue label="GitHub" value={`${githubSources.length} repos`} />
              </div>
            </div>

            <section className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div className="grid content-start gap-5">
                <Card>
                  <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-2">
                      <CardTitle>Attached sources</CardTitle>
                      <CardDescription>
                        Manual notes and imported repositories are the upstream records for this Work Item.
                      </CardDescription>
                    </div>
                    <SourceAddControl>{manualNoteForm}</SourceAddControl>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {visibleSources.length ? (
                      visibleSources.map((source) => {
                        const importedAt = getSourceImportedAt(source.metadata);
                        const repositoryFullName = getRepositoryFullName(source.metadata);

                        return (
                          <div
                            key={source.id}
                            className="rounded-[22px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={source.type === "manual_note" ? "accent" : "neutral"}>
                                {titleCase(source.type)}
                              </Badge>
                              <Badge>{source.label}</Badge>
                              {importedAt ? <Badge>imported {formatDateTime(importedAt)}</Badge> : null}
                            </div>
                            <p className="mt-3 line-clamp-3 text-sm leading-6 text-[color:var(--ink-soft)]">
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

                <Card>
                  <CardHeader>
                    <CardTitle>GitHub imports</CardTitle>
                    <CardDescription>
                      Attach repositories here, then re-import later to pick up new commits.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {githubConnection ? (
                      <>
                        <div className="rounded-[22px] border border-black/8 bg-[color:var(--panel-muted)] p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="success">Connected</Badge>
                            <Badge>@{githubConnection.login}</Badge>
                            <Badge>
                              {githubSources.length} attached repo{githubSources.length === 1 ? "" : "s"}
                            </Badge>
                          </div>
                        </div>

                        <form method="GET" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                          <input type="hidden" name="tab" value="sources" />
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
                          <div className="grid max-h-[34rem] gap-3 overflow-y-auto pr-1">
                            {repositories.map((repository) => (
                              <GitHubRepoRow
                                key={repository.id}
                                repository={repository}
                                workItemId={workItem.id}
                                attached={attachedRepoIds.has(repository.id)}
                                returnTo={sourcesReturnTo}
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
                      <div className="grid gap-4 rounded-[22px] border border-dashed border-black/10 bg-white p-5">
                        <div className="flex items-start gap-3">
                          <FolderGit2 className="mt-0.5 h-5 w-5 text-[color:var(--accent)]" />
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                              GitHub is not connected yet
                            </p>
                            <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                              Connect GitHub to list accessible repositories and import bounded evidence.
                            </p>
                          </div>
                        </div>
                        <Link
                          href={`/api/github/connect?returnTo=${encodeURIComponent(`/work-items/${workItem.id}?tab=sources`)}`}
                          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[color:var(--accent)] px-4 text-sm font-medium text-white shadow-[0_16px_36px_rgba(15,118,110,0.24)] transition hover:bg-[color:var(--accent-strong)] [color:white] [&_svg]:text-white"
                        >
                          <FolderGit2 className="h-4 w-4" />
                          Connect GitHub
                        </Link>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <CollapsibleCard
                title="Evidence pool"
                description="Included evidence feeds highlight generation and artifact retrieval."
                meta={
                  <>
                    <Badge tone="accent">{includedEvidenceItems.length} included</Badge>
                    <Badge>{excludedEvidenceItems.length} excluded</Badge>
                  </>
                }
                defaultOpen
                bodyClassName="grid gap-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(evidenceTypeCounts).map(([type, count]) => (
                    <Badge key={type}>
                      {count} {titleCase(type)}
                    </Badge>
                  ))}
                </div>

                {workItem.evidenceItems.length ? (
                  <div className="grid max-h-[52rem] gap-3 overflow-y-auto pr-1">
                    {workItem.evidenceItems.map((item) => (
                      <div key={item.id} className="rounded-[22px] border border-black/8 bg-white p-4">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={item.included ? "success" : "neutral"}>
                                {item.included ? "Included" : "Excluded"}
                              </Badge>
                              <Badge>{titleCase(item.type)}</Badge>
                              <Badge>{item.source.label}</Badge>
                              {item.tags.slice(0, 2).map((tag) => (
                                <Badge key={`${item.id}-${tag.dimension}-${tag.tag}`}>
                                  {titleCase(tag.tag)}
                                </Badge>
                              ))}
                            </div>

                            <div className="space-y-2">
                              <p className="text-sm font-medium text-[color:var(--ink-strong)]">
                                {item.title}
                              </p>
                              <p className="line-clamp-4 text-sm leading-6 text-[color:var(--ink-soft)]">
                                {item.content}
                              </p>
                            </div>
                          </div>

                          <form action={toggleEvidenceInclusionAction} className="shrink-0">
                            <input type="hidden" name="workItemId" value={workItem.id} />
                            <input type="hidden" name="returnTo" value={sourcesReturnTo} />
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
                              {item.included ? "Exclude" : "Include"}
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
            </section>
          </section>
        }
        highlightsPanel={
          <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr] xl:items-start">
            <div className="grid gap-5">
              <Card>
                <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-2">
                    <CardTitle>Highlight pipeline</CardTitle>
                    <CardDescription>
                      Generate, review, approve, reject, and trace highlights from this Work Item.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {pendingHighlights.length ? (
                      <form action={approveAllPendingHighlightsAction}>
                        <input type="hidden" name="workItemId" value={workItem.id} />
                        <input type="hidden" name="returnTo" value={highlightsReturnTo} />
                        <SubmitButton pendingLabel="Approving highlights..." variant="secondary">
                          Accept all pending
                        </SubmitButton>
                      </form>
                    ) : null}
                    <form action={generateHighlights}>
                      <SubmitButton pendingLabel="Generating highlights..." variant="primary">
                        Generate highlights
                      </SubmitButton>
                    </form>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-4">
                  <KeyValue label="Approved" value={approvedHighlightCount} />
                  <KeyValue label="Pending" value={pendingHighlightCount} />
                  <KeyValue label="Suggested" value={pendingSuggestionCount} />
                  <KeyValue label="Rejected" value={rejectedHighlightCount} />
                </CardContent>
              </Card>

              {pendingSuggestionCount ? (
                <Card id="suggested-updates">
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>Suggested updates</CardTitle>
                      <Badge tone="accent">{pendingSuggestionCount} pending</Badge>
                    </div>
                    <CardDescription>
                      Review proposed revisions from new import evidence before approved highlights change.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {workItem.highlightSuggestions.map((suggestion) => (
                        <HighlightSuggestionCard
                          key={suggestion.id}
                          suggestion={suggestion}
                          returnTo={highlightsReturnTo}
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

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
                        returnTo={highlightsReturnTo}
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
                description="Approved highlights are reusable by artifacts."
                count={approvedHighlights.length}
                tone="success"
              >
                {approvedHighlights.length ? (
                  <div className="space-y-4">
                    {approvedHighlights.map((highlight) => (
                      <ClaimCard
                        key={highlight.id}
                        claim={mapHighlightForCard(workItem.id, highlight)}
                        returnTo={highlightsReturnTo}
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
                description="Rejected highlights stay stored so future generations can avoid weak framing."
                count={rejectedHighlights.length}
                tone="danger"
              >
                {rejectedHighlights.length ? (
                  <div className="space-y-4">
                    {rejectedHighlights.map((highlight) => (
                      <ClaimCard
                        key={highlight.id}
                        claim={mapHighlightForCard(workItem.id, highlight)}
                        returnTo={highlightsReturnTo}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    No rejected highlights for this Work Item.
                  </p>
                )}
              </ClaimSection>

              <GenerationTracePanel
                traces={highlightTraces}
                title="Generation traces"
                description="Provider responses, parsed payloads, validation failures, and persisted result refs."
              />
            </div>

            <aside className="space-y-5 xl:sticky xl:top-24 xl:self-start">
              <Card className="overflow-hidden bg-[color:var(--ink-strong)] text-white shadow-[0_24px_60px_rgba(16,33,43,0.18)]">
                <CardHeader>
                  <CardTitle className="text-white">Review summary</CardTitle>
                  <CardDescription className="text-white/72">
                    Scan the queue, decide what survives, and keep approved material quiet.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-[24px] bg-white/8 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/60">Pending</p>
                      <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em] text-white">
                        {pendingHighlights.length}
                      </p>
                    </div>
                    <div className="rounded-[24px] bg-white/8 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/60">Sensitive</p>
                      <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em] text-white">
                        {sensitiveHighlights.length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Work Item context</CardTitle>
                  <CardDescription>
                    Highlights on this tab are grounded in the current sources and evidence pool.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <KeyValue label="Type" value={titleCase(workItem.type)} />
                  <KeyValue label="Sources" value={`${visibleSources.length} attached`} />
                  <KeyValue label="Evidence" value={`${includedEvidenceItems.length} included`} />
                </CardContent>
              </Card>
            </aside>
          </section>
        }
        artifactsPanel={
          <section className="grid gap-5">
            <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
              <Card>
                <form action={generateArtifactAction}>
                  <input type="hidden" name="workItemId" value={workItem.id} />
                  <input type="hidden" name="returnTo" value={artifactsReturnTo} />
                  <ArtifactFallbackToast fallbackWillBeAttempted={approvedRetrievalHighlights.length === 0} />
                  <CardHeader>
                    <CardTitle>Generate artifact</CardTitle>
                    <CardDescription>
                      Choose the output type, angle, and tone. Retrieval starts with approved, non-sensitive highlights.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                        Artifact type
                      </span>
                      <Select name="type" defaultValue="resume_bullets">
                        {artifactTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </label>

                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                        Target angle
                      </span>
                      <Select name="targetAngle" defaultValue="general">
                        {targetAngleOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </label>

                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                        Tone
                      </span>
                      <Select name="tone" defaultValue="concise">
                        {artifactToneOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </label>

                    <SubmitButton pendingLabel="Generating artifact...">
                      Generate artifact
                    </SubmitButton>
                  </CardContent>
                </form>
              </Card>

              <CollapsibleCard
                title="Approved highlights available for retrieval"
                description="Sensitive highlights stay out. Visibility is checked at generation time."
                meta={<Badge tone="success">{approvedRetrievalHighlights.length} approved</Badge>}
                bodyClassName="space-y-4"
              >
                {approvedRetrievalHighlights.length ? (
                  approvedRetrievalHighlights.map((highlight) => (
                    <div
                      key={highlight.id}
                      className="rounded-[24px] border border-black/8 bg-[color:var(--panel-muted)] p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="success">Approved</Badge>
                        <Badge>{highlight.visibility.replace("_", " ")}</Badge>
                        <Badge>{highlight.confidence}</Badge>
                        {highlight.tags.slice(0, 3).map((tag) => (
                          <Badge key={`${highlight.id}-${tag.dimension}-${tag.tag}`}>
                            {tag.tag.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[color:var(--ink-strong)]">
                        {highlight.text}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[color:var(--ink-soft)]">
                        {highlight.summary}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    No approved, non-sensitive highlights are available yet.
                  </p>
                )}
              </CollapsibleCard>
            </section>

            {error === "no-eligible-claims" || error === "no-eligible-highlights" || error === "no-artifact-context" ? (
              <Card className="border-amber-200 bg-amber-50 shadow-none">
                <CardContent className="py-4">
                  <p className="text-sm leading-6 text-amber-900">
                    Workbase could not assemble enough approved or request-specific fallback context to generate that artifact.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {error === "artifact-generation-failed" ? (
              <Card className="border-amber-200 bg-amber-50 shadow-none">
                <CardContent className="py-4">
                  <p className="text-sm leading-6 text-amber-900">
                    Workbase could not generate that artifact. The generation trace panel below has the provider and validation details.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            <ArtifactHistoryPanel
              entries={artifactHistoryEntries}
              initialSelectedArtifactId={selectedArtifact?.id ?? null}
            />

            <GenerationTracePanel
              traces={artifactTraces}
              title="Artifact traces"
              description="Internal trace records for artifact retrieval and generation runs."
            />
          </section>
        }
      />

    </WorkbaseFrame>
  );
}
