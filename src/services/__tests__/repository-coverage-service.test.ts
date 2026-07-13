import { describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "mock",
}));

import {
  analyzeRepositoryFile,
  analyzeRepositoryFiles,
  buildCoverageMatrix,
  REPOSITORY_FILE_CHUNK_BYTES,
  selectSemanticWindows,
} from "@/src/services/repository-coverage-service";

describe("complete repository coverage", () => {
  it("analyzes every chunk of a long file and preserves exact late-file line ranges", async () => {
    const line = "export const implementationSignal = true; // repository behavior\n";
    const content = line.repeat(Math.ceil((REPOSITORY_FILE_CHUNK_BYTES * 3.2) / Buffer.byteLength(line)));

    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: "src/services/large-architecture-service.ts",
      content,
    });

    expect(analysis.chunksAnalyzed).toBeGreaterThanOrEqual(4);
    expect(analysis.facts).toHaveLength(analysis.chunksAnalyzed);
    expect(Math.max(...analysis.facts.map((fact) => fact.lineEnd))).toBe(content.split("\n").length);
    expect(analysis.facts.some((fact) => fact.lineStart > 160)).toBe(true);
  });

  it("marks coverage verified only from analyzed content observations", async () => {
    const analysis = await analyzeRepositoryFile({
      repository: "workbase/demo",
      commitSha: "b".repeat(40),
      path: "src/services/project-knowledge-retrieval-service.ts",
      content: "export const retrieve = () => 'grounded';",
    });
    const matrix = buildCoverageMatrix([{ path: analysis.path, analysis }]);

    expect(matrix.find((target) => target.key === "retrieval_provenance")).toMatchObject({
      status: "semantic_verified",
      paths: ["src/services/project-knowledge-retrieval-service.ts"],
    });
    expect(matrix.find((target) => target.key === "review_ui")?.status).toBe("not_applicable");
  });

  it("does not misclassify ordinary RegExp.test calls as automated tests", async () => {
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "workbase/demo",
      commitSha: "c".repeat(40),
      path: "src/services/intent-router.ts",
      content: "export function route(question: string) { return freshnessPattern.test(question); }",
    }]);

    expect(analysis.architectureSignals).not.toContain("automated test coverage");
    expect(analysis.facts.some((fact) => fact.statement.includes("automated tests"))).toBe(false);
  });

  it("preserves project-specific architecture areas instead of collapsing every service into one module", async () => {
    const analyses = await analyzeRepositoryFiles([
      {
        repository: "workbase/demo",
        commitSha: "d".repeat(40),
        path: "src/services/knowledge-refresh-service.ts",
        content: "export async function startKnowledgeRefresh() { return true; }",
      },
      {
        repository: "workbase/demo",
        commitSha: "d".repeat(40),
        path: "src/services/project-chat-agent-service.ts",
        content: "export async function runProjectChatAgent() { return true; }",
      },
    ]);

    expect(analyses[0]?.subsystemKeys).toContain("repository_knowledge_lifecycle");
    expect(analyses[1]?.subsystemKeys).toContain("project_chat_grounding");
  });

  it("selects one bounded semantic notebook per large file", () => {
    const content = Array.from({ length: 2_000 }, (_, index) =>
      index % 75 === 0 ? `export async function capability${index}() { return ${index}; }` : `const local${index} = ${index};`,
    ).join("\n");
    const windows = selectSemanticWindows(content);

    expect(windows).toHaveLength(1);
    expect(Buffer.byteLength(windows[0]!.content, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(windows[0]!.content).toMatch(/^\d+:/m);
  });

  it("gives semantic credit only to capability keys supported by semantic findings", () => {
    const matrix = buildCoverageMatrix([{
      path: "src/services/multi-purpose.ts",
      analysis: {
        path: "src/services/multi-purpose.ts",
        summary: "A multipurpose service.",
        subsystemKeys: ["ai_runtime", "domain_data"],
        responsibilities: [],
        symbols: [],
        dependencies: [],
        architectureSignals: [],
        userFacingCapabilities: [],
        facts: [
          {
            statement: "Invokes a schema-constrained model.",
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 10,
            lineEnd: 12,
            productImportance: 4,
            implementationBreadth: 3,
            technicalDifficulty: 4,
            subsystemKeys: ["ai_runtime"],
            evidenceMode: "semantic",
            path: "src/services/multi-purpose.ts",
          },
          {
            statement: "Imports a persisted record type.",
            category: "data_flow",
            confidence: "high",
            sensitivityFlag: false,
            lineStart: 1,
            lineEnd: 1,
            productImportance: 2,
            implementationBreadth: 1,
            technicalDifficulty: 1,
            subsystemKeys: ["domain_data"],
            evidenceMode: "static",
            path: "src/services/multi-purpose.ts",
          },
        ],
        unresolvedQuestions: [],
        chunksAnalyzed: 1,
        tokenUsage: [],
        analysisMode: "semantic",
        semanticStatus: "succeeded",
        semanticDiagnostics: [],
      },
    }]);

    expect(matrix.find((target) => target.key === "ai_runtime")).toMatchObject({
      status: "semantic_verified",
      semanticPathCount: 1,
    });
    expect(matrix.find((target) => target.key === "domain_data")).toMatchObject({
      status: "static_mapped",
      semanticPathCount: 0,
    });
  });
});
