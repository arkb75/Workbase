import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "bedrock",
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import {
  compactProjectFactExtractionExcerpt,
  deterministicFactRecoveryFromCitations,
  deterministicFactsFromCitations,
  extractFactsWithRecovery,
} from "@/src/services/project-fact-service";

describe("Project Fact extraction limit recovery", () => {
  beforeEach(() => generateStructuredMock.mockReset());
  afterEach(() => delete process.env.WORKBASE_PROJECT_FACT_RECOVERY_MODE);

  it("keeps a bounded question-focused window for semantic extraction", () => {
    const excerpt = `${"const unrelated = true;\n".repeat(180)}if (iterations >= limits.maxIterations) { throw new Error("stop"); }\n${"const tail = true;\n".repeat(180)}`;
    const compacted = compactProjectFactExtractionExcerpt(
      excerpt,
      "Where are iteration limits enforced, and what terminates the loop?",
    );

    expect(compacted.length).toBeLessThanOrEqual(2_900);
    expect(compacted).toContain("limits.maxIterations");
    expect(compacted).toContain("excerpt text omitted");
  });

  it("does not call the model when exact excerpts establish bounded control flow", async () => {
    const result = await extractFactsWithRecovery({
      question: "Where are retry limits enforced, and what terminates the loop?",
      workItemTitle: "Workbase",
      citations: [{
        kind: "github_file",
        label: "src/agent.ts",
        excerpt: "if (iterations >= limits.maxIterations) {\n  throw new Error('stop');\n}\nif (stopReason === 'end_turn') {\n  return result;\n}",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/agent.ts",
        startLine: 20,
        endLine: 25,
      }],
      partial: true,
      maxFacts: 4,
    });

    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ statement: expect.stringContaining("limits.maxIterations") }),
      expect.objectContaining({ statement: expect.stringContaining("stopReason") }),
    ]));
    expect(result.coverageGaps).toContain(
      "The inspected excerpts did not establish a retry or backoff policy; an iteration guard must not be reported as a retry count.",
    );
  });

  it("salvages supported facts from smaller batches after a full structured output fails", async () => {
    process.env.WORKBASE_PROJECT_FACT_RECOVERY_MODE = "batched_model_retry";
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

  it("stops after one model attempt and preserves exact notebook facts by default", async () => {
    generateStructuredMock.mockRejectedValueOnce(new StructuredOutputError(
      "Output was truncated.",
      "parse_error",
      "{",
      null,
      { inputTokens: 20_000, outputTokens: 4_000 },
      "bedrock_json_schema",
      null,
    ));

    const result = await extractFactsWithRecovery({
      question: "Where is retry behavior implemented?",
      workItemTitle: "Workbase",
      citations: [{
        kind: "github_file",
        label: "src/retry.ts",
        excerpt: "export function retry() {}",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/retry.ts",
        startLine: 1,
        endLine: 1,
      }],
      partial: true,
      maxFacts: 2,
    });
    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(result.facts).toEqual([expect.objectContaining({
      category: "code_location",
      statement: expect.stringContaining("defines `retry`"),
      citationIndexes: [1],
    })]);
    expect(result.coverageGaps[0]).toContain("Semantic Project Fact extraction did not complete");
  });

  it("marks a provider failure with missing usage as an unknown charged attempt", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("provider disconnected"));

    const result = await extractFactsWithRecovery({
      question: "Where is retry behavior implemented?",
      workItemTitle: "Workbase",
      citations: [{
        kind: "github_file",
        label: "src/retry.ts",
        excerpt: "export function retry() {}",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/retry.ts",
        startLine: 1,
        endLine: 1,
      }],
      partial: true,
      maxFacts: 2,
    });

    expect(result.tokenUsage).toEqual([
      expect.objectContaining({ unknownUsageAttempts: 1, fallback: "deterministic_notebook" }),
    ]);
  });

  it("does not promote unrelated files merely because they contain question stop words", () => {
    expect(deterministicFactsFromCitations({
      question: "Inspect the attached repository: where are retry limits enforced, and what terminates the loop?",
      citations: [{
        kind: "github_file",
        label: "src/unrelated.ts",
        excerpt: "export const content = 'bread and butter';",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/unrelated.ts",
        startLine: 1,
        endLine: 1,
      }],
      maxFacts: 2,
    })).toEqual([]);
  });

  it("does not turn a limit-shaped identifier into an unsupported bounded-loop claim", () => {
    const recovered = deterministicFactRecoveryFromCitations({
      question: "Where are retry limits enforced, and what terminates the loop?",
      citations: [{
        kind: "github_file",
        label: "src/agent-config.ts",
        excerpt: "export const maxIterations = 8;\nexport const provider = 'bedrock';",
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/agent-config.ts",
        startLine: 20,
        endLine: 21,
      }],
      maxFacts: 4,
    });

    expect(recovered.facts.every((fact) => !fact.statement.includes("bounded by"))).toBe(true);
    expect(recovered.facts.every((fact) => !fact.statement.includes("loop condition"))).toBe(true);
    expect(recovered.coverageGaps).toEqual([
      expect.stringContaining("no retry or iteration-bound claim was inferred"),
      expect.stringContaining("no loop-termination path was inferred"),
      expect.stringContaining("did not establish a retry or backoff policy"),
    ]);
  });

  it("recovers exact loop bounds and exit conditions without semantic embellishment", () => {
    const recovered = deterministicFactRecoveryFromCitations({
      question: "Where are retry limits enforced, and what terminates the loop?",
      citations: [{
        kind: "github_file",
        label: "src/agent-runtime.ts",
        excerpt: [
          "export async function retry() {",
          "  for (let iteration = 0; iteration < maxIterations; iteration += 1) {",
          "    if (stopReason === 'end_turn') {",
          "      break;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        repository: "workbase/demo",
        commitSha: "a".repeat(40),
        path: "src/agent-runtime.ts",
        startLine: 40,
        endLine: 46,
      }],
      maxFacts: 4,
    });

    expect(recovered.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "behavior",
        confidence: "high",
        statement: expect.stringContaining("`iteration < maxIterations` at line 41"),
      }),
      expect.objectContaining({
        category: "behavior",
        confidence: "high",
        statement: expect.stringContaining("`break;` under `stopReason === 'end_turn'` at line 42"),
      }),
    ]));
    expect(recovered.coverageGaps).toEqual([]);
  });

  it("keeps retry-loop guards while rejecting unrelated file-size limits", () => {
    const recovered = deterministicFactRecoveryFromCitations({
      question: "Where are retry limits enforced, and what terminates the loop?",
      citations: [
        {
          kind: "github_file",
          label: "src/github-reader.ts",
          excerpt: [
            "if (blob.size > limits.maxFileBytes) {",
            "  throw new Error('file too large');",
            "}",
          ].join("\n"),
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          path: "src/github-reader.ts",
          startLine: 10,
          endLine: 12,
        },
        {
          kind: "github_file",
          label: "src/agent-runtime.ts",
          excerpt: [
            "while (true) {",
            "  if (iterations >= limits.maxIterations) {",
            "    throw new AgentError(",
            "      `Exceeded ${limits.maxIterations} iterations.`,",
            "    );",
            "  }",
            "}",
          ].join("\n"),
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          path: "src/agent-runtime.ts",
          startLine: 730,
          endLine: 736,
        },
      ],
      maxFacts: 4,
    });

    expect(recovered.facts).toEqual([
      expect.objectContaining({
        citationIndexes: [2],
        statement: expect.stringContaining("`throw` under `iterations >= limits.maxIterations` at line 731"),
      }),
    ]);
    expect(recovered.coverageGaps).toEqual([
      expect.stringContaining("did not establish a retry or backoff policy"),
    ]);
  });
});
