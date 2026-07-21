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

  it("accepts an empty verifier result when no draft claim is supported", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        blocks: [],
        issues: [{
          claim: "Redis and Kubernetes provide durable workflow retries.",
          verdict: "unsupported",
          correction: "The cited source mentions bounded retries but does not mention Redis or Kubernetes.",
        }],
      },
      tokenUsage: { inputTokens: 80, outputTokens: 15 },
    });

    const result = await groundProjectAnswer({
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

    expect(result.blocks).toEqual([]);
    expect(result.issues).toEqual([
      "unsupported: Redis and Kubernetes provide durable workflow retries. — The cited source mentions bounded retries but does not mention Redis or Kubernetes.",
    ]);
    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
  });

  it("skips the semantic verifier for deterministic factual-summary grounding", async () => {
    const result = await groundProjectAnswer({
      answer: "Redis and Kubernetes provide durable workflow retries. [citation:1]",
      citationCount: 1,
      verificationMode: "deterministic",
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

    expect(result.blocks).toEqual([]);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("allows verifier indexes only from citations actually referenced by the draft", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        blocks: [{ heading: null, bodyMarkdown: "The workflow retries with a bound.", citationIndexes: [1] }],
        issues: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });

    await groundProjectAnswer({
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
        title: "Unreferenced deployment fact",
        content: "The application has a deployment workflow.",
        currentRun: true,
        citationIndexes: [2],
        supportingSources: [],
      }],
    });

    const request = generateStructuredMock.mock.calls[0]![0];
    const payload = JSON.parse(request.userPrompt) as {
      sources: Array<{ citationIndexes: number[]; title: string }>;
    };
    expect(payload.sources.map((source) => source.title)).toEqual(["Bounded retries"]);
    expect(request.extraValidation({
      blocks: [{
        heading: null,
        bodyMarkdown: "The application has a deployment workflow.",
        citationIndexes: [2],
      }],
      issues: [],
    })).toContain("Block 1 references a citation that was not used by the draft.");
  });

  it("defensively drops a verifier block that introduces an unreferenced citation", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        blocks: [{
          heading: null,
          bodyMarkdown: "The application has a deployment workflow.",
          citationIndexes: [2],
        }],
        issues: [],
      },
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await groundProjectAnswer({
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
        title: "Unreferenced deployment fact",
        content: "The application has a deployment workflow.",
        currentRun: true,
        citationIndexes: [2],
        supportingSources: [],
      }],
    });

    expect(result.blocks).toEqual([]);
    expect(result.issues).toContain(
      "verifier_contract: Block 1 references a citation that was not used by the draft.",
    );
  });

  it("does not make a required minimum prevent an honest empty verifier result", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        blocks: [],
        issues: [{
          claim: "An unsupported claim.",
          verdict: "unsupported",
          correction: "No supplied source entails the claim.",
        }],
      },
      tokenUsage: { inputTokens: 80, outputTokens: 15 },
    });

    const result = await groundProjectAnswer({
      answer: "An unsupported infrastructure claim. [citation:1]",
      citationCount: 1,
      requiredBlockCount: { minimum: 7, maximum: 10 },
      entries: [{
        kind: "project_fact",
        authority: "verified_project_fact",
        title: "A project fact",
        content: "The project contains a bounded workflow.",
        currentRun: true,
        citationIndexes: [1],
        supportingSources: [],
      }],
    });

    expect(result.blocks).toEqual([]);
    const request = generateStructuredMock.mock.calls[0]![0];
    expect(request.extraValidation({ blocks: [], issues: [] })).toEqual([]);
    expect(request.schema.safeParse({ blocks: [], issues: [] }).success).toBe(true);
    expect(request.jsonSchema.properties.blocks.minItems).toBe(0);
    expect(request.budget.limits.maxModelCalls).toBe(1);
    expect(request.budget.limits.maxRepairPasses).toBe(0);
  });
});
