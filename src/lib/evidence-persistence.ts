import { Prisma } from "@/src/generated/prisma/client";
import type {
  HighlightDraft,
  JsonValue,
  SourceSnapshot,
} from "@/src/domain/types";
import { buildEvidenceSearchText, inferEvidenceTags } from "@/src/lib/highlight-tags";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { prisma } from "@/src/lib/prisma";

export const WORK_ITEM_DESCRIPTION_SOURCE_KIND = "work_item_description";

type EvidenceItemWrite = {
  workItemId: string;
  sourceId: string;
  externalId: string;
  sourceType?: "manual_note" | "github_repo";
  type:
    | "manual_note_excerpt"
    | "github_readme"
    | "github_commit"
    | "github_pull_request"
    | "github_issue"
    | "github_release";
  title: string;
  content: string;
  searchText?: string;
  parentKind?: string | null;
  parentKey?: string | null;
  included: boolean;
  metadata: JsonValue | null;
};

function readMetadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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
  const nextExternalIds = evidenceItems.map((item) => item.externalId);

  if (existingItems.length) {
    await prisma.evidenceItem.deleteMany({
      where: {
        sourceId,
        externalId: {
          notIn: nextExternalIds.length ? nextExternalIds : [""],
        },
      },
    });
  }

  for (const item of evidenceItems) {
    const existing = existingByExternalId.get(item.externalId);
    const searchText =
      item.searchText ??
      buildEvidenceSearchText({
        title: item.title,
        content: item.content,
        metadata: item.metadata,
      });

    const persisted = await prisma.evidenceItem.upsert({
      where: {
        sourceId_externalId: {
          sourceId,
          externalId: item.externalId,
        },
      },
      create: {
        workItemId: item.workItemId,
        sourceId: item.sourceId,
        externalId: item.externalId,
        type: item.type,
        title: item.title,
        content: item.content,
        searchText,
        parentKind: item.parentKind ?? null,
        parentKey: item.parentKey ?? null,
        included: item.included,
        metadata: item.metadata as Prisma.InputJsonValue,
      },
      update: {
        title: item.title,
        content: item.content,
        type: item.type,
        searchText,
        parentKind: item.parentKind ?? null,
        parentKey: item.parentKey ?? null,
        included: existing?.included ?? item.included,
        metadata: item.metadata as Prisma.InputJsonValue,
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
      });
    }
  }
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
