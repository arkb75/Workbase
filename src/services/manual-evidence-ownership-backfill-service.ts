import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue, SourceSnapshot } from "@/src/domain/types";
import {
  buildManualEvidenceItemsFromSource,
  isExplicitUserAuthoredManualNoteMetadata,
  isExplicitUserAuthoredManualNoteSourceMetadata,
  USER_AUTHORED_MANUAL_NOTE_KIND,
  USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
} from "@/src/lib/evidence-items";
import { prisma } from "@/src/lib/prisma";

function metadataRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasTrustedLegacySourceShape(source: {
  externalId: string | null;
  metadata: unknown;
}) {
  const metadata = metadataRecord(source.metadata);
  return source.externalId === null && (!metadata || Object.keys(metadata).length === 0);
}

function hasTrustedLegacyEvidenceMetadata(value: unknown, lineIndex: number) {
  const metadata = metadataRecord(value);
  if (!metadata) return false;
  const keys = Object.keys(metadata).sort();
  return keys.length === 2 &&
    keys[0] === "lineIndex" &&
    keys[1] === "sourceType" &&
    metadata.lineIndex === lineIndex &&
    metadata.sourceType === "manual_note";
}

/**
 * Marks only legacy Evidence that can be reproduced byte-for-byte from the
 * user-facing manual-note ingestion shape. Work Item descriptions have a
 * system-owned Source identity, while imported or hand-crafted Source rows
 * carry an external identity/metadata or fail the deterministic excerpt match.
 * Any ambiguity fails closed and leaves the Evidence without ownership authority.
 */
export async function backfillTrustedLegacyManualEvidenceOwnership(input: {
  db?: typeof prisma | Prisma.TransactionClient;
  workItemId: string;
}) {
  const db = input.db ?? prisma;
  const sources = await db.source.findMany({
    where: {
      workItemId: input.workItemId,
      type: "manual_note",
    },
    include: {
      evidenceItems: {
        where: {
          type: "manual_note_excerpt",
          included: true,
          lifecycleStatus: "active",
          reviewState: { not: "reverted" },
        },
        orderBy: { externalId: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const updatedEvidenceItemIds: string[] = [];
  const updatedSourceIds: string[] = [];

  for (const source of sources) {
    const legacySource = hasTrustedLegacySourceShape(source);
    const markedSource =
      source.externalId === null &&
      isExplicitUserAuthoredManualNoteSourceMetadata(source.metadata);
    if ((!legacySource && !markedSource) || source.rawContent == null) continue;
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
    const expectedByExternalId = new Map(
      buildManualEvidenceItemsFromSource(sourceSnapshot).map((item) => [
        item.externalId,
        item,
      ]),
    );

    const candidates = source.evidenceItems.flatMap((evidence) => {
      if (isExplicitUserAuthoredManualNoteMetadata(evidence.metadata)) return [];
      const expected = expectedByExternalId.get(evidence.externalId);
      const expectedMetadata = metadataRecord(expected?.metadata);
      const lineIndex = expectedMetadata?.lineIndex;
      if (
        !expected ||
        typeof lineIndex !== "number" ||
        evidence.sourceId !== source.id ||
        evidence.title !== expected.title ||
        evidence.content !== expected.content ||
        evidence.searchText !== expected.searchText ||
        evidence.parentKind !== expected.parentKind ||
        evidence.parentKey !== expected.parentKey ||
        !hasTrustedLegacyEvidenceMetadata(evidence.metadata, lineIndex)
      ) {
        return [];
      }
      return [{ evidence, expected, lineIndex }];
    });
    if (!candidates.length) continue;

    if (legacySource) {
      const updated = await db.source.updateMany({
        where: {
          id: source.id,
          workItemId: input.workItemId,
          externalId: null,
          updatedAt: source.updatedAt,
        },
        data: {
          metadata: {
            kind: USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
            userAuthored: true,
          } satisfies Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) continue;
      updatedSourceIds.push(source.id);
    }

    for (const { evidence, expected, lineIndex } of candidates) {
      const updated = await db.evidenceItem.updateMany({
        where: {
          id: evidence.id,
          sourceId: source.id,
          updatedAt: evidence.updatedAt,
        },
        data: {
          metadata: {
            ...(metadataRecord(expected.metadata) ?? {}),
            kind: USER_AUTHORED_MANUAL_NOTE_KIND,
            userAuthored: true,
            lineIndex,
            sourceType: "manual_note",
          } as Prisma.InputJsonValue,
        },
      });
      if (updated.count === 1) updatedEvidenceItemIds.push(evidence.id);
    }
  }

  return { updatedSourceIds, updatedEvidenceItemIds };
}
