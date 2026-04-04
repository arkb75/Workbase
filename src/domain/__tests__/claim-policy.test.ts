import { describe, expect, it } from "vitest";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { getEligibleClaimsForArtifact } from "@/src/domain/artifact-eligibility";
import type { ClaimSnapshot } from "@/src/domain/types";

function makeClaim(overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
  return {
    id: overrides.id ?? "claim-1",
    workItemId: overrides.workItemId ?? "work-item-1",
    text: overrides.text ?? "Built a review workflow for project evidence.",
    category: overrides.category ?? "backend",
    confidence: overrides.confidence ?? "medium",
    ownershipClarity: overrides.ownershipClarity ?? "clear",
    sensitivityFlag: overrides.sensitivityFlag ?? false,
    verificationStatus: overrides.verificationStatus ?? "draft",
    visibility: overrides.visibility ?? "resume_safe",
    risksSummary: overrides.risksSummary ?? null,
    missingInfo: overrides.missingInfo ?? null,
    rejectionReason: overrides.rejectionReason ?? null,
    evidenceCard: overrides.evidenceCard ?? {
      evidenceSummary: "Grounded in the source note.",
      rationaleSummary: "Implementation language matches the evidence.",
      sourceRefs: [],
      verificationNotes: null,
    },
  };
}

describe("claim status transitions", () => {
  it("allows draft, flagged, and rejected claims to become approved", () => {
    expect(transitionClaimStatus("draft", "approve")).toBe("approved");
    expect(transitionClaimStatus("flagged", "approve")).toBe("approved");
    expect(transitionClaimStatus("rejected", "approve")).toBe("approved");
  });

  it("moves claims into rejected and can restore rejected claims to flagged", () => {
    expect(transitionClaimStatus("draft", "reject")).toBe("rejected");
    expect(transitionClaimStatus("approved", "reject")).toBe("rejected");
    expect(transitionClaimStatus("rejected", "restore")).toBe("flagged");
  });
});

describe("artifact eligibility", () => {
  const claims = [
    makeClaim({
      id: "approved-resume",
      verificationStatus: "approved",
      visibility: "resume_safe",
    }),
    makeClaim({
      id: "approved-linkedin",
      verificationStatus: "approved",
      visibility: "linkedin_safe",
    }),
    makeClaim({
      id: "approved-public",
      verificationStatus: "approved",
      visibility: "public_safe",
    }),
    makeClaim({
      id: "sensitive-approved",
      verificationStatus: "approved",
      visibility: "public_safe",
      sensitivityFlag: true,
    }),
    makeClaim({
      id: "rejected-claim",
      verificationStatus: "rejected",
      visibility: "public_safe",
    }),
  ];

  it("filters resume bullets to approved, non-sensitive claims only", () => {
    expect(
      getEligibleClaimsForArtifact(claims, "resume_bullets").map((claim) => claim.id),
    ).toEqual(["approved-resume", "approved-linkedin", "approved-public"]);
  });

  it("filters linkedin artifacts to linkedin-safe and public-safe claims", () => {
    expect(
      getEligibleClaimsForArtifact(claims, "linkedin_experience").map(
        (claim) => claim.id,
      ),
    ).toEqual(["approved-linkedin", "approved-public"]);
  });

  it("filters project summaries to public-safe claims", () => {
    expect(
      getEligibleClaimsForArtifact(claims, "project_summary").map((claim) => claim.id),
    ).toEqual(["approved-public"]);
  });
});
