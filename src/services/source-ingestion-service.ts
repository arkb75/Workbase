import type { NormalizedSource } from "@/src/domain/types";
import type { SourceIngestionService } from "@/src/services/types";
import { normalizeWhitespace, toSentence } from "@/src/lib/utils";

function splitIntoExcerpts(value: string) {
  return value
    .split(/\n+/)
    .map((line) => toSentence(line))
    .filter((line) => line.length > 12)
    .slice(0, 6);
}

export const sourceIngestionService: SourceIngestionService = {
  async normalize({ workItem, sources }) {
    const normalizedSources: NormalizedSource[] = [];

    for (const source of sources) {
      if (source.type === "manual_note") {
        const body = normalizeWhitespace(source.rawContent ?? "");

        normalizedSources.push({
          id: source.id,
          label: source.label,
          type: source.type,
          body,
          excerpts: splitIntoExcerpts(source.rawContent ?? ""),
          metadata: source.metadata,
        });
        continue;
      }

      const repoUrl =
        typeof source.metadata === "object" &&
        source.metadata &&
        "repoUrl" in source.metadata
          ? String(source.metadata.repoUrl)
          : "";

      normalizedSources.push({
        id: source.id,
        label: source.label,
        type: source.type,
        body: normalizeWhitespace(
          `${workItem.title} repository placeholder ${repoUrl}`.trim(),
        ),
        excerpts: repoUrl ? [toSentence(repoUrl)] : [],
        metadata: source.metadata,
      });
    }

    return normalizedSources;
  },
};
