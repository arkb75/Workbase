import { describe, expect, it } from "vitest";
import {
  BedrockStructuredLlmClient,
  type ConverseTextRuntime,
} from "@/src/lib/bedrock-structured-llm-client";
import {
  aggregateSemanticModelBudgetUsage,
  boundedSemanticRepairPackagesForModelCalls,
  buildRepositorySemanticPlannerRequest,
  buildFileSemanticTask,
  capabilityCandidatesFromAnalysis,
  compactRepositorySemanticPlannerInput,
  createRepositorySemanticPlannerBudget,
  effectiveCapabilityReportsAfterRepair,
  enforceMandatoryCoverage,
  immutableSemanticCacheWhere,
  missingAssignedFileCandidateGaps,
  missingCapabilityCandidateGaps,
  packSemanticBundleIndexes,
  partitionCapabilityReports,
  preserveSettledCapabilityReports,
  reusableCurrentSnapshotSemanticAnalysis,
  reusableSemanticAnalysis,
  semanticCoverageAssignmentGaps,
  semanticFileReportSignals,
  semanticOrchestrationUsage,
  semanticPlannerTokenCommitment,
  semanticRepairTokenPool,
  semanticRepairWaveDecision,
  semanticSignalKeysForFile,
  semanticWorkPackageGenerationLimits,
  semanticWorkPackageModelCallCount,
  unresolvedSemanticExecutionGaps,
  type CapabilityManifestArea,
  type CapabilityReport,
  type SemanticWorkPackage,
} from "@/src/services/repository-semantic-orchestrator-service";
import { REPOSITORY_SEMANTIC_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

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
        ...(key === "workflow_orchestration"
          ? [
              { id: "workflow-start-facet", path: "src/services/agent-run-workflow-start-service.ts", score: 9 },
              { id: "chat-store-facet", path: "src/services/project-chat-store.ts", score: 8 },
            ]
          : key === "project_chat_grounding"
          ? [{ id: "project-chat-harness-facet", path: "src/services/project-agent-harness.ts", score: 9 }]
          : key === "repository_knowledge_lifecycle"
            ? [{ id: "semantic-orchestrator-facet", path: "src/services/repository-semantic-orchestrator-service.ts", score: 9 }]
            : key === "knowledge_review_lifecycle"
              ? [{ id: "knowledge-staleness-facet", path: "src/services/knowledge-staleness-service.ts", score: 9 }]
              : key === "review_ui"
                ? [{ id: "project-workspace-facet", path: "app/work-items/[id]/page.tsx", score: 9 }]
                : []),
        { id: `${key}-generic`, path: "src/services/miscellaneous-service.ts", score: 1_000 },
      ],
    }));
  }

  it("commits metered planner usage and contains known or unknown fallback spend", () => {
    expect(semanticPlannerTokenCommitment({
      totalTokens: 7_500,
      unknownUsageCalls: 0,
      fallbackUsed: false,
      maxTotalTokens: 80_000,
    })).toBe(7_500);
    expect(semanticPlannerTokenCommitment({
      totalTokens: 12_000,
      unknownUsageCalls: 1,
      fallbackUsed: true,
      maxTotalTokens: 80_000,
    })).toBe(12_000);
    expect(semanticPlannerTokenCommitment({
      totalTokens: 90_000,
      unknownUsageCalls: 0,
      fallbackUsed: true,
      maxTotalTokens: 80_000,
    })).toBe(80_000);
  });

  it("carries unused initial-wave capacity into the model repair pool", () => {
    expect(semanticRepairTokenPool({
      maxTotalTokens: 80_000,
      plannerTokenCommitment: 2_901,
      initialWorkerTokens: 30_000,
    })).toBe(47_099);
    expect(semanticRepairTokenPool({
      maxTotalTokens: 80_000,
      plannerTokenCommitment: 10_000,
      initialWorkerTokens: 54_000,
    })).toBe(16_000);
    expect(semanticRepairTokenPool({
      maxTotalTokens: 80_000,
      plannerTokenCommitment: 2_310,
      initialWorkerTokens: 38_483 + 15_729,
    })).toBe(23_478);
    expect(semanticRepairTokenPool({
      maxTotalTokens: 80_000,
      plannerTokenCommitment: 10_000,
      initialWorkerTokens: 80_000,
    })).toBe(0);
  });

  it("aggregates bounded repair waves before admitting another wave", () => {
    const repairUsage = aggregateSemanticModelBudgetUsage([
      {
        modelCalls: 4,
        repairPasses: 0,
        inputTokens: 8_737,
        outputTokens: 2_262,
        totalTokens: 15_729,
        unknownUsageCalls: 0,
      },
      {
        modelCalls: 2,
        repairPasses: 1,
        inputTokens: 4_000,
        outputTokens: 1_500,
        totalTokens: 5_500,
        unknownUsageCalls: 1,
      },
    ]);
    expect(repairUsage).toEqual({
      modelCalls: 6,
      repairPasses: 1,
      inputTokens: 12_737,
      outputTokens: 3_762,
      totalTokens: 21_229,
      unknownUsageCalls: 1,
    });
    const remaining = semanticRepairTokenPool({
      maxTotalTokens: 80_000,
      plannerTokenCommitment: 2_310,
      initialWorkerTokens: 38_483 + repairUsage.totalTokens,
    });
    expect(remaining).toBe(17_978);
    expect(2_310 + 38_483 + repairUsage.totalTokens + remaining).toBe(80_000);
  });

  it("admits at most three repair waves, stops early, and deducts prior usage", () => {
    const usage = (totalTokens: number) => ({
      modelCalls: 1,
      repairPasses: 0,
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      unknownUsageCalls: 0,
    });
    const decision = (
      waveIndex: number,
      hasRepairPackages: boolean,
      priorRepairUsages: ReturnType<typeof usage>[],
    ) => semanticRepairWaveDecision({
      waveIndex,
      hasRepairPackages,
      maxTotalTokens: 80_000,
      maxModelCalls: 8,
      plannerTokenCommitment: 5_000,
      initialWorkerTokens: 30_000,
      priorRepairUsages,
    });

    expect(decision(0, true, [])).toEqual({
      shouldRun: true,
      tokenPool: 45_000,
      modelCallPool: 8,
    });
    expect(decision(1, true, [usage(10_000)]))
      .toEqual({ shouldRun: true, tokenPool: 35_000, modelCallPool: 7 });
    expect(decision(2, true, [usage(10_000), usage(15_000)]))
      .toEqual({ shouldRun: true, tokenPool: 20_000, modelCallPool: 6 });
    expect(decision(3, true, [])).toEqual({
      shouldRun: false,
      tokenPool: 45_000,
      modelCallPool: 8,
    });
    expect(decision(1, false, [usage(10_000)]))
      .toEqual({ shouldRun: false, tokenPool: 35_000, modelCallPool: 7 });
    expect(decision(1, true, [usage(45_000)]))
      .toEqual({ shouldRun: false, tokenPool: 0, modelCallPool: 7 });
  });

  it("admits all native repair-wave primaries without inline schema fallbacks", () => {
    const repairPackage = (
      id: string,
      fileSnapshotIds: string[],
      singletonFileSnapshotIds: string[] = [],
    ): Omit<SemanticWorkPackage, "id" | "budget"> => ({
      objective: id,
      capabilityKeys: [id],
      fileSnapshotIds,
      singletonFileSnapshotIds,
      questions: [],
      expectedOutputs: [],
    });
    const singletonIds = Array.from({ length: 8 }, (_, index) => `retry-${index}`);
    const [boundedSingletons] = boundedSemanticRepairPackagesForModelCalls([
      repairPackage("singleton", singletonIds, singletonIds),
    ], 8);
    expect(boundedSingletons?.fileSnapshotIds).toEqual(singletonIds);
    expect(semanticWorkPackageGenerationLimits(boundedSingletons!)).toMatchObject({
      primaryModelCalls: 8,
      maxModelCalls: 8,
      maxRepairPasses: 0,
    });

    const ordinary = boundedSemanticRepairPackagesForModelCalls([
      repairPackage("first", ["a", "b", "c", "d"]),
      repairPackage("second", ["e", "f", "g", "h"]),
      repairPackage("third", ["i", "j", "k", "l"]),
    ], 4);
    expect(ordinary.map((entry) => entry.objective)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(ordinary.reduce((total, entry) =>
      total + semanticWorkPackageGenerationLimits(entry).primaryModelCalls, 0
    )).toBe(3);
  });

  it("counts shared semantic waves once in orchestration usage", () => {
    const usage = (modelCalls: number, totalTokens: number) => ({
      modelCalls,
      repairPasses: 0,
      inputTokens: Math.floor(totalTokens * 0.75),
      outputTokens: totalTokens - Math.floor(totalTokens * 0.75),
      totalTokens,
      unknownUsageCalls: 0,
    });

    expect(semanticOrchestrationUsage({
      inputBytes: 48_000,
      planner: { inputBytes: 0, ...usage(1, 2_901) },
      initialWorkers: usage(5, 30_000),
      repairWorkers: usage(2, 12_000),
    })).toMatchObject({
      inputBytes: 48_000,
      modelCalls: 8,
      totalTokens: 44_901,
    });
  });

  it("dispatches a realistic large manifest through the compact planner prompt", async () => {
    const omittedAnalysisMarker = "FULL_SEMANTIC_ANALYSIS_MUST_NOT_REACH_ROUTING";
    const largeManifest = Array.from({ length: 30 }, (_, areaIndex) => ({
      key: `project_domain:capability-${String(areaIndex).padStart(2, "0")}`,
      label: `Capability ${areaIndex}`,
      scopeKey: `example/repository-${Math.floor(areaIndex / 10)}`,
      description: `${omittedAnalysisMarker}:${areaIndex}`,
      salience: 500 - areaIndex,
      files: Array.from({ length: 60 }, (_, fileIndex) => ({
        id: `cmtd5planner${String(areaIndex).padStart(2, "0")}${String(fileIndex).padStart(3, "0")}`,
        path: `src/features/capability-${areaIndex}/workflow/deeply-nested-implementation-${fileIndex}.ts`,
        score: 100 - fileIndex,
        analysis: {
          facts: Array.from({ length: 20 }, () => omittedAnalysisMarker),
        },
      })),
    })) as unknown as CapabilityManifestArea[];
    const budget = createRepositorySemanticPlannerBudget();
    const request = buildRepositorySemanticPlannerRequest({
      projectTitle: "A realistic multi-surface application",
      manifest: largeManifest,
      budget,
    });
    const prompt = compactRepositorySemanticPlannerInput({
      projectTitle: "A realistic multi-surface application",
      manifest: largeManifest,
    });

    expect(prompt.capabilities).toHaveLength(30);
    expect(prompt.capabilities.every((capability) =>
      capability.representativeFiles.length === 1
    )).toBe(true);
    expect(request.userPrompt).not.toContain(omittedAnalysisMarker);
    expect(request.userPrompt).not.toContain("analysis");

    const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const responsePackage = {
      objective: "Route the complete capability inventory for semantic inspection.",
      capabilityKeys: largeManifest.map((area) => area.key),
      fileSnapshotIds: [largeManifest[0]!.files[0]!.id],
      questions: ["What behavior does each routed capability implement?"],
      expectedOutputs: ["Evidence-backed capability findings."],
    };
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        calls.push(input);
        return {
          text: "",
          structuredData: { packages: [responsePackage] },
          tokenUsage: { inputTokens: 3_200, outputTokens: 700, totalTokens: 3_900 },
          requestId: "planner-large-manifest-1",
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "routing-model",
    });

    await expect(client.generateStructured(request)).resolves.toMatchObject({
      data: { packages: [responsePackage] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(2_500);
    expect(budget.usage).toMatchObject({
      modelCalls: 1,
      totalTokens: 3_900,
    });
  });

  it("finds a feasible bounded packing when greedy placement can strand capacity", () => {
    const sizes = [7, 7, 4, 4, 3, 3, 2];
    const assignments = packSemanticBundleIndexes({
      bundles: sizes.map((size, index) => ({
        size,
        capabilityKeys: [`capability-${index}`],
        orderKey: String(index).padStart(2, "0"),
      })),
      plannerClaims: [[], [], [], []],
      maxWorkers: 4,
      maxFilesPerWorker: 8,
      microBatchSize: 4,
    });

    expect(assignments).not.toBeNull();
    const assignedIndexes = assignments!.flat();
    expect(new Set(assignedIndexes)).toEqual(new Set(sizes.map((_size, index) => index)));
    const loads = assignments!.map((bundleIndexes) =>
      bundleIndexes.reduce((total, bundleIndex) => total + sizes[bundleIndex]!, 0)
    );
    expect(loads.every((load) => load <= 8)).toBe(true);
    expect(loads.reduce((total, load) => total + Math.ceil(load / 4), 0)).toBe(8);
  });

  it("minimizes provider calls among feasible bundle assignments", () => {
    const sizes = [5, 5, 3, 3];
    const assignments = packSemanticBundleIndexes({
      bundles: sizes.map((size, index) => ({
        size,
        capabilityKeys: [`capability-${index}`],
        orderKey: String(index).padStart(2, "0"),
      })),
      plannerClaims: [[], [], [], []],
      maxWorkers: 4,
      maxFilesPerWorker: 8,
      microBatchSize: 4,
    });

    expect(assignments).not.toBeNull();
    const loads = assignments!.map((bundleIndexes) =>
      bundleIndexes.reduce((total, bundleIndex) => total + sizes[bundleIndex]!, 0)
    );
    expect(loads.reduce((total, load) => total + (load ? Math.ceil(load / 4) : 0), 0)).toBe(4);
  });

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
    expect(packages).toHaveLength(5);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 8)).toBe(true);
    expect(selectedIds.size).toBe(18);
    expect(packages.reduce(
      (calls, entry) => calls + Math.ceil(entry.fileSnapshotIds.length / 4),
      0,
    )).toBeLessThanOrEqual(5);
    for (const [primaryId, supplementId] of [
      ["project_chat_grounding-specific", "project-chat-harness-facet"],
      ["repository_knowledge_lifecycle-specific", "semantic-orchestrator-facet"],
      ["knowledge_review_lifecycle-specific", "knowledge-staleness-facet"],
      ["review_ui-specific", "project-workspace-facet"],
      ["workflow_orchestration-specific", "workflow-start-facet"],
      ["workflow_orchestration-specific", "chat-store-facet"],
    ]) {
      expect(packages.some((entry) =>
        entry.fileSnapshotIds.includes(primaryId) &&
        entry.fileSnapshotIds.includes(supplementId)
      )).toBe(true);
    }
    expect(packages.flatMap((entry) => entry.capabilityKeys).every((key) => key in paths)).toBe(true);
    for (const key of Object.keys(paths)) expect(selectedIds.has(`${key}-specific`)).toBe(true);
    for (const supplementalId of [
      "project-chat-harness-facet",
      "semantic-orchestrator-facet",
      "knowledge-staleness-facet",
      "project-workspace-facet",
      "workflow-start-facet",
      "chat-store-facet",
    ]) expect(selectedIds.has(supplementalId)).toBe(true);
  });

  it("treats selected non-Workbase project domains as mandatory manifest obligations", () => {
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect the repository's product domains.",
        capabilityKeys: ["project_domain:payments", "project_domain:search"],
        fileSnapshotIds: [],
        questions: ["What do these domains implement?"],
        expectedOutputs: ["Supported exact-line facts"],
      }],
      manifest: [
        {
          key: "project_domain:payments",
          label: "payments project domain",
          files: [{ id: "payments-file", path: "src/payments/charge-service.ts", score: 12 }],
        },
        {
          key: "project_domain:search",
          label: "search project domain",
          files: [{ id: "search-file", path: "src/search/index-service.ts", score: 10 }],
        },
      ],
    });

    expect(new Set(packages.flatMap((entry) => entry.fileSnapshotIds))).toEqual(
      new Set(["payments-file", "search-file"]),
    );
    expect(new Set(packages.flatMap((entry) => entry.capabilityKeys))).toEqual(
      new Set(["project_domain:payments", "project_domain:search"]),
    );
  });

  it("keeps each repository-scoped review workspace supplement with its primary", () => {
    const scopedManifest = ["owner/repo-a", "owner/repo-b"].map((scopeKey, index) => ({
      key: "review_ui",
      label: "Review and UI",
      scopeKey,
      files: [
        {
          id: `repo-${index + 1}-chat`,
          path: "components/chat/project-chat-workspace.tsx",
          score: 10,
        },
        {
          id: `repo-${index + 1}-workspace`,
          path: "app/work-items/[id]/page.tsx",
          score: 9,
        },
      ],
    }));
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect repository-scoped review workspaces.",
        capabilityKeys: ["review_ui"],
        fileSnapshotIds: [],
        questions: ["What review workspace behavior is implemented?"],
        expectedOutputs: ["Supported review UI facts"],
      }],
      manifest: scopedManifest,
    });

    for (const index of [1, 2]) {
      expect(packages.some((entry) =>
        entry.fileSnapshotIds.includes(`repo-${index}-chat`) &&
        entry.fileSnapshotIds.includes(`repo-${index}-workspace`)
      )).toBe(true);
    }
    expect(semanticCoverageAssignmentGaps({
      manifest: scopedManifest,
      packages,
      expectedScopeKeys: ["owner/repo-a", "owner/repo-b"],
    })).toEqual([]);
  });

  it("reserves decisive cross-file facets for every full attached repository", () => {
    const scopedManifest = ["owner/repo-a", "owner/repo-b"].flatMap((scopeKey, repositoryIndex) =>
      manifest().map((area) => ({
        ...area,
        scopeKey,
        files: area.files.map((file) => ({
          ...file,
          id: `repo-${repositoryIndex + 1}:${file.id}`,
        })),
      }))
    );
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect complete capability coverage in both attached repositories.",
        capabilityKeys: Object.keys(paths),
        fileSnapshotIds: [],
        questions: ["What decisive cross-file behavior does each repository implement?"],
        expectedOutputs: ["Supported repository-scoped capability facts"],
      }],
      manifest: scopedManifest,
    });

    const selectedIds = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));
    expect(selectedIds.size).toBe(32);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 8)).toBe(true);
    expect(packages.reduce(
      (calls, entry) => calls + Math.ceil(entry.fileSnapshotIds.length / 4),
      0,
    )).toBe(8);
    for (const repositoryIndex of [1, 2]) {
      for (const supplementalId of [
        "project-chat-harness-facet",
        "semantic-orchestrator-facet",
        "knowledge-staleness-facet",
        "project-workspace-facet",
      ]) {
        expect(selectedIds.has(`repo-${repositoryIndex}:${supplementalId}`)).toBe(true);
      }
    }
    expect(semanticCoverageAssignmentGaps({
      manifest: scopedManifest,
      packages,
      expectedScopeKeys: ["owner/repo-a", "owner/repo-b"],
    })).toEqual([]);
  });

  it("co-locates a review workspace supplement even when it is another capability's primary", () => {
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect the product surface and its review workspace.",
        capabilityKeys: ["product_surface", "review_ui"],
        fileSnapshotIds: [],
        questions: ["How does the complete workspace support project review?"],
        expectedOutputs: ["Supported review UI facts"],
      }],
      manifest: [
        {
          key: "product_surface",
          label: "Product surface",
          files: [{
            id: "project-workspace",
            path: "app/work-items/[id]/page.tsx",
            score: 20,
          }],
        },
        {
          key: "review_ui",
          label: "Review and UI",
          files: [
            {
              id: "chat-workspace",
              path: "components/chat/project-chat-workspace.tsx",
              score: 20,
            },
            {
              id: "project-workspace",
              path: "app/work-items/[id]/page.tsx",
              score: 19,
            },
          ],
        },
      ],
    });

    expect(packages.some((entry) =>
      entry.capabilityKeys.includes("review_ui") &&
      entry.fileSnapshotIds.includes("chat-workspace") &&
      entry.fileSnapshotIds.includes("project-workspace")
    )).toBe(true);
    expect(semanticCoverageAssignmentGaps({
      manifest: [
        {
          key: "product_surface",
          label: "Product surface",
          files: [{ id: "project-workspace", path: "app/work-items/[id]/page.tsx", score: 20 }],
        },
        {
          key: "review_ui",
          label: "Review and UI",
          files: [{ id: "chat-workspace", path: "components/chat/project-chat-workspace.tsx", score: 20 }],
        },
      ],
      packages,
    })).toEqual([]);
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

    expect(packages).toHaveLength(5);
    expect(packages.every((entry) => entry.fileSnapshotIds.length >= 3 && entry.fileSnapshotIds.length <= 4)).toBe(true);
    expect(packages.map((entry) => entry.fileSnapshotIds.length).sort()).toEqual([3, 3, 4, 4, 4]);
    expect(new Set(packages.flatMap((entry) => entry.fileSnapshotIds))).toEqual(
      new Set([
        ...Object.keys(paths).map((key) => `${key}-specific`),
        "project-chat-harness-facet",
        "semantic-orchestrator-facet",
        "knowledge-staleness-facet",
        "project-workspace-facet",
        "workflow-start-facet",
        "chat-store-facet",
      ]),
    );
    for (const key of Object.keys(paths)) {
      expect(packages.some((entry) =>
        entry.capabilityKeys.includes(key) && entry.fileSnapshotIds.includes(`${key}-specific`)
      )).toBe(true);
    }
  });

  it("routes retrieval, application tests, and the full workspace to decisive files", () => {
    const routedManifest = manifest().map((area) => {
      if (area.key === "retrieval_provenance") {
        return {
          ...area,
          files: [
            ...area.files,
            { id: "chat-citation-high-score", path: "src/services/chat-citation-service.ts", score: 9_000 },
          ],
        };
      }
      if (area.key === "tests_operations") {
        return {
          ...area,
          files: [
            ...area.files,
            { id: "application-scenarios", path: "src/evals/__tests__/project-chat-application-runner.test.ts", score: 1 },
          ],
        };
      }
      return area;
    });

    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect broad repository accomplishments.",
        capabilityKeys: Object.keys(paths),
        fileSnapshotIds: [],
        questions: ["What does the project implement?"],
        expectedOutputs: ["Supported facts"],
      }],
      manifest: routedManifest,
    });
    const selectedIds = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));

    expect(selectedIds.has("retrieval_provenance-specific")).toBe(true);
    expect(selectedIds.has("chat-citation-high-score")).toBe(false);
    expect(selectedIds.has("application-scenarios")).toBe(true);
    expect(selectedIds.has("tests_operations-specific")).toBe(false);
    expect(selectedIds.has("review_ui-specific")).toBe(true);
    expect(selectedIds.has("project-workspace-facet")).toBe(true);
    expect(selectedIds.size).toBeLessThanOrEqual(18);
    expect(packages.reduce((calls, entry) => calls + Math.ceil(entry.fileSnapshotIds.length / 4), 0)).toBeLessThanOrEqual(5);
  });

  it("adds repository import beside exploration when the bounded plan has capacity", () => {
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect repository ingestion and exploration.",
        capabilityKeys: ["ingestion_integrations"],
        fileSnapshotIds: [],
        questions: ["What becomes durable project evidence?"],
        expectedOutputs: ["Supported ingestion facts"],
      }],
      manifest: [{
        key: "ingestion_integrations",
        label: "GitHub ingestion",
        files: [
          { id: "exploration", path: "src/services/github-repository-exploration-service.ts", score: 20 },
          { id: "import", path: "src/services/github-repo-import-service.ts", score: 10 },
        ],
      }],
    });

    expect(new Set(packages.flatMap((entry) => entry.fileSnapshotIds))).toEqual(
      new Set(["exploration", "import"]),
    );
    expect(packages.reduce((calls, entry) => calls + Math.ceil(entry.fileSnapshotIds.length / 4), 0)).toBe(1);
  });

  it("reports repository-scoped obligations that exceed package capacity", () => {
    const gaps = semanticCoverageAssignmentGaps({
      manifest: [
        { key: "project_chat_grounding", label: "Chat", scopeKey: "owner/repo-a", files: [{ id: "a", path: "a.ts", score: 1 }] },
        { key: "project_chat_grounding", label: "Chat", scopeKey: "owner/repo-b", files: [{ id: "b", path: "b.ts", score: 1 }] },
      ],
      packages: [{ capabilityKeys: ["project_chat_grounding"], fileSnapshotIds: ["a"] }],
    });

    expect(gaps).toEqual([
      "Semantic coverage capacity omitted project_chat_grounding for owner/repo-b.",
    ]);
  });

  it("reports an attached repository with no classifiable mandatory capability", () => {
    const gaps = semanticCoverageAssignmentGaps({
      manifest: [
        { key: "ai_runtime", label: "AI runtime", scopeKey: "owner/repo-a", files: [{ id: "a", path: "agent.ts", score: 1 }] },
      ],
      packages: [{ capabilityKeys: ["ai_runtime"], fileSnapshotIds: ["a"] }],
      expectedScopeKeys: ["owner/repo-a", "owner/repo-b"],
    });

    expect(gaps).toEqual([
      "No mandatory semantic capability could be classified for attached repository owner/repo-b; coverage cannot be verified.",
    ]);
  });

  it("keeps capacity omissions explicit across three capability-rich repositories", () => {
    const repositories = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];
    const scopedManifest = repositories.flatMap((scopeKey) => Object.entries(paths).map(([key, path]) => ({
      key,
      label: key,
      scopeKey,
      files: [{ id: `${scopeKey}:${key}`, path, score: 10 }],
    })));
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect every mandatory capability across attached repositories.",
        capabilityKeys: Object.keys(paths),
        fileSnapshotIds: [],
        questions: ["What does each repository implement?"],
        expectedOutputs: ["Repository-scoped supported facts"],
      }],
      manifest: scopedManifest,
    });
    const gaps = semanticCoverageAssignmentGaps({
      manifest: scopedManifest,
      packages,
      expectedScopeKeys: repositories,
    });

    expect(packages).toHaveLength(4);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 8)).toBe(true);
    expect(new Set(packages.flatMap((entry) => entry.fileSnapshotIds)).size).toBe(32);
    expect(gaps).toHaveLength(4);
    expect(gaps.every((gap) => gap.startsWith("Semantic coverage capacity omitted"))).toBe(true);
  });

  it("selects a mandatory capability representative from every attached repository", () => {
    const packages = enforceMandatoryCoverage({
      packages: [{
        objective: "Inspect the AI runtime across attached repositories.",
        capabilityKeys: ["ai_runtime"],
        fileSnapshotIds: [],
        questions: ["How is the runtime implemented?"],
        expectedOutputs: ["Supported facts"],
      }],
      manifest: [
        {
          key: "ai_runtime",
          label: "AI runtime",
          scopeKey: "snapshot-repository-a",
          files: [{ id: "repo-a-bedrock", path: "src/lib/bedrock-converse-agent.ts", score: 10 }],
        },
        {
          key: "ai_runtime",
          label: "AI runtime",
          scopeKey: "snapshot-repository-b",
          files: [{ id: "repo-b-runtime", path: "src/lib/llm-runtime.ts", score: 10 }],
        },
      ],
    });

    const selectedIds = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));
    expect(selectedIds).toEqual(new Set(["repo-a-bedrock", "repo-b-runtime"]));
    for (const fileId of selectedIds) {
      expect(packages.some((entry) =>
        entry.fileSnapshotIds.includes(fileId) && entry.capabilityKeys.includes("ai_runtime")
      )).toBe(true);
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
      retryFileSnapshotIds: ["file-2"],
      partial: true,
      gaps: [expect.stringContaining("provider unavailable")],
    });
  });

  it("uses the latest exact-file repair for final evidence and execution gaps", () => {
    const usage = {
      inputBytes: 100,
      modelCalls: 1,
      repairPasses: 0,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      unknownUsageCalls: 0,
    };
    const report = (
      packageId: string,
      statement: string,
      retryFileSnapshotIds: string[],
      gaps: string[],
      partial: boolean,
    ): CapabilityReport => ({
      packageId,
      inspectedFileSnapshotIds: ["file-1"],
      retryFileSnapshotIds,
      candidates: statement ? [{
        key: "project_domain:orders",
        statement,
        kind: "behavior",
        evidence: [{ fileSnapshotId: "file-1", lineStart: 1, lineEnd: 2 }],
        confidence: "high",
        supportedQualifiers: [],
        unresolved: [],
      }] : [],
      contradictions: [],
      gaps,
      tokenUsage: [],
      usage,
      partial,
    });
    const initial = report(
      "initial",
      "The partial batch produced an obsolete observation.",
      ["file-1"],
      ["src/orders/menu.ts: Semantic analysis degraded."],
      true,
    );
    const repaired = report(
      "repair",
      "The isolated retry establishes the implemented order workflow.",
      [],
      [],
      false,
    );
    const filePathBySnapshotId = new Map([["file-1", "src/orders/menu.ts"]]);

    const effective = effectiveCapabilityReportsAfterRepair({
      initialReports: [initial],
      repairReports: [repaired],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId,
    });
    expect(effective.flatMap((entry) => entry.candidates.map((candidate) => candidate.statement))).toEqual([
      "The isolated retry establishes the implemented order workflow.",
    ]);
    expect(unresolvedSemanticExecutionGaps({
      initialReports: [initial],
      repairReports: [repaired],
      retriedFileSnapshotIds: ["file-1"],
    })).toEqual([]);

    const firstWaveFailed = report(
      "repair-1",
      "",
      ["file-1"],
      ["src/orders/menu.ts: Semantic analysis degraded."],
      true,
    );
    const afterFirstWave = effectiveCapabilityReportsAfterRepair({
      initialReports: [initial],
      repairReports: [firstWaveFailed],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId,
    });
    const afterSecondWave = effectiveCapabilityReportsAfterRepair({
      initialReports: afterFirstWave,
      repairReports: [repaired],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId,
    });
    expect(afterSecondWave.flatMap((entry) => entry.gaps)).toEqual([]);
    expect(afterSecondWave.flatMap((entry) => entry.candidates.map((candidate) => candidate.statement))).toEqual([
      "The isolated retry establishes the implemented order workflow.",
    ]);
    expect(unresolvedSemanticExecutionGaps({
      initialReports: afterSecondWave,
      repairReports: [],
      retriedFileSnapshotIds: [],
      filePathBySnapshotId,
    })).toEqual([]);

    const partiallyRetried = effectiveCapabilityReportsAfterRepair({
      initialReports: [{
        ...initial,
        inspectedFileSnapshotIds: ["file-1", "file-2"],
        retryFileSnapshotIds: ["file-1", "file-2"],
        gaps: [
          "src/orders/menu.ts: Semantic analysis degraded.",
          "src/orders/service.ts: Semantic analysis failed.",
        ],
      }],
      repairReports: [repaired],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId: new Map([
        ["file-1", "src/orders/menu.ts"],
        ["file-2", "src/orders/service.ts"],
      ]),
    });
    expect(partiallyRetried[0]).toMatchObject({
      retryFileSnapshotIds: ["file-2"],
      gaps: ["src/orders/service.ts: Semantic analysis failed."],
    });

    const reportLevelFailureRemains = effectiveCapabilityReportsAfterRepair({
      initialReports: [{
        ...initial,
        retryFileSnapshotIds: ["file-1"],
        gaps: [
          "src/orders/menu.ts: Semantic analysis degraded.",
          "Semantic worker audit persistence failed after extraction.",
        ],
      }],
      repairReports: [repaired],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId: new Map([["file-1", "src/orders/menu.ts"]]),
    });
    expect(reportLevelFailureRemains.flatMap((entry) => entry.gaps)).toEqual([
      "Semantic worker audit persistence failed after extraction.",
    ]);

    const failedRepair = report(
      "failed-repair",
      "",
      ["file-1"],
      ["src/orders/menu.ts: Semantic analysis failed."],
      true,
    );
    expect(unresolvedSemanticExecutionGaps({
      initialReports: [initial],
      repairReports: [failedRepair],
      retriedFileSnapshotIds: ["file-1"],
      filePathBySnapshotId: new Map([["file-1", "src/orders/menu.ts"]]),
    })).toEqual(expect.arrayContaining([
      "src/orders/menu.ts: Semantic analysis degraded.",
      "src/orders/menu.ts: Semantic analysis failed.",
      "src/orders/menu.ts: Semantic model retry did not establish complete assigned capability coverage.",
    ]));

    const requiredIds = Array.from({ length: 7 }, (_, index) => `file-${index + 1}`);
    const selectedIds = requiredIds.slice(0, 6);
    expect(unresolvedSemanticExecutionGaps({
      initialReports: [{
        ...initial,
        inspectedFileSnapshotIds: requiredIds,
        retryFileSnapshotIds: requiredIds,
        candidates: [],
        gaps: [],
      }],
      repairReports: [{
        ...repaired,
        inspectedFileSnapshotIds: selectedIds,
        candidates: [],
      }],
      retriedFileSnapshotIds: selectedIds,
      filePathBySnapshotId: new Map(requiredIds.map((id) => [id, `src/orders/${id}.ts`])),
    })).toEqual([
      "src/orders/file-7.ts: Semantic model retry did not establish complete assigned capability coverage.",
    ]);
  });

  it("budgets isolated retries separately from remaining micro-batched files", () => {
    expect(semanticWorkPackageModelCallCount({
      fileSnapshotIds: ["retry", "ordinary-a", "ordinary-b"],
      singletonFileSnapshotIds: ["retry"],
    })).toBe(2);
    expect(semanticWorkPackageModelCallCount({
      fileSnapshotIds: ["ordinary-a", "ordinary-b", "ordinary-c", "ordinary-d"],
    })).toBe(1);
    expect(semanticWorkPackageGenerationLimits({
      fileSnapshotIds: ["retry-a", "retry-b", "retry-c"],
      singletonFileSnapshotIds: ["retry-a", "retry-b", "retry-c"],
    })).toEqual({
      primaryModelCalls: 3,
      maxModelCalls: 3,
      maxRepairPasses: 0,
    });
  });

  it("keeps eight ordinary repair files within two four-file primary calls", () => {
    const packages = [
      { fileSnapshotIds: ["a", "b", "c", "d"] },
      { fileSnapshotIds: ["e", "f", "g", "h"] },
    ];
    const limits = packages.map(semanticWorkPackageGenerationLimits);

    expect(limits).toEqual([
      { primaryModelCalls: 1, maxModelCalls: 1, maxRepairPasses: 0 },
      { primaryModelCalls: 1, maxModelCalls: 1, maxRepairPasses: 0 },
    ]);
    expect(limits.reduce((total, entry) => total + entry.primaryModelCalls, 0)).toBe(2);
    expect(limits.reduce((total, entry) => total + entry.maxModelCalls, 0)).toBe(2);
  });

  it("keeps model follow-up questions diagnostic when semantic extraction succeeded", () => {
    const signals = semanticFileReportSignals({
      path: "src/services/__tests__/repository-semantic-budget-service.test.ts",
      semanticStatus: "succeeded",
      unresolvedQuestions: [
        "What condition distinguishes a degraded fallback from a failed outcome in omitted lines?",
      ],
    });

    expect(signals.gaps).toEqual([]);
    expect(signals.diagnosticNotes).toEqual([
      expect.stringContaining("failed outcome"),
    ]);
  });

  it("keeps execution failures and missing required capabilities as deterministic gaps", () => {
    expect(semanticFileReportSignals({
      path: "src/services/provider.ts",
      semanticStatus: "failed",
      unresolvedQuestions: ["The provider request timed out."],
    })).toMatchObject({
      gaps: ["src/services/provider.ts: Semantic analysis failed."],
      diagnosticNotes: [expect.stringContaining("timed out")],
    });

    expect(missingCapabilityCandidateGaps({
      capabilityKeys: ["ai_runtime", "domain_data", "ai_runtime"],
      candidates: [{ key: "ai_runtime" }],
    })).toEqual([
      "No supported semantic finding was produced for required capability domain_data.",
    ]);

    expect(missingAssignedFileCandidateGaps({
      files: [
        { id: "repo-a-runtime", path: "repo-a/agent.ts", staticSubsystemKeys: ["ai_runtime"] },
        { id: "repo-b-runtime", path: "repo-b/agent.ts", staticSubsystemKeys: ["ai_runtime"] },
      ],
      workPackageCapabilityKeys: ["ai_runtime"],
      candidates: [{
        key: "ai_runtime",
        evidence: [{ fileSnapshotId: "repo-a-runtime", lineStart: 1, lineEnd: 2 }],
      }],
    })).toEqual([
      "repo-b/agent.ts: No supported semantic finding was produced for assigned capability ai_runtime.",
    ]);
  });

  it("classifies structurally partial reports as incomplete even when they inspected files and emitted candidates", () => {
    expect(partitionCapabilityReports([
      { packageId: "complete", partial: false },
      { packageId: "missing-one-capability", partial: true },
    ])).toEqual({
      completePackages: ["complete"],
      incompletePackages: ["missing-one-capability"],
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

    expect(reusableCurrentSnapshotSemanticAnalysis({
      semanticStatus: "succeeded",
      semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
      semanticAnalysis: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    })).toMatchObject({
      path: "workflows/project-chat.ts",
      facts: [expect.objectContaining({ statement: "The workflow defines retry-safe steps." })],
    });
    expect(reusableCurrentSnapshotSemanticAnalysis({
      semanticStatus: "succeeded",
      semanticAnalyzerVersion: "repository-coverage-v13",
      semanticAnalysis: cached,
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    })).toBeNull();
  });

  it("scopes a highlight embedding file to retrieval instead of unrelated package capabilities", () => {
    const task = buildFileSemanticTask({
      path: "src/services/highlight-embedding-service.ts",
      workPackageCapabilityKeys: ["ingestion_integrations", "retrieval_provenance"],
      staticSubsystemKeys: ["retrieval_provenance"],
    });

    expect(task).toMatchObject({
      capabilityKeys: ["retrieval_provenance"],
      questions: expect.arrayContaining([expect.stringContaining("retrieval_provenance")]),
      expectedOutputs: expect.arrayContaining([
        expect.stringContaining("Runnable example or proof-of-concept source"),
      ]),
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

  it("does not require a backend review service to prove review UI behavior", () => {
    const task = buildFileSemanticTask({
      path: "src/services/knowledge-review-service.ts",
      workPackageCapabilityKeys: ["knowledge_review_lifecycle", "review_ui"],
      staticSubsystemKeys: ["knowledge_review_lifecycle", "review_ui"],
    });

    expect(task).toMatchObject({
      capabilityKeys: ["knowledge_review_lifecycle"],
      semanticSignalKeys: expect.arrayContaining([
        "knowledge_review_lifecycle.immutable_successors",
        "knowledge_review_lifecycle.dependent_invalidation",
        "knowledge_review_lifecycle.restore_retire_modes",
      ]),
    });
    expect(missingAssignedFileCandidateGaps({
      files: [{
        id: "knowledge-review-service",
        path: "src/services/knowledge-review-service.ts",
        staticSubsystemKeys: ["knowledge_review_lifecycle", "review_ui"],
      }],
      workPackageCapabilityKeys: ["knowledge_review_lifecycle", "review_ui"],
      candidates: [{
        key: "knowledge_review_lifecycle",
        evidence: [{ fileSnapshotId: "knowledge-review-service", lineStart: 1, lineEnd: 2 }],
      }],
    })).toEqual([]);
  });

  it("does not require specialized persistence files to prove application-core behavior", () => {
    const task = buildFileSemanticTask({
      path: "prisma/migrations/0001_init/migration.sql",
      workPackageCapabilityKeys: [
        "repository_area:application_core",
        "repository_area:data_model",
      ],
      staticSubsystemKeys: ["domain_data", "module:prisma/migrations"],
    });

    expect(task?.capabilityKeys).toEqual(["repository_area:data_model"]);
  });

  it("keeps cartography-canonical project domains relevant across singular and plural static aliases", () => {
    const task = buildFileSemanticTask({
      path: "src/circles/contribution-service.ts",
      workPackageCapabilityKeys: ["project_domain:circle"],
      staticSubsystemKeys: ["project_domain:circles"],
    });

    expect(task?.capabilityKeys).toEqual(["project_domain:circle"]);
    expect(missingAssignedFileCandidateGaps({
      files: [{
        id: "circle-contributions",
        path: "src/circles/contribution-service.ts",
        staticSubsystemKeys: ["project_domain:circles"],
      }],
      workPackageCapabilityKeys: ["project_domain:circle"],
      candidates: [{
        key: "project_domain:circle",
        evidence: [{ fileSnapshotId: "circle-contributions", lineStart: 1, lineEnd: 8 }],
      }],
    })).toEqual([]);
  });

  it("requires repository-derived capabilities only from admissible coverage evidence", () => {
    const task = buildFileSemanticTask({
      path: "src/test/persistence/DataLoaderTest.java",
      workPackageCapabilityKeys: [
        "repository_area:data_model",
        "repository_area:quality",
        "project_domain:catalog",
      ],
      staticSubsystemKeys: ["project_domain:catalog"],
    });

    expect(task?.capabilityKeys).toEqual(["repository_area:quality"]);
    expect(missingAssignedFileCandidateGaps({
      files: [{
        id: "data-loader-test",
        path: "src/test/persistence/DataLoaderTest.java",
        staticSubsystemKeys: ["project_domain:catalog"],
      }],
      workPackageCapabilityKeys: [
        "repository_area:data_model",
        "repository_area:quality",
        "project_domain:catalog",
      ],
      candidates: [{
        key: "repository_area:quality",
        evidence: [{ fileSnapshotId: "data-loader-test", lineStart: 1, lineEnd: 8 }],
      }],
    })).toEqual([]);
  });

  it("provides path-scoped stable semantic signals instead of freeform facet labels", () => {
    expect(semanticSignalKeysForFile({
      path: "app/work-items/[id]/page.tsx",
      capabilityKeys: ["review_ui", "product_surface"],
    })).toEqual([
      "review_ui.url_addressable_views",
      "review_ui.highlight_lifecycle",
      "review_ui.artifact_highlight_traceability",
    ]);
    expect(semanticSignalKeysForFile({
      path: "components/chat/project-chat-workspace.tsx",
      capabilityKeys: ["review_ui"],
    })).toEqual([
      "review_ui.candidate_metadata",
      "review_ui.citation_navigation",
    ]);
    expect(semanticSignalKeysForFile({
      path: "workflows/project-chat.ts",
      capabilityKeys: ["workflow_orchestration"],
    })).toEqual([
      "workflow_orchestration.chat_workflow",
      "workflow_orchestration.repository_refresh_workflow",
      "workflow_orchestration.artifact_workflow",
      "workflow_orchestration.approval_pause_resume",
      "workflow_orchestration.reconciliation_retry_boundary",
      "workflow_orchestration.shared_refresh_owner_recovery",
    ]);
    expect(semanticSignalKeysForFile({
      path: "src/services/agent-run-workflow-start-service.ts",
      capabilityKeys: ["workflow_orchestration", "ai_runtime"],
    })).toEqual(["workflow_orchestration.workflow_start_reservation"]);
    expect(semanticSignalKeysForFile({
      path: "src/services/project-chat-store.ts",
      capabilityKeys: ["workflow_orchestration", "project_chat_grounding"],
    })).toEqual([
      "workflow_orchestration.chat_run_idempotency",
      "workflow_orchestration.event_sequence_guard",
      "workflow_orchestration.terminal_write_guard",
    ]);
  });

  it("asks workflow files about retry, idempotency, and recovery without unrelated capabilities", () => {
    const task = buildFileSemanticTask({
      path: "src/services/project-chat-store.ts",
      workPackageCapabilityKeys: ["workflow_orchestration", "ingestion_integrations"],
      staticSubsystemKeys: ["workflow_orchestration", "project_chat_grounding"],
    });

    expect(task).toMatchObject({
      capabilityKeys: ["workflow_orchestration"],
      semanticSignalKeys: [
        "workflow_orchestration.chat_run_idempotency",
        "workflow_orchestration.event_sequence_guard",
        "workflow_orchestration.terminal_write_guard",
      ],
      questions: expect.arrayContaining([
        expect.stringContaining("terminal finalization"),
        expect.stringContaining("duplicate or replayed writes"),
      ]),
    });
    expect(JSON.stringify(task)).not.toContain("ingestion_integrations");
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
      semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
      snapshot: { sourceId: "attached-source" },
    });
  });
});
