import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ClaimCard } from "@/components/claims/claim-card";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/app/actions", () => ({
  updateClaimAction: vi.fn(),
}));

function buildClaim(overrides: Partial<Parameters<typeof ClaimCard>[0]["claim"]> = {}) {
  return {
    id: "highlight-1",
    workItemId: "work-item-1",
    text: "Lifecycle-aware highlight",
    summary: "A grounded summary.",
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    lifecycleStatus: "active",
    reviewState: "reviewed",
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: null,
    evidence: {
      summary: "A grounded summary.",
      verificationNotes: null,
      sourceRefs: [],
    },
    tags: [],
    ...overrides,
  };
}

function renderClaim(claim: Parameters<typeof ClaimCard>[0]["claim"]) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ClaimCard claim={claim} />
    </TooltipProvider>,
  );
}

describe("ClaimCard lifecycle presentation", () => {
  it("labels stale pending highlights and withholds ordinary approval actions", () => {
    const html = renderClaim(
      buildClaim({
        verificationStatus: "draft",
        lifecycleStatus: "stale",
        reviewState: "pending_review",
      }),
    );

    expect(html).toContain("Verification: Draft");
    expect(html).toContain("Lifecycle: Stale");
    expect(html).toContain("Review: Pending Review");
    expect(html).toContain("Create edited successor");
    expect(html).not.toContain("Approve highlight");
    expect(html).not.toContain("Reject and retire");
  });

  it("describes only active approved highlights as retrieval-ready", () => {
    const activeHtml = renderClaim(buildClaim());
    const retiredHtml = renderClaim(buildClaim({ lifecycleStatus: "retired" }));

    expect(activeHtml).toContain("Active, approved, and available for retrieval-driven artifact generation");
    expect(retiredHtml).toContain("Retired from active knowledge");
    expect(retiredHtml).not.toContain("available for retrieval-driven artifact generation");
  });
});
