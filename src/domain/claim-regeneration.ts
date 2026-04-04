import type { ClaimDraft, ClaimSnapshot } from "@/src/domain/types";
import { slugifyText } from "@/src/lib/utils";

export function partitionClaimsByPersistence(claims: ClaimSnapshot[]) {
  const preserved = claims.filter(
    (claim) => claim.verificationStatus === "approved",
  );
  const replaceable = claims.filter(
    (claim) =>
      claim.verificationStatus === "draft" ||
      claim.verificationStatus === "flagged",
  );

  return { preserved, replaceable };
}

export function filterDuplicateClaimDrafts(
  drafts: ClaimDraft[],
  preservedClaims: ClaimSnapshot[],
) {
  const preservedFingerprints = new Set(
    preservedClaims.map((claim) => slugifyText(claim.text)),
  );

  return drafts.filter((draft, index) => {
    const fingerprint = slugifyText(draft.text);

    if (preservedFingerprints.has(fingerprint)) {
      return false;
    }

    const firstMatchingIndex = drafts.findIndex(
      (candidate) => slugifyText(candidate.text) === fingerprint,
    );

    return firstMatchingIndex === index;
  });
}
