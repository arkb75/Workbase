"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { start } from "workflow/api";
import type { Prisma } from "@/src/generated/prisma/client";
import type { ClaimDraft, ClaimSnapshot, JsonValue } from "@/src/domain/types";
import { prisma } from "@/src/lib/prisma";
import { ensureDemoUser } from "@/src/lib/demo-user";
import {
  artifactGenerationSchema,
  claimUpdateSchema,
  evidenceInclusionSchema,
  formDataToBoolean,
  githubSourceSchema,
  githubRepoImportSchema,
  highlightSuggestionActionSchema,
  manualSourceSchema,
  onboardingSchema,
  workItemSchema,
} from "@/src/lib/schemas";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import {
  buildClaimGenerationDrafts,
  buildIncrementalClaimGenerationDrafts,
} from "@/src/domain/workbase-workflows";
import {
  areNearDuplicateHighlights,
  collectHighlightEvidenceIds,
  classifyHighlightSimilarity,
  haveEvidenceOrTagOverlap,
} from "@/src/domain/claim-regeneration";
import {
  createHighlightWithRelations,
  syncManualEvidenceItemsForWorkItem,
  syncWorkItemDescriptionEvidenceForWorkItem,
  upsertEvidenceItemsForSource,
} from "@/src/lib/evidence-persistence";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { pendingHighlightBulkApprovalWhere } from "@/src/lib/highlight-bulk-approval";
import { coerceHighlightTagAssignments } from "@/src/lib/highlight-tags";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { githubRepoImportService } from "@/src/services/github-repo-import-service";
import {
  buildHighlightEmbeddingText,
  ensureHighlightEmbeddings,
  findNearestHighlightEmbedding,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  applyDraftToHighlight,
  coerceStoredHighlightDraft,
  createOrUpdateHighlightSuggestion,
  refreshHighlightEmbeddingFromDraft,
} from "@/src/services/highlight-suggestion-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import {
  archiveProjectChatThread,
  createProjectChatRun,
  createProjectChatThread,
  renameProjectChatThread,
} from "@/src/services/project-chat-store";
import {
  cancelAgentRunWorkflowSafely,
  startAgentRunWorkflowOnce,
} from "@/src/services/agent-run-workflow-start-service";
import { resolveAgentCandidate } from "@/src/services/candidate-review-service";
import { artifactWorkflowService } from "@/src/services/artifact-workflow-application-service";
import { repositoryKnowledgeRefreshApplicationService } from "@/src/services/repository-knowledge-refresh-application-service";
import { knowledgeRefreshService } from "@/src/services/knowledge-refresh-service";
import { knowledgeLifecycleService, knowledgeReviewService } from "@/src/services/knowledge-review-service";
import { deleteWorkItemForUser } from "@/src/services/work-item-deletion-service";
import {
  artifactGenerationWorkflow,
  projectChatTurnWorkflow,
} from "@/workflows/project-chat";

function toRepositorySummaryJsonValue(repository: {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  url: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string | null;
}) {
  return {
    id: repository.id,
    fullName: repository.fullName,
    owner: repository.owner,
    name: repository.name,
    description: repository.description,
    url: repository.url,
    defaultBranch: repository.defaultBranch,
    private: repository.private,
    updatedAt: repository.updatedAt,
  } as Prisma.InputJsonValue;
}

function toDateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
}

export async function deleteWorkItemAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "").trim();
  if (!workItemId) return;

  await deleteWorkItemForUser({ userId: user.id, workItemId });
  revalidatePath("/dashboard");
}

async function importGitHubRepositoryIntoWorkItem(input: {
  userId: string;
  workItem: {
    id: string;
    userId: string;
    title: string;
    type: "project" | "experience";
    description: string;
    startDate: Date | null;
    endDate: Date | null;
  };
  repositoryId: string;
  repositoryFullName: string;
}) {
  const imported = await githubRepoImportService.importRepository({
    userId: input.userId,
    workItem: mapWorkItemSnapshot(input.workItem),
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
  });

  const persistedEvidenceItems = await upsertEvidenceItemsForSource(
    imported.source.id,
    imported.importedEvidenceItems.map((item) => ({
      workItemId: item.workItemId,
      sourceId: item.sourceId,
      externalId: item.externalId,
      sourceType: item.source.type,
      type: item.type,
      title: item.title,
      content: item.content,
      searchText: item.searchText,
      parentKind: item.parentKind,
      parentKey: item.parentKey,
      included: item.included,
      metadata: item.metadata,
    })),
  );

  await prisma.source.update({
    where: {
      id: imported.source.id,
    },
    data: {
      metadata: {
        ...(
          imported.source.metadata &&
          typeof imported.source.metadata === "object" &&
          !Array.isArray(imported.source.metadata)
            ? imported.source.metadata
            : {}
        ),
        repository: toRepositorySummaryJsonValue(imported.importSummary.repository),
        importedAt: imported.importSummary.importedAt,
        counts: imported.importSummary.counts,
        status: "imported",
      },
    },
  });

  await repositoryKnowledgeRefreshApplicationService.start({
    userId: input.userId,
    workItemId: input.workItem.id,
    trigger: "repository_attach",
    idempotencyKey: `repository-attach:${imported.source.id}:${imported.importSummary.importedAt}`,
  });

  return {
    sourceId: imported.source.id,
    newCommitEvidenceItemIds: persistedEvidenceItems.flatMap((item) =>
      item.type === "github_commit" && !item.wasExisting && item.included
        ? [item.id]
        : [],
    ),
  };
}

function appendFieldErrors(
  searchParams: URLSearchParams,
  fieldErrors: Record<string, string[] | undefined>,
) {
  for (const [field, errors] of Object.entries(fieldErrors)) {
    if (!errors?.length) {
      continue;
    }

    searchParams.set(`${field}Error`, errors[0]);
  }
}

function readWorkItemReturnTo(formData: FormData, workItemId: string, fallback: string) {
  const value = formData.get("returnTo");

  if (
    typeof value === "string" &&
    value.startsWith(`/work-items/${workItemId}`) &&
    !value.startsWith("//")
  ) {
    return value;
  }

  return fallback;
}

function appendRedirectParams(path: string, entries: Record<string, string | null | undefined>) {
  const [pathname, search = ""] = path.split("?");
  const searchParams = new URLSearchParams(search);

  for (const [key, value] of Object.entries(entries)) {
    if (value) {
      searchParams.set(key, value);
    }
  }

  const nextSearch = searchParams.toString();
  return nextSearch ? `${pathname}?${nextSearch}` : pathname;
}

