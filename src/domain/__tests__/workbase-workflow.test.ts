import { describe, expect, it } from "vitest";
import {
  buildArtifactFromApprovedClaims,
  buildClaimGenerationDrafts,
  toClaimSnapshot,
} from "@/src/domain/workbase-workflows";
import type { SourceSnapshot, WorkItemSnapshot } from "@/src/domain/types";
import { transitionClaimStatus } from "@/src/domain/claim-status";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";

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

    const claimPlan = await buildClaimGenerationDrafts({
      workItem,
      sources,
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

    expect(artifact.content).toContain(approvedClaim.text.replace(/\.$/, ""));
    expect(artifact.usedClaimIds).toEqual(["claim-approved"]);
  });
});
