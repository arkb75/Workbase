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
  formDataToBoolean,
  githubSourceSchema,
  manualSourceSchema,
  onboardingSchema,
  workItemSchema,
} from "@/src/lib/schemas";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { buildArtifactFromApprovedClaims, buildClaimGenerationDrafts } from "@/src/domain/workbase-workflows";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";

function toDateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
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
    rawContent: source.rawContent,
    metadata: (source.metadata as JsonValue | null) ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
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
  verificationStatus: "draft" | "approved" | "flagged";
  visibility: "private" | "resume_safe" | "linkedin_safe" | "public_safe";
  risksSummary: string | null;
  missingInfo: string | null;
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
  const parsed = workItemSchema.safeParse({
    title: formData.get("title"),
    type: formData.get("type"),
    description: formData.get("description"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });

  if (!parsed.success) {
    redirect("/work-items/new?error=invalid");
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

  revalidatePath("/dashboard");
  redirect(`/work-items/${workItem.id}`);
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

  await prisma.source.create({
    data: {
      workItemId: parsed.data.workItemId,
      type: "manual_note",
      label: parsed.data.label,
      rawContent: parsed.data.rawContent,
    },
  });

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

export async function generateClaimsAction(workItemId: string) {
  const demoUser = await ensureDemoUser();
  const workItem = await prisma.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId: demoUser.id,
    },
    include: {
      sources: {
        orderBy: {
          createdAt: "asc",
        },
      },
      claims: {
        include: {
          evidenceCard: true,
        },
      },
    },
  });

  const claimPlan = await buildClaimGenerationDrafts({
    workItem: mapWorkItemSnapshot(workItem),
    sources: workItem.sources.map(mapSourceSnapshot),
    existingClaims: workItem.claims.map(mapClaimSnapshot),
    sourceIngestionService,
    claimResearchService,
    claimVerificationService,
  });

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
      await tx.claim.create({
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
    }
  });

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
    intent: formData.get("intent") ?? "save",
  });

  if (!parsed.success) {
    redirect(`/work-items/${claim.workItemId}/claims?error=invalid-claim`);
  }

  const nextStatus = transitionClaimStatus(
    claim.verificationStatus,
    parsed.data.intent,
  );

  if (parsed.data.intent === "reject") {
    await prisma.claim.delete({
      where: {
        id: claim.id,
      },
    });

    revalidatePath(`/work-items/${parsed.data.workItemId}`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/claims`);
    revalidatePath(`/work-items/${parsed.data.workItemId}/artifacts/new`);
    redirect(`/work-items/${parsed.data.workItemId}/claims?result=rejected`);
  }

  await prisma.claim.update({
    where: {
      id: claim.id,
    },
    data: {
      text: parsed.data.text,
      visibility: parsed.data.visibility,
      sensitivityFlag: parsed.data.sensitivityFlag,
      verificationStatus: nextStatus,
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
    parsed.data.intent === "save"
      ? "saved"
      : nextStatus === "approved"
        ? "approved"
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

  let artifactDraft = null;

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
    artifactDraft = null;
  }

  if (!artifactDraft) {
    redirect(`/work-items/${workItem.id}/artifacts/new?error=no-eligible-claims`);
  }

  const artifact = await prisma.artifact.create({
    data: {
      userId: demoUser.id,
      workItemId: workItem.id,
      type: artifactDraft.type,
      targetAngle: artifactDraft.targetAngle,
      tone: artifactDraft.tone,
      content: artifactDraft.content,
    },
  });

  revalidatePath(`/work-items/${workItem.id}`);
  revalidatePath(`/work-items/${workItem.id}/artifacts/new`);
  redirect(`/work-items/${workItem.id}/artifacts/new?artifactId=${artifact.id}`);
}
