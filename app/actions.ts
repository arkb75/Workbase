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
  reclusterEvidenceSchema,
  workItemSchema,
} from "@/src/lib/schemas";
import { getEligibleClaimsForArtifact } from "@/src/domain/artifact-eligibility";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { buildArtifactFromApprovedClaims, buildClaimGenerationDrafts } from "@/src/domain/workbase-workflows";
import { evidenceClustersAreStale } from "@/src/lib/evidence-items";
import {
  persistEvidenceClusters,
  syncManualEvidenceItemsForWorkItem,
  upsertEvidenceItemsForSource,
} from "@/src/lib/evidence-persistence";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { evidenceClusteringService } from "@/src/services/evidence-clustering-service";
import { githubRepoImportService } from "@/src/services/github-repo-import-service";
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
      type: item.type,
      title: item.title,
      content: item.content,
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
}) {
  return {
    id: item.id,
    workItemId: item.workItemId,
    sourceId: item.sourceId,
    externalId: item.externalId,
    type: item.type,
    title: item.title,
    content: item.content,
    included: item.included,
    metadata: (item.metadata as JsonValue | null) ?? null,
    source: {
      id: item.source.id,
      label: item.source.label,
      type: item.source.type,
      externalId: item.source.externalId,
    },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function mapEvidenceClusterSnapshot(cluster: {
  id: string;
  workItemId: string;
  title: string;
  summary: string;
  theme: string;
  confidence: "low" | "medium" | "high";
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    evidenceItemId: string;
    relevanceScore: number | null;
  }>;
}) {
  return {
    id: cluster.id,
    workItemId: cluster.workItemId,
    title: cluster.title,
    summary: cluster.summary,
    theme: cluster.theme,
    confidence: cluster.confidence,
    metadata: (cluster.metadata as JsonValue | null) ?? null,
    items: cluster.items.map((item) => ({
      id: item.id,
      evidenceItemId: item.evidenceItemId,
      relevanceScore: item.relevanceScore,
    })),
    createdAt: cluster.createdAt,
    updatedAt: cluster.updatedAt,
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
        },
        orderBy: {
          createdAt: "asc",
        },
      },
      evidenceClusters: {
        include: {
          items: {
            orderBy: {
              createdAt: "asc",
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      },
      claims: {
        include: {
          evidenceCard: true,
        },
      },
    },
  });
}

async function ensureFreshEvidenceClusters(input: {
  userId: string;
  workItemId: string;
}) {
  await syncManualEvidenceItemsForWorkItem(input.workItemId);
  const workItem = await getWorkItemGenerationContext(input.userId, input.workItemId);
  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);
  const latestClusterUpdatedAt = workItem.evidenceClusters[0]?.updatedAt ?? null;

  if (!includedEvidenceItems.length) {
    return {
      workItem,
      didRecluster: false,
      clusteringGenerationRunId: null as string | null,
    };
  }

  if (!evidenceClustersAreStale(includedEvidenceItems, latestClusterUpdatedAt)) {
    return {
      workItem,
      didRecluster: false,
      clusteringGenerationRunId: null as string | null,
    };
  }

  const clusteringResult = await evidenceClusteringService.cluster({
    workItem: mapWorkItemSnapshot(workItem),
    evidenceItems: includedEvidenceItems,
  });

  await persistEvidenceClusters(workItem.id, clusteringResult.clusters);

  const refreshedWorkItem = await getWorkItemGenerationContext(input.userId, input.workItemId);

  if (clusteringResult.generationRunId) {
    await updateGenerationRunResultRefs(clusteringResult.generationRunId, {
      persistedClusterIds: refreshedWorkItem.evidenceClusters.map((cluster) => cluster.id),
      includedEvidenceItemIds: includedEvidenceItems.map((item) => item.id),
    } as Prisma.InputJsonValue);
  }

  return {
    workItem: refreshedWorkItem,
    didRecluster: true,
    clusteringGenerationRunId: clusteringResult.generationRunId,
  };
}

