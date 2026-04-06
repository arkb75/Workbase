"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { prisma } from "@/src/lib/prisma";
import { ensureDemoUser } from "@/src/lib/demo-user";
import {
  artifactGenerationSchema,
  claimUpdateSchema,
  evidenceInclusionSchema,
  formDataToBoolean,
  githubSourceSchema,
  githubRepoImportSchema,
  manualSourceSchema,
  onboardingSchema,
  workItemSchema,
} from "@/src/lib/schemas";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { buildArtifactFromApprovedClaims, buildClaimGenerationDrafts } from "@/src/domain/workbase-workflows";
import {
  createHighlightWithRelations,
  syncManualEvidenceItemsForWorkItem,
  syncWorkItemDescriptionEvidenceForWorkItem,
  upsertEvidenceItemsForSource,
} from "@/src/lib/evidence-persistence";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { coerceHighlightTagAssignments } from "@/src/lib/highlight-tags";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { githubRepoImportService } from "@/src/services/github-repo-import-service";
import { highlightRetrievalService } from "@/src/services/highlight-retrieval-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";

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

  await upsertEvidenceItemsForSource(
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
        repository: toRepositorySummaryJsonValue(imported.importSummary.repository),
        importedAt: imported.importSummary.importedAt,
        counts: imported.importSummary.counts,
        status: "imported",
      },
    },
  });
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
  type: "manual_note" | "github_repo";
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
    | "github_release";
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
    type: "manual_note" | "github_repo";
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
        type: "manual_note" | "github_repo";
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
      await importGitHubRepositoryIntoWorkItem({
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

  revalidatePath("/dashboard");
  redirect(
    `/work-items/${workItem.id}${
      attachRepositoryOnCreate && selectedRepositoryId ? "?result=github-imported" : ""
    }`,
  );
}

export async function createManualSourceAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const parsed = manualSourceSchema.safeParse({
    workItemId: formData.get("workItemId"),
    label: formData.get("label"),
    rawContent: formData.get("rawContent"),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}?error=invalid-note`);
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

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  redirect(`/work-items/${parsed.data.workItemId}`);
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
  const parsed = githubRepoImportSchema.safeParse({
    workItemId: formData.get("workItemId"),
    repositoryId: formData.get("repositoryId"),
    repositoryFullName: formData.get("repositoryFullName"),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}?error=invalid-repo`);
  }

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
  });

  try {
    await importGitHubRepositoryIntoWorkItem({
      userId: demoUser.id,
      repositoryId: parsed.data.repositoryId,
      repositoryFullName: parsed.data.repositoryFullName,
      workItem,
    });
  } catch {
    redirect(`/work-items/${workItem.id}?error=github-import-failed`);
  }

  revalidatePath(`/work-items/${workItem.id}`);
  redirect(`/work-items/${workItem.id}?result=github-imported`);
}

export async function toggleEvidenceInclusionAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const parsed = evidenceInclusionSchema.safeParse({
    workItemId: formData.get("workItemId"),
    evidenceItemId: formData.get("evidenceItemId"),
    included: formDataToBoolean(formData.get("included")),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}?error=invalid-evidence`);
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
    `/work-items/${parsed.data.workItemId}?result=${
      parsed.data.included ? "evidence-included" : "evidence-excluded"
    }`,
  );
}

export async function reclusterEvidenceAction(formData: FormData) {
  const workItemId = String(formData.get("workItemId") ?? "");
  revalidatePath(`/work-items/${workItemId}`);
  redirect(`/work-items/${workItemId}?result=clusters-current`);
}

export async function generateClaimsAction(workItemId: string) {
  const demoUser = await ensureDemoUser();
  await syncManualEvidenceItemsForWorkItem(workItemId);
  await syncWorkItemDescriptionEvidenceForWorkItem(workItemId);
  const workItem = await getWorkItemGenerationContext(demoUser.id, workItemId);
  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);

  if (!includedEvidenceItems.length) {
    redirect(`/work-items/${workItem.id}/claims?error=highlight-generation-failed`);
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
    redirect(`/work-items/${workItem.id}/claims?error=highlight-generation-failed`);
  }

  const createdHighlightIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    if (claimPlan.replaceableClaims.length) {
      await tx.highlight.deleteMany({
        where: {
          id: {
            in: claimPlan.replaceableClaims.map((claim) => claim.id),
          },
        },
      });
    }

    for (const draft of claimPlan.drafts) {
      const createdHighlight = await createHighlightWithRelations({
        tx,
        workItemId: workItem.id,
        draft,
      });

      createdHighlightIds.push(createdHighlight.id);
    }
  });

  await Promise.allSettled(
    [
      ...claimPlan.generationRunIds.generation,
      claimPlan.generationRunIds.verification,
    ]
      .filter(Boolean)
      .map((generationRunId) =>
        updateGenerationRunResultRefs(generationRunId!, {
          persistedHighlightIds: createdHighlightIds,
          preservedHighlightIds: claimPlan.preservedClaims.map((claim) => claim.id),
        } as Prisma.InputJsonValue),
      ),
  );

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/claims`);
  redirect(`/work-items/${workItem.id}/claims`);
}

export async function approveAllPendingHighlightsAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const workItemId = String(formData.get("workItemId") ?? "");

  if (!workItemId) {
    redirect("/dashboard");
  }

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId: demoUser.id,
    },
  });

  await prisma.highlight.updateMany({
    where: {
      workItemId: workItem.id,
      verificationStatus: {
        in: ["draft", "flagged"],
      },
    },
    data: {
      verificationStatus: "approved",
      rejectionReason: null,
    },
  });

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/claims`);
  revalidatePath(`/work-items/${workItem.id}/artifacts/new`);
  redirect(`/work-items/${workItem.id}/claims?result=approved-all`);
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
    redirect(`/work-items/${claim.workItemId}/claims?error=invalid-highlight`);
  }

  const nextStatus = transitionClaimStatus(
    claim.verificationStatus,
    parsed.data.intent,
  );
  const nextRejectionReason =
    nextStatus === "rejected"
      ? parsed.data.rejectionReason?.trim() || null
      : null;

  await prisma.highlight.update({
    where: {
      id: claim.id,
    },
    data: {
      text: parsed.data.text,
      visibility: parsed.data.visibility,
      sensitivityFlag: parsed.data.sensitivityFlag,
      verificationStatus: nextStatus,
      rejectionReason: nextRejectionReason,
      verificationNotes: parsed.data.verificationNotes ?? null,
    },
  });

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
  redirect(`/work-items/${parsed.data.workItemId}/claims?result=${result}`);
}

export async function generateArtifactAction(formData: FormData) {
  const demoUser = await ensureDemoUser();
  const parsed = artifactGenerationSchema.safeParse({
    workItemId: formData.get("workItemId"),
    type: formData.get("type"),
    targetAngle: formData.get("targetAngle"),
    tone: formData.get("tone"),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}/artifacts/new?error=invalid`);
  }

  await syncWorkItemDescriptionEvidenceForWorkItem(parsed.data.workItemId);

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
    include: {
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
      },
      evidenceItems: {
        include: {
          source: true,
          tags: true,
        },
      },
    },
  });
  let artifactDraft;

  try {
    artifactDraft = await buildArtifactFromApprovedClaims({
      request: {
        userId: demoUser.id,
        workItemId: workItem.id,
        type: parsed.data.type,
        targetAngle: parsed.data.targetAngle,
        tone: parsed.data.tone,
      },
      workItem: mapWorkItemSnapshot(workItem),
      highlights: workItem.highlights.map(mapClaimSnapshot),
      evidenceItems: workItem.evidenceItems.map(mapEvidenceItemSnapshot),
      highlightRetrievalService,
      artifactGenerationService,
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });
  } catch {
    redirect(`/work-items/${workItem.id}/artifacts/new?error=artifact-generation-failed`);
  }

  if (!artifactDraft.artifactDraft) {
    redirect(`/work-items/${workItem.id}/artifacts/new?error=no-artifact-context`);
  }

  const artifact = await prisma.artifact.create({
    data: {
      userId: demoUser.id,
      workItemId: workItem.id,
      type: artifactDraft.artifactDraft.type,
      targetAngle: artifactDraft.artifactDraft.targetAngle,
      tone: artifactDraft.artifactDraft.tone,
      content: artifactDraft.artifactDraft.content,
    },
  });

  if (artifactDraft.generationRunId) {
    await updateGenerationRunResultRefs(artifactDraft.generationRunId, {
      artifactId: artifact.id,
      usedHighlightIds: artifactDraft.artifactDraft.usedHighlightIds,
      supportingEvidenceItemIds: artifactDraft.artifactDraft.supportingEvidenceItemIds,
      fallbackUsed: Boolean(artifactDraft.fallback?.highlights.length),
      fallbackNote: artifactDraft.fallback?.note ?? null,
      unreviewedFallbackHighlights:
        artifactDraft.fallback?.highlights.map((highlight) => ({
          id: highlight.id,
          text: highlight.text,
          summary: highlight.summary,
          confidence: highlight.confidence,
          ownershipClarity: highlight.ownershipClarity,
        })) ?? [],
    } as Prisma.InputJsonValue);
  }

  if (artifactDraft.retrieval.generationRunId) {
    await updateGenerationRunResultRefs(artifactDraft.retrieval.generationRunId, {
      artifactId: artifact.id,
      usedHighlightIds: artifactDraft.artifactDraft.usedHighlightIds,
      supportingEvidenceItemIds: artifactDraft.artifactDraft.supportingEvidenceItemIds,
      fallbackUsed: Boolean(artifactDraft.fallback?.highlights.length),
      fallbackNote: artifactDraft.fallback?.note ?? null,
      unreviewedFallbackHighlights:
        artifactDraft.fallback?.highlights.map((highlight) => ({
          id: highlight.id,
          text: highlight.text,
          summary: highlight.summary,
          confidence: highlight.confidence,
          ownershipClarity: highlight.ownershipClarity,
        })) ?? [],
    } as Prisma.InputJsonValue);
  }

  await Promise.allSettled(
    [
      ...(artifactDraft.fallback?.generationRunIds.generation ?? []),
      artifactDraft.fallback?.generationRunIds.verification ?? null,
    ]
      .filter(Boolean)
      .map((generationRunId) =>
        updateGenerationRunResultRefs(generationRunId!, {
          artifactId: artifact.id,
          fallbackUsed: true,
          fallbackNote: artifactDraft.fallback?.note ?? null,
          unreviewedFallbackHighlights:
            artifactDraft.fallback?.highlights.map((highlight) => ({
              id: highlight.id,
              text: highlight.text,
              summary: highlight.summary,
              confidence: highlight.confidence,
              ownershipClarity: highlight.ownershipClarity,
            })) ?? [],
          supportingEvidenceItemIds: artifactDraft.artifactDraft.supportingEvidenceItemIds,
        } as Prisma.InputJsonValue),
      ),
  );

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/artifacts/new`);
  redirect(`/work-items/${workItem.id}/artifacts/new?artifactId=${artifact.id}`);
}
