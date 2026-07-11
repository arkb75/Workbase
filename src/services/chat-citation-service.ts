import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";

const citationMarkerPattern = /\[citation:(\d+)\]/gi;

export function selectReferencedCitations(
  answer: string,
  catalog: readonly ProjectKnowledgeCitation[],
  maxCitations = 20,
) {
  const referenced = Array.from(answer.matchAll(citationMarkerPattern))
    .map((match) => Number(match[1]) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < catalog.length);
  const uniqueIndexes = Array.from(new Set(referenced)).slice(0, maxCitations);
  const remap = new Map(uniqueIndexes.map((index, compactIndex) => [index, compactIndex + 1]));
  const content = answer
    .replace(citationMarkerPattern, (_marker, rawOrdinal: string) => {
      const compactOrdinal = remap.get(Number(rawOrdinal) - 1);
      return compactOrdinal ? `[citation:${compactOrdinal}]` : "";
    })
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return {
    content,
    citations: uniqueIndexes.map((index) => catalog[index]!),
    referencedIndexes: uniqueIndexes,
  };
}

export type CitationTextSegment =
  | { kind: "text"; text: string }
  | { kind: "citations"; ordinals: number[] };

export function splitCitationText(content: string): CitationTextSegment[] {
  return content
    .split(/((?:\[citation:\d+\])+)/gi)
    .filter(Boolean)
    .map((part) => {
      const ordinals = Array.from(part.matchAll(citationMarkerPattern)).map((match) =>
        Number(match[1]),
      );
      return ordinals.length
        ? { kind: "citations" as const, ordinals }
        : { kind: "text" as const, text: part };
    });
}

export function citationCatalogKey(citation: ProjectKnowledgeCitation) {
  return [
    citation.kind,
    citation.highlightId,
    citation.projectFactId,
    citation.evidenceItemId,
    citation.artifactId,
    citation.repository,
    citation.commitSha,
    citation.path,
    citation.startLine,
    citation.endLine,
  ].join(":");
}

export function dedupeCitationCatalog(citations: readonly ProjectKnowledgeCitation[]) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationCatalogKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