function mapWorkItemSnapshot(workItem: {
  id: string;
  userId: string;
  title: string;
  type: "project" | "experience";
  description: string;
  startDate: Date | null;
  endDate: Date | null;
}) {
  return {
    id: workItem.id,
    userId: workItem.userId,
    title: workItem.title,
    type: workItem.type,
    description: workItem.description,
    startDate: workItem.startDate,
    endDate: workItem.endDate,
  };
}

function mapSourceSnapshot(source: {
  id: string;
  workItemId: string;
  type: "manual_note" | "github_repo" | "chat_context";
  label: string;
  externalId: string | null;
  rawContent: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: source.id,
    workItemId: source.workItemId,
    type: source.type,
    label: source.label,
    externalId: source.externalId,
    rawContent: source.rawContent,
    metadata: (source.metadata as JsonValue | null) ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function mapEvidenceItemSnapshot(item: {
  id: string;
  workItemId: string;
  sourceId: string;
  externalId: string;
  type:
    | "manual_note_excerpt"
    | "github_readme"
    | "github_commit"
    | "github_pull_request"
    | "github_issue"
    | "github_release"
    | "chat_user_statement"
    | "github_file_excerpt";
  title: string;
  content: string;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  included: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    label: string;
    type: "manual_note" | "github_repo" | "chat_context";
    externalId: string | null;
  };
  tags?: Array<{
    dimension: "domain" | "competency" | "emphasis" | "audience_fit";
    tag: string;
    score: number | null;
  }>;
}) {
  return {
    id: item.id,
    workItemId: item.workItemId,
    sourceId: item.sourceId,
    externalId: item.externalId,
    type: item.type,
    title: item.title,
    content: item.content,
    searchText: item.searchText,
    parentKind: item.parentKind,
    parentKey: item.parentKey,
    included: item.included,
    metadata: (item.metadata as JsonValue | null) ?? null,
    source: {
      id: item.source.id,
      label: item.source.label,
      type: item.source.type,
      externalId: item.source.externalId,
    },
    tags: coerceHighlightTagAssignments(
      item.tags?.map((tag) => ({
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score,
      })) ?? [],
    ),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function getWorkItemGenerationContext(userId: string, workItemId: string) {
  return prisma.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId,
    },
    include: {
      sources: {
        orderBy: {
          createdAt: "asc",
        },
      },
      evidenceItems: {
        include: {
          source: true,
          tags: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
      highlights: {
        include: {
          evidence: {
            include: {
              evidenceItem: {
                include: {
                  source: true,
                },
              },
            },
          },
          tags: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      },
    },
  });
}
function mapClaimSnapshot(claim: {
  id: string;
  workItemId: string;
  text: string;
  summary: string;
  searchText: string;
  confidence: "low" | "medium" | "high";
  ownershipClarity: "unclear" | "partial" | "clear";
  sensitivityFlag: boolean;
  verificationStatus: "draft" | "approved" | "flagged" | "rejected";
  visibility: "private" | "resume_safe" | "linkedin_safe" | "public_safe";
  risksSummary: string | null;
  missingInfo: string | null;
  rejectionReason: string | null;
  verificationNotes: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  evidence: Array<{
    evidenceItemId: string;
    relevanceScore: number | null;
    evidenceItem: {
      id: string;
      sourceId: string;
      title: string;
      content: string;
      source: {
        label: string;
        type: "manual_note" | "github_repo" | "chat_context";
      };
    };
  }>;
  tags: Array<{
    dimension: "domain" | "competency" | "emphasis" | "audience_fit";
    tag: string;
    score: number | null;
  }>;
}) {
  return {
    id: claim.id,
    workItemId: claim.workItemId,
    text: claim.text,
    summary: claim.summary,
    searchText: claim.searchText,
    confidence: claim.confidence,
    ownershipClarity: claim.ownershipClarity,
    sensitivityFlag: claim.sensitivityFlag,
    verificationStatus: claim.verificationStatus,
    visibility: claim.visibility,
    risksSummary: claim.risksSummary,
    missingInfo: claim.missingInfo,
    rejectionReason: claim.rejectionReason,
    verificationNotes: claim.verificationNotes ?? null,
    metadata: (claim.metadata as JsonValue | null) ?? null,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    evidence: {
      summary: claim.summary,
      sourceRefs: claim.evidence.map((item) => ({
        evidenceItemId: item.evidenceItemId,
        sourceId: item.evidenceItem.sourceId,
        sourceLabel: item.evidenceItem.source.label,
        sourceType: item.evidenceItem.source.type,
        title: item.evidenceItem.title,
        excerpt: item.evidenceItem.content,
      })),
      verificationNotes: claim.verificationNotes ?? null,
    },
    tags: coerceHighlightTagAssignments(
      claim.tags.map((tag) => ({
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score,
      })),
    ),
  };
}

async function persistGeneratedHighlightPlan(params: {
  workItemId: string;
  claimPlan: Awaited<ReturnType<typeof buildClaimGenerationDrafts>>;
}) {
  const createdHighlights: Array<{ id: string; draft: ClaimDraft }> = [];

  await prisma.$transaction(async (tx) => {
    if (params.claimPlan.replaceableClaims.length) {
      await tx.highlight.updateMany({
        where: {
          id: {
            in: params.claimPlan.replaceableClaims.map((claim) => claim.id),
          },
        },
        data: {
          lifecycleStatus: "retired",
        },
      });
    }

    for (const draft of params.claimPlan.drafts) {
      const createdHighlight = await createHighlightWithRelations({
        tx,
        workItemId: params.workItemId,
        draft,
      });

      createdHighlights.push({
        id: createdHighlight.id,
        draft,
      });
    }
  });

  await Promise.allSettled(
    [
      ...params.claimPlan.generationRunIds.generation,
      params.claimPlan.generationRunIds.verification,
    ]
      .filter(Boolean)
      .map((generationRunId) =>
        updateGenerationRunResultRefs(generationRunId!, {
          persistedHighlightIds: createdHighlights.map((highlight) => highlight.id),
          preservedHighlightIds: params.claimPlan.preservedClaims.map((claim) => claim.id),
        } as Prisma.InputJsonValue),
      ),
  );

  await Promise.all(
    createdHighlights.map((highlight) =>
      upsertHighlightEmbedding({
        highlightId: highlight.id,
        inputText: buildHighlightEmbeddingText(highlight.draft),
      }),
    ),
  );

  return {
    createdHighlightIds: createdHighlights.map((highlight) => highlight.id),
  };
}

function collectGenerationRunIds(runIds: {
  generation: string[];
  verification: string | null;
}) {
  return [...runIds.generation, runIds.verification].filter(
    (generationRunId): generationRunId is string => Boolean(generationRunId),
  );
}

function findDeterministicMatch(
  draft: ClaimDraft,
  existingClaims: ClaimSnapshot[],
) {
  return existingClaims.find((claim) => areNearDuplicateHighlights(claim, draft)) ?? null;
}

async function findIncrementalMatch(params: {
  workItemId: string;
  draft: ClaimDraft;
  existingClaims: ClaimSnapshot[];
}) {
  const deterministicMatch = findDeterministicMatch(
    params.draft,
    params.existingClaims,
  );

  if (deterministicMatch) {
    return {
      claim: deterministicMatch,
      similarityClass: "strong" as const,
      cosineDistance: null,
      cosineSimilarity: null,
      reason: "Deterministic duplicate based on text and evidence overlap.",
    };
  }

  const nearest = (
    await findNearestHighlightEmbedding({
      workItemId: params.workItemId,
      inputText: buildHighlightEmbeddingText(params.draft),
      limit: 1,
    })
  )[0];
  const nearestClaim = nearest
    ? params.existingClaims.find((claim) => claim.id === nearest.highlightId) ?? null
    : null;

  if (!nearest || !nearestClaim) {
    return null;
  }

  const evidenceOrTagOverlap = haveEvidenceOrTagOverlap(nearestClaim, params.draft);
  const similarityClass = classifyHighlightSimilarity({
    cosineSimilarity: nearest.cosineSimilarity,
    evidenceOrTagOverlap,
  });

  if (similarityClass === "none") {
    return null;
  }

  return {
    claim: nearestClaim,
    similarityClass,
    cosineDistance: nearest.cosineDistance,
    cosineSimilarity: nearest.cosineSimilarity,
    reason:
      similarityClass === "strong"
        ? "Embedding similarity is above the strong match threshold."
        : "Embedding similarity is in the possible match range and evidence or tags overlap.",
  };
}

function coerceNewIncrementalDraft(draft: ClaimDraft): ClaimDraft {
  return {
    ...draft,
    verificationStatus:
      draft.verificationStatus === "approved" ? "draft" : draft.verificationStatus,
  };
}

function isNoopApprovedMatch(match: ClaimSnapshot, draft: ClaimDraft) {
  if (match.verificationStatus !== "approved") {
    return false;
  }

  if (match.text.trim().toLowerCase() !== draft.text.trim().toLowerCase()) {
    return false;
  }

  const existingEvidenceIds = collectHighlightEvidenceIds(match);
  const draftEvidenceIds = collectHighlightEvidenceIds(draft);

  for (const evidenceId of draftEvidenceIds) {
    if (!existingEvidenceIds.has(evidenceId)) {
      return false;
    }
  }

  return true;
}

async function runBootstrapHighlightGenerationIfNeeded(input: {
  userId: string;
  workItemId: string;
}) {
  const workItem = await getWorkItemGenerationContext(input.userId, input.workItemId);

  if (workItem.highlights.length) {
    return {
      created: 0,
    };
  }

  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);

  if (!includedEvidenceItems.length) {
    return {
      created: 0,
    };
  }

  const claimPlan = await buildClaimGenerationDrafts({
    workItem: mapWorkItemSnapshot(workItem),
    sources: workItem.sources.map(mapSourceSnapshot),
    evidenceItems: includedEvidenceItems,
    existingClaims: [],
    sourceIngestionService,
    claimResearchService,
    claimVerificationService,
  });
  const result = await persistGeneratedHighlightPlan({
    workItemId: workItem.id,
    claimPlan,
  });

  return {
    created: result.createdHighlightIds.length,
  };
}

async function runIncrementalHighlightGeneration(input: {
  userId: string;
  workItemId: string;
  incrementalEvidenceItemIds: string[];
}) {
  if (!input.incrementalEvidenceItemIds.length) {
    return {
      created: 0,
      updated: 0,
      suggestions: 0,
      suppressed: 0,
    };
  }

  const workItem = await getWorkItemGenerationContext(input.userId, input.workItemId);
  const existingClaims = workItem.highlights.map(mapClaimSnapshot);

  if (!existingClaims.length) {
    const bootstrap = await runBootstrapHighlightGenerationIfNeeded(input);

    return {
      created: bootstrap.created,
      updated: 0,
      suggestions: 0,
      suppressed: 0,
    };
  }

  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);
  const existingClaimsById = new Map(existingClaims.map((claim) => [claim.id, claim]));
  const incrementalPlan = await buildIncrementalClaimGenerationDrafts({
    workItem: mapWorkItemSnapshot(workItem),
    sources: workItem.sources.map(mapSourceSnapshot),
    evidenceItems: includedEvidenceItems,
    incrementalEvidenceItemIds: input.incrementalEvidenceItemIds,
    existingClaims,
    sourceIngestionService,
    claimResearchService,
    claimVerificationService,
  });
  const generationRunIds = collectGenerationRunIds(incrementalPlan.generationRunIds);
  const createdHighlights: Array<{ id: string; draft: ClaimDraft }> = [];
  const updatedHighlightIds: string[] = [];
  const suggestedHighlightIds: string[] = [];
  let suppressed = 0;

  await ensureHighlightEmbeddings(existingClaims);

  for (const rawDraft of incrementalPlan.drafts) {
    const draft = coerceNewIncrementalDraft(rawDraft);
    const match = await findIncrementalMatch({
      workItemId: workItem.id,
      draft,
      existingClaims: Array.from(existingClaimsById.values()),
    });

    if (!match) {
      const createdHighlight = await prisma.$transaction((tx) =>
        createHighlightWithRelations({
          tx,
          workItemId: workItem.id,
          draft,
        }),
      );

      createdHighlights.push({
        id: createdHighlight.id,
        draft,
      });
      continue;
    }

    if (match.claim.verificationStatus === "rejected") {
      suppressed += 1;
      continue;
    }

    if (isNoopApprovedMatch(match.claim, draft)) {
      suppressed += 1;
      continue;
    }

    if (match.claim.verificationStatus === "approved") {
      const suggestion = await createOrUpdateHighlightSuggestion({
        workItemId: workItem.id,
        sourceHighlight: match.claim,
        draft,
        matchReason: match.reason,
        cosineDistance: match.cosineDistance,
        generationRunIds,
      });

      suggestedHighlightIds.push(suggestion.id);
      continue;
    }

    await prisma.$transaction((tx) =>
      applyDraftToHighlight({
        tx,
        highlightId: match.claim.id,
        existingStatus: match.claim.verificationStatus,
        draft,
        mergeEvidence: false,
      }),
    );
    await refreshHighlightEmbeddingFromDraft({
      highlightId: match.claim.id,
      draft,
    });
    updatedHighlightIds.push(match.claim.id);
  }

  await Promise.all(
    createdHighlights.map((highlight) =>
      upsertHighlightEmbedding({
        highlightId: highlight.id,
        inputText: buildHighlightEmbeddingText(highlight.draft),
      }),
    ),
  );
  await Promise.allSettled(
    generationRunIds.map((generationRunId) =>
      updateGenerationRunResultRefs(generationRunId, {
        persistedHighlightIds: createdHighlights.map((highlight) => highlight.id),
        updatedHighlightIds,
        suggestedHighlightIds,
        suppressedHighlightCount: suppressed,
      } as Prisma.InputJsonValue),
    ),
  );

  return {
    created: createdHighlights.length,
    updated: updatedHighlightIds.length,
    suggestions: suggestedHighlightIds.length,
    suppressed,
  };
}

function appendHighlightAutomationParams(
  searchParams: URLSearchParams,
  result: {
    created?: number;
    updated?: number;
    suggestions?: number;
    suppressed?: number;
  },
) {
  if (result.created) {
    searchParams.set("generatedHighlights", String(result.created));
  }

  if (result.updated) {
    searchParams.set("updatedHighlights", String(result.updated));
  }

  if (result.suggestions) {
    searchParams.set("highlightSuggestions", String(result.suggestions));
  }

  if (result.suppressed) {
    searchParams.set("suppressedHighlights", String(result.suppressed));
  }
}

export async function createChatThreadAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");

  if (!workItemId) {
    redirect("/dashboard");
  }

  const thread = await createProjectChatThread({
    userId: user.id,
    workItemId,
  });
  revalidatePath(`/work-items/${workItemId}`);
  redirect(`/work-items/${workItemId}?tab=chat&thread=${thread.id}`);
}

