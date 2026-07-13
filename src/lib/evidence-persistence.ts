import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type {
  HighlightDraft,
  JsonValue,
  SourceSnapshot,
} from "@/src/domain/types";
import { buildEvidenceSearchText, inferEvidenceTags } from "@/src/lib/highlight-tags";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { prisma } from "@/src/lib/prisma";
import { upsertReviewableKnowledgeChange } from "@/src/services/knowledge-change-service";
import { invalidateEvidenceDependents } from "@/src/services/knowledge-dependency-service";

export const WORK_ITEM_DESCRIPTION_SOURCE_KIND = "work_item_description";

type EvidenceItemWrite = {
  workItemId: string;
  sourceId: string;
  externalId: string;
  sourceType?: "manual_note" | "github_repo" | "chat_context";
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
  searchText?: string;
  parentKind?: string | null;
  parentKey?: string | null;
  included: boolean;
  metadata: JsonValue | null;
};

export type PersistedEvidenceItemWriteResult = {
  id: string;
  externalId: string;
  type: EvidenceItemWrite["type"];
  included: boolean;
  wasExisting: boolean;
};

function readMetadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function lifecycleTransitionVersion(item: { updatedAt?: Date; lifecycleStatus: string; externalId: string }) {
  return item.updatedAt instanceof Date
    ? item.updatedAt.toISOString()
    : createHash("sha256").update(`${item.externalId}:${item.lifecycleStatus}`).digest("hex").slice(0, 16);
}

export function isWorkItemDescriptionSourceMetadata(value: unknown) {
  const metadata = readMetadataRecord(value);
  return metadata?.kind === WORK_ITEM_DESCRIPTION_SOURCE_KIND;
}

function buildWorkItemDescriptionSourceExternalId(workItemId: string) {
  return `${workItemId}:work-item-description-source`;
}

function buildWorkItemDescriptionEvidenceExternalId(workItemId: string) {
  return `${workItemId}:work-item-description`;
}

