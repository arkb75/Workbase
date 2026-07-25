import Link from "next/link";
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import {
  FolderGit2,
} from "lucide-react";
import {
  approveAllPendingHighlightsAction,
  attachGithubRepoAction,
  createManualSourceAction,
  editKnowledgeItemAction,
  generateArtifactAction,
  generateClaimsAction,
  retireKnowledgeItemAction,
  toggleEvidenceInclusionAction,
} from "@/app/actions";
import {
  ArtifactHistoryPanel,
  type ArtifactHistoryEntry,
} from "@/components/artifacts/artifact-history-panel";
import { ClaimCard } from "@/components/claims/claim-card";
import { HighlightSuggestionCard } from "@/components/claims/highlight-suggestion-card";
import { HighlightSuggestionToast } from "@/components/claims/highlight-suggestion-toast";
import { ProjectChatWorkspace } from "@/components/chat/project-chat-workspace";
import { SubmitButton } from "@/components/forms/submit-button";
import { GenerationTracePanel } from "@/components/generation-trace-panel";
import { KnowledgeUpdateInbox } from "@/components/knowledge/knowledge-update-inbox";
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
import {
  getWorkItemForUser,
  getWorkItemWorkspaceForUser,
} from "@/src/data/workbase";
import { getDemoUser } from "@/src/lib/demo-user";
import {
  nestArtifactEvidenceUnderHighlights,
  readArtifactEvidenceProvenance,
  readArtifactHighlightProvenance,
} from "@/src/lib/artifact-provenance";
import {
  isWorkItemDescriptionSourceMetadata,
} from "@/src/lib/evidence-persistence";
import { loadWorkItemRouteData } from "@/src/lib/work-item-route";
import {
  artifactToneOptions,
  artifactTypeOptions,
  targetAngleOptions,
} from "@/src/lib/options";
import { formatDateTime, titleCase } from "@/src/lib/utils";
import {
  buildWorkItemWorkspaceHref,
  buildWorkItemWorkspaceTabHrefs,
  readWorkItemWorkspacePage,
  readWorkItemWorkspaceTab,
  type WorkItemWorkspaceSearchParams,
} from "@/src/lib/work-item-workspace-tabs";
import { githubAuthService } from "@/src/services/github-auth-service";
import { artifactWorkflowService } from "@/src/services/artifact-workflow-application-service";
import { getProjectChatWorkspace } from "@/src/services/project-chat-store";
import type { GitHubRepositorySummary } from "@/src/services/types";

export const dynamic = "force-dynamic";

type WorkItemDetailSearchParams = WorkItemWorkspaceSearchParams & {
  error?: string;
  result?: string;
  repoQuery?: string;
  repoList?: string;
  tab?: string;
  evidencePage?: string;
  knowledgePage?: string;
  artifactId?: string;
  generatedHighlights?: string;
  updatedHighlights?: string;
  highlightSuggestions?: string;
  thread?: string;
};

function readSourceMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readChatFreshness(value: unknown) {
  const metadata = readSourceMetadata(value);
  const freshness = readSourceMetadata(metadata?.freshness);
  if (!freshness || !Array.isArray(freshness.repositories)) return null;
  const repositories = freshness.repositories.flatMap((entry) => {
    const repository = readSourceMetadata(entry);
    return typeof repository?.name === "string" && typeof repository.commitSha === "string" && typeof repository.resolvedAt === "string"
      ? [{ name: repository.name, commitSha: repository.commitSha, resolvedAt: repository.resolvedAt }]
      : [];
  });
  const coverage = freshness.coverage === "partial" ? "partial" as const : "complete" as const;
  const gaps = Array.isArray(freshness.gaps)
    ? freshness.gaps.filter((gap): gap is string => typeof gap === "string")
    : [];
  return repositories.length ? { repositories, coverage, gaps } : null;
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

function getRepositoryRefreshMode(value: unknown) {
  const metadata = readSourceMetadata(value);
  const webhook = readSourceMetadata(metadata?.webhook);
  return webhook?.status === "configured"
    ? "live" as const
    : "scheduled" as const;
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

  if (result === "approved-all") {
    return {
      tone: "success" as const,
      message: "All eligible pending highlights were approved.",
    };
  }

  if (result === "no-eligible-highlights") {
    return {
      tone: "success" as const,
      message:
        "No pending highlights were eligible for bulk approval. Candidate-gated items still require their review decision.",
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
    lifecycleStatus: highlight.lifecycleStatus,
    reviewState: highlight.reviewState,
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

function readCandidateSnapshot(value: unknown): {
  text: string;
  summary: string;
  visibility: "private" | "resume_safe" | "linkedin_safe" | "public_safe";
  sensitivityFlag: boolean;
  evidenceLabels: string[];
  confidence: "low" | "medium" | "high";
  ownershipClarity: "unclear" | "partial" | "clear";
  risksSummary: string | null;
  missingInfo: string | null;
  tags: string[];
  verificationNotes: string | null;
  category: "architecture" | "behavior" | "data_flow" | "code_location" | "dependency" | "configuration" | null;
  partial: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      text: "Candidate highlight",
      summary: "Review the supporting context before approval.",
      visibility: "private" as const,
      sensitivityFlag: false,
      evidenceLabels: [],
      confidence: "medium",
      ownershipClarity: "partial",
      risksSummary: null,
      missingInfo: null,
      tags: [],
      verificationNotes: null,
      category: null,
      partial: false,
    };
  }

  const snapshot = value as Record<string, unknown>;
  const evidence =
    snapshot.evidence && typeof snapshot.evidence === "object" && !Array.isArray(snapshot.evidence)
      ? (snapshot.evidence as Record<string, unknown>)
      : null;
  const sourceRefs = Array.isArray(evidence?.sourceRefs) ? evidence.sourceRefs : [];
  const tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
  return {
    text:
      typeof snapshot.text === "string"
        ? snapshot.text
        : typeof snapshot.statement === "string"
          ? snapshot.statement
          : "Candidate highlight",
    summary:
      typeof snapshot.summary === "string"
        ? snapshot.summary
        : typeof snapshot.statement === "string"
          ? snapshot.statement
          : "Review the supporting context before approval.",
    visibility:
      snapshot.visibility === "resume_safe" ||
      snapshot.visibility === "linkedin_safe" ||
      snapshot.visibility === "public_safe"
        ? snapshot.visibility
        : ("private" as const),
    sensitivityFlag: snapshot.sensitivityFlag === true,
    evidenceLabels: Array.isArray(snapshot.evidenceLabels)
      ? snapshot.evidenceLabels.filter((label): label is string => typeof label === "string")
      : sourceRefs.flatMap((sourceRef) => {
      if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return [];
      const title = (sourceRef as Record<string, unknown>).title;
      return typeof title === "string" ? [title] : [];
      }),
    confidence:
      snapshot.confidence === "low" || snapshot.confidence === "high"
        ? snapshot.confidence
        : "medium",
    ownershipClarity:
      snapshot.ownershipClarity === "unclear" || snapshot.ownershipClarity === "clear"
        ? snapshot.ownershipClarity
        : "partial",
    risksSummary: typeof snapshot.risksSummary === "string" ? snapshot.risksSummary : null,
    missingInfo: typeof snapshot.missingInfo === "string" ? snapshot.missingInfo : null,
    tags: tags.flatMap((tag) => {
      if (!tag || typeof tag !== "object" || Array.isArray(tag)) return [];
      const value = (tag as Record<string, unknown>).tag;
      return typeof value === "string" ? [value] : [];
    }),
    verificationNotes:
      typeof snapshot.verificationNotes === "string"
        ? snapshot.verificationNotes
        : typeof snapshot.reviewNotes === "string"
          ? snapshot.reviewNotes
          : null,
    category:
      snapshot.category === "architecture" ||
      snapshot.category === "behavior" ||
      snapshot.category === "data_flow" ||
      snapshot.category === "code_location" ||
      snapshot.category === "dependency" ||
      snapshot.category === "configuration"
        ? snapshot.category
        : null,
    partial: snapshot.partial === true,
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

function WorkspacePaginationNav({
  label,
  page,
  totalPages,
  totalItems,
  summary,
  previousHref,
  nextHref,
}: {
  label: string;
  page: number;
  totalPages: number;
  totalItems: number;
  summary?: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label={`${label} pages`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-black/8 bg-[color:var(--panel-muted)] px-4 py-3"
    >
      <p className="text-xs text-[color:var(--ink-muted)]">
        Page {page} of {totalPages} · {summary ?? `${totalItems} total`}
      </p>
      <div className="flex items-center gap-2">
        {previousHref ? (
          <Link
            href={previousHref}
            scroll={false}
            className="inline-flex h-9 items-center rounded-full bg-white px-4 text-xs font-medium text-[color:var(--ink-strong)] ring-1 ring-black/10"
          >
            Previous
          </Link>
        ) : null}
        {nextHref ? (
          <Link
            href={nextHref}
            scroll={false}
            className="inline-flex h-9 items-center rounded-full bg-[color:var(--accent)] px-4 text-xs font-medium text-white"
          >
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

function ProjectFactSection({
  facts,
  workItemId,
  approvedCount,
  totalCount,
}: {
  facts: Awaited<ReturnType<typeof getWorkItemForUser>>["projectFacts"];
  workItemId: string;
  approvedCount: number;
  totalCount: number;
}) {
  const groups = ["approved", "draft", "rejected", "superseded"] as const;
  return (
    <section id="project-facts" className="scroll-mt-24 border-t border-black/8 pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--accent)]">
            Project memory
          </p>
          <h3 className="mt-2 font-display text-2xl font-semibold tracking-[-0.035em] text-[color:var(--ink-strong)]">
            Project facts
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--ink-soft)]">
            Reviewed technical facts derived from repository evidence. File excerpts remain underneath each fact as provenance.
          </p>
        </div>
        <Badge tone="accent">{approvedCount} approved</Badge>
      </div>
      <div className="mt-5 grid gap-6">
        {groups.map((status) => {
          const entries = facts.filter((fact) => fact.status === status);
          if (!entries.length) return null;
          return (
            <div key={status} className="grid gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--ink-muted)]">
                {titleCase(status)} · {entries.length}
              </p>
              <div className="divide-y divide-black/7 border-y border-black/7">
                {entries.map((fact) => (
                  <article key={fact.id} className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-6 text-[color:var(--ink-strong)]">
                        {fact.statement}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge>{titleCase(fact.category)}</Badge>
                        <Badge>{fact.confidence} confidence</Badge>
                        <Badge tone={fact.lifecycleStatus === "active" ? "success" : fact.lifecycleStatus === "quarantined" ? "danger" : "warning"}>
                          {titleCase(fact.lifecycleStatus)}
                        </Badge>
                        {fact.reviewState === "pending_review" ? <Badge tone="accent">New update</Badge> : null}
                        {fact.sensitivityFlag ? <Badge tone="warning">Sensitive</Badge> : null}
                      </div>
                      {fact.reviewNotes ? (
                        <p className="mt-2 text-xs leading-5 text-[color:var(--ink-soft)]">{fact.reviewNotes}</p>
                      ) : null}
                    </div>
                    {fact.evidence.length ? (
                      <details className="text-xs sm:w-72">
                        <summary className="cursor-pointer font-medium text-[color:var(--accent)]">
                          {fact.evidence.length} evidence excerpt{fact.evidence.length === 1 ? "" : "s"}
                        </summary>
                        <div className="mt-2 grid gap-2 border-l border-black/8 pl-3">
                          {fact.evidence.map((entry) => (
                            <div key={entry.id}>
                              <p className="font-mono text-[10px] text-[color:var(--ink-muted)]">
                                {entry.evidenceItem.title}
                              </p>
                              <p className="mt-1 line-clamp-3 leading-5 text-[color:var(--ink-soft)]">
                                {entry.evidenceItem.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                    {fact.lifecycleStatus === "active" ||
                    fact.lifecycleStatus === "needs_validation" ||
                    fact.lifecycleStatus === "stale" ? (
                      <details className="text-xs sm:col-span-2">
                        <summary className="cursor-pointer font-medium text-[color:var(--accent)]">Edit or retire</summary>
                        <div className="mt-3 grid gap-3 border-l border-black/8 pl-3 sm:grid-cols-[1fr_auto]">
                          <form action={editKnowledgeItemAction} className="flex gap-2">
                            <input type="hidden" name="workItemId" value={workItemId} />
                            <input type="hidden" name="entityId" value={fact.id} />
                            <input type="hidden" name="kind" value="project_fact" />
                            <input type="hidden" name="idempotencyKey" value={`project-fact-edit:${fact.id}:${fact.updatedAt.toISOString()}`} />
                            <Input name="value" defaultValue={fact.statement} aria-label="Edited Project Fact statement" />
                            <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Save successor</SubmitButton>
                          </form>
                          <form action={retireKnowledgeItemAction}>
                            <input type="hidden" name="workItemId" value={workItemId} />
                            <input type="hidden" name="entityId" value={fact.id} />
                            <input type="hidden" name="kind" value="project_fact" />
                            <input type="hidden" name="reason" value="Retired from the Project Facts workspace." />
                            <SubmitButton size="sm" variant="ghost" pendingLabel="Retiring…">Retire</SubmitButton>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          );
        })}
        {!totalCount ? (
          <p className="border-y border-black/7 py-5 text-sm text-[color:var(--ink-soft)]">
            No project facts yet. Chat research will propose them when reviewed memory cannot answer a technical question.
          </p>
        ) : !facts.length ? (
          <p className="border-y border-black/7 py-5 text-sm text-[color:var(--ink-soft)]">
            No project facts are shown on this page.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function mapKnowledgeChangeForInbox(
  change: Awaited<ReturnType<typeof getWorkItemForUser>>["knowledgeChanges"][number],
) {
  const entity = change.projectFact ?? change.highlight ?? change.evidenceItem ?? change.artifact;
  const entityRecord = entity as unknown as Record<string, unknown> | null;
  const primary = change.projectFact?.statement
    ?? change.highlight?.text
    ?? change.evidenceItem?.title
    ?? change.artifact?.content
    ?? "Unavailable knowledge item";
  const secondary = change.highlight?.summary
    ?? change.evidenceItem?.content
    ?? (change.projectFact?.reviewNotes || null);
  const primaryField = change.projectFact
    ? "statement" as const
    : change.highlight
      ? "text" as const
      : change.evidenceItem
        ? "title" as const
        : "content" as const;
  const secondaryField = change.highlight
    ? "summary" as const
    : change.evidenceItem
      ? "content" as const
      : null;
  return {
    id: change.id,
    entityId: change.projectFactId ?? change.highlightId ?? change.evidenceItemId ?? change.artifactId ?? change.id,
    entityKind: change.entityKind,
    action: change.action,
    reason: change.reason,
    createdAt: change.createdAt.toISOString(),
    primary,
    secondary,
    primaryField,
    secondaryField,
    category: change.projectFact?.category ?? null,
    visibility: change.highlight?.visibility ?? null,
    sensitivityFlag: Boolean(change.projectFact?.sensitivityFlag ?? change.highlight?.sensitivityFlag),
    lifecycleStatus: typeof entityRecord?.lifecycleStatus === "string" ? entityRecord.lifecycleStatus : "retired",
    publicSafetyStatus: typeof entityRecord?.publicSafetyStatus === "string" ? entityRecord.publicSafetyStatus : null,
    beforeSnapshot: change.beforeSnapshot,
    afterSnapshot: change.afterSnapshot,
    provenance: change.provenance,
    downstreamImpact: change.downstreamImpact,
  };
}

export default async function WorkItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<WorkItemDetailSearchParams>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const {
    error,
    result,
    repoQuery = "",
    repoList,
    tab,
    evidencePage: evidencePageValue,
    knowledgePage: knowledgePageValue,
    artifactId,
    generatedHighlights,
    updatedHighlights,
    highlightSuggestions,
    thread,
  } = resolvedSearchParams;
  const activeTab = readWorkItemWorkspaceTab(tab);
  const evidencePage = readWorkItemWorkspacePage(evidencePageValue);
  const knowledgePage = readWorkItemWorkspacePage(knowledgePageValue);
  const tabHrefs = buildWorkItemWorkspaceTabHrefs({
    pathname: `/work-items/${id}`,
    searchParams: resolvedSearchParams,
  });
  const user = await getDemoUser();

  const [workItemResult, githubConnection, chatWorkspace] = await loadWorkItemRouteData(
    () => Promise.all([
      getWorkItemWorkspaceForUser(user.id, id, activeTab, {
        evidencePage,
        knowledgePage,
      }),
      activeTab === "sources"
        ? githubAuthService.getConnection(user.id)
        : Promise.resolve(null),
      activeTab === "chat"
        ? getProjectChatWorkspace({
            userId: user.id,
            workItemId: id,
            activeThreadId: thread,
          })
        : Promise.resolve(null),
    ] as const),
  );
  const {
    workItem,
    sensitiveContextAvailable: chatSensitiveContextAvailable,
    visibleSourceCount,
    includedEvidenceCount,
    evidenceTypeCounts,
    highlightCounts,
    highlightCount,
    pendingHighlightSuggestionCount,
    approvedProjectFactCount,
    projectFactCount,
    pagination: workspacePagination,
  } = workItemResult;
  let repositories: GitHubRepositorySummary[] = [];
  let repositoryLookupFailed = false;

  const shouldListRepositories =
    activeTab === "sources" &&
    Boolean(githubConnection) &&
    (repoList === "1" || repoQuery.trim().length > 0);

  if (shouldListRepositories) {
    try {
      repositories = await githubAuthService.listRepositories({
        userId: user.id,
        query: repoQuery,
      });
    } catch {
      repositoryLookupFailed = true;
    }
  }

  const activeHighlights = workItem.highlights.filter(
    (highlight) => highlight.lifecycleStatus === "active",
  );
  const lifecycleHighlights = workItem.highlights.filter(
    (highlight) => highlight.lifecycleStatus !== "active",
  );
  const pendingHighlights = activeHighlights.filter(
    (highlight) =>
      highlight.verificationStatus === "draft" ||
      highlight.verificationStatus === "flagged",
  );
  const approvedHighlights = activeHighlights.filter(
    (highlight) => highlight.verificationStatus === "approved",
  );
  const rejectedHighlights = activeHighlights.filter(
    (highlight) => highlight.verificationStatus === "rejected",
  );
  const canApproveAllPendingHighlights = highlightCounts.bulkApprovable > 0;
  const visibleSources = workItem.sources.filter(
    (source) => !isWorkItemDescriptionSourceMetadata(source.metadata),
  );
  const githubSources = visibleSources.filter((source) => source.type === "github_repo");
  const attachedRepoIds = new Set(
    githubSources
      .map((source) => source.externalId)
      .filter((value): value is string => Boolean(value)),
  );
  const pendingSuggestionCount = pendingHighlightSuggestionCount;
  const approvedRetrievalHighlights = activeHighlights.filter(
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
    activeTab === "artifacts"
      ? workItem.artifacts.find((artifact) => artifact.id === artifactId) ?? workItem.artifacts[0] ?? null
      : null;
  if (selectedArtifact?.lifecycleStatus === "stale") {
    await artifactWorkflowService.start({
      userId: user.id,
      workItemId: workItem.id,
      brief: selectedArtifact.requestBrief,
      supersedesArtifactId: selectedArtifact.id,
      idempotencyKey: `artifact-open-refresh:${selectedArtifact.id}:${selectedArtifact.updatedAt.toISOString()}`,
    }).catch(() => null);
  }
  const artifactHistoryEntries: ArtifactHistoryEntry[] = activeTab === "artifacts"
    ? workItem.artifacts.map((artifact) => {
    const trace = artifactTraceById.get(artifact.id) ?? null;
    const resultRefs = trace ? readArtifactResultRefs(trace.resultRefs) : null;
    const usedHighlightIds = resultRefs?.usedHighlightIds ?? [];
    const supportingEvidenceItemIds = resultRefs?.supportingEvidenceItemIds ?? [];
    const legacyUsedHighlights = usedHighlightIds
      .map((highlightId) => workItem.highlights.find((highlight) => highlight.id === highlightId))
      .filter((highlight): highlight is (typeof workItem.highlights)[number] => Boolean(highlight))
      .map((highlight) => ({
        id: highlight.id,
        text: highlight.text,
        summary: highlight.summary,
        visibility: highlight.visibility,
        confidence: highlight.confidence,
        evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
      }));
    const usedHighlightSnapshots = artifact.highlightProvenance.length
      ? readArtifactHighlightProvenance(artifact.highlightProvenance)
      : legacyUsedHighlights;
    const fallbackHighlights = resultRefs?.unreviewedFallbackHighlights ?? [];
    const legacySupportingEvidence = supportingEvidenceItemIds
      .map((evidenceItemId) => workItem.evidenceItems.find((item) => item.id === evidenceItemId))
      .filter((item): item is (typeof workItem.evidenceItems)[number] => Boolean(item))
      .map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        type: item.type,
        sourceLabel: item.source.label,
      }));
    const supportingEvidence = artifact.evidenceProvenance.length
      ? readArtifactEvidenceProvenance(artifact.evidenceProvenance)
      : legacySupportingEvidence;
    const usedHighlights = nestArtifactEvidenceUnderHighlights(
      usedHighlightSnapshots.map((highlight) =>
        highlight.evidenceItemIds.length
          ? highlight
          : {
              ...highlight,
              evidenceItemIds:
                workItem.highlights
                  .find((current) => current.id === highlight.id)
                  ?.evidence.map((entry) => entry.evidenceItemId) ?? [],
            },
      ),
      supportingEvidence,
    );

    return {
      id: artifact.id,
      workItemId: workItem.id,
      type: artifact.type,
      targetAngle: artifact.targetAngle,
      tone: artifact.tone,
      content: artifact.content,
      lifecycleStatus: artifact.lifecycleStatus,
      publicSafetyStatus: artifact.publicSafetyStatus,
      staleReason: artifact.staleReason,
      createdAt:
        artifact.createdAt instanceof Date ? artifact.createdAt.toISOString() : String(artifact.createdAt),
      highlightCount: usedHighlights.length || fallbackHighlights.length,
      evidenceCount: supportingEvidence.length,
      fallbackUsed: resultRefs?.fallbackUsed ?? false,
      fallbackNote: resultRefs?.fallbackNote ?? null,
      hasTrace: Boolean(trace),
      usedHighlights,
      fallbackHighlights,
    };
      })
    : [];
  const chatThreads = chatWorkspace?.threads.map((chatThread) => ({
    id: chatThread.id,
    title: chatThread.title,
    updatedAt: chatThread.updatedAt.toISOString(),
  })) ?? [];
  const chatMessages = chatWorkspace?.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    status:
      message.status === "queued"
        ? ("pending" as const)
        : message.status === "running"
          ? ("streaming" as const)
          : message.status,
    createdAt: message.createdAt.toISOString(),
    freshness: readChatFreshness(message.metadata),
    citationIntegrity: readSourceMetadata(message.metadata)?.citationIntegrity === "legacy_unverifiable"
      ? "legacy_unverifiable" as const
      : readSourceMetadata(message.metadata)?.citationIntegrity === "verified"
        ? "verified" as const
        : null,
    citations: message.citations.map((citation) => {
      const citationMetadata = readSourceMetadata(citation.metadata);
      const snapshottedProvenance = Array.isArray(citationMetadata?.provenance)
        ? citationMetadata.provenance.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const value = entry as Record<string, unknown>;
            return [{
              id: typeof value.evidenceItemId === "string" ? value.evidenceItemId : `${citation.id}:provenance`,
              title: typeof value.title === "string" ? value.title : "Repository evidence",
              excerpt: typeof value.excerpt === "string" ? value.excerpt : "Source excerpt unavailable.",
              path: typeof value.path === "string" ? value.path : null,
              commitSha: typeof value.commitSha === "string" ? value.commitSha : null,
              url: typeof value.url === "string" ? value.url : null,
            }];
          })
        : null;
      return {
        id: citation.id,
        kind: citation.kind,
        label: citation.label,
        excerpt: citation.excerpt ?? "Source excerpt unavailable.",
        url: citation.immutableUrl,
        path: citation.path,
        commitSha: citation.commitSha,
        highlightId: citation.highlightId,
        projectFactId: citation.projectFactId,
        evidenceItemId: citation.evidenceItemId,
        artifactId: citation.artifactId,
        provenance: snapshottedProvenance ?? citation.projectFact?.evidence.map((entry) => {
          const metadata = readSourceMetadata(entry.evidenceItem.metadata);
          return {
            id: entry.evidenceItem.id,
            title: entry.evidenceItem.title,
            excerpt: entry.evidenceItem.content,
            path: typeof metadata?.path === "string" ? metadata.path : null,
            commitSha: typeof metadata?.commitSha === "string" ? metadata.commitSha : null,
            url: typeof metadata?.url === "string" ? metadata.url : null,
          };
        }) ?? [],
      };
    }),
  })) ?? [];
  const chatEvents = chatWorkspace?.events.map((event) => ({
    id: event.id,
    runId: event.runId,
    message: event.message ?? titleCase(event.type),
    eventType: event.type,
    createdAt: event.createdAt.toISOString(),
  })) ?? [];
  const chatCandidates = chatWorkspace?.candidates.map((candidate) => {
    const snapshot = readCandidateSnapshot(candidate.snapshot);
    if (candidate.projectFact) {
      return {
        id: candidate.id,
        runId: candidate.runId,
        kind:
          candidate.kind === "project_fact_revision"
            ? ("project_fact_revision" as const)
            : ("project_fact" as const),
        status:
          candidate.status === "edited_and_approved"
            ? ("approved" as const)
            : candidate.status,
        text: candidate.projectFact.statement,
        summary: candidate.projectFact.statement,
        visibility: "private" as const,
        sensitivityFlag: candidate.projectFact.sensitivityFlag,
        confidence: candidate.projectFact.confidence,
        ownershipClarity: "unclear" as const,
        risksSummary: null,
        missingInfo: snapshot.partial ? "Research ended before every repository area could be checked." : null,
        tags: [candidate.projectFact.category],
        verificationNotes: candidate.projectFact.reviewNotes,
        evidenceLabels: candidate.projectFact.evidence.map((entry) => entry.evidenceItem.title),
        category: candidate.projectFact.category,
        partial: snapshot.partial,
      };
    }
    return {
      id: candidate.id,
      runId: candidate.runId,
      kind: candidate.kind === "highlight_revision" ? ("revision" as const) : ("new_highlight" as const),
      status:
        candidate.status === "edited_and_approved"
          ? ("approved" as const)
          : candidate.status,
      text: candidate.highlight?.text ?? snapshot.text,
      summary: candidate.highlight?.summary ?? snapshot.summary,
      visibility: candidate.highlight?.visibility ?? snapshot.visibility,
      sensitivityFlag: candidate.highlight?.sensitivityFlag ?? snapshot.sensitivityFlag,
      confidence: candidate.highlight?.confidence ?? snapshot.confidence,
      ownershipClarity:
        candidate.highlight?.ownershipClarity ?? snapshot.ownershipClarity,
      risksSummary: candidate.highlight?.risksSummary ?? snapshot.risksSummary,
      missingInfo: candidate.highlight?.missingInfo ?? snapshot.missingInfo,
      tags: candidate.highlight?.tags.map((tag) => tag.tag) ?? snapshot.tags,
      verificationNotes:
        candidate.highlight?.verificationNotes ?? snapshot.verificationNotes,
      evidenceLabels:
        candidate.highlight?.evidence.map((entry) => entry.evidenceItem.title) ??
        snapshot.evidenceLabels,
      category: null,
      partial: false,
    };
  }) ?? [];
  const chatRuns = chatWorkspace?.runs.map((run) => ({
    id: run.id,
    status: run.status,
    kind: run.kind,
    failure: (() => {
      const failure = readSourceMetadata(run.error);
      if (!failure || typeof failure.message !== "string") return null;
      const recovery = typeof failure.recovery === "string" ? failure.recovery : null;
      return {
        code: typeof failure.code === "string" ? failure.code : null,
        stage: typeof failure.stage === "string" ? failure.stage : null,
        message: recovery && failure.message.endsWith(recovery)
          ? failure.message.slice(0, -recovery.length).trim()
          : failure.message,
        recovery,
        retryable: failure.retryable !== false,
      };
    })(),
  })) ?? [];
  const workspacePathname = `/work-items/${workItem.id}`;
  const evidencePageHref = (page: number) => buildWorkItemWorkspaceHref({
    pathname: workspacePathname,
    searchParams: resolvedSearchParams,
    updates: {
      tab: "sources",
      evidencePage: page === 1 ? null : page,
      repoList: null,
      repoQuery: null,
    },
  });
  const knowledgePageHref = (page: number) => buildWorkItemWorkspaceHref({
    pathname: workspacePathname,
    searchParams: resolvedSearchParams,
    updates: {
      tab: "highlights",
      knowledgePage: page === 1 ? null : page,
    },
  });
  const sourcesReturnTo = buildWorkItemWorkspaceHref({
    pathname: workspacePathname,
    searchParams: { tab: "sources" },
    updates: {
      evidencePage:
        workspacePagination.evidence.page === 1
          ? null
          : workspacePagination.evidence.page,
    },
  });
  const highlightsReturnTo = buildWorkItemWorkspaceHref({
    pathname: workspacePathname,
    searchParams: { tab: "highlights" },
    updates: {
      knowledgePage:
        workspacePagination.knowledge.page === 1
          ? null
          : workspacePagination.knowledge.page,
    },
  });
  const artifactsReturnTo = `/work-items/${workItem.id}?tab=artifacts`;
  const artifactFormIdempotencyKey = `artifact-form:${workItem.id}:${randomUUID()}`;
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
        activeTab={activeTab}
        tabHrefs={tabHrefs}
        sourcesPanel={
          activeTab === "sources" ? <section className="grid gap-5">
            <div className="grid gap-4 rounded-[30px] border border-black/8 bg-white/86 p-5 shadow-[0_18px_54px_rgba(15,23,42,0.05)] lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="grid gap-4 sm:grid-cols-3">
                <KeyValue label="Sources" value={`${visibleSourceCount} attached`} />
                <KeyValue label="Evidence" value={`${includedEvidenceCount} included`} />
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
                        const refreshMode = source.type === "github_repo"
                          ? getRepositoryRefreshMode(source.metadata)
                          : null;

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
                              {refreshMode === "live"
                                ? <Badge tone="success">live refresh</Badge>
                                : refreshMode === "scheduled"
                                  ? <Badge tone="warning">scheduled refresh</Badge>
                                  : null}
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
                          <input type="hidden" name="repoList" value="1" />
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
                            Search repositories
                          </button>
                        </form>

                        {!shouldListRepositories ? (
                          <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                            Search by owner or repository name, or submit an empty search to browse all accessible repositories.
                          </p>
                        ) : repositoryLookupFailed ? (
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
                    <Badge tone="accent">{includedEvidenceCount} included</Badge>
                    <Badge>
                      {workspacePagination.evidence.totalItems - includedEvidenceCount} excluded
                    </Badge>
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
                  <>
                    <WorkspacePaginationNav
                      label="Evidence"
                      page={workspacePagination.evidence.page}
                      totalPages={workspacePagination.evidence.totalPages}
                      totalItems={workspacePagination.evidence.totalItems}
                      previousHref={
                        workspacePagination.evidence.page > 1
                          ? evidencePageHref(workspacePagination.evidence.page - 1)
                          : null
                      }
                      nextHref={
                        workspacePagination.evidence.page < workspacePagination.evidence.totalPages
                          ? evidencePageHref(workspacePagination.evidence.page + 1)
                          : null
                      }
                    />
                    <div className="grid gap-3">
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
                              <Badge
                                tone={
                                  item.lifecycleStatus === "active"
                                    ? "success"
                                    : item.lifecycleStatus === "quarantined" || item.lifecycleStatus === "retired"
                                      ? "danger"
                                      : "warning"
                                }
                              >
                                Lifecycle: {titleCase(item.lifecycleStatus)}
                              </Badge>
                              {item.reviewState === "pending_review" ? (
                                <Badge tone="accent">Review: Pending review</Badge>
                              ) : null}
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
                        {item.lifecycleStatus === "active" ||
                        item.lifecycleStatus === "needs_validation" ||
                        item.lifecycleStatus === "stale" ? (
                          <details className="mt-3 border-t border-black/7 pt-3 text-xs">
                            <summary className="cursor-pointer font-medium text-[color:var(--accent)]">Edit or retire this evidence</summary>
                            <div className="mt-3 grid gap-3">
                              <form action={editKnowledgeItemAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                                <input type="hidden" name="workItemId" value={workItem.id} />
                                <input type="hidden" name="entityId" value={item.id} />
                                <input type="hidden" name="kind" value="evidence" />
                                <input type="hidden" name="idempotencyKey" value={`evidence-edit:${item.id}:${item.updatedAt.toISOString()}`} />
                                <Textarea name="value" defaultValue={item.content} className="min-h-24" aria-label="Edited evidence content" />
                                <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Save successor</SubmitButton>
                              </form>
                              <form action={retireKnowledgeItemAction} className="flex items-center justify-end gap-2">
                                <input type="hidden" name="workItemId" value={workItem.id} />
                                <input type="hidden" name="entityId" value={item.id} />
                                <input type="hidden" name="kind" value="evidence" />
                                <input type="hidden" name="reason" value="Retired from the Evidence workspace." />
                                <SubmitButton size="sm" variant="ghost" pendingLabel="Retiring…">Retire evidence</SubmitButton>
                              </form>
                            </div>
                          </details>
                        ) : null}
                      </div>
                      ))}
                    </div>
                    <WorkspacePaginationNav
                      label="Evidence"
                      page={workspacePagination.evidence.page}
                      totalPages={workspacePagination.evidence.totalPages}
                      totalItems={workspacePagination.evidence.totalItems}
                      previousHref={
                        workspacePagination.evidence.page > 1
                          ? evidencePageHref(workspacePagination.evidence.page - 1)
                          : null
                      }
                      nextHref={
                        workspacePagination.evidence.page < workspacePagination.evidence.totalPages
                          ? evidencePageHref(workspacePagination.evidence.page + 1)
                          : null
                      }
                    />
                  </>
                ) : (
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    No evidence items have been materialized for this Work Item yet.
                  </p>
                )}
              </CollapsibleCard>
            </section>
          </section> : null
        }
        highlightsPanel={
          activeTab === "highlights" ? <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr] xl:items-start">
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
                    {canApproveAllPendingHighlights ? (
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
                <CardContent className="grid gap-3 sm:grid-cols-5">
                  <KeyValue label="Active approved" value={highlightCounts.approved} />
                  <KeyValue label="Pending" value={highlightCounts.pending} />
                  <KeyValue label="Suggested" value={pendingSuggestionCount} />
                  <KeyValue label="Lifecycle review" value={highlightCounts.lifecycle} />
                  <KeyValue label="Rejected" value={highlightCounts.rejected} />
                </CardContent>
              </Card>

              <WorkspacePaginationNav
                label="Project knowledge"
                page={workspacePagination.knowledge.page}
                totalPages={workspacePagination.knowledge.totalPages}
                totalItems={workspacePagination.knowledge.totalItems}
                summary={`${highlightCount} highlights · ${projectFactCount} project facts`}
                previousHref={
                  workspacePagination.knowledge.page > 1
                    ? knowledgePageHref(workspacePagination.knowledge.page - 1)
                    : null
                }
                nextHref={
                  workspacePagination.knowledge.page < workspacePagination.knowledge.totalPages
                    ? knowledgePageHref(workspacePagination.knowledge.page + 1)
                    : null
                }
              />

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
                count={highlightCounts.pending}
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
                    {highlightCounts.pending
                      ? "No pending highlights are shown on this page."
                      : "No pending highlights right now."}
                  </p>
                )}
              </ClaimSection>

              <ClaimSection
                title="Approved"
                description="Only approved highlights with an active lifecycle appear here and participate in normal retrieval when visibility allows."
                count={highlightCounts.approved}
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
                    {highlightCounts.approved
                      ? "No approved highlights are shown on this page."
                      : "No approved highlights yet."}
                  </p>
                )}
              </ClaimSection>

              <ClaimSection
                title="Lifecycle review"
                description="Needs-validation, stale, quarantined, superseded, and retired versions stay outside the ordinary active lanes and remain visible for audit or successor edits."
                count={highlightCounts.lifecycle}
                tone="warning"
              >
                {lifecycleHighlights.length ? (
                  <div className="space-y-4">
                    {lifecycleHighlights.map((highlight) => (
                      <ClaimCard
                        key={highlight.id}
                        claim={mapHighlightForCard(workItem.id, highlight)}
                        returnTo={highlightsReturnTo}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm leading-6 text-[color:var(--ink-soft)]">
                    {highlightCounts.lifecycle
                      ? "No lifecycle highlights are shown on this page."
                      : "No highlights need lifecycle attention right now."}
                  </p>
                )}
              </ClaimSection>

              <ClaimSection
                title="Rejected"
                description="Rejected highlights stay stored so future generations can avoid weak framing."
                count={highlightCounts.rejected}
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
                    {highlightCounts.rejected
                      ? "No rejected highlights are shown on this page."
                      : "No rejected highlights for this Work Item."}
                  </p>
                )}
              </ClaimSection>

              <ProjectFactSection
                facts={workItem.projectFacts}
                workItemId={workItem.id}
                approvedCount={approvedProjectFactCount}
                totalCount={projectFactCount}
              />

              <WorkspacePaginationNav
                label="Project knowledge"
                page={workspacePagination.knowledge.page}
                totalPages={workspacePagination.knowledge.totalPages}
                totalItems={workspacePagination.knowledge.totalItems}
                summary={`${highlightCount} highlights · ${projectFactCount} project facts`}
                previousHref={
                  workspacePagination.knowledge.page > 1
                    ? knowledgePageHref(workspacePagination.knowledge.page - 1)
                    : null
                }
                nextHref={
                  workspacePagination.knowledge.page < workspacePagination.knowledge.totalPages
                    ? knowledgePageHref(workspacePagination.knowledge.page + 1)
                    : null
                }
              />

              <KnowledgeUpdateInbox
                workItemId={workItem.id}
                refreshes={workItem.knowledgeRefreshRuns.map((refresh) => ({
                  id: refresh.id,
                  status: refresh.status,
                  trigger: refresh.trigger,
                  targetHeads: refresh.targetHeads,
                  progress: refresh.progress,
                  qualityStatus: refresh.qualityStatus,
                  coverage: refresh.coverage,
                  orchestration: refresh.orchestration,
                  budgetUsage: refresh.budgetUsage,
                  createdAt: refresh.createdAt.toISOString(),
                  finishedAt: refresh.finishedAt?.toISOString() ?? null,
                }))}
                changes={workItem.knowledgeChanges.map(mapKnowledgeChangeForInbox)}
                counts={workItem.knowledgeChangeCounts}
              />

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
                    <a
                      href="#knowledge-updates"
                      aria-label={`Jump to ${workItem.knowledgeChangeCounts.totalKnowledgeCount} knowledge updates`}
                      className="group block cursor-pointer rounded-[24px] bg-white/8 p-4 transition hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <p className="text-xs uppercase tracking-[0.18em] text-white/60">Knowledge updates</p>
                      <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em] text-white transition group-hover:translate-x-0.5">
                        {workItem.knowledgeChangeCounts.totalKnowledgeCount}
                      </p>
                    </a>
                    <div className="rounded-[24px] bg-white/8 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/60">Sensitive</p>
                      <p className="mt-2 font-display text-4xl font-semibold tracking-[-0.05em] text-white">
                        {highlightCounts.sensitive}
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
                  <KeyValue label="Sources" value={`${visibleSourceCount} attached`} />
                  <KeyValue label="Evidence" value={`${includedEvidenceCount} included`} />
                </CardContent>
              </Card>
            </aside>
          </section> : null
        }
        chatPanel={
          activeTab === "chat" && chatWorkspace ? <ProjectChatWorkspace
            workItemId={workItem.id}
            workItemTitle={workItem.title}
            activeThreadId={chatWorkspace.activeThread?.id ?? null}
            threads={chatThreads}
            messages={chatMessages}
            events={chatEvents}
            candidates={chatCandidates}
            runs={chatRuns}
            sensitiveContextAvailable={chatSensitiveContextAvailable}
          /> : null
        }
        artifactsPanel={
          activeTab === "artifacts" ? <section className="grid gap-5">
            <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
              <Card>
                <form action={generateArtifactAction}>
                  <input type="hidden" name="workItemId" value={workItem.id} />
                  <input type="hidden" name="returnTo" value={artifactsReturnTo} />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={artifactFormIdempotencyKey}
                  />
                  <CardHeader>
                    <CardTitle>Generate artifact</CardTitle>
                    <CardDescription>
                      Give Workbase a brief. It uses approved highlights or starts a review-gated research run.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                        Brief
                      </span>
                      <Textarea
                        name="brief"
                        placeholder="Example: Write concise resume bullets emphasizing backend reliability and my ownership of the migration."
                        className="min-h-28"
                      />
                    </label>
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

                    <SubmitButton pendingLabel="Starting workflow...">
                      Start artifact workflow
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
                        <Badge tone="success">Lifecycle: Active</Badge>
                        <Badge tone={highlight.reviewState === "pending_review" ? "accent" : "neutral"}>
                          Review: {titleCase(highlight.reviewState)}
                        </Badge>
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
                    Workbase could not assemble enough approved context. The research workflow will propose reviewable highlights instead of using unapproved material.
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
          </section> : null
        }
      />

    </WorkbaseFrame>
  );
}