export async function renameChatThreadAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  const title = String(formData.get("title") ?? "");

  if (!workItemId || !threadId || !title.trim()) {
    return;
  }

  await renameProjectChatThread({
    userId: user.id,
    workItemId,
    threadId,
    title,
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function archiveChatThreadAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");

  if (!workItemId || !threadId) {
    return;
  }

  await archiveProjectChatThread({
    userId: user.id,
    workItemId,
    threadId,
  });
  revalidatePath(`/work-items/${workItemId}`);
  redirect(`/work-items/${workItemId}?tab=chat`);
}

export async function sendProjectChatMessageAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  const message = String(formData.get("message") ?? "");
  const submittedKey = String(formData.get("idempotencyKey") ?? "").trim();

  if (!workItemId || !threadId || message.trim().length < 2) {
    return;
  }

  const run = await createProjectChatRun({
    userId: user.id,
    workItemId,
    threadId,
    message,
    idempotencyKey: submittedKey || `chat:${threadId}:${randomUUID()}`,
  });
  await startAgentRunWorkflowOnce({
    runId: run.id,
    startWorkflow: () =>
      run.kind === "artifact_workflow"
        ? start(artifactGenerationWorkflow, [run.id])
        : start(projectChatTurnWorkflow, [run.id]),
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function resolveAgentCandidateAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const candidateId = String(formData.get("candidateId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const editedText = String(formData.get("editedText") ?? "").trim();
  const feedback = String(formData.get("feedback") ?? "").trim();
  const reviewNotes = String(formData.get("reviewNotes") ?? "").trim();
  const visibilityValue = String(formData.get("visibility") ?? "");
  const categoryValue = String(formData.get("category") ?? "");
  const category = [
    "architecture",
    "behavior",
    "data_flow",
    "code_location",
    "dependency",
    "configuration",
  ].includes(categoryValue)
    ? (categoryValue as "architecture" | "behavior" | "data_flow" | "code_location" | "dependency" | "configuration")
    : null;
  const visibility = ["private", "resume_safe", "linkedin_safe", "public_safe"].includes(
    visibilityValue,
  )
    ? (visibilityValue as "private" | "resume_safe" | "linkedin_safe" | "public_safe")
    : null;
  const sensitivityFlag = formData.has("sensitivityFlagPresent")
    ? formDataToBoolean(formData.get("sensitivityFlag"))
    : null;

  if (!workItemId || !candidateId || !["approve", "deny"].includes(decision)) {
    return;
  }

  await resolveAgentCandidate({
    userId: user.id,
    candidateId,
    decision: decision as "approve" | "deny",
    editedText: editedText || null,
    feedback: feedback || null,
    visibility,
    sensitivityFlag,
    reviewNotes: reviewNotes || null,
    category,
    idempotencyKey: `candidate:${candidateId}:${decision}`,
  });
  revalidatePath(`/work-items/${workItemId}`);
  revalidatePath(`/work-items/${workItemId}/claims`);
  revalidatePath(`/work-items/${workItemId}/artifacts/new`);
}

export async function cancelAgentRunAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const runId = String(formData.get("runId") ?? "");

  if (!workItemId || !runId) return;
  const cancellation = await cancelAgentRunWorkflowSafely({
    runId,
    userId: user.id,
    workItemId,
  });
  if (cancellation.cancelled && cancellation.knowledgeRefreshRunId) {
    await knowledgeRefreshService.releaseInline({
      runId: cancellation.knowledgeRefreshRunId,
      ownerToken: `inline-agent:${runId}`,
    }).catch(() => undefined);
  }
  revalidatePath(`/work-items/${workItemId}`);
}

export async function retryAgentRunAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const runId = String(formData.get("runId") ?? "");
  if (!workItemId || !runId) return;

  const previous = await prisma.agentRun.findFirst({
    where: {
      id: runId,
      workItemId,
      userId: user.id,
      status: { in: ["failed", "insufficient_context", "cancelled"] },
      threadId: { not: null },
    },
  });
  if (!previous?.threadId) return;
  const request = previous.request as Record<string, unknown>;
  const message =
    typeof request.message === "string"
      ? request.message
      : typeof request.brief === "string"
        ? request.brief
        : "";
  if (!message) return;

  const run = await createProjectChatRun({
    userId: user.id,
    workItemId,
    threadId: previous.threadId,
    message,
    kind: previous.kind === "artifact_workflow" ? "artifact_workflow" : "chat_turn",
    idempotencyKey: `retry:${previous.id}`,
  });
  await startAgentRunWorkflowOnce({
    runId: run.id,
    startWorkflow: () =>
      run.kind === "artifact_workflow"
        ? start(artifactGenerationWorkflow, [run.id])
        : start(projectChatTurnWorkflow, [run.id]),
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function regenerateHistoricalChatMessageAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!workItemId || !messageId) return;
  const message = await prisma.chatMessage.findFirst({
    where: {
      id: messageId,
      role: "assistant",
      thread: { userId: user.id, workItemId },
      agentRun: { status: "completed" },
    },
    include: { agentRun: true },
  });
  if (!message?.agentRun?.threadId) return;
  const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : null;
  if (metadata?.citationIntegrity !== "legacy_unverifiable") return;
  const request = message.agentRun.request as Record<string, unknown>;
  const prompt = typeof request.message === "string" ? request.message : typeof request.brief === "string" ? request.brief : "";
  if (!prompt) return;
  const run = await createProjectChatRun({
    userId: user.id,
    workItemId,
    threadId: message.agentRun.threadId,
    message: prompt,
    kind: message.agentRun.kind === "artifact_workflow" ? "artifact_workflow" : "chat_turn",
    idempotencyKey: `regenerate:${message.id}`,
  });
  await startAgentRunWorkflowOnce({
    runId: run.id,
    startWorkflow: () => run.kind === "artifact_workflow"
      ? start(artifactGenerationWorkflow, [run.id])
      : start(projectChatTurnWorkflow, [run.id]),
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function updateOnboardingAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const parsed = onboardingSchema.safeParse({
    careerStage: formData.get("careerStage"),
    currentGoal: formData.get("currentGoal"),
    focusPreference: formData.get("focusPreference"),
  });

  if (!parsed.success) {
    redirect("/onboarding?error=invalid");
  }

  await prisma.user.update({
    where: {
      id: demoUser.id,
    },
    data: parsed.data,
  });

  revalidatePath("/");
  revalidatePath("/onboarding");
  redirect("/dashboard");
}

export async function createWorkItemAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const manualNotes = String(formData.get("manualNotes") ?? "").trim();
  const submittedValues = {
    title: String(formData.get("title") ?? ""),
    type: String(formData.get("type") ?? "project"),
    description: String(formData.get("description") ?? ""),
    startDate: String(formData.get("startDate") ?? ""),
    endDate: String(formData.get("endDate") ?? ""),
  };
  const selectedRepositoryId = String(formData.get("repositoryId") ?? "");
  const selectedRepositoryFullName = String(formData.get("repositoryFullName") ?? "");
  const attachRepositoryOnCreate = formDataToBoolean(formData.get("attachRepositoryOnCreate"));
  const parsed = workItemSchema.safeParse(submittedValues);
  let githubImportResult: Awaited<ReturnType<typeof importGitHubRepositoryIntoWorkItem>> | null = null;

  if (!parsed.success) {
    const searchParams = new URLSearchParams({
      error: "invalid",
      title: submittedValues.title,
      type: submittedValues.type,
      description: submittedValues.description,
      startDate: submittedValues.startDate,
      endDate: submittedValues.endDate,
    });

    if (selectedRepositoryId) {
      searchParams.set("repoId", selectedRepositoryId);
    }

    if (selectedRepositoryFullName) {
      searchParams.set("repoFullName", selectedRepositoryFullName);
    }

    if (attachRepositoryOnCreate) {
      searchParams.set("attachRepositoryOnCreate", "true");
    }

    if (manualNotes) {
      searchParams.set("manualNotes", manualNotes);
    }

    appendFieldErrors(searchParams, parsed.error.flatten().fieldErrors);

    redirect(`/work-items/new?${searchParams.toString()}`);
  }

  const workItem = await prisma.workItem.create({
    data: {
      userId: demoUser.id,
      title: parsed.data.title,
      type: parsed.data.type,
      description: parsed.data.description,
      startDate: toDateOrNull(parsed.data.startDate),
      endDate: toDateOrNull(parsed.data.endDate),
    },
  });

  await syncWorkItemDescriptionEvidenceForWorkItem(workItem.id);

  if (attachRepositoryOnCreate && selectedRepositoryId && selectedRepositoryFullName) {
    try {
      githubImportResult = await importGitHubRepositoryIntoWorkItem({
        userId: demoUser.id,
        workItem,
        repositoryId: selectedRepositoryId,
        repositoryFullName: selectedRepositoryFullName,
      });
    } catch {
      revalidatePath("/dashboard");
      redirect(`/work-items/${workItem.id}?error=github-import-failed`);
    }
  }

  if (manualNotes) {
    const source = await prisma.source.create({
      data: {
        workItemId: workItem.id,
        type: "manual_note",
        label: "Initial notes",
        rawContent: manualNotes,
      },
    });

    await upsertEvidenceItemsForSource(
      source.id,
      buildManualEvidenceItemsFromSource(mapSourceSnapshot(source)),
    );
  }

  const searchParams = new URLSearchParams();

  if (attachRepositoryOnCreate && selectedRepositoryId) {
    searchParams.set("result", "github-imported");
  }

  try {
    const bootstrapResult = await runBootstrapHighlightGenerationIfNeeded({
      userId: demoUser.id,
      workItemId: workItem.id,
    });

    appendHighlightAutomationParams(searchParams, bootstrapResult);
  } catch {
    searchParams.set("error", "highlight-automation-failed");
  }

  if (githubImportResult?.newCommitEvidenceItemIds.length) {
    searchParams.set(
      "newCommits",
      String(githubImportResult.newCommitEvidenceItemIds.length),
    );
  }

  revalidatePath("/dashboard");
  redirect(
    `/work-items/${workItem.id}${
      searchParams.size ? `?${searchParams.toString()}` : ""
    }`,
  );
}

export async function createManualSourceAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}?tab=sources`,
  );
  const parsed = manualSourceSchema.safeParse({
    workItemId: formData.get("workItemId"),
    label: formData.get("label"),
    rawContent: formData.get("rawContent"),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-note" }));
  }

  await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
  });

  const source = await prisma.source.create({
    data: {
      workItemId: parsed.data.workItemId,
      type: "manual_note",
      label: parsed.data.label,
      rawContent: parsed.data.rawContent,
    },
  });

  await upsertEvidenceItemsForSource(
    source.id,
    buildManualEvidenceItemsFromSource(mapSourceSnapshot(source)),
  );

  const searchParams = new URLSearchParams();

  try {
    const bootstrapResult = await runBootstrapHighlightGenerationIfNeeded({
      userId: demoUser.id,
      workItemId: parsed.data.workItemId,
    });

    appendHighlightAutomationParams(searchParams, bootstrapResult);
  } catch {
    searchParams.set("error", "highlight-automation-failed");
  }

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  redirect(
    appendRedirectParams(returnTo, Object.fromEntries(searchParams)),
  );
}

export async function createGithubSourceAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const parsed = githubSourceSchema.safeParse({
    workItemId: formData.get("workItemId"),
    label: formData.get("label"),
    repoUrl: formData.get("repoUrl"),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}?error=invalid-repo`);
  }

  await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
  });

  await prisma.source.create({
    data: {
      workItemId: parsed.data.workItemId,
      type: "github_repo",
      label: parsed.data.label,
      metadata: {
        repoUrl: parsed.data.repoUrl,
        status: "placeholder",
      },
    },
  });

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  redirect(`/work-items/${parsed.data.workItemId}`);
}

