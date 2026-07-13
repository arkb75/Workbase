import { beforeEach, describe, expect, it, vi } from "vitest";

const generateStructuredMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/llm-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/llm-config")>();
  return { ...actual, resolveWorkbaseLlmProvider: () => "bedrock" };
});

vi.mock("@/src/services/bedrock-runtime", () => ({
  getBedrockStructuredLlmClient: () => ({ generateStructured: generateStructuredMock }),
}));

import {
  analyzeRepositoryFile,
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
        objective: "Determine how project chat is durably orchestrated.",
        capabilityKeys: ["workflow_orchestration"],
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
        subsystemKeys: ["workflow_orchestration"],
      }),
    ]));
    expect(analysis.semanticDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "provider_error" }),
      expect.objectContaining({ status: "deterministic_exact_line_fallback" }),
    ]));
  });

  it("recovers review lifecycle semantics from decisions, restoration, invalidation, and revalidation patterns", async () => {
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

    expect(analysis.semanticStatus).toBe("degraded");
    expect(analysis.semanticSource).toBe("deterministic_fallback");
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/dispatches keep, edit-and-keep, revert, and retire/);
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/repository revalidation pass/);
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/restores validation state and exact Project Fact evidence relations/);
    expect(analysis.facts.map((fact) => fact.statement).join(" ")).toMatch(/invalidates downstream dependents/);
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