export async function upsertEvidenceItemsForSource(
  sourceId: string,
  evidenceItems: EvidenceItemWrite[],
) {
  const existingItems = await prisma.evidenceItem.findMany({
    where: {
      sourceId,
    },
  });
  const existingByExternalId = new Map(
    existingItems.map((item) => [item.externalId, item]),
  );
  const currentByLogicalKey = new Map(
    existingItems
      .filter((item) => item.lifecycleStatus === "active" || item.lifecycleStatus === "needs_validation")
      .map((item) => [item.logicalKey ?? item.externalId, item]),
  );
  const nextExternalIds = evidenceItems.map((item) => item.externalId);
  const persistedItems: PersistedEvidenceItemWriteResult[] = [];

  if (existingItems.length && evidenceItems.some((item) => item.sourceType === "github_repo")) {
    const nextLogicalKeys = new Set(nextExternalIds);
    const retiredItems = existingItems.filter(
      (item) =>
        item.type !== "github_file_excerpt" &&
        (item.lifecycleStatus === "active" || item.lifecycleStatus === "needs_validation") &&
        !nextLogicalKeys.has(item.logicalKey ?? item.externalId),
    );
    for (const retired of retiredItems) {
      await prisma.evidenceItem.update({
        where: { id: retired.id },
        data: {
          lifecycleStatus: "retired",
          included: false,
          purgeEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      });
      const idempotencyKey = `github-import:evidence:retired:${retired.id}:${lifecycleTransitionVersion(retired)}`;
      await upsertReviewableKnowledgeChange({
        workItemId: retired.workItemId,
        entityKind: "evidence",
        action: "retired",
        entityId: retired.id,
        beforeSnapshot: {
          id: retired.id,
          title: retired.title,
          lifecycleStatus: retired.lifecycleStatus,
          included: retired.included,
        },
        afterSnapshot: { id: retired.id, title: retired.title, lifecycleStatus: "retired" },
        reason: "The current GitHub import no longer contains this Evidence item.",
        provenance: { sourceId, logicalKey: retired.logicalKey ?? retired.externalId },
        policyVersion: "knowledge-lifecycle-v2",
        idempotencyKey,
      });
      await invalidateEvidenceDependents({
        workItemId: retired.workItemId,
        evidenceItemId: retired.id,
        reason: "Supporting repository Evidence was retired because it is absent from the current import.",
        idempotencyScope: idempotencyKey,
      });
    }
  }

  for (const item of evidenceItems) {
    const logicalKey = item.externalId;
    const existing = item.sourceType === "github_repo"
      ? currentByLogicalKey.get(logicalKey) ?? existingByExternalId.get(item.externalId)
      : existingByExternalId.get(item.externalId);
    const searchText =
      item.searchText ??
      buildEvidenceSearchText({
        title: item.title,
        content: item.content,
        metadata: item.metadata,
      });

    const contentVersion = createHash("sha256")
      .update(JSON.stringify({ title: item.title, content: item.content, type: item.type, metadata: item.metadata }))
      .digest("hex")
      .slice(0, 16);
    const isChangedRepositoryEvidence = Boolean(
      item.sourceType === "github_repo" &&
      existing &&
      (existing.title !== item.title || existing.content !== item.content || existing.type !== item.type),
    );
    const isReactivatedRepositoryEvidence = Boolean(
      item.sourceType === "github_repo" &&
      existing &&
      existing.lifecycleStatus !== "active" &&
      existing.lifecycleStatus !== "needs_validation" &&
      !isChangedRepositoryEvidence,
    );
    const persistedExternalId = isChangedRepositoryEvidence
      ? `${logicalKey}:revision:${contentVersion}`
      : item.externalId;
    if (isChangedRepositoryEvidence && existing) {
      await prisma.evidenceItem.update({
        where: { id: existing.id },
        data: { lifecycleStatus: "superseded" },
      });
    }
    const persisted = await prisma.evidenceItem.upsert({
      where: {
        sourceId_externalId: {
          sourceId,
          externalId: persistedExternalId,
        },
      },
      create: {
        workItemId: item.workItemId,
        sourceId: item.sourceId,
        externalId: persistedExternalId,
        logicalKey,
        type: item.type,
        title: item.title,
        content: item.content,
        searchText,
        parentKind: item.parentKind ?? null,
        parentKey: item.parentKey ?? null,
        included: item.included,
        metadata: item.metadata as Prisma.InputJsonValue,
        lifecycleStatus: "active",
        reviewState: item.sourceType === "github_repo" ? "pending_review" : "reviewed",
        approvalSource: item.sourceType === "github_repo" ? "automation" : "user",
        autoAppliedAt: item.sourceType === "github_repo" ? new Date() : null,
        supersedesEvidenceItemId: isChangedRepositoryEvidence ? existing?.id : null,
      },
      update: {
        ...(item.sourceType === "github_repo"
          ? {
              lifecycleStatus: "active" as const,
              reviewState: "pending_review" as const,
              approvalSource: "automation" as const,
              lastValidatedAt: new Date(),
              autoAppliedAt: new Date(),
            }
          : {
              title: item.title,
              content: item.content,
              type: item.type,
              searchText,
              parentKind: item.parentKind ?? null,
              parentKey: item.parentKey ?? null,
              metadata: item.metadata as Prisma.InputJsonValue,
            }),
        included: existing?.included ?? item.included,
      },
    });

    const tags = inferEvidenceTags({
      title: item.title,
      content: item.content,
      sourceType: item.sourceType ?? "github_repo",
      evidenceType: item.type,
    });

    await prisma.evidenceTag.deleteMany({
      where: {
        evidenceItemId: persisted.id,
      },
    });

    if (tags.length) {
      await prisma.evidenceTag.createMany({
        data: tags.map((tag) => ({
          evidenceItemId: persisted.id,
          dimension: tag.dimension,
          tag: tag.tag,
          score: tag.score ?? null,
        })),
        skipDuplicates: true,
      });
    }

    if (item.sourceType === "github_repo" && (!existing || isChangedRepositoryEvidence || isReactivatedRepositoryEvidence)) {
      const transitionVersion = existing ? lifecycleTransitionVersion(existing) : contentVersion;
      const idempotencyKey = `github-import:evidence:${persisted.id}:${contentVersion}:${transitionVersion}`;
      await upsertReviewableKnowledgeChange({
        workItemId: item.workItemId,
        entityKind: "evidence",
        action: isChangedRepositoryEvidence ? "updated" : isReactivatedRepositoryEvidence ? "revalidated" : "created",
        entityId: persisted.id,
        beforeSnapshot: existing
          ? { id: existing.id, title: existing.title, content: existing.content, lifecycleStatus: existing.lifecycleStatus }
          : undefined,
        afterSnapshot: {
          id: persisted.id,
          title: persisted.title,
          content: persisted.content,
          type: persisted.type,
          lifecycleStatus: "active",
        },
        reason: isChangedRepositoryEvidence
          ? "A GitHub import produced a new immutable Evidence revision."
          : isReactivatedRepositoryEvidence
            ? "A GitHub import reactivated Evidence that is present again."
            : "A GitHub import added new Evidence.",
        provenance: { sourceId, logicalKey },
        policyVersion: "knowledge-lifecycle-v2",
        idempotencyKey,
      });
      if (isChangedRepositoryEvidence && existing) {
        await invalidateEvidenceDependents({
          workItemId: item.workItemId,
          evidenceItemId: existing.id,
          reason: "Supporting repository Evidence was superseded by a new immutable revision.",
          idempotencyScope: idempotencyKey,
        });
      }
    }

    persistedItems.push({
      id: persisted.id,
      externalId: persisted.externalId,
      type: persisted.type,
      included: persisted.included,
      wasExisting: Boolean(existing),
    });
  }

  return persistedItems;
}

export async function syncManualEvidenceItemsForWorkItem(workItemId: string) {
  const sources = await prisma.source.findMany({
    where: {
      workItemId,
      type: "manual_note",
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  for (const source of sources) {
    if (isWorkItemDescriptionSourceMetadata(source.metadata)) {
      continue;
    }

    const sourceSnapshot: SourceSnapshot = {
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

    await upsertEvidenceItemsForSource(
      source.id,
      buildManualEvidenceItemsFromSource(sourceSnapshot),
    );
  }
}

export async function syncWorkItemDescriptionEvidenceForWorkItem(workItemId: string) {
  const workItem = await prisma.workItem.findUniqueOrThrow({
    where: {
      id: workItemId,
    },
    select: {
      id: true,
      description: true,
      sources: {
        where: {
          type: "manual_note",
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  const existingDescriptionSource =
    workItem.sources.find((source) => isWorkItemDescriptionSourceMetadata(source.metadata)) ?? null;
  const descriptionSource =
    existingDescriptionSource ??
    (await prisma.source.create({
      data: {
        workItemId: workItem.id,
        type: "manual_note",
        label: "Work Item description",
        externalId: buildWorkItemDescriptionSourceExternalId(workItem.id),
        rawContent: workItem.description,
        metadata: {
          kind: WORK_ITEM_DESCRIPTION_SOURCE_KIND,
          systemOwned: true,
        } satisfies Prisma.InputJsonValue,
      },
    }));

  if (existingDescriptionSource) {
    await prisma.source.update({
      where: {
        id: existingDescriptionSource.id,
      },
      data: {
        label: "Work Item description",
        rawContent: workItem.description,
        metadata: {
          kind: WORK_ITEM_DESCRIPTION_SOURCE_KIND,
          systemOwned: true,
        } satisfies Prisma.InputJsonValue,
      },
    });
  }

  await upsertEvidenceItemsForSource(descriptionSource.id, [
    {
      workItemId: workItem.id,
      sourceId: descriptionSource.id,
      externalId: buildWorkItemDescriptionEvidenceExternalId(workItem.id),
      sourceType: "manual_note",
      type: "manual_note_excerpt",
      title: "Work Item description",
      content: workItem.description,
      searchText: buildEvidenceSearchText({
        title: "Work Item description",
        content: workItem.description,
        metadata: {
          kind: WORK_ITEM_DESCRIPTION_SOURCE_KIND,
          systemOwned: true,
        },
      }),
      parentKind: "work_item",
      parentKey: workItem.id,
      included: true,
      metadata: {
        kind: WORK_ITEM_DESCRIPTION_SOURCE_KIND,
        systemOwned: true,
        sourceType: "manual_note",
      },
    },
  ]);
}

export async function createHighlightWithRelations(params: {
  tx: Prisma.TransactionClient;
  workItemId: string;
  draft: HighlightDraft;
}) {
  const highlight = await params.tx.highlight.create({
    data: {
      workItemId: params.workItemId,
      text: params.draft.text,
      summary: params.draft.summary,
      searchText: [params.draft.text, params.draft.summary, params.draft.verificationNotes ?? ""]
        .filter(Boolean)
        .join(" "),
      confidence: params.draft.confidence,
      ownershipClarity: params.draft.ownershipClarity,
      sensitivityFlag: params.draft.sensitivityFlag,
      verificationStatus: params.draft.verificationStatus,
      visibility: params.draft.visibility,
      risksSummary: params.draft.risksSummary ?? null,
      missingInfo: params.draft.missingInfo ?? null,
      rejectionReason: params.draft.rejectionReason ?? null,
      verificationNotes: params.draft.verificationNotes ?? null,
      metadata:
        params.draft.metadata == null
          ? Prisma.JsonNull
          : (params.draft.metadata as Prisma.InputJsonValue),
    },
  });

  if (params.draft.evidence.sourceRefs.length) {
    await params.tx.highlightEvidence.createMany({
      data: params.draft.evidence.sourceRefs.flatMap((ref) =>
        ref.evidenceItemId
          ? [
              {
                highlightId: highlight.id,
                evidenceItemId: ref.evidenceItemId,
                relevanceScore: null,
              },
            ]
          : [],
      ),
      skipDuplicates: true,
    });
  }

  if (params.draft.tags.length) {
    await params.tx.highlightTag.createMany({
      data: params.draft.tags.map((tag) => ({
        highlightId: highlight.id,
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score ?? null,
      })),
      skipDuplicates: true,
    });
  }

  return highlight;
}