export async function attachGithubRepoAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}?tab=sources`,
  );
  const parsed = githubRepoImportSchema.safeParse({
    workItemId: formData.get("workItemId"),
    repositoryId: formData.get("repositoryId"),
    repositoryFullName: formData.get("repositoryFullName"),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-repo" }));
  }

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
  });

  let githubImportResult: Awaited<ReturnType<typeof importGitHubRepositoryIntoWorkItem>>;

  try {
    githubImportResult = await importGitHubRepositoryIntoWorkItem({
      userId: demoUser.id,
      repositoryId: parsed.data.repositoryId,
      repositoryFullName: parsed.data.repositoryFullName,
      workItem,
    });
  } catch {
    redirect(appendRedirectParams(returnTo, { error: "github-import-failed" }));
  }

  const searchParams = new URLSearchParams({
    result: "github-imported",
  });

  try {
    const bootstrapResult = await runBootstrapHighlightGenerationIfNeeded({
      userId: demoUser.id,
      workItemId: workItem.id,
    });

    appendHighlightAutomationParams(searchParams, bootstrapResult);

    if (
      !bootstrapResult.created &&
      githubImportResult.newCommitEvidenceItemIds.length
    ) {
      const incrementalResult = await runIncrementalHighlightGeneration({
        userId: demoUser.id,
        workItemId: workItem.id,
        incrementalEvidenceItemIds: githubImportResult.newCommitEvidenceItemIds,
      });

      appendHighlightAutomationParams(searchParams, incrementalResult);
      searchParams.set(
        "newCommits",
        String(githubImportResult.newCommitEvidenceItemIds.length),
      );
    }
  } catch {
    searchParams.set("error", "highlight-automation-failed");
  }

  revalidatePath(`/work-items/${workItem.id}`);
  redirect(appendRedirectParams(returnTo, Object.fromEntries(searchParams)));
}

export async function toggleEvidenceInclusionAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}?tab=sources`,
  );
  const parsed = evidenceInclusionSchema.safeParse({
    workItemId: formData.get("workItemId"),
    evidenceItemId: formData.get("evidenceItemId"),
    included: formDataToBoolean(formData.get("included")),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-evidence" }));
  }

  await prisma.evidenceItem.updateMany({
    where: {
      id: parsed.data.evidenceItemId,
      workItemId: parsed.data.workItemId,
      workItem: {
        userId: demoUser.id,
      },
    },
    data: {
      included: parsed.data.included,
    },
  });

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
  redirect(
    appendRedirectParams(returnTo, {
      result: parsed.data.included ? "evidence-included" : "evidence-excluded",
    }),
  );
}

