import { describe, expect, it } from "vitest";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { getEligibleClaimsForArtifact } from "@/src/domain/artifact-eligibility";
import type { HighlightSnapshot } from "@/src/domain/types";

function makeHighlight(overrides: Partial<HighlightSnapshot> = {}): HighlightSnapshot {
  return {
    id: overrides.id ?? "highlight-1",
    workItemId: overrides.workItemId ?? "work-item-1",
    text: overrides.text ?? "Built a review workflow for project evidence.",
    summary: overrides.summary ?? "Grounded in the source note.",
    confidence: overrides.confidence ?? "medium",
    ownershipClarity: overrides.ownershipClarity ?? "clear",
    sensitivityFlag: overrides.sensitivityFlag ?? false,
    verificationStatus: overrides.verificationStatus ?? "draft",
    visibility: overrides.visibility ?? "resume_safe",
    risksSummary: overrides.risksSummary ?? null,
    missingInfo: overrides.missingInfo ?? null,
    rejectionReason: overrides.rejectionReason ?? null,
    verificationNotes: overrides.verificationNotes ?? null,
    metadata: overrides.metadata ?? null,
    evidence: overrides.evidence ?? {
      summary: "Grounded in the source note.",
      verificationNotes: null,
      sourceRefs: [],
    },
    tags: overrides.tags ?? [],
  };
}

describe("claim status transitions", () => {
  it("allows draft, flagged, and rejected highlights to become approved", () => {
    expect(transitionClaimStatus("draft", "approve")).toBe("approved");
    expect(transitionClaimStatus("flagged", "approve")).toBe("approved");
    expect(transitionClaimStatus("rejected", "approve")).toBe("approved");
  });

  it("moves highlights into rejected and can restore rejected highlights to flagged", () => {
    expect(transitionClaimStatus("draft", "reject")).toBe("rejected");
    expect(transitionClaimStatus("approved", "reject")).toBe("rejected");
    expect(transitionClaimStatus("rejected", "restore")).toBe("flagged");
  });
});

describe("artifact eligibility", () => {
  const highlights = [
    makeHighlight({
      id: "approved-resume",
      verificationStatus: "approved",
      visibility: "resume_safe",
    }),
    makeHighlight({
      id: "approved-linkedin",
      verificationStatus: "approved",
      visibility: "linkedin_safe",
    }),
    makeHighlight({
      id: "approved-public",
      verificationStatus: "approved",
      visibility: "public_safe",
    }),
    makeHighlight({
      id: "sensitive-approved",
      verificationStatus: "approved",
      visibility: "public_safe",
      sensitivityFlag: true,
    }),
    makeHighlight({
      id: "rejected-highlight",
      verificationStatus: "rejected",
      visibility: "public_safe",
    }),
  ];

  it("filters resume bullets to approved, non-sensitive highlights only", () => {
    expect(
      getEligibleClaimsForArtifact(highlights, "resume_bullets").map((highlight) => highlight.id),
    ).toEqual(["approved-resume", "approved-linkedin", "approved-public"]);
  });

  it("filters linkedin artifacts to linkedin-safe and public-safe highlights", () => {
    expect(
      getEligibleClaimsForArtifact(highlights, "linkedin_experience").map(
        (highlight) => highlight.id,
      ),
    ).toEqual(["approved-linkedin", "approved-public"]);
  });

  it("filters project summaries to public-safe highlights", () => {
    expect(
      getEligibleClaimsForArtifact(highlights, "project_summary").map((highlight) => highlight.id),
    ).toEqual(["approved-public"]);
  });
});