function mapClaimSnapshot(claim: {
  id: string;
  workItemId: string;
  text: string;
  category: string | null;
  confidence: "low" | "medium" | "high";
  ownershipClarity: "unclear" | "partial" | "clear";
  sensitivityFlag: boolean;
  verificationStatus: "draft" | "approved" | "flagged" | "rejected";
  visibility: "private" | "resume_safe" | "linkedin_safe" | "public_safe";
  risksSummary: string | null;
  missingInfo: string | null;
  rejectionReason: string | null;
  evidenceCard: {
    evidenceSummary: string;
    rationaleSummary: string;
    sourceRefs: unknown;
    verificationNotes: string | null;
  } | null;
}) {
  return {
    id: claim.id,
    workItemId: claim.workItemId,
    text: claim.text,
    category: claim.category,
    confidence: claim.confidence,
    ownershipClarity: claim.ownershipClarity,
    sensitivityFlag: claim.sensitivityFlag,
    verificationStatus: claim.verificationStatus,
    visibility: claim.visibility,
    risksSummary: claim.risksSummary,
    missingInfo: claim.missingInfo,
    rejectionReason: claim.rejectionReason,
    evidenceCard: {
      evidenceSummary: claim.evidenceCard?.evidenceSummary ?? "",
      rationaleSummary: claim.evidenceCard?.rationaleSummary ?? "",
      sourceRefs: Array.isArray(claim.evidenceCard?.sourceRefs)
        ? (claim.evidenceCard?.sourceRefs as [])
        : [],
      verificationNotes: claim.evidenceCard?.verificationNotes ?? null,
    },
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
  const demoUser = await ensureDemoUser();
  const parsed = reclusterEvidenceSchema.safeParse({
    workItemId: formData.get("workItemId"),
  });

  if (!parsed.success) {
    redirect(`/work-items/${formData.get("workItemId")}?error=invalid-cluster`);
  }

  let workItemState;

  try {
    workItemState = await ensureFreshEvidenceClusters({
      userId: demoUser.id,
      workItemId: parsed.data.workItemId,
    });
  } catch {
    redirect(`/work-items/${parsed.data.workItemId}?error=clustering-failed`);
  }

  revalidatePath(`/work-items/${parsed.data.workItemId}`);
  revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
  redirect(
    `/work-items/${parsed.data.workItemId}?result=${
      workItemState.didRecluster ? "reclustered" : "clusters-current"
    }`,
  );
}

export async function generateClaimsAction(workItemId: string) {
  const demoUser = await ensureDemoUser();
  let workItemState;

  try {
    workItemState = await ensureFreshEvidenceClusters({
      userId: demoUser.id,
      workItemId,
    });
  } catch {
    redirect(`/work-items/${workItemId}/claims?error=claim-generation-failed`);
  }

  const workItem = workItemState.workItem;
  const includedEvidenceItems = workItem.evidenceItems
    .map(mapEvidenceItemSnapshot)
    .filter((item) => item.included);

  if (!includedEvidenceItems.length) {
    redirect(`/work-items/${workItem.id}/claims?error=claim-generation-failed`);
  }

  let claimPlan;

  try {
    claimPlan = await buildClaimGenerationDrafts({
      workItem: mapWorkItemSnapshot(workItem),
      sources: workItem.sources.map(mapSourceSnapshot),
      evidenceItems: includedEvidenceItems,
      clusters: workItem.evidenceClusters.map(mapEvidenceClusterSnapshot),
      existingClaims: workItem.claims.map(mapClaimSnapshot),
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });
  } catch {
    redirect(`/work-items/${workItem.id}/claims?error=claim-generation-failed`);
  }

  const createdClaimIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    if (claimPlan.replaceableClaims.length) {
      await tx.claim.deleteMany({
        where: {
          id: {
            in: claimPlan.replaceableClaims.map((claim) => claim.id),
          },
        },
      });
    }

    for (const draft of claimPlan.drafts) {
      const createdClaim = await tx.claim.create({
        data: {
          workItemId: workItem.id,
          text: draft.text,
          category: draft.category ?? null,
          confidence: draft.confidence,
          ownershipClarity: draft.ownershipClarity,
          sensitivityFlag: draft.sensitivityFlag,
          verificationStatus: draft.verificationStatus,
          visibility: draft.visibility,
          risksSummary: draft.risksSummary ?? null,
          missingInfo: draft.missingInfo ?? null,
          rejectionReason: draft.rejectionReason ?? null,
          evidenceCard: {
            create: {
              evidenceSummary: draft.evidenceCard.evidenceSummary,
              rationaleSummary: draft.evidenceCard.rationaleSummary,
              sourceRefs:
                draft.evidenceCard.sourceRefs as unknown as Prisma.InputJsonValue,
              verificationNotes: draft.evidenceCard.verificationNotes ?? null,
            },
          },
        },
      });

      createdClaimIds.push(createdClaim.id);
    }
  });

  await Promise.allSettled(
    [claimPlan.generationRunIds.research, claimPlan.generationRunIds.verification]
      .filter(Boolean)
      .map((generationRunId) =>
        updateGenerationRunResultRefs(generationRunId!, {
          persistedClaimIds: createdClaimIds,
          preservedClaimIds: claimPlan.preservedClaims.map((claim) => claim.id),
        } as Prisma.InputJsonValue),
      ),
  );

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/claims`);
  redirect(`/work-items/${workItem.id}/claims`);
}

export async function updateClaimAction(claimId: string, formData: FormData) {
  const demoUser = await ensureDemoUser();
  const claim = await prisma.claim.findFirstOrThrow({
    where: {
      id: claimId,
      workItem: {
        userId: demoUser.id,
      },
    },
    include: {
      evidenceCard: true,
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
    redirect(`/work-items/${claim.workItemId}/claims?error=invalid-claim`);
  }

  const nextStatus = transitionClaimStatus(
    claim.verificationStatus,
    parsed.data.intent,
  );
  const nextRejectionReason =
    nextStatus === "rejected"
      ? parsed.data.rejectionReason?.trim() || null
      : null;

  await prisma.claim.update({
    where: {
      id: claim.id,
    },
    data: {
      text: parsed.data.text,
      visibility: parsed.data.visibility,
      sensitivityFlag: parsed.data.sensitivityFlag,
      verificationStatus: nextStatus,
      rejectionReason: nextRejectionReason,
      evidenceCard: claim.evidenceCard
        ? {
            update: {
              verificationNotes: parsed.data.verificationNotes ?? null,
            },
          }
        : undefined,
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

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: parsed.data.workItemId,
      userId: demoUser.id,
    },
    include: {
      claims: {
        include: {
          evidenceCard: true,
        },
      },
    },
  });
  const eligibleClaims = getEligibleClaimsForArtifact(
    workItem.claims.map(mapClaimSnapshot),
    parsed.data.type,
  );

  if (!eligibleClaims.length) {
    redirect(`/work-items/${workItem.id}/artifacts/new?error=no-eligible-claims`);
  }

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
      claims: workItem.claims.map(mapClaimSnapshot),
      artifactGenerationService,
    });
  } catch {
    redirect(`/work-items/${workItem.id}/artifacts/new?error=artifact-generation-failed`);
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
      usedClaimIds: artifactDraft.artifactDraft.usedClaimIds,
    } as Prisma.InputJsonValue);
  }

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/artifacts/new`);
  redirect(`/work-items/${workItem.id}/artifacts/new?artifactId=${artifact.id}`);
}
