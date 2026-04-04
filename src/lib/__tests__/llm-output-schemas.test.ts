import { describe, expect, it } from "vitest";
import { claimVerificationLlmOutputSchema } from "@/src/lib/llm-output-schemas";

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
