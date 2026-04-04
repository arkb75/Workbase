import { filterDuplicateClaimDrafts, partitionClaimsByPersistence } from "@/src/domain/claim-regeneration";
import { getEligibleClaimsForArtifact } from "@/src/domain/artifact-eligibility";
import type {
  ArtifactRequest,
  ClaimDraft,
  ClaimSnapshot,
  NormalizedSource,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import type {
  ArtifactGenerationService,
  ClaimResearchService,
  ClaimVerificationService,
  SourceIngestionService,
} from "@/src/services/types";

function buildRejectedClaimGuidanceSource(rejectedClaims: ClaimSnapshot[]) {
  if (!rejectedClaims.length) {
    return null;
  }

  return {
    id: "rejected-claim-guidance",
    label: "Previously rejected claims",
    type: "manual_note" as const,
    body: rejectedClaims
      .map((claim) =>
        [
          `Rejected claim: ${claim.text}`,
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
      kind: "rejected_claim_context",
      rejectedClaimIds: rejectedClaims.map((claim) => claim.id),
    } as const,
  };
}

export async function buildClaimGenerationDrafts(params: {
  workItem: WorkItemSnapshot;
  sources: SourceSnapshot[];
  existingClaims: ClaimSnapshot[];
  sourceIngestionService: SourceIngestionService;
  claimResearchService: ClaimResearchService;
  claimVerificationService: ClaimVerificationService;
}) {
  const normalizedSources = await params.sourceIngestionService.normalize({
    workItem: params.workItem,
    sources: params.sources,
  });
  const { preserved, replaceable } = partitionClaimsByPersistence(
    params.existingClaims,
  );
  const rejectedGuidanceSource = buildRejectedClaimGuidanceSource(
    preserved.filter((claim) => claim.verificationStatus === "rejected"),
  );
  const researchSources = rejectedGuidanceSource
    ? [...normalizedSources, rejectedGuidanceSource]
    : normalizedSources;
  const candidateClaims = await params.claimResearchService.generate({
    workItem: params.workItem,
    sources: researchSources,
  });
  const verifiedClaims = await params.claimVerificationService.verify({
    workItem: params.workItem,
    sources: researchSources,
    claims: candidateClaims,
  });
  const researchRun = readGenerationRunMetadata(candidateClaims);
  const verificationRun = readGenerationRunMetadata(verifiedClaims);

  return {
    normalizedSources,
    preservedClaims: preserved,
    replaceableClaims: replaceable,
    drafts: filterDuplicateClaimDrafts(verifiedClaims, preserved),
    generationRunIds: {
      research: researchRun?.id ?? null,
      verification: verificationRun?.id ?? null,
    },
  };
}

export async function buildArtifactFromApprovedClaims(params: {
  request: ArtifactRequest;
  claims: ClaimSnapshot[];
  artifactGenerationService: ArtifactGenerationService;
}) {
  const eligibleClaims = getEligibleClaimsForArtifact(
    params.claims,
    params.request.type,
  );

  const artifactDraft = await params.artifactGenerationService.generate({
    request: params.request,
    claims: eligibleClaims,
  });
  const generationRun = readGenerationRunMetadata(artifactDraft);

  return {
    artifactDraft,
    generationRunId: generationRun?.id ?? null,
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
  claim: ClaimDraft,
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

export function summarizeNormalizedSources(sources: NormalizedSource[]) {
  return sources.map((source) => ({
    id: source.id,
    label: source.label,
    excerptCount: source.excerpts.length,
  }));
}
