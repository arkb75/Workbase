import type {
  EvidenceItemSnapshot,
  HighlightSnapshot,
} from "@/src/domain/types";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";

type ArtifactVerificationHighlight = Pick<
  HighlightSnapshot,
  | "id"
  | "text"
  | "summary"
  | "ownershipClarity"
  | "sensitivityFlag"
  | "publicSafetyStatus"
>;

type ArtifactHighlight = ArtifactVerificationHighlight &
  Pick<HighlightSnapshot, "evidence">;

type ArtifactEvidence = Pick<
  EvidenceItemSnapshot,
  "id" | "title" | "content" | "metadata"
>;

export const MAX_PUBLIC_ARTIFACT_PROVENANCE_ITEMS = 24;

function metadataRecord(value: ArtifactEvidence["metadata"]) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Evidence can be persisted only as provenance already attached to a used
 * approved Highlight. The drafting model never chooses Evidence directly.
 */
export function deriveArtifactEvidenceItemIds(input: {
  highlights: readonly ArtifactHighlight[];
  usedHighlightIds: readonly string[];
  allowedEvidenceItemIds: ReadonlySet<string>;
}) {
  const usedHighlightIds = new Set(input.usedHighlightIds);

  return Array.from(new Set(
    input.highlights
      .filter((highlight) => usedHighlightIds.has(highlight.id))
      .flatMap((highlight) => highlight.evidence.sourceRefs)
      .flatMap((reference) =>
        reference.evidenceItemId && input.allowedEvidenceItemIds.has(reference.evidenceItemId)
          ? [reference.evidenceItemId]
          : [],
      ),
  )).slice(0, MAX_PUBLIC_ARTIFACT_PROVENANCE_ITEMS);
}

export function selectArtifactSupportingEvidence(input: {
  highlights: readonly ArtifactHighlight[];
  evidenceItems: readonly EvidenceItemSnapshot[];
}) {
  const eligibleEvidence = input.evidenceItems.filter(
    (item) =>
      item.included &&
      (item.lifecycleStatus === undefined || item.lifecycleStatus === "active"),
  );
  const evidenceById = new Map(
    eligibleEvidence.map((item) => [item.id, item] as const),
  );
  const selectedIds: string[] = [];
  const selectedIdSet = new Set<string>();
  const queues = input.highlights.map((highlight) =>
    highlight.evidence.sourceRefs.flatMap((reference) =>
      reference.evidenceItemId && evidenceById.has(reference.evidenceItemId)
        ? [reference.evidenceItemId]
        : [],
    ),
  );

  // Round-robin preserves representation for every selected Highlight before
  // a source-rich Highlight can consume the bounded provenance budget.
  while (
    selectedIds.length < MAX_PUBLIC_ARTIFACT_PROVENANCE_ITEMS &&
    queues.some((queue) => queue.length)
  ) {
    for (const queue of queues) {
      const evidenceItemId = queue.shift();
      if (!evidenceItemId || selectedIdSet.has(evidenceItemId)) continue;
      selectedIdSet.add(evidenceItemId);
      selectedIds.push(evidenceItemId);
      if (selectedIds.length >= MAX_PUBLIC_ARTIFACT_PROVENANCE_ITEMS) break;
    }
  }

  return selectedIds.flatMap((evidenceItemId) => {
    const item = evidenceById.get(evidenceItemId);
    return item ? [item] : [];
  });
}

/** Public verification receives approved Highlight claims, never raw Evidence. */
export function buildPublicArtifactVerificationSources(
  highlights: readonly ArtifactVerificationHighlight[],
) {
  return highlights.map((highlight) => ({
    kind: "highlight" as const,
    // The exact approved Highlight is the public claim boundary. Keep it in
    // the source content field so a verifier cannot mistake it for a display
    // label and evaluate only the broader descriptive summary.
    title: "Approved Highlight",
    content: highlight.text,
    ownershipClarity: highlight.ownershipClarity,
    sensitivityFlag: highlight.sensitivityFlag,
    publicSafetyStatus: highlight.publicSafetyStatus,
  }));
}

/**
 * Public Artifact source panels expose approved Highlights as peer sources.
 * Exact Evidence, including immutable GitHub excerpts, remains nested beneath
 * the Highlight that authorized its use.
 */
export function buildPublicArtifactCitations(input: {
  highlights: readonly ArtifactHighlight[];
  usedHighlightIds: readonly string[];
  supportingEvidence: readonly ArtifactEvidence[];
}): ProjectKnowledgeCitation[] {
  const usedHighlightIds = new Set(input.usedHighlightIds);
  const supportingEvidenceById = new Map(
    input.supportingEvidence.map((item) => [item.id, item] as const),
  );

  return input.highlights
    .filter((highlight) => usedHighlightIds.has(highlight.id))
    .map((highlight) => ({
      kind: "highlight" as const,
      label: highlight.text,
      excerpt: highlight.summary,
      highlightId: highlight.id,
      provenance: highlight.evidence.sourceRefs.flatMap((reference) => {
        if (!reference.evidenceItemId) return [];
        const item = supportingEvidenceById.get(reference.evidenceItemId);
        if (!item) return [];
        const metadata = metadataRecord(item.metadata);

        return [{
          evidenceItemId: item.id,
          title: item.title,
          excerpt: item.content,
          repository:
            metadata && typeof metadata.repository === "string"
              ? metadata.repository
              : undefined,
          commitSha:
            metadata && typeof metadata.commitSha === "string"
              ? metadata.commitSha
              : undefined,
          blobSha:
            metadata && typeof metadata.blobSha === "string"
              ? metadata.blobSha
              : undefined,
          path:
            metadata && typeof metadata.path === "string"
              ? metadata.path
              : undefined,
          startLine:
            metadata && typeof metadata.startLine === "number"
              ? metadata.startLine
              : undefined,
          endLine:
            metadata && typeof metadata.endLine === "number"
              ? metadata.endLine
              : undefined,
          url:
            metadata && typeof metadata.url === "string"
              ? metadata.url
              : undefined,
          contentHash:
            metadata && typeof metadata.excerptHash === "string"
              ? metadata.excerptHash
              : undefined,
        }];
      }),
    }));
}
