import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  invalidateEvidenceDependents,
  invalidateHighlightDependents,
} from "@/src/services/knowledge-dependency-service";
import {
  buildArtifactEmbeddingText,
  buildEvidenceEmbeddingText,
  buildProjectFactEmbeddingText,
  upsertArtifactEmbedding,
  upsertEvidenceEmbedding,
  upsertProjectFactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import {
  entityRelationId,
  reviewSnapshotMatchesEntity,
  upsertReviewableKnowledgeChange,
} from "@/src/services/knowledge-change-service";

type ReviewDecision = "keep" | "edit_and_keep" | "revert" | "retire";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function suffix(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function entityRelation(change: {
  evidenceItemId?: string | null;
  highlightId?: string | null;
  projectFactId?: string | null;
  artifactId?: string | null;
}) {
  return change.evidenceItemId
    ? { evidenceItemId: change.evidenceItemId }
    : change.highlightId
      ? { highlightId: change.highlightId }
      : change.projectFactId
        ? { projectFactId: change.projectFactId }
        : change.artifactId
          ? { artifactId: change.artifactId }
          : null;
}

async function queueEditedKnowledgeRevalidation(input: {
  userId: string;
  workItemId: string;
  successor: { kind: string; id: string };
}) {
  if (input.successor.kind !== "project_fact" && input.successor.kind !== "highlight") return;
  try {
    const { repositoryKnowledgeRefreshApplicationService } = await import("@/src/services/repository-knowledge-refresh-application-service");
    await repositoryKnowledgeRefreshApplicationService.start({
      userId: input.userId,
      workItemId: input.workItemId,
      trigger: "backfill",
      idempotencyKey: `knowledge-edit:${input.successor.kind}:${input.successor.id}`,
    });
  } catch (error) {
    await upsertReviewableKnowledgeChange({
      workItemId: input.workItemId,
      entityKind: input.successor.kind,
      action: "updated",
      entityId: input.successor.id,
      afterSnapshot: { id: input.successor.id, lifecycleStatus: "needs_validation" },
      reason: "The edited item is saved but its automatic repository revalidation could not be queued.",
      provenance: { error: error instanceof Error ? error.message : String(error) },
      policyVersion: "knowledge-lifecycle-v2",
      idempotencyKey: `knowledge-edit-revalidation-failed:${input.successor.id}`,
    });
  }
}

async function createEditedSuccessor(input: {
  change: Awaited<ReturnType<typeof loadAuthorizedChange>>;
  patch: Record<string, unknown>;
}) {
  const { change } = input;
  if (change.projectFact) {
    const statement = typeof input.patch.statement === "string" ? input.patch.statement.trim() : change.projectFact.statement;
    const category = typeof input.patch.category === "string" && ["architecture", "behavior", "data_flow", "code_location", "dependency", "configuration"].includes(input.patch.category)
      ? input.patch.category as typeof change.projectFact.category
      : change.projectFact.category;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.projectFact.create({
        data: {
          workItemId: change.workItemId,
          statement,
          category,
          confidence: change.projectFact!.confidence,
          status: "approved",
          sensitivityFlag: typeof input.patch.sensitivityFlag === "boolean" ? input.patch.sensitivityFlag : change.projectFact!.sensitivityFlag,
          reviewNotes: typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.projectFact!.reviewNotes,
          searchText: normalizeWhitespace([statement, category, typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.projectFact!.reviewNotes ?? ""].join(" ")),
          supersedesProjectFactId: change.projectFact!.id,
          lifecycleStatus: "needs_validation",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "not_eligible",
          validatedThroughSha: null,
          lastValidatedAt: null,
          // User edits change the assertion. Preserve provenance, but require the
          // edited successor to be validated again before claiming current-head coverage.
          validationHeads: Prisma.JsonNull,
          subsystemKey: change.projectFact!.subsystemKey,
          productImportance: change.projectFact!.productImportance,
          implementationBreadth: change.projectFact!.implementationBreadth,
          technicalDifficulty: change.projectFact!.technicalDifficulty,
          distinctiveness: change.projectFact!.distinctiveness,
          evidence: { create: change.projectFact!.evidence.map((entry) => ({ evidenceItemId: entry.evidenceItemId, relevanceScore: entry.relevanceScore })) },
        },
      });
      await tx.projectFact.update({ where: { id: change.projectFact!.id }, data: { status: "superseded", lifecycleStatus: "superseded" } });
      return created;
    });
    await upsertProjectFactEmbedding({
      projectFactId: successor.id,
      inputText: buildProjectFactEmbeddingText(successor),
    }).catch(() => undefined);
    return { kind: "project_fact" as const, id: successor.id };
  }
  if (change.highlight) {
    const text = typeof input.patch.text === "string" ? input.patch.text.trim() : change.highlight.text;
    const summary = typeof input.patch.summary === "string" ? input.patch.summary.trim() : change.highlight.summary;
    const visibility = typeof input.patch.visibility === "string" && ["private", "resume_safe", "linkedin_safe", "public_safe"].includes(input.patch.visibility)
      ? input.patch.visibility as typeof change.highlight.visibility
      : change.highlight.visibility;
    const tags = inferHighlightTags({ text, summary, verificationNotes: change.highlight.verificationNotes });
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.highlight.create({
        data: {
          workItemId: change.workItemId,
          text,
          summary,
          searchText: normalizeWhitespace([text, summary, change.highlight!.verificationNotes ?? ""].join(" ")),
          confidence: change.highlight!.confidence,
          ownershipClarity: change.highlight!.ownershipClarity,
          sensitivityFlag: typeof input.patch.sensitivityFlag === "boolean" ? input.patch.sensitivityFlag : change.highlight!.sensitivityFlag,
          verificationStatus: "approved",
          visibility,
          risksSummary: change.highlight!.risksSummary,
          missingInfo: change.highlight!.missingInfo,
          verificationNotes: typeof input.patch.reviewNotes === "string" ? input.patch.reviewNotes : change.highlight!.verificationNotes,
          metadata: change.highlight!.metadata ?? undefined,
          lifecycleStatus: "needs_validation",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          validatedThroughSha: null,
          lastValidatedAt: null,
          validationHeads: Prisma.JsonNull,
          supersedesHighlightId: change.highlight!.id,
          evidence: { create: change.highlight!.evidence.map((entry) => ({ evidenceItemId: entry.evidenceItemId, relevanceScore: entry.relevanceScore })) },
          tags: { create: tags.map((tag) => ({ dimension: tag.dimension, tag: tag.tag, score: tag.score ?? null })) },
        },
      });
      await tx.highlight.update({ where: { id: change.highlight!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    await upsertHighlightEmbedding({
      highlightId: successor.id,
      inputText: buildHighlightEmbeddingText({
        text: successor.text,
        summary: successor.summary,
        verificationNotes: successor.verificationNotes,
        tags,
        evidence: {
          summary: successor.summary,
          verificationNotes: successor.verificationNotes,
          sourceRefs: change.highlight.evidence.map((entry) => ({
            evidenceItemId: entry.evidenceItemId,
            sourceId: entry.evidenceItem.sourceId,
            sourceType: entry.evidenceItem.source.type,
            sourceLabel: entry.evidenceItem.source.label,
            title: entry.evidenceItem.title,
            excerpt: entry.evidenceItem.content,
          })),
        },
      }),
    }).catch(() => undefined);
    await invalidateHighlightDependents({
      workItemId: change.workItemId,
      highlightId: change.highlight.id,
      reason: "A supporting Highlight was superseded by a user-edited version that requires validation.",
      idempotencyScope: `edit-highlight:${change.id}:${successor.id}`,
    });
    return { kind: "highlight" as const, id: successor.id };
  }
  if (change.evidenceItem) {
    const title = typeof input.patch.title === "string" ? input.patch.title.trim() : change.evidenceItem.title;
    const content = typeof input.patch.content === "string" ? input.patch.content.trim() : change.evidenceItem.content;
    const externalId = `correction:${change.evidenceItem.id}:${suffix(`${title}:${content}`)}`;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.evidenceItem.create({
        data: {
          workItemId: change.workItemId,
          sourceId: change.evidenceItem!.sourceId,
          externalId,
          logicalKey: change.evidenceItem!.logicalKey ?? change.evidenceItem!.externalId,
          type: change.evidenceItem!.type,
          title,
          content,
          searchText: normalizeWhitespace([title, content].join(" ")),
          parentKind: "user_correction",
          parentKey: change.evidenceItem!.id,
          included: true,
          metadata: toInputJson({ correctedEvidenceId: change.evidenceItem!.id, originalMetadata: change.evidenceItem!.metadata }),
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "not_eligible",
          supersedesEvidenceItemId: change.evidenceItem!.id,
        },
      });
      await tx.evidenceItem.update({ where: { id: change.evidenceItem!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    await invalidateEvidenceDependents({
      workItemId: change.workItemId,
      evidenceItemId: change.evidenceItem.id,
      reason: "Supporting Evidence was superseded by a user-edited immutable revision.",
      idempotencyScope: `edit-evidence:${change.id}:${successor.id}`,
    });
    await upsertEvidenceEmbedding({
      evidenceItemId: successor.id,
      inputText: buildEvidenceEmbeddingText({
        title: successor.title,
        content: successor.content,
        searchText: successor.searchText,
      }),
    }).catch(() => undefined);
    return { kind: "evidence" as const, id: successor.id };
  }
  if (change.artifact) {
    const content = typeof input.patch.content === "string" ? input.patch.content.trim() : change.artifact.content;
    const successor = await prisma.$transaction(async (tx) => {
      const created = await tx.artifact.create({
        data: {
          userId: change.artifact!.userId,
          workItemId: change.artifact!.workItemId,
          type: change.artifact!.type,
          targetAngle: change.artifact!.targetAngle,
          tone: change.artifact!.tone,
          requestBrief: change.artifact!.requestBrief,
          content,
          searchText: normalizeWhitespace([change.artifact!.requestBrief, content].join(" ")),
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          supersedesArtifactId: change.artifact!.id,
          highlightProvenance: { create: change.artifact!.highlightProvenance.map((entry) => ({ highlightId: entry.highlightId, highlightSnapshot: entry.highlightSnapshot as Prisma.InputJsonValue, rank: entry.rank, relevanceScore: entry.relevanceScore })) },
          evidenceProvenance: { create: change.artifact!.evidenceProvenance.map((entry) => ({ evidenceItemId: entry.evidenceItemId, evidenceSnapshot: entry.evidenceSnapshot as Prisma.InputJsonValue, rank: entry.rank, relevanceScore: entry.relevanceScore })) },
        },
      });
      await tx.artifact.update({ where: { id: change.artifact!.id }, data: { lifecycleStatus: "superseded" } });
      return created;
    });
    await upsertArtifactEmbedding({
      artifactId: successor.id,
      inputText: buildArtifactEmbeddingText(successor),
    }).catch(() => undefined);
    return { kind: "artifact" as const, id: successor.id };
  }
  throw new Error("The knowledge change no longer references an item.");
}

function loadAuthorizedChange(userId: string, changeId: string) {
  return prisma.knowledgeChange.findFirstOrThrow({
    where: { id: changeId, workItem: { userId } },
    include: {
      projectFact: {
        include: {
          evidence: true,
          supersededByProjectFacts: { select: { id: true, lifecycleStatus: true } },
        },
      },
      highlight: {
        include: {
          evidence: { include: { evidenceItem: { include: { source: true } } } },
          tags: true,
          supersededByHighlights: { select: { id: true, lifecycleStatus: true } },
        },
      },
      evidenceItem: { include: { supersededByEvidenceItems: { select: { id: true, lifecycleStatus: true } } } },
      artifact: {
        include: {
          highlightProvenance: true,
          evidenceProvenance: true,
          supersededByArtifacts: { select: { id: true, lifecycleStatus: true } },
        },
      },
    },
  });
}

async function retireOutdatedReviewCard(
  change: Awaited<ReturnType<typeof loadAuthorizedChange>>,
) {
  const relation = entityRelation(change);
  const entityId = entityRelationId(change);
  const entity = change.projectFact ?? change.highlight ?? change.evidenceItem ?? change.artifact;
  if (!relation || !entityId) return false;
  const newer = await prisma.knowledgeChange.findFirst({
    where: {
      workItemId: change.workItemId,
      id: { not: change.id },
      createdAt: { gt: change.createdAt },
      ...relation,
    },
    select: { id: true },
  });
  const activeSuccessor = [
    ...(change.projectFact?.supersededByProjectFacts ?? []),
    ...(change.highlight?.supersededByHighlights ?? []),
    ...(change.evidenceItem?.supersededByEvidenceItems ?? []),
    ...(change.artifact?.supersededByArtifacts ?? []),
  ].some((entry) => ["active", "needs_validation", "quarantined"].includes(entry.lifecycleStatus));
  const matches = reviewSnapshotMatchesEntity({
    entityId,
    afterSnapshot: change.afterSnapshot,
    entity: entity as unknown as Record<string, unknown> | null,
  });
  if (!newer && !activeSuccessor && matches) return false;
  await prisma.knowledgeChange.updateMany({
    where: { id: change.id, decision: "pending" },
    data: {
      decision: "retired",
      reviewedAt: new Date(),
      feedback: newer || activeSuccessor
        ? "This review card was superseded by a newer lifecycle transition."
        : "This review card no longer matches the current entity version and was retired without mutating knowledge.",
    },
  });
  return true;
}

async function setEntityReviewState(change: Awaited<ReturnType<typeof loadAuthorizedChange>>, reviewState: "reviewed" | "reverted") {
  if (change.projectFactId) await prisma.projectFact.updateMany({ where: { id: change.projectFactId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.highlightId) await prisma.highlight.updateMany({ where: { id: change.highlightId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.evidenceItemId) await prisma.evidenceItem.updateMany({ where: { id: change.evidenceItemId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
  if (change.artifactId) await prisma.artifact.updateMany({ where: { id: change.artifactId }, data: { reviewState, approvalSource: reviewState === "reviewed" ? "user" : undefined } });
}

type KnowledgeChangeAction = "created" | "updated" | "revalidated" | "retired" | "quarantined";

export function knowledgeRevertMode(action: KnowledgeChangeAction, options?: { inPlace?: boolean }) {
  if (action === "retired") return "restore_retired" as const;
  if (action === "revalidated" || (action === "updated" && options?.inPlace)) return "restore_in_place" as const;
  return "retire_applied_revision" as const;
}

function snapshotRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function snapshotString(snapshot: Record<string, unknown> | null, key: string) {
  return typeof snapshot?.[key] === "string" ? snapshot[key] as string : null;
}

function snapshotDate(snapshot: Record<string, unknown> | null, key: string) {
  const value = snapshotString(snapshot, key);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function snapshotStringArray(snapshot: Record<string, unknown> | null, key: string) {
  return Array.isArray(snapshot?.[key])
    ? (snapshot![key] as unknown[]).filter((value): value is string => typeof value === "string")
    : null;
}

function resolvedSuccessor(change: Awaited<ReturnType<typeof loadAuthorizedChange>>) {
  const after = snapshotRecord(change.afterSnapshot);
  const recordedId = snapshotString(after, "reviewSuccessorId");
  const recordedKind = snapshotString(after, "reviewSuccessorKind");
  if (recordedId && recordedKind) return { kind: recordedKind, id: recordedId };
  const relationSuccessor = change.projectFact?.supersededByProjectFacts?.[0]
    ? { kind: "project_fact", id: change.projectFact.supersededByProjectFacts[0].id }
    : change.highlight?.supersededByHighlights?.[0]
      ? { kind: "highlight", id: change.highlight.supersededByHighlights[0].id }
      : change.evidenceItem?.supersededByEvidenceItems?.[0]
        ? { kind: "evidence", id: change.evidenceItem.supersededByEvidenceItems[0].id }
        : change.artifact?.supersededByArtifacts?.[0]
          ? { kind: "artifact", id: change.artifact.supersededByArtifacts[0].id }
          : null;
  return relationSuccessor;
}

async function revertAppliedChange(change: Awaited<ReturnType<typeof loadAuthorizedChange>>) {
  const before = snapshotRecord(change.beforeSnapshot);
  const after = snapshotRecord(change.afterSnapshot);
  const entityId = change.projectFactId ?? change.highlightId ?? change.evidenceItemId ?? change.artifactId;
  const beforeId = snapshotString(before, "id");
  const afterId = snapshotString(after, "id");
  const hasExplicitPredecessor = Boolean(
    change.projectFact?.supersedesProjectFactId ||
    change.highlight?.supersedesHighlightId ||
    change.evidenceItem?.supersedesEvidenceItemId ||
    change.artifact?.supersedesArtifactId,
  );
  const inPlace = Boolean(
    entityId &&
    ((beforeId === entityId && (!afterId || afterId === entityId)) ||
      (!beforeId && !afterId && !hasExplicitPredecessor)),
  );
  const mode = knowledgeRevertMode(change.action, { inPlace });

  if (mode === "restore_retired") {
    const priorLifecycle = snapshotString(before, "lifecycleStatus") ?? "active";
    if (change.projectFact) {
      const priorStatus = snapshotString(before, "status") ?? "approved";
      await prisma.projectFact.update({
        where: { id: change.projectFact.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.projectFact.lifecycleStatus,
          status: priorStatus as typeof change.projectFact.status,
          rejectionReason: null,
          reviewState: "reviewed",
        },
      });
    } else if (change.highlight) {
      await prisma.highlight.update({
        where: { id: change.highlight.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.highlight.lifecycleStatus,
          rejectionReason: null,
          reviewState: "reviewed",
        },
      });
    } else if (change.evidenceItem) {
      await prisma.evidenceItem.update({
        where: { id: change.evidenceItem.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.evidenceItem.lifecycleStatus,
          included: typeof before?.included === "boolean" ? before.included : true,
          purgeEligibleAt: null,
          reviewState: "reviewed",
        },
      });
    } else if (change.artifact) {
      await prisma.artifact.update({
        where: { id: change.artifact.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.artifact.lifecycleStatus,
          staleReason: snapshotString(before, "staleReason"),
          reviewState: "reviewed",
        },
      });
    }
    return;
  }

  if (mode === "restore_in_place") {
    const validatedThroughSha = snapshotString(before, "validatedThroughSha");
    const priorLifecycle = snapshotString(before, "lifecycleStatus") ?? (validatedThroughSha ? "active" : "needs_validation");
    const validationHeads = before?.validationHeads == null
      ? Prisma.JsonNull
      : toInputJson(before.validationHeads);
    if (change.projectFact) {
      const evidenceItemIds = snapshotStringArray(before, "evidenceItemIds");
      await prisma.$transaction(async (tx) => {
        await tx.projectFact.update({
          where: { id: change.projectFact!.id },
          data: {
            lifecycleStatus: priorLifecycle as typeof change.projectFact.lifecycleStatus,
            validatedThroughSha,
            validationHeads,
            lastValidatedAt: snapshotDate(before, "lastValidatedAt"),
            status: (snapshotString(before, "status") ?? change.projectFact!.status) as typeof change.projectFact.status,
            rejectionReason: snapshotString(before, "rejectionReason"),
            reviewState: (snapshotString(before, "reviewState") ?? "reviewed") as typeof change.projectFact.reviewState,
            approvalSource: (snapshotString(before, "approvalSource") ?? change.projectFact!.approvalSource) as typeof change.projectFact.approvalSource,
            publicSafetyStatus: (snapshotString(before, "publicSafetyStatus") ?? change.projectFact!.publicSafetyStatus) as typeof change.projectFact.publicSafetyStatus,
            autoAppliedAt: snapshotDate(before, "autoAppliedAt"),
          },
        });
        if (evidenceItemIds) {
          await tx.projectFactEvidence.deleteMany({ where: { projectFactId: change.projectFact!.id } });
          if (evidenceItemIds.length) {
            await tx.projectFactEvidence.createMany({
              data: evidenceItemIds.map((evidenceItemId) => ({ projectFactId: change.projectFact!.id, evidenceItemId })),
              skipDuplicates: true,
            });
          }
        }
      });
    } else if (change.highlight) {
      const evidenceItemIds = snapshotStringArray(before, "evidenceItemIds");
      await prisma.$transaction(async (tx) => {
        await tx.highlight.update({
          where: { id: change.highlight!.id },
          data: {
            lifecycleStatus: priorLifecycle as typeof change.highlight.lifecycleStatus,
            validatedThroughSha,
            validationHeads,
            lastValidatedAt: snapshotDate(before, "lastValidatedAt"),
            rejectionReason: snapshotString(before, "rejectionReason"),
            reviewState: (snapshotString(before, "reviewState") ?? "reviewed") as typeof change.highlight.reviewState,
            approvalSource: (snapshotString(before, "approvalSource") ?? change.highlight!.approvalSource) as typeof change.highlight.approvalSource,
            publicSafetyStatus: (snapshotString(before, "publicSafetyStatus") ?? change.highlight!.publicSafetyStatus) as typeof change.highlight.publicSafetyStatus,
            autoAppliedAt: snapshotDate(before, "autoAppliedAt"),
          },
        });
        if (evidenceItemIds) {
          await tx.highlightEvidence.deleteMany({ where: { highlightId: change.highlight!.id } });
          if (evidenceItemIds.length) {
            await tx.highlightEvidence.createMany({
              data: evidenceItemIds.map((evidenceItemId) => ({ highlightId: change.highlight!.id, evidenceItemId })),
              skipDuplicates: true,
            });
          }
        }
      });
    } else if (change.evidenceItem) {
      await prisma.evidenceItem.update({
        where: { id: change.evidenceItem.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.evidenceItem.lifecycleStatus,
          validatedThroughSha,
          lastValidatedAt: snapshotDate(before, "lastValidatedAt"),
          included: typeof before?.included === "boolean" ? before.included : change.evidenceItem.included,
          purgeEligibleAt: null,
          reviewState: (snapshotString(before, "reviewState") ?? "reverted") as typeof change.evidenceItem.reviewState,
          approvalSource: (snapshotString(before, "approvalSource") ?? change.evidenceItem.approvalSource) as typeof change.evidenceItem.approvalSource,
          publicSafetyStatus: (snapshotString(before, "publicSafetyStatus") ?? change.evidenceItem.publicSafetyStatus) as typeof change.evidenceItem.publicSafetyStatus,
          autoAppliedAt: snapshotDate(before, "autoAppliedAt"),
        },
      });
    } else if (change.artifact) {
      await prisma.artifact.update({
        where: { id: change.artifact.id },
        data: {
          lifecycleStatus: priorLifecycle as typeof change.artifact.lifecycleStatus,
          validatedThroughSha,
          lastValidatedAt: snapshotDate(before, "lastValidatedAt"),
          staleReason: snapshotString(before, "staleReason"),
          reviewState: (snapshotString(before, "reviewState") ?? "reverted") as typeof change.artifact.reviewState,
          approvalSource: (snapshotString(before, "approvalSource") ?? change.artifact.approvalSource) as typeof change.artifact.approvalSource,
          publicSafetyStatus: (snapshotString(before, "publicSafetyStatus") ?? change.artifact.publicSafetyStatus) as typeof change.artifact.publicSafetyStatus,
          autoAppliedAt: snapshotDate(before, "autoAppliedAt"),
        },
      });
    }
    return;
  }

  if (change.projectFact) {
    await prisma.projectFact.update({ where: { id: change.projectFact.id }, data: { lifecycleStatus: "retired", reviewState: "reverted", status: "rejected" } });
    if (change.projectFact.supersedesProjectFactId) await prisma.projectFact.update({ where: { id: change.projectFact.supersedesProjectFactId }, data: { lifecycleStatus: "active", status: "approved" } });
  } else if (change.highlight) {
    await prisma.highlight.update({ where: { id: change.highlight.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.highlight.supersedesHighlightId) await prisma.highlight.update({ where: { id: change.highlight.supersedesHighlightId }, data: { lifecycleStatus: "active" } });
    await invalidateHighlightDependents({
      workItemId: change.workItemId,
      highlightId: change.highlight.id,
      reason: "An automatically applied Highlight was reverted.",
      idempotencyScope: `revert:${change.id}`,
    });
  } else if (change.evidenceItem) {
    await prisma.evidenceItem.update({ where: { id: change.evidenceItem.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.evidenceItem.supersedesEvidenceItemId) await prisma.evidenceItem.update({ where: { id: change.evidenceItem.supersedesEvidenceItemId }, data: { lifecycleStatus: "active" } });
    await invalidateEvidenceDependents({
      workItemId: change.workItemId,
      evidenceItemId: change.evidenceItem.id,
      reason: "Automatically applied Evidence was reverted.",
      idempotencyScope: `revert:${change.id}`,
    });
  } else if (change.artifact) {
    await prisma.artifact.update({ where: { id: change.artifact.id }, data: { lifecycleStatus: "retired", reviewState: "reverted" } });
    if (change.artifact.supersedesArtifactId) await prisma.artifact.update({ where: { id: change.artifact.supersedesArtifactId }, data: { lifecycleStatus: "active", staleReason: null } });
  }
}

async function retireEntity(change: Awaited<ReturnType<typeof loadAuthorizedChange>>, feedback?: string | null) {
  if (change.projectFact) await prisma.projectFact.update({ where: { id: change.projectFact.id }, data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: feedback ?? "Retired during knowledge review.", reviewState: "reviewed" } });
  if (change.highlight) {
    await prisma.highlight.update({ where: { id: change.highlight.id }, data: { lifecycleStatus: "retired", rejectionReason: feedback ?? "Retired during knowledge review.", reviewState: "reviewed" } });
    await invalidateHighlightDependents({
      workItemId: change.workItemId,
      highlightId: change.highlight.id,
      reason: "A supporting Highlight was retired.",
      idempotencyScope: `retire:${change.id}`,
    });
  }
  if (change.evidenceItem) {
    await prisma.evidenceItem.update({ where: { id: change.evidenceItem.id }, data: { lifecycleStatus: "retired", included: false, purgeEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), reviewState: "reviewed" } });
    await invalidateEvidenceDependents({
      workItemId: change.workItemId,
      evidenceItemId: change.evidenceItem.id,
      reason: "Supporting Evidence was retired.",
      idempotencyScope: `retire:${change.id}`,
    });
  }
  if (change.artifact) await prisma.artifact.update({ where: { id: change.artifact.id }, data: { lifecycleStatus: "retired", reviewState: "reviewed", staleReason: feedback ?? change.artifact.staleReason } });
}

export async function resolveKnowledgeChange(input: {
  userId: string;
  changeId: string;
  decision: ReviewDecision;
  patch?: Record<string, unknown>;
  feedback?: string | null;
}) {
  const change = await loadAuthorizedChange(input.userId, input.changeId);
  if (change.decision !== "pending") {
    return { changeId: change.id, decision: change.decision, successor: resolvedSuccessor(change) };
  }
  if (await retireOutdatedReviewCard(change)) {
    return { changeId: change.id, decision: "retired" as const, successor: null, superseded: true };
  }
  if (change.action === "quarantined" && input.decision === "keep") {
    throw new Error("Quarantined knowledge cannot be kept unchanged. Edit it into a validation-gated successor, revert it, or retire it.");
  }
  let successor: { kind: string; id: string } | null = null;
  if (input.decision === "keep") {
    await setEntityReviewState(change, "reviewed");
  } else if (input.decision === "edit_and_keep") {
    successor = await createEditedSuccessor({ change, patch: input.patch ?? {} });
  } else if (input.decision === "revert") {
    await revertAppliedChange(change);
  } else {
    await retireEntity(change, input.feedback);
  }
  if (successor) {
    await queueEditedKnowledgeRevalidation({
      userId: input.userId,
      workItemId: change.workItemId,
      successor,
    });
  }
  const decision = input.decision === "keep"
    ? "kept"
    : input.decision === "edit_and_keep"
      ? "edited_and_kept"
      : input.decision === "revert"
        ? "reverted"
        : "retired";
  await prisma.knowledgeChange.update({
    where: { id: change.id },
    data: {
      decision,
      reviewedAt: new Date(),
      reviewedByUserId: input.userId,
      feedback: input.feedback ?? null,
      ...(successor
        ? {
            afterSnapshot: toInputJson({
              ...(snapshotRecord(change.afterSnapshot) ?? {}),
              reviewSuccessorId: successor.id,
              reviewSuccessorKind: successor.kind,
            }),
          }
        : {}),
    },
  });
  return { changeId: change.id, decision, successor };
}

export async function purgeExpiredUnreferencedEvidence(now = new Date()) {
  const candidates = await prisma.evidenceItem.findMany({
    where: { lifecycleStatus: { in: ["retired", "stale"] }, purgeEligibleAt: { lte: now } },
    include: {
      highlightEvidence: true,
      projectFactEvidence: true,
      artifactProvenance: true,
      chatCitations: true,
      knowledgeChanges: true,
      supersededByEvidenceItems: true,
    },
  });
  const ids = candidates.filter((item) =>
    !item.highlightEvidence.length &&
    !item.projectFactEvidence.length &&
    !item.artifactProvenance.length &&
    !item.chatCitations.length &&
    !item.knowledgeChanges.length &&
    !item.supersededByEvidenceItems.length,
  ).map((item) => item.id);
  if (ids.length) await prisma.evidenceItem.deleteMany({ where: { id: { in: ids } } });
  return ids;
}

async function createManualLifecycleChange(input: {
  userId: string;
  workItemId: string;
  kind: "evidence" | "highlight" | "project_fact" | "artifact";
  entityId: string;
  action: "updated" | "retired";
  idempotencyKey: string;
  reason: string;
}) {
  const workItem = await prisma.workItem.findFirst({ where: { id: input.workItemId, userId: input.userId }, select: { id: true } });
  if (!workItem) throw new Error("The Work Item is not available.");
  const entity = input.kind === "evidence"
    ? await prisma.evidenceItem.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
    : input.kind === "highlight"
      ? await prisma.highlight.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
      : input.kind === "project_fact"
        ? await prisma.projectFact.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } })
        : await prisma.artifact.findFirst({ where: { id: input.entityId, workItemId: input.workItemId } });
  if (!entity) throw new Error("The knowledge item is not available.");
  return upsertReviewableKnowledgeChange({
    workItemId: input.workItemId,
    entityKind: input.kind,
    action: input.action,
    entityId: input.entityId,
    beforeSnapshot: entity,
    reason: input.reason,
    policyVersion: "knowledge-lifecycle-v2",
    idempotencyKey: input.idempotencyKey,
  });
}

export const knowledgeLifecycleService = {
  async edit(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    patch: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    const change = await createManualLifecycleChange({ ...input, action: "updated", reason: "The user requested a versioned knowledge edit." });
    const resolved = await resolveKnowledgeChange({ userId: input.userId, changeId: change.id, decision: "edit_and_keep", patch: input.patch });
    if (!resolved.successor) throw new Error("The edited successor was not created.");
    return { successorId: resolved.successor.id };
  },
  async retire(input: {
    userId: string;
    workItemId: string;
    kind: "evidence" | "highlight" | "project_fact" | "artifact";
    entityId: string;
    reason?: string | null;
    idempotencyKey: string;
  }) {
    const change = await createManualLifecycleChange({ ...input, action: "retired", reason: input.reason ?? "The user requested retirement." });
    await resolveKnowledgeChange({ userId: input.userId, changeId: change.id, decision: "retire", feedback: input.reason });
    return { entityId: input.entityId, lifecycleStatus: "retired" as const };
  },
};

export const knowledgeReviewService = {
  resolve: resolveKnowledgeChange,
  purgeExpiredEvidence: purgeExpiredUnreferencedEvidence,
};
