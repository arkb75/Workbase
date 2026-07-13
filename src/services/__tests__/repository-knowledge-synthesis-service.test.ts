import { describe, expect, it } from "vitest";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  derivedRepositoryKnowledgeLifecycleFact,
  fallbackSubsystemSynthesis,
  semanticFactsForSubsystem,
} from "@/src/services/repository-knowledge-synthesis-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

function entry(path: string, statement = `${path} defines supported repository behavior.`): SynthesisNotebookEntry {
  return {
    sourceId: "source-1",
    repository: "workbase/demo",
    commitSha: "a".repeat(40),
    blobSha: `blob:${path}`,
    path,
    lineStart: 1,
    lineEnd: 1,
    statement,
    category: "architecture",
    confidence: "high",
    sensitivityFlag: false,
    productImportance: 4,
    implementationBreadth: 4,
    technicalDifficulty: 4,
    changeType: "modified",
  };
}

describe("repository synthesis limit fallback", () => {
  it("does not leak a finding from a multi-purpose file into another capability", () => {
    const base = {
      path: "src/services/multi-purpose.ts",
      summary: "Multi-purpose service",
      subsystemKeys: ["ai_runtime", "domain_data"],
      responsibilities: [], symbols: [], dependencies: [], architectureSignals: [], userFacingCapabilities: [], unresolvedQuestions: [], chunksAnalyzed: 1, tokenUsage: [], analysisMode: "semantic" as const,
      facts: [
        { statement: "Uses Bedrock Converse tool results.", category: "behavior" as const, confidence: "high" as const, sensitivityFlag: false, lineStart: 1, lineEnd: 2, productImportance: 4, implementationBreadth: 3, technicalDifficulty: 4, path: "src/services/multi-purpose.ts", subsystemKeys: ["ai_runtime"] },
        { statement: "Persists a normalized project record.", category: "data_flow" as const, confidence: "high" as const, sensitivityFlag: false, lineStart: 4, lineEnd: 5, productImportance: 3, implementationBreadth: 2, technicalDifficulty: 3, path: "src/services/multi-purpose.ts", subsystemKeys: ["domain_data"] },
      ],
    } satisfies RepositoryFileAnalysis;

    expect(semanticFactsForSubsystem(base, "ai_runtime").map((fact) => fact.statement)).toEqual(["Uses Bedrock Converse tool results."]);
    expect(semanticFactsForSubsystem(base, "domain_data").map((fact) => fact.statement)).toEqual(["Persists a normalized project record."]);
  });

  it("creates a cross-file AI runtime fact instead of a filename-only observation", () => {
    const result = fallbackSubsystemSynthesis("ai_runtime", [
      entry("src/lib/bedrock-converse-agent.ts"),
      entry("src/lib/bedrock-structured-llm-client.ts"),
      entry("src/services/project-chat-agent-service.ts"),
      entry("app/api/agent-runs/[id]/stream/route.ts"),
    ]);

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining("Bedrock Converse agent"),
      confidence: "high",
      citationIndexes: [1, 2, 3, 4],
    })]);
    expect(result.highlights).toEqual([]);
  });

  it("grounds retrieval/provenance synthesis in several distinct services", () => {
    const result = fallbackSubsystemSynthesis("retrieval_provenance", [
      entry("src/services/project-knowledge-retrieval-service.ts"),
      entry("src/services/highlight-embedding-service.ts"),
      entry("src/services/chat-citation-service.ts"),
      entry("src/services/prior-turn-provenance-service.ts"),
      entry("src/services/project-answer-grounding-service.ts"),
    ]);

    expect(result.facts[0]?.citationIndexes).toHaveLength(5);
    expect(result.facts[0]?.statement).toContain("citation, provenance");
  });

  it("retains the cross-file repository knowledge lifecycle as a ranked fact", () => {
    const result = derivedRepositoryKnowledgeLifecycleFact([
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol startKnowledgeRefresh."),
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol analyzeKnowledgeRefreshBatch."),
      entry("src/services/repository-knowledge-synthesis-service.ts", "src/services/repository-knowledge-synthesis-service.ts defines the symbol synthesizeRepositoryKnowledge."),
      entry("src/services/knowledge-reconciliation-service.ts", "src/services/knowledge-reconciliation-service.ts defines the symbol reconcileRepositoryKnowledge."),
      entry("src/services/knowledge-staleness-service.ts", "src/services/knowledge-staleness-service.ts defines the symbol reconcileStaleKnowledge."),
    ]);

    expect(result).toMatchObject({
      category: "architecture",
      confidence: "high",
      productImportance: 5,
      implementationBreadth: 5,
      distinctiveness: 5,
      citationIndexes: [1, 2, 3, 4, 5],
    });
    expect(result?.statement).toContain("end-to-end knowledge lifecycle");
  });

  it.each([
    [
      "project_chat_grounding",
      [
        "src/services/project-chat-agent-service.ts",
        "src/services/project-knowledge-retrieval-service.ts",
        "src/services/project-answer-grounding-service.ts",
        "src/services/chat-citation-service.ts",
      ],
      "real multi-turn history",
    ],
    [
      "artifact_generation",
      [
        "src/services/artifact-workflow-service.ts",
        "src/services/artifact-generation-service.ts",
        "src/services/artifact-persistence-service.ts",
      ],
      "freeform briefs",
    ],
    [
      "knowledge_review_lifecycle",
      [
        "src/services/knowledge-change-service.ts",
        "src/services/knowledge-review-service.ts",
        "src/services/knowledge-staleness-service.ts",
      ],
      "auto-applied when safe",
    ],
  ])("creates a broad deterministic baseline for %s", (subsystemKey, paths, expected) => {
    const result = fallbackSubsystemSynthesis(subsystemKey, paths.map((path) => entry(path)));

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining(expected),
      confidence: "high",
    })]);
    expect(result.facts[0]?.citationIndexes.length).toBeGreaterThanOrEqual(3);
  });
});
