import { filterDuplicateClaimDrafts, partitionClaimsByPersistence } from "@/src/domain/claim-regeneration";
import type {
  ArtifactRequest,
  HighlightDraft,
  ClaimSnapshot,
  EvidenceItemSnapshot,
  NormalizedEvidenceItem,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { inferEvidenceTags } from "@/src/lib/highlight-tags";
import type {
  ArtifactGenerationService,
  ClaimResearchService,
  ClaimVerificationService,
  HighlightRetrievalService,
  SourceIngestionService,
} from "@/src/services/types";

function buildRejectedHighlightGuidanceSource(rejectedClaims: ClaimSnapshot[]) {
  if (!rejectedClaims.length) {
    return null;
  }

  return {
    id: "rejected-highlight-guidance",
    sourceId: "rejected-highlight-guidance",
    label: "Previously rejected highlights",
    type: "manual_note" as const,
    evidenceType: "manual_note_excerpt" as const,
    searchText: rejectedClaims
      .map((claim) => [claim.text, claim.rejectionReason ?? ""].join(" "))
      .join(" "),
    parentKind: "work_item" as const,
    parentKey: rejectedClaims[0]?.workItemId ?? null,
    body: rejectedClaims
      .map((claim) =>
        [
          `Rejected highlight: ${claim.text}`,
          claim.rejectionReason
            ? `Reason: ${claim.rejectionReason}`
            : "Reason: No rejection reason was provided.",
        ].join("\n"),
      )
      .join("\n\n"),
    excerpts: rejectedClaims.map((claim) =>
      claim.rejectionReason
        ? `${claim.text} Reason: ${claim.rejectionReason}`
        : claim.text,
      ),
    metadata: {
      kind: "rejected_highlight_context",
      rejectedClaimIds: rejectedClaims.map((claim) => claim.id),
    } as const,
    tags: inferEvidenceTags({
      title: "Previously rejected highlights",
      content: rejectedClaims
        .map((claim) => [claim.text, claim.rejectionReason ?? ""].join(" "))
        .join(" "),
      sourceType: "manual_note",
      evidenceType: "manual_note_excerpt",
    }),
  };
}

export async function buildClaimGenerationDrafts(params: {
  workItem: WorkItemSnapshot;
  sources: SourceSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  existingClaims: ClaimSnapshot[];
  agentRunId?: string;
  sourceIngestionService: SourceIngestionService;
  claimResearchService: ClaimResearchService;
  claimVerificationService: ClaimVerificationService;
}) {
  const normalizedEvidenceItems = await params.sourceIngestionService.normalize({
    workItem: params.workItem,
    sources: params.sources,
    evidenceItems: params.evidenceItems,
  });
  const { preserved, replaceable } = partitionClaimsByPersistence(
    params.existingClaims,
  );
  const rejectedGuidanceSource = buildRejectedHighlightGuidanceSource(
    preserved.filter((claim) => claim.verificationStatus === "rejected"),
  );
  const researchEvidenceItems = rejectedGuidanceSource
    ? [...normalizedEvidenceItems, rejectedGuidanceSource]
    : normalizedEvidenceItems;
  const candidateClaims = await params.claimResearchService.generate({
    workItem: params.workItem,
    evidenceItems: researchEvidenceItems,
    existingHighlights: preserved,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });
  const verifiedClaims = await params.claimVerificationService.verify({
    workItem: params.workItem,
    evidenceItems: researchEvidenceItems,
    highlights: candidateClaims.highlights,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });
  const verificationRun = readGenerationRunMetadata(verifiedClaims);

  return {
    normalizedEvidenceItems,
    preservedClaims: preserved,
    replaceableClaims: replaceable,
    drafts: filterDuplicateClaimDrafts(verifiedClaims, preserved),
    generationRunIds: {
      generation: candidateClaims.generationRunIds.generation,
      verification: verificationRun?.id ?? null,
    },
  };
}

export async function buildIncrementalClaimGenerationDrafts(params: {
  workItem: WorkItemSnapshot;
  sources: SourceSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  incrementalEvidenceItemIds: string[];
  existingClaims: ClaimSnapshot[];
  agentRunId?: string;
  sourceIngestionService: SourceIngestionService;
  claimResearchService: ClaimResearchService;
  claimVerificationService: ClaimVerificationService;
}) {
  const incrementalEvidenceIds = new Set(params.incrementalEvidenceItemIds);
  const normalizedEvidenceItems = await params.sourceIngestionService.normalize({
    workItem: params.workItem,
    sources: params.sources,
    evidenceItems: params.evidenceItems,
  });
  const selectedEvidenceItems = normalizedEvidenceItems.filter((item) =>
    incrementalEvidenceIds.has(item.id),
  );

  if (!selectedEvidenceItems.length) {
    return {
      normalizedEvidenceItems,
      drafts: [] as HighlightDraft[],
      generationRunIds: {
        generation: [] as string[],
        verification: null as string | null,
      },
    };
  }

  const selectedSourceIds = new Set(selectedEvidenceItems.map((item) => item.sourceId));
  const contextEvidenceItems = normalizedEvidenceItems
    .filter(
      (item) =>
        !incrementalEvidenceIds.has(item.id) &&
        (item.evidenceType === "github_readme" ||
          (item.evidenceType === "manual_note_excerpt" && item.parentKind === "work_item") ||
          selectedSourceIds.has(item.sourceId)),
    )
    .slice(0, 6);
  const rejectedGuidanceSource = buildRejectedHighlightGuidanceSource(
    params.existingClaims.filter((claim) => claim.verificationStatus === "rejected"),
  );
  const researchEvidenceItems = rejectedGuidanceSource
    ? [...selectedEvidenceItems, ...contextEvidenceItems, rejectedGuidanceSource]
    : [...selectedEvidenceItems, ...contextEvidenceItems];
  const candidateClaims = await params.claimResearchService.generate({
    workItem: params.workItem,
    evidenceItems: researchEvidenceItems,
    existingHighlights: params.existingClaims,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });
  const verifiedClaims = await params.claimVerificationService.verify({
    workItem: params.workItem,
    evidenceItems: researchEvidenceItems,
    highlights: candidateClaims.highlights,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });
  const verificationRun = readGenerationRunMetadata(verifiedClaims);

  return {
    normalizedEvidenceItems,
    drafts: filterDuplicateClaimDrafts(verifiedClaims, []),
    generationRunIds: {
      generation: candidateClaims.generationRunIds.generation,
      verification: verificationRun?.id ?? null,
    },
  };
}

export async function buildArtifactFromApprovedClaims(params: {
  request: ArtifactRequest;
  agentRunId?: string;
  highlights: ClaimSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  workItem: WorkItemSnapshot;
  highlightRetrievalService: HighlightRetrievalService;
  artifactGenerationService: ArtifactGenerationService;
  sourceIngestionService: SourceIngestionService;
  claimResearchService: ClaimResearchService;
  claimVerificationService: ClaimVerificationService;
}) {
  const retrieval = await params.highlightRetrievalService.retrieve({
    workItem: params.workItem,
    request: params.request,
    highlights: params.highlights,
    evidenceItems: params.evidenceItems,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });

  const artifactHighlights = retrieval.highlights;
  const supportingEvidence = retrieval.supportingEvidence;

  if (!artifactHighlights.length || retrieval.adequacy.status !== "sufficient") {
    return {
      retrieval,
      artifactDraft: null,
      generationRunId: null,
      fallback: null,
    };
  }

  const artifactDraft = await params.artifactGenerationService.generate({
    request: params.request,
    highlights: artifactHighlights,
    supportingEvidence,
    ...(params.agentRunId ? { agentRunId: params.agentRunId } : {}),
  });
  const generationRun = readGenerationRunMetadata(artifactDraft);

  return {
    retrieval,
    artifactDraft,
    generationRunId: generationRun?.id ?? null,
    fallback: null,
  };
}

export function countClaimsByStatus(claims: ClaimSnapshot[]) {
  return claims.reduce<Record<string, number>>((counts, claim) => {
    counts[claim.verificationStatus] =
      (counts[claim.verificationStatus] ?? 0) + 1;
    return counts;
  }, {});
}

export function toClaimSnapshot(
  workItemId: string,
  id: string,
  claim: HighlightDraft,
): ClaimSnapshot {
  return {
    id,
    workItemId,
    ...claim,
  };
}

export function hasUsableSources(sources: SourceSnapshot[]) {
  return sources.some(
    (source) => source.type === "manual_note" || Boolean(source.metadata),
  );
}

export function summarizeNormalizedSources(evidenceItems: NormalizedEvidenceItem[]) {
  return evidenceItems.map((source) => ({
    id: source.id,
    label: source.label,
    excerptCount: source.excerpts.length,
  }));
}
