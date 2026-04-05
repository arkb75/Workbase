import type { NormalizedEvidenceItem } from "@/src/domain/types";
import type { SourceIngestionService } from "@/src/services/types";
import { normalizeWhitespace } from "@/src/lib/utils";

export const sourceIngestionService: SourceIngestionService = {
  async normalize({ evidenceItems }) {
    const normalizedEvidenceItems: NormalizedEvidenceItem[] = [];

    for (const evidenceItem of evidenceItems) {
      normalizedEvidenceItems.push({
        id: evidenceItem.id,
        sourceId: evidenceItem.sourceId,
        label: evidenceItem.title,
        type: evidenceItem.source.type,
        evidenceType: evidenceItem.type,
        body: normalizeWhitespace(evidenceItem.content),
        excerpts: [normalizeWhitespace(evidenceItem.content)],
        metadata: {
          ...(typeof evidenceItem.metadata === "object" &&
          evidenceItem.metadata &&
          !Array.isArray(evidenceItem.metadata)
            ? evidenceItem.metadata
            : {}),
          sourceLabel: evidenceItem.source.label,
          sourceExternalId: evidenceItem.source.externalId ?? null,
        },
      });
    }

    return normalizedEvidenceItems;
  },
};
