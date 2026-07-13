import { describe, expect, it } from "vitest";
import {
  buildFileSemanticTask,
  capabilityCandidatesFromAnalysis,
  enforceMandatoryCoverage,
  immutableSemanticCacheWhere,
  preserveSettledCapabilityReports,
  reusableSemanticAnalysis,
  type CapabilityReport,
  type SemanticWorkPackage,
} from "@/src/services/repository-semantic-orchestrator-service";

describe("repository semantic orchestration guardrails", () => {
  const paths: Record<string, string> = {
    product_surface: "README.md",
    domain_data: "prisma/schema.prisma",
    ai_runtime: "src/lib/bedrock-converse-agent.ts",
    ingestion_integrations: "src/services/github-client.ts",
    retrieval_provenance: "src/services/project-knowledge-retrieval-service.ts",
    workflow_orchestration: "workflows/project-chat.ts",
    repository_knowledge_lifecycle: "src/services/knowledge-refresh-service.ts",
    project_chat_grounding: "src/services/project-chat-agent-service.ts",
    artifact_generation: "src/services/artifact-workflow-service.ts",
    knowledge_review_lifecycle: "src/services/knowledge-review-service.ts",
    review_ui: "components/chat/project-chat-workspace.tsx",
    tests_operations: "src/services/__tests__/project-chat-agent-service.test.ts",
  };

  function manifest() {
    return Object.entries(paths).map(([key, path]) => ({
      key,
      label: key,
      files: [
        { id: `${key}-specific`, path, score: 10 },
        { id: `${key}-generic`, path: "src/services/miscellaneous-service.ts", score: 1_000 },
      ],
    }));
  }

  it("covers every mandatory capability with a target-specific representative file", () => {
    const packages = enforceMandatoryCoverage({
      packages: Array.from({ length: 4 }, (_, index) => ({
        objective: `Planner package ${index}`,
        capabilityKeys: ["project_chat_grounding"],
        fileSnapshotIds: ["generic-project-chat-file"],
        questions: ["What does this package implement?"],
        expectedOutputs: ["Supported facts"],
      })),
      manifest: manifest(),
    });

    const selectedIds = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));
    expect(packages).toHaveLength(4);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 3)).toBe(true);
    expect(packages.flatMap((entry) => entry.capabilityKeys).every((key) => key in paths)).toBe(true);
    for (const key of Object.keys(paths)) expect(selectedIds.has(`${key}-specific`)).toBe(true);
  });

  it("rebalances mandatory capabilities when the model clusters every key into one package", () => {
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "A badly concentrated model plan.",
        capabilityKeys: Object.keys(paths),
        fileSnapshotIds: ["generic-project-chat-file"],
        questions: ["What does the repository implement?"],
        expectedOutputs: ["Supported facts"],
      }],
      manifest: manifest(),
    });

    expect(packages).toHaveLength(4);
    expect(packages.every((entry) => entry.fileSnapshotIds.length === 3)).toBe(true);
    expect(new Set(packages.flatMap((entry) => entry.fileSnapshotIds))).toEqual(
      new Set(Object.keys(paths).map((key) => `${key}-specific`)),
    );
    for (const entry of packages) {
      for (const key of entry.capabilityKeys.filter((value) => value in paths)) {
        expect(entry.fileSnapshotIds).toContain(`${key}-specific`);
      }
    }
  });

  it("preserves completed worker reports when another worker fails", () => {
    const budget: SemanticWorkPackage["budget"] = {
      maxWorkers: 4,
      maxModelCalls: 8,
      maxInputBytes: 64 * 1024,
      maxOutputTokens: 8_000,
      maxTotalTokens: 32_000,
      maxRepairPasses: 1,
    };
    const packages: SemanticWorkPackage[] = [
      { id: "complete", objective: "Inspect the AI runtime implementation.", capabilityKeys: ["ai_runtime"], fileSnapshotIds: ["file-1"], questions: [], expectedOutputs: [], budget },
      { id: "failed", objective: "Inspect the workflow implementation.", capabilityKeys: ["workflow_orchestration"], fileSnapshotIds: ["file-2"], questions: [], expectedOutputs: [], budget },
    ];
    const complete: CapabilityReport = {
      packageId: "complete",
      inspectedFileSnapshotIds: ["file-1"],
      candidates: [],
      contradictions: [],
      gaps: [],
      tokenUsage: [],
      usage: { inputBytes: 100, modelCalls: 1, repairPasses: 0, inputTokens: 20, outputTokens: 10, totalTokens: 30, unknownUsageCalls: 0 },
      partial: false,
    };

    const reports = preserveSettledCapabilityReports(packages, [
      { status: "fulfilled", value: complete },
      { status: "rejected", reason: new Error("provider unavailable") },
    ]);

    expect(reports[0]).toBe(complete);
    expect(reports[1]).toMatchObject({
      packageId: "failed",
      inspectedFileSnapshotIds: [],
      partial: true,
      gaps: [expect.stringContaining("provider unavailable")],
    });
  });

  it("reuses immutable-blob semantic analysis only when it supports the assigned capability", () => {
    const cached = {
      path: "src/old-path.ts",
      summary: "Implements durable chat orchestration.",
      subsystemKeys: ["workflow_orchestration"],
      responsibilities: ["Defines retry-safe workflow steps."],
      symbols: ["projectChatWorkflow"],
      dependencies: [],
      architectureSignals: ["retry-safe workflow step"],
      userFacingCapabilities: [],
      facts: [{
        statement: "The workflow defines retry-safe steps.",
        category: "architecture" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        lineStart: 4,
        lineEnd: 4,
        productImportance: 4,
        implementationBreadth: 5,
        technicalDifficulty: 4,
        subsystemKeys: ["workflow_orchestration"],
        evidenceMode: "semantic" as const,
        path: "src/old-path.ts",
      }],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
      analysisMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSource: "model" as const,
    };

    expect(reusableSemanticAnalysis({
      value: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    })).toMatchObject({
      path: "workflows/project-chat.ts",
      subsystemKeys: ["workflow_orchestration"],
      facts: [expect.objectContaining({ path: "workflows/project-chat.ts" })],
    });
    expect(reusableSemanticAnalysis({
      value: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: ["domain_data"],
    })).toBeNull();
    expect(reusableSemanticAnalysis({
      value: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration", "project_chat_grounding"],
    })).toBeNull();
    expect(reusableSemanticAnalysis({
      value: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: [],
    })).toBeNull();
    expect(reusableSemanticAnalysis({
      value: { ...cached, semanticStatus: "degraded" },
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    })).toBeNull();

    const reusedSubset = reusableSemanticAnalysis({
      value: {
        ...cached,
        subsystemKeys: ["workflow_orchestration", "domain_data"],
        facts: [
          ...cached.facts,
          {
            ...cached.facts[0],
            statement: "Persists an unrelated domain record.",
            subsystemKeys: ["domain_data"],
          },
        ],
      },
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    });
    expect(reusedSubset?.subsystemKeys).toEqual(["workflow_orchestration"]);
    expect(reusedSubset?.facts.map((fact) => fact.statement)).toEqual([
      "The workflow defines retry-safe steps.",
    ]);
  });

  it("scopes a highlight embedding file to retrieval instead of unrelated package capabilities", () => {
    const task = buildFileSemanticTask({
      workPackageCapabilityKeys: ["ingestion_integrations", "retrieval_provenance"],
      staticSubsystemKeys: ["retrieval_provenance"],
    });

    expect(task).toMatchObject({
      capabilityKeys: ["retrieval_provenance"],
      questions: [expect.stringContaining("retrieval_provenance")],
    });
    expect(JSON.stringify(task)).not.toContain("ingestion_integrations");

    const candidates = capabilityCandidatesFromAnalysis({
      fileSnapshotId: "highlight-embedding-file",
      relevantCapabilityKeys: task!.capabilityKeys,
      analysis: {
        facts: [{
          statement: "Embeds approved highlights for semantic retrieval.",
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 10,
          lineEnd: 20,
          productImportance: 4,
          implementationBreadth: 3,
          technicalDifficulty: 3,
          subsystemKeys: ["retrieval_provenance", "ingestion_integrations"],
          path: "src/services/highlight-embedding-service.ts",
        }],
      },
    });

    expect(candidates.map((candidate) => candidate.key)).toEqual(["retrieval_provenance"]);
  });

  it("emits a deliberate candidate for every relevant capability supported by a multi-key fact", () => {
    const candidates = capabilityCandidatesFromAnalysis({
      fileSnapshotId: "multi-purpose-file",
      relevantCapabilityKeys: ["repository_knowledge_lifecycle", "retrieval_provenance"],
      analysis: {
        facts: [{
          statement: "Reconciles repository facts into searchable project memory.",
          category: "data_flow",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 40,
          lineEnd: 55,
          productImportance: 4,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          subsystemKeys: ["repository_knowledge_lifecycle", "retrieval_provenance"],
          path: "src/services/repository-knowledge-synthesis-service.ts",
        }],
      },
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.key)).toEqual([
      "repository_knowledge_lifecycle",
      "retrieval_provenance",
    ]);
    expect(candidates.every((candidate) => candidate.kind === "data_flow")).toBe(true);
  });

  it("scopes semantic cache reuse to an immutable blob at the same attached source and path", () => {
    expect(immutableSemanticCacheWhere({
      fileSnapshotId: "current-file",
      sourceId: "attached-source",
      path: "workflows/project-chat.ts",
      blobSha: "a".repeat(40),
    })).toMatchObject({
      id: { not: "current-file" },
      path: "workflows/project-chat.ts",
      blobSha: "a".repeat(40),
      disposition: "analyzed",
      semanticStatus: "succeeded",
      semanticAnalyzerVersion: "repository-coverage-v13",
      snapshot: { sourceId: "attached-source" },
    });
  });
});
