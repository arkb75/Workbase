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
} from "@/src/services/types";

describe("workbase workflow", () => {
  it("creates claims from notes, approves one, and generates an artifact from approved claims only", async () => {
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
      included: item.included,
      metadata: item.metadata,
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
      clusters: [],
      existingClaims: [],
      sourceIngestionService,
      claimResearchService,
      claimVerificationService,
    });

    expect(claimPlan.drafts.length).toBeGreaterThan(0);

    const approvedClaim = {
      ...toClaimSnapshot(workItem.id, "claim-approved", claimPlan.drafts[0]),
      verificationStatus: transitionClaimStatus(
        claimPlan.drafts[0].verificationStatus,
        "approve",
      ),
      visibility: "resume_safe" as const,
      sensitivityFlag: false,
      rejectionReason: null,
    };
    const artifact = await buildArtifactFromApprovedClaims({
      request: {
        userId: "user-1",
        workItemId: workItem.id,
        type: "resume_bullets",
        targetAngle: "backend",
        tone: "concise",
      },
      claims: [approvedClaim],
      artifactGenerationService,
    });

    expect(artifact.artifactDraft.content).toContain(
      approvedClaim.text.replace(/\.$/, ""),
    );
    expect(artifact.artifactDraft.usedClaimIds).toEqual(["claim-approved"]);
  });

  it("passes reviewed evidence items and persisted clusters into claim generation", async () => {
    const workItem: WorkItemSnapshot = {
      id: "work-item-2",
      userId: "user-1",
      title: "Clustered claims flow",
      type: "project",
      description: "Uses evidence clusters before claim generation.",
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
      id: `cluster-evidence-${index + 1}`,
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
    const clusters = [
      {
        id: "cluster-1",
        workItemId: workItem.id,
        title: "Dashboard and imports",
        summary: "UI and pipeline work grouped together.",
        theme: "full_stack",
        confidence: "medium" as const,
        metadata: null,
        items: evidenceItems.map((item, index) => ({
          id: `cluster-item-${index + 1}`,
          evidenceItemId: item.id,
          relevanceScore: 0.8,
        })),
      },
    ];
    let researchEvidenceIds: string[] = [];
    let verificationClusterIds: string[] = [];

    const capturingResearchService: ClaimResearchService = {
      async generate(input) {
        researchEvidenceIds = input.evidenceItems.map((item) => item.id);

        return [
          {
            text: "Built a dashboard and import workflow.",
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
              evidenceSummary: "Grounded in evidence items.",
              rationaleSummary: "Grouped by cluster.",
              sourceRefs: [],
              verificationNotes: null,
            },
          },
        ];
      },
    };
    const capturingVerificationService: ClaimVerificationService = {
      async verify(input) {
        verificationClusterIds = input.clusters.map((cluster) => cluster.id);
        return input.claims;
      },
    };

    await buildClaimGenerationDrafts({
      workItem,
      sources,
      evidenceItems,
      clusters,
      existingClaims: [],
      sourceIngestionService,
      claimResearchService: capturingResearchService,
      claimVerificationService: capturingVerificationService,
    });

    expect(researchEvidenceIds).toEqual(evidenceItems.map((item) => item.id));
    expect(verificationClusterIds).toEqual(["cluster-1"]);
  });
});
