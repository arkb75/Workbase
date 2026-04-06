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
import { targetAngleKeywordMap } from "@/src/lib/options";
import { normalizeWhitespace } from "@/src/lib/utils";
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
  });
  const verifiedClaims = await params.claimVerificationService.verify({
    workItem: params.workItem,
    evidenceItems: researchEvidenceItems,
    highlights: candidateClaims.highlights,
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

function buildArtifactQueryText(params: {
  workItem: WorkItemSnapshot;
  request: ArtifactRequest;
}) {
  const targetAngleTerms = targetAngleKeywordMap[params.request.targetAngle];
  const toneTerms =
    params.request.tone === "technical"
      ? ["architecture", "implementation", "system", "api", "model"]
      : params.request.tone === "recruiter_friendly"
        ? ["impact", "teamwork", "ownership", "delivery"]
        : ["concise", "implementation"];

  return normalizeWhitespace(
    [
      params.workItem.title,
      params.workItem.description,
      params.request.type.replace(/_/g, " "),
      params.request.targetAngle.replace(/_/g, " "),
      params.request.tone.replace(/_/g, " "),
      ...targetAngleTerms,
      ...toneTerms,
    ].join(" "),
  );
}

function scoreEvidenceForArtifactFallback(params: {
  evidenceItem: NormalizedEvidenceItem;
  queryTerms: string[];
  request: ArtifactRequest;
}) {
  const searchText = `${params.evidenceItem.searchText} ${params.evidenceItem.body}`.toLowerCase();
  let score = params.queryTerms.reduce(
    (sum, term) => sum + (searchText.includes(term) ? 1 : 0),
    0,
  );

  score += params.evidenceItem.excerpts.length * 0.1;

  for (const tag of params.evidenceItem.tags ?? []) {
    if (
      tag.dimension === "domain" &&
      (tag.tag === params.request.targetAngle ||
        (params.request.targetAngle === "general" && tag.tag === "general"))
    ) {
      score += 4;
    }

    if (
      params.request.tone === "technical" &&
      tag.dimension === "emphasis" &&
      ["implementation", "architecture", "optimization", "reliability"].includes(tag.tag)
    ) {
      score += 2;
    }

    if (
      params.request.type === "project_summary" &&
      tag.dimension === "audience_fit" &&
      tag.tag === "project_summary"
    ) {
      score += 2;
    }
  }

  return score;
}

async function buildArtifactFallbackHighlights(params: {
  request: ArtifactRequest;
  workItem: WorkItemSnapshot;
  highlights: ClaimSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  sourceIngestionService: SourceIngestionService;
  claimResearchService: ClaimResearchService;
  claimVerificationService: ClaimVerificationService;
}) {
  const normalizedEvidenceItems = await params.sourceIngestionService.normalize({
    workItem: params.workItem,
    sources: [],
    evidenceItems: params.evidenceItems.filter((item) => item.included),
  });
  const queryText = buildArtifactQueryText({
    workItem: params.workItem,
    request: params.request,
  });
  const queryTerms = queryText.toLowerCase().split(/\W+/).filter(Boolean);
  const candidateEvidence = [...normalizedEvidenceItems]
    .map((evidenceItem) => ({
      evidenceItem,
      score: scoreEvidenceForArtifactFallback({
        evidenceItem,
        queryTerms,
        request: params.request,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((entry) => entry.evidenceItem);

  if (!candidateEvidence.length) {
    return {
      highlights: [] as ClaimSnapshot[],
      supportingEvidence: [] as EvidenceItemSnapshot[],
      note: null,
      generationRunIds: {
        generation: [] as string[],
        verification: null as string | null,
      },
    };
  }

  const generated = await params.claimResearchService.generate({
    workItem: params.workItem,
    evidenceItems: candidateEvidence,
    existingHighlights: params.highlights,
    artifactRequest: params.request,
  });
  const verified = await params.claimVerificationService.verify({
    workItem: params.workItem,
    evidenceItems: candidateEvidence,
    highlights: generated.highlights,
  });
  const verificationRun = readGenerationRunMetadata(verified);
  const fallbackDrafts = filterDuplicateClaimDrafts(verified, params.highlights).slice(0, 4);
  const fallbackHighlights = fallbackDrafts.map((draft, index) =>
    toClaimSnapshot(
      params.workItem.id,
      `fallback-highlight-${index + 1}`,
      {
        ...draft,
        verificationStatus: "draft",
      },
    ),
  );
  const referencedEvidenceIds = new Set(
    fallbackHighlights.flatMap((highlight) =>
      highlight.evidence.sourceRefs.flatMap((sourceRef) =>
        sourceRef.evidenceItemId ? [sourceRef.evidenceItemId] : [],
      ),
    ),
  );
  const supportingEvidence = params.evidenceItems
    .filter((item) => referencedEvidenceIds.has(item.id))
    .slice(0, 12);

  return {
    highlights: fallbackHighlights,
    supportingEvidence,
    note:
      "This artifact includes request-specific fallback highlights generated from source evidence during artifact generation. Those highlights were not previously reviewed or approved in the highlight review flow.",
    generationRunIds: {
      generation: generated.generationRunIds.generation,
      verification: verificationRun?.id ?? generated.generationRunIds.verification,
    },
  };
}

export async function buildArtifactFromApprovedClaims(params: {
  request: ArtifactRequest;
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
  });

  const fallback =
    retrieval.highlights.length > 0
      ? null
      : await buildArtifactFallbackHighlights({
          request: params.request,
          workItem: params.workItem,
          highlights: params.highlights,
          evidenceItems: params.evidenceItems,
          sourceIngestionService: params.sourceIngestionService,
          claimResearchService: params.claimResearchService,
          claimVerificationService: params.claimVerificationService,
        });
  const artifactHighlights = retrieval.highlights.length
    ? retrieval.highlights
    : fallback?.highlights ?? [];
  const supportingEvidence = retrieval.highlights.length
    ? retrieval.supportingEvidence
    : fallback?.supportingEvidence ?? [];

  if (!artifactHighlights.length) {
    return {
      retrieval,
      artifactDraft: null,
      generationRunId: null,
      fallback,
    };
  }

  const artifactDraft = await params.artifactGenerationService.generate({
    request: params.request,
    highlights: artifactHighlights,
    supportingEvidence,
  });
  const generationRun = readGenerationRunMetadata(artifactDraft);

  return {
    retrieval,
    artifactDraft,
    generationRunId: generationRun?.id ?? null,
    fallback,
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
