import { beforeEach, describe, expect, it, vi } from "vitest";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "bedrock",
}));
vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import {
  evaluateDeterministicAnswerGrounding,
  groundProjectAnswer,
} from "@/src/services/project-answer-grounding-service";

describe("project answer grounding cost controls", () => {
  beforeEach(() => generateStructuredMock.mockReset());

  it("sends only answer-referenced catalog entries to the semantic verifier", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        blocks: [{ heading: null, bodyMarkdown: "The workflow has bounded retries.", citationIndexes: [1] }],
        issues: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });

    await groundProjectAnswer({
      // "always" deliberately triggers semantic review because the source
      // does not support that absolute qualifier.
      answer: "The workflow always retries with a bound. [citation:1]",
      citationCount: 2,
      entries: [{
        kind: "project_fact",
        authority: "verified_project_fact",
        title: "Bounded retries",
        content: "The workflow retries up to a configured bound.",
        currentRun: true,
        citationIndexes: [1],
        supportingSources: [],
      }, {
        kind: "project_fact",
        authority: "verified_project_fact",
        title: "Unrelated full catalog entry",
        content: "A large unrelated source that should not enter verification.",
        currentRun: true,
        citationIndexes: [2],
        supportingSources: [],
      }],
    });

    const request = generateStructuredMock.mock.calls[0]![0];
    const payload = JSON.parse(request.userPrompt) as { sources: Array<{ title: string }> };
    expect(payload.sources.map((source) => source.title)).toEqual(["Bounded retries"]);
    expect(request).toMatchObject({
      maxTokens: 4_000,
      effort: "medium",
      transportPreference: ["bedrock_json_schema"],
    });
  });

  it("does not mistake topical overlap for support of novel infrastructure claims", () => {
    const result = evaluateDeterministicAnswerGrounding({
      answer: "Redis and Kubernetes provide durable workflow retries. [citation:1]",
      citationCount: 1,
      entries: [{
        kind: "project_fact",
        authority: "verified_project_fact",
        title: "Bounded workflow retries",
        content: "The workflow retries a failed step up to a configured bound.",
        currentRun: true,
        citationIndexes: [1],
        supportingSources: [],
      }],
    });

    expect(result.requiresModel).toBe(true);
    expect(result.unsupportedBlockCount).toBe(1);
  });
});
