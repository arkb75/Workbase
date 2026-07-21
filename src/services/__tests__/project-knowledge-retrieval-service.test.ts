import { describe, expect, it } from "vitest";
import { projectKnowledgeScoring } from "@/src/services/project-knowledge-retrieval-service";

describe("project knowledge scoring", () => {
  it("treats project-value and explicit multi-capability requests as broad synthesis", () => {
    for (const query of [
      "Give me the gist of why this project would matter to an engineering team. Use three concise bullets, ordered by value.",
      "Give me exactly four bullets for a senior backend engineer. Prioritize architecture, data integrity, AI/runtime control, and reliability.",
      "Give me three points. Prioritize architecture, provenance, and reliability.",
      "What were the hardest parts of Workbase to build that also created the most end-to-end user value?",
    ]) {
      expect(projectKnowledgeScoring.isBroadProjectKnowledgeQuery(query)).toBe(true);
    }
  });

  it("keeps genuinely focused counted requests on query-directed retrieval", () => {
    for (const query of [
      "Give me two implementation details about retry backoff.",
      "List three files that implement GitHub OAuth.",
      "Explain the Bedrock tool loop in four steps.",
      "Give a senior backend engineer two bullets about retry backoff.",
      "Give a hiring manager three findings about GitHub OAuth.",
    ]) {
      expect(projectKnowledgeScoring.isBroadProjectKnowledgeQuery(query)).toBe(false);
    }
  });

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

  it("normalizes direct, PostgreSQL lexical, and semantic retrieval signals independently", () => {
    expect(projectKnowledgeScoring.normalizedRetrievalRelevance({
      query: "Explain its security posture",
      content: "Credential redaction protects provider tokens before model calls.",
      vectorSimilarity: 0.72,
    })).toBe(0.72);
    expect(projectKnowledgeScoring.normalizedRetrievalRelevance({
      query: "Explain authorization",
      content: "GitHub OAuth scopes attached-repository access.",
      postgresLexicalRank: 0.04,
    })).toBeGreaterThan(0.75);
    expect(projectKnowledgeScoring.normalizedRetrievalRelevance({
      query: "Explain GitHub OAuth authorization",
      content: "GitHub OAuth scopes attached-repository access.",
      postgresLexicalRank: 0.04,
    })).toBeGreaterThan(0.5);
    expect(projectKnowledgeScoring.normalizedRetrievalRelevance({
      query: "Where is github-client.ts auth implemented?",
      content: "Authentication is implemented in src/services/github-client.ts.",
    })).toBeGreaterThan(0.5);
  });

  it("does not treat generic words or substrings as focused lexical support", () => {
    expect(projectKnowledgeScoring.lexicalScore(
      "What CDN and production deployment topology does Workbase use?",
      "Workbase helps users produce reviewed career content.",
    )).toBe(0);
    expect(projectKnowledgeScoring.normalizedRetrievalRelevance({
      query: "What CDN and production deployment topology does Workbase use?",
      content: "Workbase helps users produce reviewed career content.",
      vectorSimilarity: 0.54,
    })).toBe(0);
    expect(projectKnowledgeScoring.lexicalScore(
      "Explain how the Bedrock tool loop enforces limits.",
      "The runtime enforces iteration/tool/token budgets through Bedrock Converse.",
    )).toBeGreaterThanOrEqual(2);
  });

  it("expands common focused intents into the vocabulary used by durable memory", () => {
    expect(projectKnowledgeScoring.lexicalScore(
      "Explain the security posture.",
      "The runtime performs credential redaction before model events are exposed.",
    )).toBeGreaterThan(0);
    expect(projectKnowledgeScoring.lexicalScore(
      "How are authentication and repository permissions enforced?",
      "GitHub OAuth is configured for repository access.",
    )).toBeGreaterThan(0);
    expect(projectKnowledgeScoring.lexicalScore(
      "Where does the system handle resiliency?",
      "Durable workflow progress persists so a run can resume.",
    )).toBeGreaterThan(0);
  });

  it("filters public artifacts before similarity ranking", () => {
    expect(
      projectKnowledgeScoring.isHighlightEligible(
        {
          verificationStatus: "approved",
          sensitivityFlag: false,
          visibility: "resume_safe",
          publicSafetyStatus: "verified",
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

  it("never treats draft, flagged, or rejected Highlights as positive chat authority", () => {
    for (const verificationStatus of ["draft", "flagged", "rejected"]) {
      expect(
        projectKnowledgeScoring.isHighlightEligible(
          {
            verificationStatus,
            sensitivityFlag: false,
            visibility: "private",
          },
          "private_chat",
        ),
      ).toBe(false);
    }
    expect(
      projectKnowledgeScoring.isHighlightEligible(
        {
          verificationStatus: "approved",
          sensitivityFlag: true,
          visibility: "private",
        },
        "private_chat",
      ),
    ).toBe(true);
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
