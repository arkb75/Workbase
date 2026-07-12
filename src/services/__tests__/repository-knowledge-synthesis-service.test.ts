import { describe, expect, it } from "vitest";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  derivedRepositoryKnowledgeLifecycleFact,
  fallbackSubsystemSynthesis,
} from "@/src/services/repository-knowledge-synthesis-service";

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
});
