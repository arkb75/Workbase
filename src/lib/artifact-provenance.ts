function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readArtifactHighlightProvenance(
  entries: Array<{
    id: string;
    highlightId: string | null;
    highlightSnapshot: unknown;
    highlight: {
      id: string;
      text: string;
      summary: string;
      visibility: string;
      confidence: string;
    } | null;
  }>,
) {
  return entries.map((entry) => {
    const snapshot = objectValue(entry.highlightSnapshot);
    return {
      id: entry.highlightId ?? entry.id,
      text:
        typeof snapshot.text === "string"
          ? snapshot.text
          : entry.highlight?.text ?? "Deleted highlight snapshot",
      summary:
        typeof snapshot.summary === "string"
          ? snapshot.summary
          : entry.highlight?.summary ?? "",
      visibility:
        typeof snapshot.visibility === "string"
          ? snapshot.visibility
          : entry.highlight?.visibility ?? "private",
      confidence:
        typeof snapshot.confidence === "string"
          ? snapshot.confidence
          : entry.highlight?.confidence ?? "medium",
    };
  });
}

export function readArtifactEvidenceProvenance(
  entries: Array<{
    id: string;
    evidenceItemId: string | null;
    evidenceSnapshot: unknown;
    evidenceItem: {
      id: string;
      title: string;
      content: string;
      type: string;
      source: { label: string };
    } | null;
  }>,
) {
  return entries.map((entry) => {
    const snapshot = objectValue(entry.evidenceSnapshot);
    return {
      id: entry.evidenceItemId ?? entry.id,
      title:
        typeof snapshot.title === "string"
          ? snapshot.title
          : entry.evidenceItem?.title ?? "Deleted evidence snapshot",
      content:
        typeof snapshot.content === "string"
          ? snapshot.content
          : entry.evidenceItem?.content ?? "",
      type:
        typeof snapshot.type === "string"
          ? snapshot.type
          : entry.evidenceItem?.type ?? "evidence_snapshot",
      sourceLabel: entry.evidenceItem?.source.label ?? "Immutable artifact snapshot",
    };
  });
}
