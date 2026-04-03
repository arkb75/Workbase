import type { ClaimSnapshot } from "@/src/domain/types";
import type { ArtifactType } from "@/src/lib/options";
import { publicArtifactVisibilityRules } from "@/src/lib/options";

export function getEligibleClaimsForArtifact(
  claims: ClaimSnapshot[],
  artifactType: ArtifactType,
) {
  const allowedVisibilities = publicArtifactVisibilityRules[artifactType];

  return claims.filter((claim) => {
    if (claim.verificationStatus !== "approved") {
      return false;
    }

    if (claim.sensitivityFlag) {
      return false;
    }

    return allowedVisibilities.includes(claim.visibility);
  });
}
