import { filterDuplicateClaimDrafts, partitionClaimsByPersistence } from "@/src/domain/claim-regeneration";
import type {
  ArtifactRequest,
  ClaimSnapshot,
  EvidenceItemSnapshot,
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
