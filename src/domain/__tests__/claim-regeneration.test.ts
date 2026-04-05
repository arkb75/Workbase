import { describe, expect, it } from "vitest";
import { buildClaimGenerationDrafts } from "@/src/domain/workbase-workflows";
import type {
  ClaimDraft,
  ClaimSnapshot,
  EvidenceItemSnapshot,
  NormalizedEvidenceItem,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import type {
  ClaimResearchService,
  ClaimVerificationService,
  SourceIngestionService,
} from "@/src/services/types";

const workItem: WorkItemSnapshot = {
  id: "work-item-1",
  userId: "user-1",
  title: "Verified notes workspace",
  type: "project",
  description: "Built a notes workflow for reviewing technical evidence.",
  startDate: null,
  endDate: null,
};

const sources: SourceSnapshot[] = [
  {
    id: "source-1",
    workItemId: "work-item-1",
    type: "manual_note",
    label: "Manual notes",
    rawContent:
      "Built the first claim review screen. Built the first claim review screen. Collaborated with a teammate on wording.",
    metadata: null,
  },
];

const evidenceItems: EvidenceItemSnapshot[] = buildManualEvidenceItemsFromSource(
  sources[0],
).map((item, index) => ({
  id: `evidence-${index + 1}`,
  workItemId: item.workItemId,
  sourceId: item.sourceId,
  externalId: item.externalId,
  type: item.type,
  title: item.title,
  content: item.content,
  included: item.included,
  metadata: item.metadata,
  source: {
    id: sources[0].id,
    label: sources[0].label,
    type: sources[0].type,
    externalId: sources[0].externalId ?? null,
  },
}));

function makeExistingClaim(
  id: string,
  status: ClaimSnapshot["verificationStatus"],
  text: string,
): ClaimSnapshot {
  return {
    id,
    workItemId: "work-item-1",
    text,
    category: "full_stack",
    confidence: "medium",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: status,
    visibility: "resume_safe",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: status === "rejected" ? "Too vague for approval." : null,
    evidenceCard: {
      evidenceSummary: "Existing evidence",
      rationaleSummary: "Existing rationale",
      sourceRefs: [],
      verificationNotes: null,
    },
  };
}

describe("claim regeneration behavior", () => {
  it("preserves approved and rejected claims while replacing pending ones", async () => {
    const result = await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      clusters: [],
      existingClaims: [
        makeExistingClaim(
          "approved-1",
          "approved",
          "Built the first claim review screen.",
        ),
        makeExistingClaim(
          "rejected-1",
          "rejected",
          "Claim that should keep steering future generations away.",
        ),
        makeExistingClaim("draft-1", "draft", "Outdated pending claim."),
        makeExistingClaim("flagged-1", "flagged", "Potentially sensitive pending claim."),
      ],
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });

    expect(result.preservedClaims.map((claim) => claim.id)).toEqual([
      "approved-1",
      "rejected-1",
    ]);
    expect(result.replaceableClaims.map((claim) => claim.id)).toEqual([
      "draft-1",
      "flagged-1",
    ]);
  });

  it("skips duplicate drafts against preserved claims and within the new draft set", async () => {
    const result = await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      clusters: [],
      existingClaims: [
        makeExistingClaim(
          "approved-1",
          "approved",
          "Built the first claim review screen.",
        ),
        makeExistingClaim(
          "rejected-1",
          "rejected",
          "Collaborated with a teammate on wording.",
        ),
      ],
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });

    const draftTexts = result.drafts.map((draft) => draft.text);
    const uniqueDraftTexts = new Set(draftTexts);

    expect(draftTexts).not.toContain("Built the first claim review screen.");
    expect(uniqueDraftTexts.size).toBe(draftTexts.length);
  });

  it("includes rejected claim reasons in the generation context assembly", async () => {
    let capturedEvidenceItems: NormalizedEvidenceItem[] = [];

    const capturingSourceIngestionService: SourceIngestionService = {
      async normalize(input) {
        return sourceIngestionService.normalize(input);
      },
    };
    const capturingResearchService: ClaimResearchService = {
      async generate({ evidenceItems: normalizedEvidenceItems }) {
        capturedEvidenceItems = normalizedEvidenceItems;

        const draft: ClaimDraft = {
          text: "Built the first claim review screen.",
          category: "full_stack",
          confidence: "medium",
          ownershipClarity: "clear",
          sensitivityFlag: false,
          verificationStatus: "draft",
          visibility: "resume_safe",
          risksSummary: null,
          missingInfo: null,
          rejectionReason: null,
          evidenceCard: {
            evidenceSummary: "Grounded in the attached source.",
            rationaleSummary: "Matches the note closely.",
            sourceRefs: [
              {
                sourceId: "source-1",
                sourceLabel: "Manual notes",
                sourceType: "manual_note",
                excerpt: "Built the first claim review screen.",
              },
            ],
            verificationNotes: null,
          },
        };

        return [draft];
      },
    };
    const passthroughVerificationService: ClaimVerificationService = {
      async verify({ claims }) {
        return claims;
      },
    };

    await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      clusters: [],
      existingClaims: [
        makeExistingClaim(
          "rejected-1",
          "rejected",
          "Claim that should not be regenerated.",
        ),
      ],
      sourceIngestionService: capturingSourceIngestionService,
      claimResearchService: capturingResearchService,
      claimVerificationService: passthroughVerificationService,
    });

    const rejectedContext = capturedEvidenceItems.find(
      (evidenceItem) =>
        typeof evidenceItem.metadata === "object" &&
        evidenceItem.metadata &&
        "kind" in evidenceItem.metadata &&
        evidenceItem.metadata.kind === "rejected_claim_context",
    );

    expect(rejectedContext?.body).toContain("Claim that should not be regenerated.");
    expect(rejectedContext?.body).toContain("Too vague for approval.");
  });
});
