import type { NormalizedEvidenceItem } from "@/src/domain/types";
import { buildPromptReadyEvidenceExcerpt } from "@/src/lib/claim-prompt-prep";
import type { SourceIngestionService } from "@/src/services/types";
import { normalizeWhitespace } from "@/src/lib/utils";

export const sourceIngestionService: SourceIngestionService = {
  async normalize({ evidenceItems }) {
    const normalizedEvidenceItems: NormalizedEvidenceItem[] = [];

    for (const evidenceItem of evidenceItems) {
      const promptExcerpt = buildPromptReadyEvidenceExcerpt({
        evidenceType: evidenceItem.type,
        title: evidenceItem.title,
        content: evidenceItem.content,
      });

      normalizedEvidenceItems.push({
        id: evidenceItem.id,
        sourceId: evidenceItem.sourceId,
        label: evidenceItem.title,
        type: evidenceItem.source.type,
        evidenceType: evidenceItem.type,
        searchText: evidenceItem.searchText,
        parentKind: evidenceItem.parentKind,
        parentKey: evidenceItem.parentKey,
        body: promptExcerpt,
        excerpts: [promptExcerpt],
        metadata: {
          ...(typeof evidenceItem.metadata === "object" &&
          evidenceItem.metadata &&
          !Array.isArray(evidenceItem.metadata)
            ? evidenceItem.metadata
            : {}),
          sourceLabel: evidenceItem.source.label,
          sourceExternalId: evidenceItem.source.externalId ?? null,
          promptExcerptLength: promptExcerpt.length,
          rawContentLength: normalizeWhitespace(evidenceItem.content).length,
        },
        tags: evidenceItem.tags ?? [],
      });
    }

    return normalizedEvidenceItems;
  },
};
