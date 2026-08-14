import { describe, expect, it } from "vitest";
import { filterDuplicateClaimDrafts } from "@/src/domain/claim-regeneration";
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
      "Built the first highlight review screen. Built the first highlight review screen. Collaborated with a teammate on wording.",
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
  searchText: item.searchText,
  parentKind: item.parentKind,
  parentKey: item.parentKey,
  included: item.included,
  metadata: item.metadata,
  tags: [],
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
    summary: "Existing evidence",
    confidence: "medium",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: status,
    visibility: "resume_safe",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: status === "rejected" ? "Too vague for approval." : null,
    verificationNotes: "Existing rationale",
    metadata: null,
    evidence: {
      summary: "Existing evidence",
      verificationNotes: "Existing rationale",
      sourceRefs: [],
    },
    tags: [],
  };
}

describe("claim regeneration behavior", () => {
  it("suppresses near-duplicate highlights that point at the same evidence", () => {
    const filtered = filterDuplicateClaimDrafts(
      [
        {
          text: "Built investor-founder messaging feature including product like and commit actions, UI components, and API routes in a full-stack web application.",
          summary: "Grounded in PR #3.",
          confidence: "medium",
          ownershipClarity: "partial",
          sensitivityFlag: false,
          verificationStatus: "draft",
          visibility: "resume_safe",
          risksSummary: null,
          missingInfo: null,
          rejectionReason: null,
          verificationNotes: null,
          metadata: null,
          evidence: {
            summary: "Grounded in PR #3.",
            verificationNotes: null,
            sourceRefs: [
              {
                evidenceItemId: "pr-3",
                sourceId: "github-source",
                sourceLabel: "arkb75/Backer",
                sourceType: "github_repo",
                excerpt:
                  "PR #3: feat: Implement investor-founder messaging, product like/commit actions, and related UI components and API routes",
              },
            ],
          },
          tags: [],
        },
        {
          text: "Implemented investor-founder messaging and product like/commit actions, including UI components and API routes, in a full-stack web application.",
          summary: "Also grounded in PR #3.",
          confidence: "medium",
          ownershipClarity: "partial",
          sensitivityFlag: false,
          verificationStatus: "draft",
          visibility: "resume_safe",
          risksSummary: null,
          missingInfo: null,
          rejectionReason: null,
          verificationNotes: null,
          metadata: null,
          evidence: {
            summary: "Also grounded in PR #3.",
            verificationNotes: null,
            sourceRefs: [
              {
                evidenceItemId: "pr-3",
                sourceId: "github-source",
                sourceLabel: "arkb75/Backer",
                sourceType: "github_repo",
                excerpt:
                  "PR #3: feat: Implement investor-founder messaging, product like/commit actions, and related UI components and API routes",
              },
            ],
          },
          tags: [],
        },
      ],
      [],
    );

    expect(filtered).toHaveLength(1);
  });

  it("preserves approved and rejected highlights while replacing pending ones", async () => {
    const result = await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      existingClaims: [
        makeExistingClaim(
          "approved-1",
          "approved",
          "Built the first highlight review screen.",
        ),
        makeExistingClaim(
          "rejected-1",
          "rejected",
          "Highlight that should keep steering future generations away.",
        ),
        makeExistingClaim("draft-1", "draft", "Outdated pending highlight."),
        makeExistingClaim("flagged-1", "flagged", "Potentially sensitive pending highlight."),
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

  it("skips duplicate drafts against preserved highlights and within the new draft set", async () => {
    const result = await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      existingClaims: [
        makeExistingClaim(
          "approved-1",
          "approved",
          "Built the first highlight review screen.",
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

    expect(draftTexts).not.toContain("Built the first highlight review screen.");
    expect(uniqueDraftTexts.size).toBe(draftTexts.length);
  });

  it("includes rejected highlight reasons in the generation context assembly", async () => {
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
          text: "Built the first highlight review screen.",
          summary: "Grounded in the attached source.",
          confidence: "medium",
          ownershipClarity: "clear",
          sensitivityFlag: false,
          verificationStatus: "draft",
          visibility: "resume_safe",
          risksSummary: null,
          missingInfo: null,
          rejectionReason: null,
          verificationNotes: "Matches the note closely.",
          metadata: null,
          evidence: {
            summary: "Grounded in the attached source.",
            sourceRefs: [
              {
                sourceId: "source-1",
                sourceLabel: "Manual notes",
                sourceType: "manual_note",
                excerpt: "Built the first highlight review screen.",
              },
            ],
            verificationNotes: null,
          },
          tags: [],
        };

        return {
          highlights: [draft],
          generationRunIds: {
            generation: [],
            verification: null,
          },
        };
      },
    };
    const passthroughVerificationService: ClaimVerificationService = {
      async verify({ highlights }) {
        return highlights;
      },
    };

    await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      existingClaims: [
        makeExistingClaim(
          "rejected-1",
          "rejected",
          "Highlight that should not be regenerated.",
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
        evidenceItem.metadata.kind === "rejected_highlight_context",
    );

    expect(rejectedContext?.body).toContain("Highlight that should not be regenerated.");
    expect(rejectedContext?.body).toContain("Too vague for approval.");
    expect(rejectedContext?.searchText).toContain("Too vague for approval.");
  });
});
