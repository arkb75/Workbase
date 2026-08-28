import { beforeEach, describe, expect, it, vi } from "vitest";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/llm-config")>();
  return { ...actual, resolveWorkbaseLlmProvider: () => "bedrock" };
});

vi.mock("@/src/services/bedrock-runtime", () => ({
  getStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import {
  analyzeRepositoryFile,
  analyzeRepositoryFileBatch,
  createRepositorySemanticBudget,
} from "@/src/services/repository-coverage-service";

describe("repository semantic task and budget", () => {
  beforeEach(() => {
    generateStructuredMock.mockReset();
    generateStructuredMock.mockImplementation(async (input: { budget?: { usage: { modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number } } }) => {
      if (input.budget) {
        input.budget.usage.modelCalls += 1;
        input.budget.usage.inputTokens += 30;
        input.budget.usage.outputTokens += 10;
        input.budget.usage.totalTokens += 40;
      }
      return {
        data: {
          summary: "The file performs project-scoped retrieval.",
          subsystemKeys: ["retrieval_provenance"],
          findings: [{
            statement: "The exported operation retrieves project-scoped records.",
            kind: "data_flow",
            capabilityKeys: ["retrieval_provenance"],
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 1,
            lineEnd: 1,
          }],
          unresolvedQuestions: [],
        },
        rawOutput: "{}",
        parsedOutput: {},
        tokenUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });
  });

  it("salvages bounded prose that slightly exceeds provider maxLength output", async () => {
    const overlongSummary = `Summary ${"s".repeat(1_300)}`;
    const overlongStatement = `The file implements ${"supported behavior ".repeat(40)}`;
    const overlongQuestion = `How does ${"this concrete dependency interact with the persisted refresh boundary ".repeat(8)}`;

    generateStructuredMock.mockImplementationOnce(async (request: {
      schema: { parse(value: unknown): {
        summary: string;
        subsystemKeys: string[];
        findings: Array<{ statement: string }>;
        unresolvedQuestions: string[];
      } };
    }) => ({
      data: request.schema.parse({
        summary: overlongSummary,
        subsystemKeys: ["repository_knowledge_lifecycle"],
        findings: [{
          statement: overlongStatement,
          kind: "behavior",
          capabilityKeys: ["repository_knowledge_lifecycle"],
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 1,
          lineEnd: 1,
        }],
        unresolvedQuestions: [overlongQuestion],
      }),
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    }));

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "f".repeat(40),
      path: "src/services/knowledge-refresh-service.ts",
      content: "export const refreshProjectKnowledge = () => true;",
      task: {
        objective: "Determine the repository knowledge lifecycle behavior.",
        capabilityKeys: ["repository_knowledge_lifecycle"],
        questions: [],
        expectedOutputs: [],
      },
    });

    expect(analysis).toMatchObject({ semanticStatus: "succeeded" });
    expect(analysis.summary).toHaveLength(1_200);
    expect(analysis.facts[0]?.statement).toHaveLength(500);
    expect(analysis.unresolvedQuestions[0]).toHaveLength(300);
    expect(generateStructuredMock.mock.calls[0]?.[0].effort).toBe("low");
  });

  it("reduces three uncached semantic files to one structured model call", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 3,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });
    const paths = ["src/chat.ts", "src/retrieval.ts", "src/artifact.ts"];
    generateStructuredMock.mockImplementationOnce(async (request: { budget?: typeof budget.model }) => {
      if (request.budget) {
        request.budget.usage.modelCalls += 1;
        request.budget.usage.inputTokens += 90;
        request.budget.usage.outputTokens += 30;
        request.budget.usage.totalTokens += 120;
      }
      return {
        data: {
          files: {
            ...Object.fromEntries(paths.map((path, index) => [
              `file-${index + 1}`,
              {
              summary: `${path} implements project behavior.`,
              subsystemKeys: ["project_chat_grounding"],
              findings: [{
                statement: `${path} performs a supported project-scoped operation.`,
                kind: "behavior",
                capabilityKeys: ["project_chat_grounding"],
                confidence: "high",
                sensitivityFlag: false,
                lineStart: 1,
                lineEnd: 1,
              }],
              unresolvedQuestions: [],
              },
            ])),
            junk: { duplicate: "file-1" },
          },
        },
        rawOutput: "{}",
        parsedOutput: {},
        tokenUsage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 },
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });

    const analyses = await analyzeRepositoryFileBatch(paths.map((path) => ({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path,
      content: "export const operation = () => true;",
      task: {
        objective: "Determine the implemented project behavior.",
        capabilityKeys: ["project_chat_grounding"],
        questions: [],
        expectedOutputs: ["An exact-line supported finding"],
      },
      budget,
    })));

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(analyses).toHaveLength(3);
    expect(analyses.map((analysis) => analysis.path)).toEqual(paths);
    expect(analyses.every((analysis) => analysis.semanticStatus === "succeeded")).toBe(true);
    expect(analyses.every((analysis) => analysis.facts[0]?.lineStart === 1 && analysis.facts[0]?.lineEnd === 1)).toBe(true);
    expect(analyses.every((analysis) => {
      const diagnostic = analysis.semanticDiagnostics?.[0];
      return Boolean(
        diagnostic &&
        typeof diagnostic === "object" &&
        "unknownBatchMembers" in diagnostic &&
        diagnostic.unknownBatchMembers === 1,
      );
    })).toBe(true);
    expect(analyses.flatMap((analysis) => analysis.tokenUsage)).toHaveLength(1);
    expect(budget.model.usage).toMatchObject({ modelCalls: 1, totalTokens: 120 });
    const request = generateStructuredMock.mock.calls[0]?.[0];
    expect(request.jsonSchema.properties.files).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["file-1", "file-2", "file-3"],
    });
    expect(Object.keys(request.jsonSchema.properties.files.properties)).toEqual(["file-1", "file-2", "file-3"]);
    expect(request.jsonSchema.$defs.semanticFileAnalysis).toBeDefined();
    expect(request.jsonSchema.properties.files.properties).toEqual({
      "file-1": { $ref: "#/$defs/semanticFileAnalysis" },
      "file-2": { $ref: "#/$defs/semanticFileAnalysis" },
      "file-3": { $ref: "#/$defs/semanticFileAnalysis" },
    });
    expect(request.exampleOutput.files["file-1"]).not.toHaveProperty("fileKey");
    expect(request.exampleOutput.files["file-1"]).not.toHaveProperty("path");
    expect(request.effort).toBe("low");
  });

  it("degrades only missing or invalid file members and retains their exact gaps", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 3,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });
    generateStructuredMock.mockImplementationOnce(async (request: { budget?: typeof budget.model }) => {
      if (request.budget) request.budget.usage.modelCalls += 1;
      const analysis = (statement: string, lineStart: number, capabilityKey = "ai_runtime") => ({
        summary: statement,
        subsystemKeys: [capabilityKey],
        findings: [{
          statement,
          kind: "behavior",
          capabilityKeys: [capabilityKey],
          confidence: "high",
          sensitivityFlag: false,
          lineStart,
          lineEnd: lineStart,
        }],
        unresolvedQuestions: [],
      });
      return {
        data: {
          files: {
            "file-1": analysis("The valid file invokes the configured model runtime.", 1),
            // file-2 is deliberately omitted.
            "file-3": analysis("The invalid finding points outside the supplied file window.", 99),
            "file-4": analysis("The finding uses a capability assigned to a different file task.", 1, "retrieval_provenance"),
            "junk": { repeated: ["file-1", "file-1"], path: "src/valid.ts" },
          },
        },
        rawOutput: "{}",
        parsedOutput: {},
        tokenUsage: null,
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });
    const files = ["src/valid.ts", "src/missing.ts", "src/out-of-window.ts", "src/wrong-capability.ts"];

    const analyses = await analyzeRepositoryFileBatch(files.map((path) => ({
      repository: "workbase/demo",
      commitSha: "b".repeat(40),
      path,
      content: "const localValue = true;",
      task: {
        objective: "Determine the AI runtime behavior.",
        capabilityKeys: ["ai_runtime"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    })));

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(analyses[0]).toMatchObject({ path: "src/valid.ts", semanticStatus: "succeeded" });
    expect(analyses[1]).toMatchObject({ path: "src/missing.ts", semanticStatus: "failed", facts: [] });
    expect(analyses[1]?.unresolvedQuestions.join(" ")).toContain("provider omitted file-2");
    expect(analyses[2]).toMatchObject({ path: "src/out-of-window.ts", semanticStatus: "degraded", facts: [] });
    expect(analyses[2]?.unresolvedQuestions.join(" ")).toContain("Rejected out-of-window finding at 99-99");
    expect(analyses[3]).toMatchObject({ path: "src/wrong-capability.ts", semanticStatus: "degraded", facts: [] });
    expect(analyses[3]?.unresolvedQuestions.join(" ")).toContain("capabilities outside this file task: retrieval_provenance");
    expect(analyses[0]?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ unknownBatchMembers: 1 }),
    ]));
    const request = generateStructuredMock.mock.calls[0]?.[0];
    expect(request.jsonSchema.properties.files.required).toEqual(["file-1", "file-2", "file-3", "file-4"]);
    expect(Object.keys(request.jsonSchema.properties.files.properties)).toEqual([
      "file-1",
      "file-2",
      "file-3",
      "file-4",
    ]);
  });

  it("degrades one malformed keyed member without losing its valid batch siblings", async () => {
    const validAnalysis = (statement: string) => ({
      summary: statement,
      subsystemKeys: ["ai_runtime"],
      findings: [{
        statement,
        kind: "behavior",
        capabilityKeys: ["ai_runtime"],
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 1,
        lineEnd: 1,
      }],
      unresolvedQuestions: [],
    });
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: {
          "file-1": validAnalysis("The first file invokes the configured AI runtime."),
          "file-2": { summary: 42, findings: "not-an-array" },
          "file-3": validAnalysis("The third file invokes the configured AI runtime."),
        },
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    });
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });

    const analyses = await analyzeRepositoryFileBatch(["src/first.ts", "src/malformed.ts", "src/third.ts"].map((path) => ({
      repository: "workbase/demo",
      commitSha: "e".repeat(40),
      path,
      content: "export const operation = () => true;",
      task: {
        objective: "Determine the implemented AI runtime behavior.",
        capabilityKeys: ["ai_runtime"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    })));

    expect(analyses).toHaveLength(3);
    expect(analyses[0]).toMatchObject({ path: "src/first.ts", semanticStatus: "succeeded" });
    expect(analyses[1]).toMatchObject({ path: "src/malformed.ts", semanticStatus: "failed", facts: [] });
    expect(analyses[1]?.unresolvedQuestions.join(" ")).toContain("malformed analysis for file-2");
    expect(analyses[2]).toMatchObject({ path: "src/third.ts", semanticStatus: "succeeded" });
    const runtimeSchema = generateStructuredMock.mock.calls[0]?.[0].schema;
    expect(runtimeSchema.safeParse({
      files: {
        "file-1": validAnalysis("The first file invokes the configured AI runtime."),
        "file-2": { malformed: true },
        junk: null,
      },
    }).success).toBe(true);
  });

  it("ignores duplicate-style extra keyed data and retains every valid requested member", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });
    const analysis = (
      summary: string,
      capabilityKey: string,
      lineStart = 1,
    ) => ({
      summary,
      subsystemKeys: [capabilityKey],
      findings: [{
        statement: `${summary} is supported by the supplied immutable line.`,
        kind: "behavior",
        capabilityKeys: [capabilityKey],
        confidence: "high",
        sensitivityFlag: false,
        lineStart,
        lineEnd: lineStart,
      }],
      unresolvedQuestions: [],
    });
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: {
          "file-1": {
            summary: "The file persists retrieval provenance.",
            subsystemKeys: ["ai_runtime", "retrieval_provenance"],
            findings: [
              ...analysis("The file invokes the configured AI runtime", "ai_runtime").findings,
              ...analysis("The file persists retrieval provenance", "retrieval_provenance").findings,
              ...analysis("This optional observation is outside the supplied window", "ai_runtime", 99).findings,
            ],
            unresolvedQuestions: [],
          },
          "file-2": analysis("The second file invokes the configured AI runtime", "ai_runtime"),
          "file-1-duplicate": analysis("Unrequested duplicate-style data must be ignored", "ai_runtime"),
        },
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    });

    const analyses = await analyzeRepositoryFileBatch([{
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/multi-purpose.ts",
      content: "export const operation = () => true;",
      task: {
        objective: "Determine AI runtime and retrieval provenance behavior.",
        capabilityKeys: ["ai_runtime", "retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    }, {
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/other.ts",
      content: "export const operation = () => true;",
      task: {
        objective: "Determine AI runtime behavior.",
        capabilityKeys: ["ai_runtime"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    }]);

    expect(analyses[0]).toMatchObject({ semanticStatus: "succeeded", semanticSource: "model" });
    expect(analyses[0]?.facts.flatMap((fact) => fact.subsystemKeys ?? [])).toEqual(expect.arrayContaining([
      "ai_runtime",
      "retrieval_provenance",
    ]));
    expect(analyses[0]?.unresolvedQuestions.join(" ")).toContain("Rejected out-of-window finding at 99-99");
    expect(analyses[0]?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "success",
        duplicateExactPathMembers: 0,
        rejectedFindings: 1,
        missingCapabilityKeys: [],
        unknownBatchMembers: 1,
      }),
    ]));
    expect(analyses[1]).toMatchObject({ semanticStatus: "succeeded" });
  });

  it("degrades a valid batch member when any assigned capability has no supported finding", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: Object.fromEntries(["src/incomplete.ts", "src/complete.ts"].map((_path, index) => [
          `file-${index + 1}`,
          {
            summary: "The file invokes the configured AI runtime.",
            subsystemKeys: ["ai_runtime"],
            findings: [{
              statement: "The file invokes a schema-constrained model runtime.",
              kind: "behavior",
              capabilityKeys: ["ai_runtime"],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 1,
              lineEnd: 1,
            }],
            unresolvedQuestions: [],
          },
        ])),
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    });
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });

    const analyses = await analyzeRepositoryFileBatch([{
      repository: "workbase/demo",
      commitSha: "d".repeat(40),
      path: "src/incomplete.ts",
      content: "export const operation = () => true;",
      task: {
        objective: "Determine runtime and provenance behavior.",
        capabilityKeys: ["ai_runtime", "retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    }, {
      repository: "workbase/demo",
      commitSha: "d".repeat(40),
      path: "src/complete.ts",
      content: "export const operation = () => true;",
      task: {
        objective: "Determine runtime behavior.",
        capabilityKeys: ["ai_runtime"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    }]);

    expect(analyses[0]).toMatchObject({ semanticStatus: "degraded" });
    expect(analyses[0]?.unresolvedQuestions.join(" ")).toContain("required capabilities: retrieval_provenance");
    expect(analyses[0]?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ missingCapabilityKeys: ["retrieval_provenance"] }),
    ]));
    expect(analyses[1]).toMatchObject({ semanticStatus: "succeeded" });
  });

  it("deterministically attributes supported test-file findings to tests operations", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: {
          "file-1": {
            summary: "The route tests cover authenticated and unauthenticated behavior.",
            subsystemKeys: ["project_domain:auth"],
            findings: [{
              statement: "The tests verify that an unauthenticated request returns an authorization error.",
              kind: "behavior",
              capabilityKeys: ["project_domain:auth"],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 1,
              lineEnd: 1,
            }],
            unresolvedQuestions: [],
          },
          "file-2": {
            summary: "The runtime exports a bounded operation.",
            subsystemKeys: ["ai_runtime"],
            findings: [{
              statement: "The runtime exports a bounded operation.",
              kind: "behavior",
              capabilityKeys: ["ai_runtime"],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 1,
              lineEnd: 1,
            }],
            unresolvedQuestions: [],
          },
          "file-3": {
            summary: "The root layout defines the application UI shell.",
            subsystemKeys: ["ui_shell"],
            findings: [{
              statement: "The root layout wraps routed content in the application UI shell.",
              kind: "integration",
              capabilityKeys: ["ui_shell"],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 1,
              lineEnd: 1,
            }],
            unresolvedQuestions: [],
          },
        },
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
      transportMode: "json_schema",
      attempts: [{ status: "success" }],
    });
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });

    const results = await analyzeRepositoryFileBatch([
      {
        repository: "workbase/demo",
        commitSha: "e".repeat(40),
        path: "src/app/api/auth/route.test.ts",
        content: "expect(await request()).toMatchObject({ status: 403 });",
        task: {
          objective: "Determine authentication behavior and automated test coverage.",
          capabilityKeys: ["tests_operations", "project_domain:auth"],
          questions: [],
          expectedOutputs: [],
        },
        budget,
      },
      {
        repository: "workbase/demo",
        commitSha: "e".repeat(40),
        path: "src/runtime.ts",
        content: "export const operation = () => true;",
        task: {
          objective: "Determine the implemented AI runtime behavior.",
          capabilityKeys: ["ai_runtime"],
          questions: [],
          expectedOutputs: [],
        },
        budget,
      },
      {
        repository: "workbase/demo",
        commitSha: "e".repeat(40),
        path: "src/app/layout.tsx",
        content: "export default function RootLayout({ children }) { return children; }",
        task: {
          objective: "Determine the implemented review and UI surface.",
          capabilityKeys: ["product_surface"],
          questions: [],
          expectedOutputs: [],
        },
        budget,
      },
    ]);
    const [result, , layoutResult] = results;

    expect(result).toMatchObject({ semanticStatus: "succeeded", semanticSource: "model" });
    expect(result?.facts[0]?.subsystemKeys).toEqual([
      "project_domain:auth",
      "tests_operations",
    ]);
    expect(result?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        missingCapabilityKeys: [],
        structurallyInferredCapabilityKeys: ["tests_operations"],
        strippedUnsupportedCapabilityKeys: [],
      }),
    ]));
    expect(layoutResult).toMatchObject({ semanticStatus: "succeeded", semanticSource: "model" });
    expect(layoutResult?.facts[0]?.subsystemKeys).toEqual(["product_surface"]);
    expect(layoutResult?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        missingCapabilityKeys: [],
        structurallyInferredCapabilityKeys: ["product_surface"],
        strippedUnsupportedCapabilityKeys: ["ui_shell"],
      }),
    ]));
  });

  it("places the complete worker objective, questions, outputs, and capability keys in the extraction prompt", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 777,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => 'project-scoped';",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: ["How is retrieval scoped?"],
        expectedOutputs: ["A supported data-flow finding"],
      },
      budget,
    });

    const request = generateStructuredMock.mock.calls[0]?.[0];
    expect(JSON.parse(request.userPrompt)).toMatchObject({
      researchTask: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: ["How is retrieval scoped?"],
        expectedOutputs: ["A supported data-flow finding"],
      },
      allowedCapabilityKeys: ["retrieval_provenance"],
    });
    expect(request.maxTokens).toBe(777);
    expect(request.budget).toBe(budget.model);
    expect(analysis.facts[0]?.subsystemKeys).toEqual(["retrieval_provenance"]);
    expect(analysis.semanticBudgetUsage).toMatchObject({ modelCalls: 1, totalTokens: 40 });
  });

  it("uses task and static-analysis hints when a singleton large file is windowed", async () => {
    const lines = Array.from({ length: 900 }, (_, index) =>
      index === 719
        ? "export function routeCitationToReviewEvidence() { return citationHref; }"
        : `const filler${index} = "${"x".repeat(24)}";`
    );
    generateStructuredMock.mockImplementationOnce(async (request: { userPrompt: string }) => ({
      data: {
        summary: "The selected window contains the assigned citation-navigation implementation.",
        subsystemKeys: ["review_ui"],
        findings: [],
        unresolvedQuestions: [],
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
      request,
    }));

    await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "components/chat/project-chat-workspace.tsx",
      content: lines.join("\n"),
      task: {
        objective: "Determine how citations navigate to review evidence.",
        capabilityKeys: ["review_ui"],
        semanticSignalKeys: ["review_ui.citation_navigation"],
        questions: ["Where is citation navigation implemented?"],
        expectedOutputs: ["An exact-line citation-navigation observation"],
      },
      staticAnalysis: {
        subsystemKeys: ["review_ui"],
        facts: [{
          path: "components/chat/project-chat-workspace.tsx",
          statement: "The workspace defines citation navigation.",
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 720,
          lineEnd: 720,
          productImportance: 5,
          implementationBreadth: 4,
          technicalDifficulty: 3,
          subsystemKeys: ["review_ui"],
        }],
      },
    });

    const prompt = JSON.parse(generateStructuredMock.mock.calls[0]?.[0].userPrompt);
    expect(prompt.content).toContain("720: export function routeCitationToReviewEvidence");
    expect(prompt.researchTask.semanticSignalKeys).toEqual(["review_ui.citation_navigation"]);
  });

  it("returns an explicit gap without calling the provider when the input-byte budget is exhausted", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 1,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "b".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => true;",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    });

    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("input-byte budget"),
    ]));
    expect(analysis.semanticBudgetUsage).toMatchObject({ inputBytes: 0, modelCalls: 0 });
  });

  it("rejects documentation-only model findings even when the prose sounds implemented", async () => {
    generateStructuredMock.mockImplementationOnce(async () => ({
      data: {
        summary: "The README describes checkout.",
        subsystemKeys: ["product_surface"],
        findings: [{
          statement: "The product supports checkout and refunds.",
          kind: "user_capability",
          capabilityKeys: ["product_surface"],
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 2,
          lineEnd: 2,
        }],
        unresolvedQuestions: [],
      },
      rawOutput: "{}",
      parsedOutput: {},
      tokenUsage: null,
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    }));

    const analysis = await analyzeRepositoryFile({
      repository: "example/catalog",
      commitSha: "a".repeat(40),
      path: "README.md",
      content: "# Catalog\nThe product supports checkout and refunds.",
      task: {
        objective: "Determine the shipped product surface.",
        capabilityKeys: ["product_surface"],
        questions: [],
        expectedOutputs: ["Executable implementation evidence"],
      },
    });

    expect(analysis.semanticStatus).toBe("degraded");
    expect(analysis.facts).toEqual([]);
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("context-only documentation"),
    ]));
  });

  it("retains a provider failure as an explicit partial-coverage gap", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("Bedrock temporarily unavailable"));
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/services/retrieval.ts",
      content: "export const retrieve = () => true;",
      task: {
        objective: "Determine how project retrieval is grounded.",
        capabilityKeys: ["retrieval_provenance"],
        questions: [],
        expectedOutputs: [],
      },
      budget,
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("Bedrock temporarily unavailable"),
    ]));
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
    ]));
  });

  it("recovers safe capability coverage from exact-line deterministic facts after structured extraction fails", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("Bedrock temporarily unavailable"));
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 4_000,
      maxTotalTokens: 16_000,
    });

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "d".repeat(40),
      path: "workflows/project-chat.ts",
      content: [
        '"use step";',
        "await prisma.chatMessage.update({ where: { id } });",
        '"use workflow";',
      ].join("\n"),
      task: {
        objective: "Determine how this operation is durably orchestrated.",
        capabilityKeys: ["automation_workflows"],
        questions: ["Where are retry-safe boundaries defined?"],
        expectedOutputs: ["A supported workflow observation"],
      },
      budget,
    });

    expect(analysis.semanticStatus).toBe("degraded");
    expect(analysis.semanticSource).toBe("deterministic_fallback");
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("partial coverage"),
      expect.stringContaining("Bedrock temporarily unavailable"),
    ]));
    expect(analysis.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceMode: "deterministic_fallback",
        subsystemKeys: ["automation_workflows"],
      }),
    ]));
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
      expect.objectContaining({ status: "deterministic_exact_line_fallback" }),
    ]));
  });

  it("recovers generic transaction and validation semantics after structured extraction fails", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("structured extraction failed"));
    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "e".repeat(40),
      path: "src/orders/order-service.ts",
      content: [
        "export async function createOrder(input) {",
        "  await beginTransaction();",
        "  validatePermission(input.token);",
        "  verifyCredential(input.token);",
        "  await commit();",
        "}",
      ].join("\n"),
      task: {
        objective: "Determine how order creation preserves consistency and authorization.",
        capabilityKeys: ["application_logic", "security_reliability"],
        questions: [],
        expectedOutputs: ["Supported transaction and validation observations"],
      },
    });

    expect(analysis.semanticStatus).toBe("degraded");
    expect(analysis.semanticSource).toBe("deterministic_fallback");
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/explicit transaction boundary/);
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/validates an identity, credential, permission/);
  });

  it("does not recover semantic coverage from a filename and exported symbol alone", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("structured extraction failed"));
    const analysis = await analyzeRepositoryFile({
      repository: "example/orders",
      commitSha: "f".repeat(40),
      path: "src/orders/order-service.ts",
      content: [
        "export async function createOrder() {",
        "  return true;",
        "}",
      ].join("\n"),
      task: {
        objective: "Determine how orders are created.",
        capabilityKeys: ["application_logic"],
        questions: [],
        expectedOutputs: [],
      },
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.semanticSource).toBeUndefined();
    expect(analysis.facts).toEqual([]);
  });
});