export async function reclusterEvidenceAction(formData: FormData) {
  const workItemId = String(formData.get("workItemId") ?? "");
  revalidatePath(`/work-items/${workItemId}`);
  redirect(`/work-items/${workItemId}?result=clusters-current`);
}

export async function generateClaimsAction(
  workItemId: string,
  returnToOrFormData?: string | FormData,
) {
  const demoUser = await ensureDemoUser();
  const returnTo =
    typeof returnToOrFormData === "string" ? returnToOrFormData : undefined;
  const destination = returnTo?.startsWith(`/work-items/${workItemId}`)
    ? returnTo
    : `/work-items/${workItemId}/claims`;
  await syncManualEvidenceItemsForWorkItem(workItemId);
  await syncWorkItemDescriptionEvidenceForWorkItem(workItemId);
  const workItem = await getWorkItemGenerationContext(demoUser.id, workItemId);
  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);

  if (!includedEvidenceItems.length) {
    redirect(appendRedirectParams(destination, { error: "highlight-generation-failed" }));
  }

  let claimPlan;

  try {
    claimPlan = await buildClaimGenerationDrafts({
      workItem: mapWorkItemSnapshot(workItem),
      sources: workItem.sources.map(mapSourceSnapshot),
      evidenceItems: includedEvidenceItems,
      existingClaims: workItem.highlights.map(mapClaimSnapshot),
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });
  } catch {
    redirect(appendRedirectParams(destination, { error: "highlight-generation-failed" }));
  }

  await persistGeneratedHighlightPlan({
    workItemId: workItem.id,
    claimPlan,
  });

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/claims`);
  redirect(appendRedirectParams(destination, { result: "highlights-generated" }));
}

export async function approveAllPendingHighlightsAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    workItemId,
    `/work-items/${workItemId}/claims`,
  );

  if (!workItemId) {
    redirect("/dashboard");
  }

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId: demoUser.id,
    },
  });

  const approved = await prisma.highlight.updateMany({
    where: pendingHighlightBulkApprovalWhere(workItem.id),
    data: {
      verificationStatus: "approved",
      rejectionReason: null,
    },
  });

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/claims`);
  revalidatePath(`/work-items/${workItem.id}/artifacts/new`);
  redirect(appendRedirectParams(returnTo, {
    result: approved.count > 0 ? "approved-all" : "no-eligible-highlights",
  }));
}

