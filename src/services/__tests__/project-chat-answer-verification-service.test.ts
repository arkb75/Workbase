import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import {
  analyzeProjectChatCitationSyntax,
  finalizeModelLedProjectChatAnswer,
  projectChatRepairInstructions,
} from "@/src/services/project-chat-answer-verification-service";

const catalog: ProjectKnowledgeCitation[] = [
  {
    kind: "evidence",
    label: "Resolved runtime profiles",
    excerpt: "primary_answer uses model-a; verification uses model-b",
    contentHash: "a".repeat(64),
  },
  {
    kind: "github_file",
    label: "Runtime implementation",
    excerpt: "The runtime resolves every profile independently.",
    repository: "arkb75/Workbase",
    commitSha: "1".repeat(40),
    path: "src/lib/llm-config.ts",
    startLine: 1,
    endLine: 20,
  },
];

describe("model-led project-chat answer boundaries", () => {
  it("limits deterministic citation validation to syntax and catalog range", () => {
    expect(analyzeProjectChatCitationSyntax(
      "Supported [citation:1] and implemented here [citation:2].",
      catalog.length,
    )).toEqual({ issues: [], citationIndexes: [1, 2] });

    expect(analyzeProjectChatCitationSyntax(
      "Bad [citation:wat] and missing [citation:7].",
      catalog.length,
    ).issues).toEqual([
      "Malformed citation marker: [citation:wat].",
      "Citation 7 is outside the available source catalog.",
      "One or more citation markers are not in canonical [citation:N] form.",
    ]);
  });

  it("preserves the primary model's table structure while compacting citations", () => {
    const answer = [
      "| Purpose | Profile | Model |",
      "|---|---|---|",
      "| Final answer | `primary_answer` | `model-a` [citation:1] |",
      "| Verification | `verification` | `model-b` [citation:1] |",
      "",
      "The mapping is resolved from the active runtime, not inferred from docs. [citation:2]",
    ].join("\n");
    const result = finalizeModelLedProjectChatAnswer({
      answer,
      catalog,
      requiresProjectCitations: true,
    });

    expect(result.answer).toBe(answer);
    expect(result.answer).toContain("| Purpose | Profile | Model |");
    expect(result.citations).toHaveLength(2);
    expect(result.citationPolicy).toBe("required_inline");
    expect(result.groundedClaims.length).toBeGreaterThanOrEqual(2);
  });

  it("allows genuinely conversational answers without manufacturing sources", () => {
    const result = finalizeModelLedProjectChatAnswer({
      answer: "Yes—tell me which trade-off you want to explore first.",
      catalog,
      requiresProjectCitations: false,
    });
    expect(result).toMatchObject({
      answer: "Yes—tell me which trade-off you want to explore first.",
      citations: [],
      citationPolicy: "none",
      groundedClaims: [],
    });
  });

  it("fails closed when a project-grounded answer has no source", () => {
    expect(() => finalizeModelLedProjectChatAnswer({
      answer: "The active runtime uses model-a.",
      catalog,
      requiresProjectCitations: true,
    })).toThrow("cites no authoritative project source");
  });

  it("accepts an authoritative citation line immediately after a Markdown table", () => {
    const result = finalizeModelLedProjectChatAnswer({
      answer: [
        "| Purpose | Model |",
        "|---|---|",
        "| Final answers | Terra |",
        "| Verification | Luna |",
        "",
        "[citation:1]",
      ].join("\n"),
      catalog,
      requiresProjectCitations: true,
    });
    expect(result.answer).toContain("| Final answers | Terra |");
    expect(result.groundedClaims).toEqual([{
      claim: "| Verification | Luna |",
      citationIndexes: [1],
    }]);
  });

  it("asks the primary model—not a template—to repair or state an evidence boundary", () => {
    const instructions = projectChatRepairInstructions({
      verdict: "insufficient_context",
      requiresProjectCitations: true,
      groundingSatisfied: false,
      instructionSatisfied: true,
      formatSatisfied: true,
      issues: [{ code: "missing_metric", explanation: "No source establishes p95." }],
      generationRunId: "verification-1",
      mechanicalIssues: [],
    });
    expect(instructions).toContain("No source establishes p95.");
    expect(instructions).toContain("say that boundary plainly instead of guessing");
    expect(instructions).toContain("Return only the revised user-facing answer");
    expect(instructions).not.toContain("Here is what I found");
  });
});
