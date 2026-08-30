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
  repositorySemanticFindingGuidance,
  REPOSITORY_SEMANTIC_BATCH_FILE_WINDOW_BYTES,
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

  it("prioritizes executed primary behavior over interface affordances", () => {
    expect(repositorySemanticFindingGuidance).toContain("primary executed action, mutation, or result");
    expect(repositorySemanticFindingGuidance).toContain("before navigation, control visibility, empty-state copy");
    expect(repositorySemanticFindingGuidance).toContain("Prefer domain mutations such as create, update, or delete");
    expect(repositorySemanticFindingGuidance).toContain("generic load, save, back-navigation");
    expect(repositorySemanticFindingGuidance).toContain("visible button or field proves an affordance");
    expect(repositorySemanticFindingGuidance).toContain("cite the action handler or mutation");
  });

  it("retains the exact cited source lines with accepted semantic facts", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        summary: "The handler removes a selected record.",
        subsystemKeys: ["product_surface"],
        findings: [{
          statement: "The handler removes the selected record by identifier.",
          kind: "user_capability",
          capabilityKeys: ["product_surface"],
          signalKeys: [],
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 2,
          lineEnd: 3,
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
    });

    const analysis = await analyzeRepositoryFile({
      repository: "example/inventory",
      commitSha: "e".repeat(40),
      path: "src/ui/remove-record.ts",
      content: [
        "button.onClick(() => {",
        "  const id = selectedRecordId();",
        "  records.remove(id);",
        "});",
      ].join("\n"),
      task: {
        objective: "Identify the implemented record-removal action.",
        capabilityKeys: ["product_surface"],
        questions: [],
        expectedOutputs: ["The executed mutation and its identifier"],
      },
    });

    expect(analysis.facts[0]).toMatchObject({
      lineStart: 2,
      lineEnd: 3,
      evidenceExcerpt: "2:   const id = selectedRecordId();\n3:   records.remove(id);",
    });
  });

  it("forces redacted cited ranges sensitive while leaving ordinary authentication unflagged", async () => {
    const response = (statement: string) => ({
      data: {
        summary: statement,
        subsystemKeys: ["security_boundary"],
        findings: [{
          statement,
          kind: "behavior",
          capabilityKeys: ["security_boundary"],
          signalKeys: [],
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 1,
          lineEnd: 1,
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
    });
    generateStructuredMock
      .mockResolvedValueOnce(response("The configuration contains service credential material."))
      .mockResolvedValueOnce(response("The handler verifies a signed session cookie before continuing."));
    const task = {
      objective: "Identify the implemented security boundary.",
      capabilityKeys: ["security_boundary"],
      questions: [],
      expectedOutputs: ["An exact-line supported finding"],
    };

    const redacted = await analyzeRepositoryFile({
      repository: "example/security",
      commitSha: "f".repeat(40),
      path: "src/runtime/config.ts",
      content: "const serviceToken = '[REDACTED API TOKEN]';",
      task,
    });
    const ordinaryAuthentication = await analyzeRepositoryFile({
      repository: "example/security",
      commitSha: "f".repeat(40),
      path: "src/auth/session.ts",
      content: "export const readSession = (cookie) => verifySignedCookie(cookie);",
      task,
    });

    expect(redacted.facts[0]).toMatchObject({
      sensitivityFlag: true,
      evidenceExcerpt: "1: const serviceToken = '[REDACTED API TOKEN]';",
    });
    expect(ordinaryAuthentication.facts[0]?.sensitivityFlag).toBe(false);
    expect(generateStructuredMock.mock.calls[0]?.[0].systemPrompt).toContain(
      "When uncertain whether cited material is protected",
    );
  });

  it("forces redacted cited ranges sensitive in semantic micro-batches", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: {
          "file-1": {
            summary: "The configuration contains credential material.",
            subsystemKeys: ["security_boundary"],
            findings: [{
              statement: "The configuration contains credential material.",
              kind: "configuration",
              capabilityKeys: ["security_boundary"],
              signalKeys: [],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 1,
              lineEnd: 1,
            }],
            unresolvedQuestions: [],
          },
          "file-2": {
            summary: "The handler verifies a signed session cookie.",
            subsystemKeys: ["security_boundary"],
            findings: [{
              statement: "The handler verifies a signed session cookie.",
              kind: "behavior",
              capabilityKeys: ["security_boundary"],
              signalKeys: [],
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
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    });
    const task = {
      objective: "Identify the implemented security boundary.",
      capabilityKeys: ["security_boundary"],
      questions: [],
      expectedOutputs: ["An exact-line supported finding"],
    };

    const [redacted, ordinaryAuthentication] = await analyzeRepositoryFileBatch([
      {
        repository: "example/security",
        commitSha: "f".repeat(40),
        path: "src/runtime/config.ts",
        content: "const serviceToken = '[REDACTED API TOKEN]';",
        task,
      },
      {
        repository: "example/security",
        commitSha: "f".repeat(40),
        path: "src/auth/session.ts",
        content: "export const readSession = (cookie) => verifySignedCookie(cookie);",
        task,
      },
    ]);

    expect(redacted?.facts[0]?.sensitivityFlag).toBe(true);
    expect(ordinaryAuthentication?.facts[0]?.sensitivityFlag).toBe(false);
  });

  it("rejects planned documentation findings in single-file semantic extraction", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        summary: "The roadmap describes future semantic recommendations.",
        subsystemKeys: ["product_surface"],
        findings: [{
          statement: "The product provides semantic recommendations.",
          kind: "user_capability",
          capabilityKeys: ["product_surface"],
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 4,
          lineEnd: 4,
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
    });

    const analysis = await analyzeRepositoryFile({
      repository: "example/product",
      commitSha: "a".repeat(40),
      path: "README.md",
      content: [
        "# Product",
        "Current ingestion is available.",
        "## Roadmap",
        "Semantic recommendations will add personalized discovery.",
      ].join("\n"),
      task: {
        objective: "Identify implemented product behavior.",
        capabilityKeys: ["product_surface"],
        questions: [],
        expectedOutputs: [],
      },
    });

    expect(analysis.facts).toEqual([]);
    expect(analysis.unresolvedQuestions.join(" ")).toContain("Rejected planned documentation finding at 4-4");
  });

  it("rejects planned documentation findings in semantic micro-batches", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        files: {
          "file-1": {
            summary: "The roadmap describes future semantic recommendations.",
            subsystemKeys: ["product_surface"],
            findings: [{
              statement: "The product provides semantic recommendations.",
              kind: "user_capability",
              capabilityKeys: ["product_surface"],
              confidence: "high",
              sensitivityFlag: false,
              lineStart: 4,
              lineEnd: 4,
            }],
            unresolvedQuestions: [],
          },
          "file-2": {
            summary: "The implementation exposes a current product surface.",
            subsystemKeys: ["product_surface"],
            findings: [{
              statement: "The current implementation renders the product surface.",
              kind: "user_capability",
              capabilityKeys: ["product_surface"],
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
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      transportMode: "bedrock_json_schema",
      attempts: [{ status: "success" }],
    });

    const task = {
      objective: "Identify implemented product behavior.",
      capabilityKeys: ["product_surface"],
      questions: [],
      expectedOutputs: [],
    };
    const [analysis] = await analyzeRepositoryFileBatch([
      {
        repository: "example/product",
        commitSha: "b".repeat(40),
        path: "README.md",
        content: [
          "# Product",
          "Current ingestion is available.",
          "## Roadmap",
          "Semantic recommendations will add personalized discovery.",
        ].join("\n"),
        task,
      },
      {
        repository: "example/product",
        commitSha: "b".repeat(40),
        path: "src/app/page.tsx",
        content: "export default function Page() { return <main>Current product</main>; }",
        task,
      },
    ]);

    expect(analysis?.facts).toEqual([]);
    expect(analysis?.unresolvedQuestions.join(" ")).toContain("Rejected planned documentation finding at 4-4");
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
    expect(analyses.every((analysis) =>
      analysis.facts[0]?.evidenceExcerpt === "1: export const operation = () => true;"
    )).toBe(true);
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
    expect(request.systemPrompt).toContain("query-parameter plumbing");
    expect(request.systemPrompt).toContain("primary executed action, mutation, or result");
    expect(request.systemPrompt).toContain("visible button or field proves an affordance");
    expect(request.systemPrompt).toContain("concrete secret, credential, token, or key material");
    expect(request.systemPrompt).toContain("not sensitive merely because they are security-related");
    expect(request.transportPreference).toEqual(["json_schema"]);
    expect(request.enablePromptCaching).toBe(false);
  });

  it("bounds a four-file model batch and leaves per-file usage to shared-wave accounting", async () => {
    const budget = createRepositorySemanticBudget({
      maxInputBytes: 64 * 1024,
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 3_000,
      maxTotalTokens: 54_000,
    });
    budget.usageScope = "shared_wave";
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    generateStructuredMock.mockImplementationOnce(async (request: { userPrompt: string }) => {
      const prompt = JSON.parse(request.userPrompt) as {
        files: Array<{ fileKey: string; lineRange: [number, number] }>;
      };
      return {
        data: {
          files: Object.fromEntries(prompt.files.map((file) => [
            file.fileKey,
            {
              summary: "The selected window implements a bounded operation.",
              subsystemKeys: ["project_domain:operations"],
              findings: [{
                statement: "The selected window exports an implemented operation.",
                kind: "behavior",
                capabilityKeys: ["project_domain:operations"],
                confidence: "high",
                sensitivityFlag: false,
                lineStart: file.lineRange[0],
                lineEnd: file.lineRange[0],
              }],
              unresolvedQuestions: [],
            },
          ])),
        },
        rawOutput: "{}",
        parsedOutput: {},
        tokenUsage: { inputTokens: 4_500, outputTokens: 900, totalTokens: 6_400 },
        provider: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-6",
        transportMode: "bedrock_json_schema",
        attempts: [{ status: "success" }],
      };
    });
    const content = Array.from({ length: 240 }, (_, index) =>
      `export const operation${index} = () => "${"source".repeat(8)}";`
    ).join("\n");

    const analyses = await analyzeRepositoryFileBatch(paths.map((path) => ({
      repository: "example/general-project",
      commitSha: "f".repeat(40),
      path,
      content,
      task: {
        objective: "Determine the implemented operation.",
        capabilityKeys: ["project_domain:operations"],
        questions: [],
        expectedOutputs: ["An exact-line supported finding"],
      },
      budget,
    })));

    const request = generateStructuredMock.mock.calls[0]?.[0];
    const prompt = JSON.parse(request.userPrompt) as { files: Array<{ content: string }> };
    const sourceBytes = prompt.files.map((file) => Buffer.byteLength(file.content, "utf8"));
    expect(sourceBytes.every((bytes) => bytes <= REPOSITORY_SEMANTIC_BATCH_FILE_WINDOW_BYTES)).toBe(true);
    expect(sourceBytes.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(
      4 * REPOSITORY_SEMANTIC_BATCH_FILE_WINDOW_BYTES,
    );
    expect(request.maxTokens).toBe(3_000);
    expect(analyses.every((analysis) => analysis.semanticSource === "model")).toBe(true);
    expect(analyses.every((analysis) => analysis.semanticBudgetUsage === undefined)).toBe(true);
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

  it("keeps usable partial capability coverage successful and reports missing keys separately", async () => {
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

    expect(analyses[0]).toMatchObject({
      semanticStatus: "succeeded",
      semanticSource: "model",
      facts: [expect.objectContaining({ subsystemKeys: ["ai_runtime"] })],
    });
    expect(analyses[0]?.unresolvedQuestions.join(" ")).not.toContain("retrieval_provenance");
    expect(analyses[0]?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "partial_capability_coverage",
        rejectedFindings: 0,
        missingCapabilityKeys: ["retrieval_provenance"],
      }),
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
          capabilityKeys: ["review_ui"],
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
    expect(layoutResult?.facts[0]?.subsystemKeys).toEqual(["review_ui"]);
    expect(layoutResult?.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        missingCapabilityKeys: [],
        structurallyInferredCapabilityKeys: ["review_ui"],
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
    expect(request.systemPrompt).toContain("query-parameter plumbing");
    expect(request.systemPrompt).toContain("concrete secret, credential, token, or key material");
    expect(request.systemPrompt).toContain("not sensitive merely because they are security-related");
    expect(request.transportPreference).toEqual(["json_schema"]);
    expect(request.enablePromptCaching).toBe(false);
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

  it("does not replace a model extraction failure with deterministic static facts", async () => {
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
        objective: "Determine how project chat is durably orchestrated.",
        capabilityKeys: ["workflow_orchestration"],
        questions: ["Where are retry-safe boundaries defined?"],
        expectedOutputs: ["A supported workflow observation"],
      },
      budget,
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.semanticSource).toBeUndefined();
    expect(analysis.unresolvedQuestions).toEqual(expect.arrayContaining([
      expect.stringContaining("Bedrock temporarily unavailable"),
    ]));
    expect(analysis.facts).toEqual([]);
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
    ]));
  });

  it("keeps rich static lifecycle evidence out of the model failure path", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("structured extraction failed"));
    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "e".repeat(40),
      path: "src/services/knowledge-review-service.ts",
      content: [
        "await repositoryKnowledgeRefreshApplicationService.start({",
        '  trigger: "backfill",',
        "  idempotencyKey: `knowledge-edit:${successor.id}`",
        "});",
        'if (input.decision === "keep") await keep(change);',
        'if (input.decision === "edit_and_keep") await edit(change);',
        'if (input.decision === "revert") await revert(change);',
        "await retireEntity(change);",
        'if (action === "retired") return "restore_retired";',
        'if (action === "updated") return "restore_in_place";',
        'return "retire_applied_revision";',
        'if (mode === "restore_in_place") {',
        "  const validationHeads = before.validationHeads;",
        "  await tx.projectFactEvidence.deleteMany({ where: { projectFactId } });",
        "  await tx.projectFactEvidence.createMany({ data: evidence });",
        "}",
        "await invalidateHighlightDependents({ highlightId });",
      ].join("\n"),
      task: {
        objective: "Determine how reviewed knowledge can be edited, restored, and revalidated.",
        capabilityKeys: ["knowledge_review_lifecycle"],
        questions: [],
        expectedOutputs: ["Supported review lifecycle observations"],
      },
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.semanticSource).toBeUndefined();
    expect(analysis.facts).toEqual([]);
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
    ]));
  });

  it("does not mark lifecycle coverage complete from generic Prisma and symbol observations alone", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("structured extraction failed"));
    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "f".repeat(40),
      path: "src/services/knowledge-review-service.ts",
      content: [
        "export async function resolveKnowledgeChange() {",
        "  return prisma.knowledgeChange.findMany();",
        "}",
        "export const knowledgeReviewService = { resolve: resolveKnowledgeChange };",
      ].join("\n"),
      task: {
        objective: "Determine the complete knowledge review lifecycle.",
        capabilityKeys: ["knowledge_review_lifecycle"],
        questions: [],
        expectedOutputs: [],
      },
    });

    expect(analysis.semanticStatus).toBe("failed");
    expect(analysis.semanticSource).toBeUndefined();
    expect(analysis.facts).toEqual([]);
  });
});
