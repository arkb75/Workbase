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
import type {
  ArtifactGenerationService,
  ClaimResearchService,
  ClaimVerificationService,
  SourceIngestionService,
} from "@/src/services/types";

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
  const candidateClaims = await params.claimResearchService.generate({
    workItem: params.workItem,
    sources: normalizedSources,
  });
  const verifiedClaims = await params.claimVerificationService.verify({
    workItem: params.workItem,
    sources: normalizedSources,
    claims: candidateClaims,
  });
  const { preserved, replaceable } = partitionClaimsByPersistence(
    params.existingClaims,
  );

  return {
    normalizedSources,
    preservedClaims: preserved,
    replaceableClaims: replaceable,
    drafts: filterDuplicateClaimDrafts(verifiedClaims, preserved),
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

  return params.artifactGenerationService.generate({
    request: params.request,
    claims: eligibleClaims,
  });
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
