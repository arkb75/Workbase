import { describe, expect, it, vi } from "vitest";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "bedrock",
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import { extractFactsWithRecovery } from "@/src/services/project-fact-service";

describe("Project Fact extraction limit recovery", () => {
  it("salvages supported facts from smaller batches after a full structured output fails", async () => {
    generateStructuredMock
      .mockRejectedValueOnce(new StructuredOutputError(
        "Output was truncated.",
        "parse_error",
        "{",
        null,
        { inputTokens: 50_000, outputTokens: 8_000 },
        "bedrock_json_schema",
        null,
      ))
      .mockResolvedValueOnce({
        data: {
          facts: [{
            statement: "The chat workflow durably resumes after Project Fact review.",
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            reviewNotes: null,
            citationIndexes: [1],
          }],
          coverageGaps: [],
        },
        tokenUsage: { inputTokens: 10_000, outputTokens: 500 },
      })
      .mockResolvedValueOnce({
        data: {
          facts: [{
            statement: "The repository research is pinned to an immutable commit SHA.",
            category: "configuration",
            confidence: "high",
            sensitivityFlag: false,
            reviewNotes: null,
            citationIndexes: [1],
          }],
          coverageGaps: [],
        },
        tokenUsage: { inputTokens: 3_000, outputTokens: 300 },
      });

    const citations = Array.from({ length: 5 }, (_, index) => ({
      kind: "github_file" as const,
      label: `src/file-${index + 1}.ts`,
      excerpt: `export const value${index + 1} = true;`,
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: `src/file-${index + 1}.ts`,
      startLine: 1,
      endLine: 1,
    }));
    const result = await extractFactsWithRecovery({
      question: "Summarize the current architecture.",
      workItemTitle: "Workbase",
      citations,
      partial: true,
      maxFacts: 4,
    });

    expect(generateStructuredMock).toHaveBeenCalledTimes(3);
    expect(result.facts.map((fact) => fact.citationIndexes)).toEqual([[1], [5]]);
    expect(result.coverageGaps[0]).toContain("retried smaller excerpt batches");
    expect(result.tokenUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "batch_1", status: "success" }),
      expect.objectContaining({ phase: "batch_2", status: "success" }),
    ]));
  });
});
