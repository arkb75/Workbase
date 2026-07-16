import { describe, expect, it } from "vitest";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  derivedRepositoryKnowledgeLifecycleFact,
  exactSinglePathProjectDomainSynthesis,
  fallbackSubsystemSynthesis,
  semanticFactsForSubsystem,
  selectedProjectDomainKeysFromOrchestration,
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
  it("retains a selected one-file project domain as an exact fact without inventing an umbrella claim", () => {
    const statement = "The charge service idempotently records a payment before publishing its receipt.";
    const result = exactSinglePathProjectDomainSynthesis("project_domain:payments", [
      entry("src/payments/charge-service.ts", statement),
    ]);

    expect(result?.facts).toEqual([expect.objectContaining({
      statement,
      citationIndexes: [1],
      reviewNotes: expect.stringContaining("verbatim"),
    })]);
    expect(result?.highlights).toEqual([]);
    expect(exactSinglePathProjectDomainSynthesis("ai_runtime", [entry("src/payments/charge-service.ts", statement)])).toBeNull();
  });

  it("admits only project domains persisted by the bounded orchestration plan", () => {
    expect(selectedProjectDomainKeysFromOrchestration({
      packages: [
        { capabilityKeys: ["ai_runtime", "project_domain:payments"] },
        { capabilityKeys: ["project_domain:search", "project_domain:payments"] },
        { capabilityKeys: "project_domain:ignored" },
      ],
    })).toEqual(["project_domain:payments", "project_domain:search"]);
    expect(selectedProjectDomainKeysFromOrchestration(null)).toEqual([]);
  });

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

  it("creates a capability-level AI runtime fact from clause-level semantic observations", () => {
    const result = fallbackSubsystemSynthesis("ai_runtime", [
      entry("src/lib/bedrock-converse-agent.ts", "BedrockConverseTransport wraps ConverseCommand and returns normalized stopReason and usage metadata."),
      entry("src/lib/bedrock-converse-agent.ts", "The runtime enforces maxIterations, maxToolCalls, and maxTotalTokens."),
      entry("src/lib/bedrock-converse-agent.ts", "Sensitive value redaction removes credentials before events are exposed."),
    ]);

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining("wraps Bedrock Converse"),
      confidence: "high",
      citationIndexes: [1, 2, 3],
    })]);
    expect(result.highlights).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("wraps Bedrock Converse"),
        visibility: "private",
        confidence: "high",
        citationIndexes: [1, 2, 3],
      }),
    ]);
  });

  it("grounds retrieval/provenance synthesis in distinct supported behaviors", () => {
    const result = fallbackSubsystemSynthesis("retrieval_provenance", [
      entry("src/services/project-knowledge-retrieval-service.ts", "Per-kind candidates merge vector and lexical top-k IDs."),
      entry("src/services/project-knowledge-retrieval-service.ts", "Broad and public artifact requests trigger re-grounding through direct provenance."),
      entry("src/services/project-knowledge-retrieval-service.ts", "Repository excerpts are retained as nested provenance subordinate to reviewed memory."),
    ]);

    expect(result.facts[0]?.citationIndexes).toHaveLength(3);
    expect(result.facts[0]?.statement).toContain("vector and lexical top-k");
    expect(result.highlights[0]?.text).not.toContain("...");
    expect(result.highlights[0]?.summary).toContain("nested beneath reviewed memory");
  });

  it("synthesizes durable GitHub import and bounded exploration as one integration accomplishment", () => {
    const result = fallbackSubsystemSynthesis("ingestion_integrations", [
      entry("src/services/github-repo-import-service.ts", "The GitHub repo import fetches README content, commits, pull requests, issues, releases, and repository activity within configured limits."),
      entry("src/services/github-repo-import-service.ts", "The GitHub repo import persists a project-scoped Source and normalized Evidence items."),
      entry("src/services/github-repository-exploration-service.ts", "Repository exploration enforces tree lookups, searches, file reads, byte budgets, and a timeout."),
      entry("src/services/github-repository-exploration-service.ts", "Repository exploration returns budget_exhausted, file_too_large, and binary_file failures."),
    ]);

    expect(result.facts[0]).toMatchObject({
      statement: expect.stringContaining("GitHub ingestion fetches bounded repository metadata"),
      productImportance: 5,
      implementationBreadth: 5,
      citationIndexes: [1, 2, 3],
    });
    expect(result.facts[1]?.statement).toContain("Repository exploration enforces");
    expect(result.highlights[0]).toMatchObject({
      text: "Built project-scoped GitHub evidence ingestion with bounded repository import and code exploration",
      summary: expect.stringContaining("project-scoped Sources and Evidence"),
    });
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
        entry("src/services/project-chat-agent-service.ts", "selectHistory retains the latest 12 messages within a bounded history budget."),
        entry("src/services/project-agent-harness.ts", "highAuthorityMemory admits verified_highlight and verified_project_fact sources."),
        entry("src/services/project-chat-agent-service.ts", "The latest-commit refresh target SHAs ground current answers."),
        entry("src/services/project-chat-agent-service.ts", "A retry request without supporting evidence fails closed, preventing hallucinated behavior."),
      ],
      "bounded multi-turn history",
    ],
    [
      "artifact_generation",
      [
        entry("src/services/artifact-workflow-service.ts", "artifactBriefRequiresMeasuredImpact detects metric-bearing briefs."),
        entry("src/services/artifact-workflow-service.ts", "hasMeasuredImpactEvidence requires authority-backed numeric evidence."),
        entry("src/services/artifact-workflow-service.ts", "After bounded research the workflow requests the actual metric and enforces a hard stop instead of producing unsupported output."),
      ],
      "fails closed",
    ],
    [
      "knowledge_review_lifecycle",
      [
        entry("src/services/knowledge-review-service.ts", "An edit creates a new immutable EvidenceItem and marks the prior item superseded."),
        entry("src/services/knowledge-review-service.ts", "The edit invalidates downstream dependents and regenerates its embedding."),
        entry("src/services/knowledge-review-service.ts", "knowledgeRevertMode selects restore_retired, restore_in_place, or retire_applied_revision."),
      ],
      "immutable successors",
    ],
    [
      "review_ui",
      [
        entry("app/work-items/[id]/page.tsx", "The page imports actions covering the complete knowledge-review lifecycle."),
        entry("app/work-items/[id]/page.tsx", "The Project Facts panel groups facts by status with nested provenance."),
        entry("app/work-items/[id]/page.tsx", "ArtifactHistoryEntry builds artifact provenance trees."),
        entry("components/chat/project-chat-workspace.tsx", "The candidate contract renders candidate review cards."),
        entry("components/chat/project-chat-workspace.tsx", "citationHref maps citations to a work-item tab URL for review evidence."),
      ],
      "review UI",
    ],
  ])("creates a broad deterministic baseline for %s", (subsystemKey, notebook, expected) => {
    const result = fallbackSubsystemSynthesis(subsystemKey, notebook);

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining(expected),
      confidence: "high",
    })]);
    expect(result.facts[0]?.citationIndexes.length).toBeGreaterThanOrEqual(3);
  });

  it("does not turn one matching filename into a broad multi-component capability", () => {
    const result = fallbackSubsystemSynthesis("ai_runtime", [
      entry("src/lib/bedrock-converse-agent.ts"),
    ]);

    expect(result.facts[0]?.statement).toBe("src/lib/bedrock-converse-agent.ts defines supported repository behavior.");
    expect(result.facts[0]?.statement).not.toContain("structured generation");
    expect(result.highlights).toEqual([]);
    expect(result.unresolvedQuestions[0]).toContain("clause-level evidence");
  });
});
