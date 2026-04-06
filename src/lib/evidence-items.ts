import type {
  SourceSnapshot,
} from "@/src/domain/types";
import { buildEvidenceSearchText } from "@/src/lib/highlight-tags";
import { normalizeWhitespace, toSentence } from "@/src/lib/utils";

export function splitManualNoteIntoEvidenceContent(value: string) {
  return value
    .split(/\n+/)
    .map((line) => toSentence(line))
    .filter((line) => line.length > 12)
    .slice(0, 8);
}

export function buildManualEvidenceExternalId(sourceId: string, index: number) {
  return `${sourceId}:excerpt:${index}`;
}

export function buildManualEvidenceItemsFromSource(source: SourceSnapshot) {
  const excerpts = splitManualNoteIntoEvidenceContent(source.rawContent ?? "");

  return excerpts.map((excerpt, index) => ({
    workItemId: source.workItemId,
    sourceId: source.id,
    externalId: buildManualEvidenceExternalId(source.id, index),
    sourceType: source.type,
    type: "manual_note_excerpt" as const,
    title: `${source.label} excerpt ${index + 1}`,
    content: excerpt,
    searchText: buildEvidenceSearchText({
      title: `${source.label} excerpt ${index + 1}`,
      content: excerpt,
      metadata: {
        sourceType: source.type,
      },
    }),
    parentKind: "source",
    parentKey: source.id,
    included: true,
    metadata: {
      lineIndex: index,
      sourceType: source.type,
    },
  }));
}

export function summarizeEvidenceContent(value: string, maxLength = 360) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}
