import type { Prisma } from "@/src/generated/prisma/client";
import type { EvidenceClusterDraft, JsonValue, SourceSnapshot } from "@/src/domain/types";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { prisma } from "@/src/lib/prisma";

type EvidenceItemWrite = {
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
  metadata: JsonValue | null;
};

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
    await prisma.evidenceClusterItem.deleteMany({
      where: {
        evidenceItem: {
          sourceId,
          externalId: {
            notIn: nextExternalIds.length ? nextExternalIds : [""],
          },
        },
      },
    });

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

    await prisma.evidenceItem.upsert({
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
        included: item.included,
        metadata: item.metadata as Prisma.InputJsonValue,
      },
      update: {
        title: item.title,
        content: item.content,
        type: item.type,
        included: existing?.included ?? item.included,
        metadata: item.metadata as Prisma.InputJsonValue,
      },
    });
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

export async function persistEvidenceClusters(
  workItemId: string,
  clusters: EvidenceClusterDraft[],
) {
  await prisma.$transaction(async (tx) => {
    await tx.evidenceCluster.deleteMany({
      where: {
        workItemId,
      },
    });

    for (const cluster of clusters) {
      await tx.evidenceCluster.create({
        data: {
          workItemId,
          title: cluster.title,
          summary: cluster.summary,
          theme: cluster.theme,
          confidence: cluster.confidence,
          metadata: cluster.metadata as Prisma.InputJsonValue,
          items: {
            create: cluster.items.map((item) => ({
              evidenceItemId: item.evidenceItemId,
              relevanceScore: item.relevanceScore ?? null,
            })),
          },
        },
      });
    }
  });
}
