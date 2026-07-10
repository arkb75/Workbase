import { describe, expect, it } from "vitest";
import { projectKnowledgeScoring } from "@/src/services/project-knowledge-retrieval-service";

describe("project knowledge scoring", () => {
  it("combines natural-language and exact identifier signals", () => {
    const exact = projectKnowledgeScoring.lexicalScore(
      "Where is github-client.ts auth implemented?",
      "Authentication is implemented in src/services/github-client.ts.",
    );
    const loose = projectKnowledgeScoring.lexicalScore(
      "Where is github-client.ts auth implemented?",
      "The project includes a client and authentication work.",
    );

    expect(exact).toBeGreaterThan(loose);
  });

  it("filters public artifacts before similarity ranking", () => {
    expect(
      projectKnowledgeScoring.isHighlightEligible(
        {
          verificationStatus: "approved",
          sensitivityFlag: false,
          visibility: "resume_safe",
        },
        "public_artifact",
      ),
    ).toBe(true);
    expect(
      projectKnowledgeScoring.isHighlightEligible(
        {
          verificationStatus: "draft",
          sensitivityFlag: false,
          visibility: "public_safe",
        },
        "public_artifact",
      ),
    ).toBe(false);
    expect(
      projectKnowledgeScoring.isHighlightEligible(
        {
          verificationStatus: "approved",
          sensitivityFlag: true,
          visibility: "public_safe",
        },
        "public_artifact",
      ),
    ).toBe(false);
  });

  it("prioritizes verified memory while retaining derivative artifacts", () => {
    expect(projectKnowledgeScoring.authorityWeight("verified_highlight")).toBeGreaterThan(
      projectKnowledgeScoring.authorityWeight("prior_artifact"),
    );
    expect(projectKnowledgeScoring.authorityWeight("prior_artifact")).toBeGreaterThan(
      projectKnowledgeScoring.authorityWeight("rejected_guidance"),
    );
  });
});