export async function updateClaimAction(claimId: string, formData: FormData) {
  const demoUser = await ensureDemoUser();
  const claim = await prisma.highlight.findFirstOrThrow({
    where: {
      id: claimId,
      workItem: {
        userId: demoUser.id,
      },
    },
    include: {
      evidence: {
        include: {
          evidenceItem: {
            include: {
              source: true,
            },
          },
        },
      },
      tags: true,
    },
  });
  const rawWorkItemId = String(formData.get("workItemId") ?? claim.workItemId);
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${claim.workItemId}/claims`,
  );

  const parsed = claimUpdateSchema.safeParse({
    workItemId: formData.get("workItemId"),
    text: formData.get("text"),
    visibility: formData.get("visibility"),
    sensitivityFlag: formDataToBoolean(formData.get("sensitivityFlag")),
    verificationNotes: formData.get("verificationNotes"),
    rejectionReason: formData.get("rejectionReason"),
    intent: formData.get("intent") ?? "save",
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-highlight" }));
  }

  const nextStatus = transitionClaimStatus(
    claim.verificationStatus,
    parsed.data.intent,
  );
  const nextRejectionReason =
    nextStatus === "rejected"
      ? parsed.data.rejectionReason?.trim() || null
      : null;

  const runCandidate = await prisma.agentRunCandidate.findFirst({
    where: {
      highlightId: claim.id,
      status: "pending",
      agentRun: { userId: demoUser.id },
    },
    select: { id: true },
  });
  if (runCandidate && (parsed.data.intent === "approve" || parsed.data.intent === "reject")) {
    await resolveAgentCandidate({
      userId: demoUser.id,
      candidateId: runCandidate.id,
      decision: parsed.data.intent === "approve" ? "approve" : "deny",
      editedText: parsed.data.intent === "approve" ? parsed.data.text : null,
      feedback: parsed.data.rejectionReason ?? null,
      visibility: parsed.data.visibility,
      sensitivityFlag: parsed.data.sensitivityFlag,
      reviewNotes: parsed.data.verificationNotes ?? null,
      idempotencyKey: `highlight-form:${runCandidate.id}:${parsed.data.intent}`,
    });
    revalidatePath(`/work-items/${parsed.data.workItemId}`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
    redirect(
      appendRedirectParams(returnTo, {
        result: parsed.data.intent === "approve" ? "approved" : "rejected",
      }),
    );
  }

  if (nextStatus === "rejected") {
    await knowledgeLifecycleService.retire({
      userId: demoUser.id,
      workItemId: claim.workItemId,
      kind: "highlight",
      entityId: claim.id,
      reason: nextRejectionReason ?? "Rejected during Highlight review.",
      idempotencyKey: `highlight-review:${claim.id}:retire:${claim.updatedAt.toISOString()}`,
    });
  } else {
    await knowledgeLifecycleService.edit({
      userId: demoUser.id,
      workItemId: claim.workItemId,
      kind: "highlight",
      entityId: claim.id,
      patch: {
        text: parsed.data.text,
        visibility: parsed.data.visibility,
        sensitivityFlag: parsed.data.sensitivityFlag,
        reviewNotes: parsed.data.verificationNotes ?? null,
      },
      idempotencyKey: `highlight-review:${claim.id}:${parsed.data.intent}:${claim.updatedAt.toISOString()}`,
    });
  }

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
  const result =
    parsed.data.intent === "approve" || nextStatus === "approved"
        ? "approved"
        : parsed.data.intent === "reject" || nextStatus === "rejected"
          ? "rejected"
          : parsed.data.intent === "restore"
            ? "restored"
            : "saved";
  redirect(appendRedirectParams(returnTo, { result }));
}

export async function acceptHighlightSuggestionAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}/claims`,
  );
  const parsed = highlightSuggestionActionSchema.safeParse({
    suggestionId: formData.get("suggestionId"),
    workItemId: formData.get("workItemId"),
    text: formData.get("text"),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-suggestion" }));
  }

  const suggestion = await prisma.highlightSuggestion.findFirstOrThrow({
    where: {
      id: parsed.data.suggestionId,
      workItemId: parsed.data.workItemId,
      status: "pending",
      workItem: {
        userId: demoUser.id,
      },
    },
    include: {
      sourceHighlight: true,
      agentRunCandidates: {
        where: { status: "pending", agentRun: { userId: demoUser.id } },
        take: 1,
      },
    },
  });
  const runCandidate = suggestion.agentRunCandidates[0];
  if (runCandidate) {
    await resolveAgentCandidate({
      userId: demoUser.id,
      candidateId: runCandidate.id,
      decision: "approve",
      editedText: parsed.data.text ?? null,
      idempotencyKey: `suggestion-form:${runCandidate.id}:approve`,
    });
    revalidatePath(`/work-items/${parsed.data.workItemId}`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
    redirect(appendRedirectParams(returnTo, { result: "suggestion-accepted" }));
  }
  const draft = coerceStoredHighlightDraft(suggestion.suggestedDraft);

  if (!draft) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-suggestion" }));
  }

  await prisma.$transaction(async (tx) => {
    await applyDraftToHighlight({
      tx,
      highlightId: suggestion.sourceHighlightId,
      existingStatus: suggestion.sourceHighlight.verificationStatus,
      draft,
      overrideText: parsed.data.text,
      mergeEvidence: true,
    });

    await tx.highlightSuggestion.update({
      where: {
        id: suggestion.id,
      },
      data: {
        status: "accepted",
      },
    });
  });
  await refreshHighlightEmbeddingFromDraft({
    highlightId: suggestion.sourceHighlightId,
    draft,
    overrideText: parsed.data.text,
  });

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
  redirect(appendRedirectParams(returnTo, { result: "suggestion-accepted" }));
}

export async function dismissHighlightSuggestionAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}/claims`,
  );
  const parsed = highlightSuggestionActionSchema.safeParse({
    suggestionId: formData.get("suggestionId"),
    workItemId: formData.get("workItemId"),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid-suggestion" }));
  }

  const runCandidate = await prisma.agentRunCandidate.findFirst({
    where: {
      highlightSuggestionId: parsed.data.suggestionId,
      status: "pending",
      agentRun: { userId: demoUser.id, workItemId: parsed.data.workItemId },
    },
    select: { id: true },
  });
  if (runCandidate) {
    await resolveAgentCandidate({
      userId: demoUser.id,
      candidateId: runCandidate.id,
      decision: "deny",
      feedback: "Dismissed from the Highlights workspace.",
      idempotencyKey: `suggestion-form:${runCandidate.id}:deny`,
    });
    revalidatePath(`/work-items/${parsed.data.workItemId}`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
    redirect(appendRedirectParams(returnTo, { result: "suggestion-dismissed" }));
  }

  await prisma.highlightSuggestion.updateMany({
    where: {
      id: parsed.data.suggestionId,
      workItemId: parsed.data.workItemId,
      status: "pending",
      workItem: {
        userId: demoUser.id,
      },
    },
    data: {
      status: "dismissed",
    },
  });

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
  redirect(appendRedirectParams(returnTo, { result: "suggestion-dismissed" }));
}

export async function generateArtifactAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const rawWorkItemId = String(formData.get("workItemId") ?? "");
  const returnTo = readWorkItemReturnTo(
    formData,
    rawWorkItemId,
    `/work-items/${rawWorkItemId}/artifacts/new`,
  );
  const parsed = artifactGenerationSchema.safeParse({
    workItemId: formData.get("workItemId"),
    type: formData.get("type"),
    targetAngle: formData.get("targetAngle"),
    tone: formData.get("tone"),
  });

  if (!parsed.success) {
    redirect(appendRedirectParams(returnTo, { error: "invalid" }));
  }

  await syncWorkItemDescriptionEvidenceForWorkItem(parsed.data.workItemId);
  await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
    select: { id: true },
  });
  const suppliedBrief = String(formData.get("brief") ?? "").trim();
  const submittedIdempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  const controlsBrief = [
    `Generate ${parsed.data.type.replace(/_/g, " ")}.`,
    `Use a ${parsed.data.targetAngle.replace(/_/g, " ")} angle`,
    `and a ${parsed.data.tone.replace(/_/g, " ")} tone.`,
  ].join(" ");
  const brief = suppliedBrief ? `${suppliedBrief}\n\n${controlsBrief}` : controlsBrief;
  const state = await artifactWorkflowService.start({
    userId: demoUser.id,
    workItemId: parsed.data.workItemId,
    brief,
    idempotencyKey: submittedIdempotencyKey || `artifact-form:${randomUUID()}`,
  });
  if (state.status !== "queued") {
    throw new Error("Artifact workflow did not enter the durable queue.");
  }
  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
  redirect(
    `/work-items/${parsed.data.workItemId}?tab=chat&thread=${state.threadId}&result=artifact-started`,
  );
}

export async function startProjectKnowledgeRefreshAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "").trim();
  if (!workItemId) throw new Error("A Work Item is required.");
  const workItem = await prisma.workItem.findFirst({
    where: { id: workItemId, userId: user.id },
    select: { id: true },
  });
  if (!workItem) throw new Error("The Work Item is not available.");
  await repositoryKnowledgeRefreshApplicationService.start({
    userId: user.id,
    workItemId,
    trigger: "manual",
    idempotencyKey: `manual:${workItemId}:${randomUUID()}`,
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function resolveKnowledgeChangeAction(formData: FormData) {
  const user = await ensureDemoUser();
  const changeId = String(formData.get("changeId") ?? "").trim();
  const workItemId = String(formData.get("workItemId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  if (!changeId || !workItemId || !["keep", "edit_and_keep", "revert", "retire"].includes(decision)) {
    throw new Error("The knowledge review request is invalid.");
  }
  const patch = {
    text: String(formData.get("text") ?? "").trim() || undefined,
    statement: String(formData.get("statement") ?? "").trim() || undefined,
    summary: String(formData.get("summary") ?? "").trim() || undefined,
    title: String(formData.get("title") ?? "").trim() || undefined,
    content: String(formData.get("content") ?? "").trim() || undefined,
    category: String(formData.get("category") ?? "").trim() || undefined,
    visibility: String(formData.get("visibility") ?? "").trim() || undefined,
    reviewNotes: String(formData.get("reviewNotes") ?? "").trim() || undefined,
    ...(formData.has("sensitivityFlag")
      ? { sensitivityFlag: formData.get("sensitivityFlag") === "true" || formData.get("sensitivityFlag") === "on" }
      : {}),
  };
  await knowledgeReviewService.resolve({
    userId: user.id,
    changeId,
    decision: decision as "keep" | "edit_and_keep" | "revert" | "retire",
    patch,
    feedback: String(formData.get("feedback") ?? "").trim() || null,
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function editKnowledgeItemAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const entityId = String(formData.get("entityId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!workItemId || !entityId || !value || !["evidence", "highlight", "project_fact", "artifact"].includes(kind)) {
    throw new Error("The knowledge edit is invalid.");
  }
  const field = kind === "evidence" || kind === "artifact" ? "content" : kind === "highlight" ? "text" : "statement";
  await knowledgeLifecycleService.edit({
    userId: user.id,
    workItemId,
    kind: kind as "evidence" | "highlight" | "project_fact" | "artifact",
    entityId,
    patch: { [field]: value },
    idempotencyKey: String(formData.get("idempotencyKey") ?? "") || `manual-edit:${entityId}:${randomUUID()}`,
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function retireKnowledgeItemAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");
  const entityId = String(formData.get("entityId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!workItemId || !entityId || !["evidence", "highlight", "project_fact", "artifact"].includes(kind)) {
    throw new Error("The knowledge retirement request is invalid.");
  }
  await knowledgeLifecycleService.retire({
    userId: user.id,
    workItemId,
    kind: kind as "evidence" | "highlight" | "project_fact" | "artifact",
    entityId,
    reason: reason || null,
    idempotencyKey: String(formData.get("idempotencyKey") ?? "") || `manual-retire:${entityId}:${randomUUID()}`,
  });
  revalidatePath(`/work-items/${workItemId}`);
}

export async function refreshStaleArtifactAction(formData: FormData) {
  const user = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "").trim();
  const artifactId = String(formData.get("artifactId") ?? "").trim();
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, workItemId, userId: user.id, lifecycleStatus: "stale" },
  });
  if (!artifact) throw new Error("The stale Artifact is not available for refresh.");
  const state = await artifactWorkflowService.start({
    userId: user.id,
    workItemId,
    brief: artifact.requestBrief,
    supersedesArtifactId: artifact.id,
    idempotencyKey: `artifact-refresh:${artifact.id}:${randomUUID()}`,
  });
  if (state.status !== "queued") throw new Error("Artifact refresh did not enter the durable queue.");
  revalidatePath(`/work-items/${workItemId}`);
  redirect(`/work-items/${workItemId}?tab=chat&thread=${state.threadId}&result=artifact-refresh-started`);
}
