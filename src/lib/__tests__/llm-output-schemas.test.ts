import { describe, expect, it } from "vitest";
import {
  claimResearchLlmOutputSchema,
  claimVerificationLlmOutputSchema,
  evidenceClusteringLlmOutputSchema,
} from "@/src/lib/llm-output-schemas";

describe("claimResearchLlmOutputSchema", () => {
  it("normalizes claim and evidenceRefs aliases from research payloads", () => {
    const parsed = claimResearchLlmOutputSchema.parse({
      claims: [
        {
          claim: "Implemented role-aware filters for internal and public datasets.",
          category: "backend",
          confidence: "medium",
          ownershipClarity: "partial",
          evidenceSummary: "Notes and repo evidence both point to role-aware filtering work.",
          rationaleSummary: "The sources support the feature, but individual ownership is partial.",
          evidenceRefs: ["evidence-1", "evidence-2"],
        },
      ],
    });

    expect(parsed).toEqual({
      claims: [
        {
          claimText: "Implemented role-aware filters for internal and public datasets.",
          category: "backend",
          confidence: "medium",
          ownershipClarity: "partial",
          evidenceSummary: "Notes and repo evidence both point to role-aware filtering work.",
          rationaleSummary: "The sources support the feature, but individual ownership is partial.",
          sourceRefs: ["evidence-1", "evidence-2"],
        },
      ],
    });
  });

  it("backfills required claim research metadata when repair output is minimal", () => {
    const parsed = claimResearchLlmOutputSchema.parse({
      claims: [
        {
          claim: "Developed a background CSV import worker for multi-team uploads.",
          category: "data_engineering",
          evidenceRefs: ["evidence-1"],
        },
      ],
    });

    expect(parsed.claims[0]).toMatchObject({
      claimText: "Developed a background CSV import worker for multi-team uploads.",
      category: "data_engineering",
      confidence: "medium",
      ownershipClarity: "partial",
      evidenceSummary:
        "Candidate claim derived from the reviewed evidence: Developed a background CSV import worker for multi-team uploads.",
      rationaleSummary: "Ground this claim against the cited evidence before approval.",
      sourceRefs: ["evidence-1"],
    });
  });
});

describe("claimVerificationLlmOutputSchema", () => {
  it("normalizes reviewer-style verification payloads into Workbase fields", () => {
    const parsed = claimVerificationLlmOutputSchema.parse({
      verificationResults: [
        {
          claimIndex: 0,
          verdict: "supported",
          confidence: "medium",
          ownershipClarity: "partial",
          summary:
            "The claim is grounded in the supplied notes but needs cautious ownership framing.",
          cautions: [
            "The source excerpt attached to this claim is mismatched.",
            "Collaborative project context means sole ownership is unclear.",
          ],
          suggestedWording:
            "Integrated Prisma with PostgreSQL and implemented role-aware filters for internal and public datasets",
          visibilityNotes:
            "This should stay private until the sensitive data language is reviewed.",
          sensitivityFlags: [
            "Touches internal dataset access patterns and should be reviewed carefully.",
          ],
          missingInfo: [
            "No corroborating commit history is attached.",
            "Extent of individual contribution is not specified.",
          ],
        },
      ],
    });

    expect(parsed).toEqual({
      results: [
        {
          claimIndex: 0,
          revisedText:
            "Integrated Prisma with PostgreSQL and implemented role-aware filters for internal and public datasets",
          confidence: "medium",
          ownershipClarity: "partial",
          visibilitySuggestion: "private",
          sensitivityWarning: true,
          shouldFlag: true,
          overstatementWarning: true,
          unsupportedImpactWarning: false,
          rationaleSummary:
            "The claim is grounded in the supplied notes but needs cautious ownership framing.",
          risksSummary:
            "The source excerpt attached to this claim is mismatched. Collaborative project context means sole ownership is unclear.",
          missingInfo:
            "No corroborating commit history is attached. Extent of individual contribution is not specified.",
          verificationNotes:
            "This should stay private until the sensitive data language is reviewed. The source excerpt attached to this claim is mismatched. Collaborative project context means sole ownership is unclear. Touches internal dataset access patterns and should be reviewed carefully.",
        },
      ],
    });
  });

  it("infers claim indexes and tolerates empty or advisory revised text", () => {
    const parsed = claimVerificationLlmOutputSchema.parse({
      verificationResults: [
        {
          verdict: "supported",
          confidence: "medium",
          ownershipClarity: "partial",
          verifierNotes:
            "The source supports the implementation detail but does not confirm sole ownership.",
          suggestedRevision: null,
          cautions: ["A stronger source would help confirm individual ownership."],
          sensitivityFlags: [],
          missingInfo: ["Commit history would strengthen this claim."],
          visibilitySuggestions: [],
        },
        {
          verdict: "supported",
          confidence: "low",
          ownershipClarity: "unclear",
          verifierNotes:
            "This is collaborative work involving sensitive data language and should be reviewed carefully.",
          suggestedRevision:
            "Consider specifying what the candidate's individual role was within the collaboration.",
          cautions: ["Sensitive data context may warrant private visibility."],
          sensitivityFlags: ["Touches sensitive data handling language."],
          missingInfo: ["Clarify the individual's role in the collaboration."],
          visibilitySuggestions: ["private"],
        },
      ],
    });

    expect(parsed.results[0]).toMatchObject({
      claimIndex: 0,
      revisedText: null,
      rationaleSummary:
        "The source supports the implementation detail but does not confirm sole ownership.",
      visibilitySuggestion: "resume_safe",
    });

    expect(parsed.results[1]).toMatchObject({
      claimIndex: 1,
      revisedText:
        "Consider specifying what the candidate's individual role was within the collaboration.",
      visibilitySuggestion: "private",
      sensitivityWarning: true,
    });
  });
});

describe("evidenceClusteringLlmOutputSchema", () => {
  it("normalizes shorthand cluster item ids into evidence item references", () => {
    const parsed = evidenceClusteringLlmOutputSchema.parse({
      clusters: [
        {
          title: "Dashboard work",
          summary: "Frontend and review surface improvements for the work item flow.",
          theme: "Dashboard and UX",
          confidence: "high",
          items: ["evidence-1", { id: "evidence-2" }, { evidenceItemId: "evidence-3" }],
        },
      ],
    });

    expect(parsed).toEqual({
      clusters: [
        {
          title: "Dashboard work",
          summary: "Frontend and review surface improvements for the work item flow.",
          theme: "Dashboard and UX",
          confidence: "high",
          items: [
            { evidenceItemId: "evidence-1" },
            { evidenceItemId: "evidence-2" },
            { evidenceItemId: "evidence-3" },
          ],
        },
      ],
    });
  });
});
