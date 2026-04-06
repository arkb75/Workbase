import { describe, expect, it } from "vitest";
import {
  buildArtifactFromApprovedClaims,
  buildClaimGenerationDrafts,
  toClaimSnapshot,
} from "@/src/domain/workbase-workflows";
import type {
  EvidenceItemSnapshot,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { buildManualEvidenceItemsFromSource } from "@/src/lib/evidence-items";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import type {
  ClaimResearchService,
  ClaimVerificationService,
  HighlightRetrievalService,
} from "@/src/services/types";

describe("workbase workflow", () => {
  it("creates highlights from notes, approves one, and generates an artifact from approved highlights only", async () => {
    const workItem: WorkItemSnapshot = {
      id: "work-item-1",
      userId: "user-1",
      title: "Ops review console",
      type: "project",
      description:
        "Built an internal review console that helps engineers inspect incidents and annotate follow-up work.",
      startDate: null,
      endDate: null,
    };

    const sources: SourceSnapshot[] = [
      {
        id: "source-1",
        workItemId: workItem.id,
        type: "manual_note",
        label: "Manual notes",
        rawContent:
          "Built a Next.js console for incident review. Added PostgreSQL-backed filters for internal records. Worked with a teammate on wording for private data.",
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

    const claimPlan = await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      existingClaims: [],
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });

    expect(claimPlan.drafts.length).toBeGreaterThan(0);

    const approvedHighlight = {
      ...toClaimSnapshot(workItem.id, "highlight-approved", claimPlan.drafts[0]),
      verificationStatus: transitionClaimStatus(
        claimPlan.drafts[0].verificationStatus,
        "approve",
      ),
      visibility: "resume_safe" as const,
      sensitivityFlag: false,
      rejectionReason: null,
    };
    const retrievalService: HighlightRetrievalService = {
      async retrieve() {
        return {
          highlights: [approvedHighlight],
          supportingEvidence: evidenceItems.slice(0, 2),
          generationRunId: null,
        };
      },
    };
    const artifact = await buildArtifactFromApprovedClaims({
      request: {
        userId: "user-1",
        workItemId: workItem.id,
        type: "resume_bullets",
        targetAngle: "backend",
        tone: "concise",
      },
      workItem,
      highlights: [approvedHighlight],
      evidenceItems,
      highlightRetrievalService: retrievalService,
      artifactGenerationService,
    });

    expect(artifact.artifactDraft.content).toContain(
      approvedHighlight.text.replace(/\.$/, ""),
    );
    expect(artifact.artifactDraft.usedHighlightIds).toEqual(["highlight-approved"]);
  });

  it("passes reviewed evidence items into highlight generation", async () => {
    const workItem: WorkItemSnapshot = {
      id: "work-item-2",
      userId: "user-1",
      title: "Highlight generation flow",
      type: "project",
      description: "Uses evidence retrieval before artifact generation.",
      startDate: null,
      endDate: null,
    };
    const sources: SourceSnapshot[] = [
      {
        id: "source-2",
        workItemId: workItem.id,
        type: "manual_note",
        label: "Manual notes",
        rawContent:
          "Built a dashboard. Added CSV imports. Implemented access rules for internal datasets.",
        metadata: null,
      },
    ];
    const evidenceItems: EvidenceItemSnapshot[] = buildManualEvidenceItemsFromSource(
      sources[0],
    ).map((item, index) => ({
      id: `highlight-evidence-${index + 1}`,
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
    let researchEvidenceIds: string[] = [];

    const capturingResearchService: ClaimResearchService = {
      async generate(input) {
        researchEvidenceIds = input.evidenceItems.map((item) => item.id);

        return {
          highlights: [
            {
              text: "Built a dashboard and import workflow.",
              summary: "Grounded in evidence items.",
              confidence: "medium",
              ownershipClarity: "clear",
              sensitivityFlag: false,
              verificationStatus: "draft",
              visibility: "resume_safe",
              risksSummary: null,
              missingInfo: null,
              rejectionReason: null,
              verificationNotes: "Generated from normalized evidence.",
              metadata: null,
              evidence: {
                summary: "Grounded in evidence items.",
                sourceRefs: [],
                verificationNotes: null,
              },
              tags: [],
            },
          ],
          generationRunIds: {
            generation: [],
            verification: null,
          },
        };
      },
    };
    const capturingVerificationService: ClaimVerificationService = {
      async verify(input) {
        return input.highlights;
      },
    };

    await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      existingClaims: [],
      sourceIngestionService,
      claimResearchService: capturingResearchService,
      claimVerificationService: capturingVerificationService,
    });

    expect(researchEvidenceIds).toEqual(evidenceItems.map((item) => item.id));
  });
});
