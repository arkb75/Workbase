import { describe, expect, it } from "vitest";
import {
  allocateSemanticWorkerTokenBudgets,
  buildFileSemanticTask,
  enforceMandatoryCoverage,
  packSemanticBundleIndexes,
  repositoryIncomingReferenceCounts,
  scoreAdaptiveRepresentative,
  selectDiverseCapabilityRepresentatives,
  semanticCoverageAssignmentGaps,
  semanticPlannerTokenReserve,
  semanticSignalKeysForFile,
} from "@/src/services/repository-semantic-orchestrator-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

describe("adaptive semantic coverage planning", () => {
  const shell = () => ({
    objective: "Inspect representative implementation evidence.",
    capabilityKeys: [] as string[],
    fileSnapshotIds: [] as string[],
    questions: [] as string[],
    expectedOutputs: [] as string[],
  });

  it("allocates the fixed worker budget in proportion to structured calls", () => {
    expect(allocateSemanticWorkerTokenBudgets({
      totalTokens: 80_000,
      modelCallCounts: [1, 2, 1],
    })).toEqual([20_000, 40_000, 20_000]);
    expect(semanticPlannerTokenReserve({ totalTokens: 9_000, unknownUsageCalls: 1 })).toBe(0);
  });

  it("packs bounded bundles deterministically without exceeding file capacity", () => {
    const assignments = packSemanticBundleIndexes({
      bundles: [
        { size: 3, capabilityKeys: ["domain_data"], orderKey: "a" },
        { size: 2, capabilityKeys: ["application_logic"], orderKey: "b" },
        { size: 2, capabilityKeys: ["interfaces_integrations"], orderKey: "c" },
      ],
      plannerClaims: [[], []],
      maxWorkers: 2,
      maxFilesPerWorker: 4,
      microBatchSize: 4,
    });
    expect(assignments).not.toBeNull();
    expect(assignments?.flat().sort()).toEqual([0, 1, 2]);
    expect(assignments?.every((indexes) =>
      indexes.reduce((total, index) => total + [3, 2, 2][index]!, 0) <= 4
    )).toBe(true);
  });

  it("prefers executable evidence over higher-scored planning context", () => {
    expect(selectDiverseCapabilityRepresentatives({
      key: "product_surface",
      label: "Product surface",
      requiredSemanticPathCount: 1,
      files: [
        { id: "readme", path: "README.md", score: 100 },
        { id: "screen", path: "src/screens/checkout-screen.tsx", score: 82 },
      ],
    }).map((file) => file.id)).toEqual(["screen"]);
  });

  it("uses multiple path families for broad capability areas", () => {
    const selected = selectDiverseCapabilityRepresentatives({
      key: "interfaces_integrations",
      label: "Interfaces",
      requiredSemanticPathCount: 2,
      files: [
        { id: "one", path: "src/api/orders/route.ts", score: 90 },
        { id: "two", path: "src/api/orders/admin-route.ts", score: 89 },
        { id: "three", path: "src/connectors/payments/client.ts", score: 78 },
      ],
    });
    expect(selected.map((file) => file.id)).toEqual(["one", "three"]);
  });

  it("builds a repository-derived plan for every generic role", () => {
    const keys = [
      "product_surface",
      "domain_data",
      "application_logic",
      "interfaces_integrations",
      "automation_workflows",
      "intelligence_search",
      "security_reliability",
      "tests_operations",
    ];
    const manifest = keys.map((key) => ({
      key,
      label: key,
      scopeKey: "example/project",
      requiredSemanticPathCount: 2,
      files: [
        { id: `${key}-a`, path: `src/${key}/primary.ts`, score: 60 },
        { id: `${key}-b`, path: `packages/${key}/secondary.ts`, score: 50 },
        { id: `${key}-low`, path: `src/${key}/helper.ts`, score: 2 },
      ],
    }));
    const packages = enforceMandatoryCoverage({
      packages: Array.from({ length: 5 }, shell),
      manifest,
    });
    const selected = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));
    expect(selected.size).toBe(16);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 8)).toBe(true);
    expect(semanticCoverageAssignmentGaps({
      manifest,
      packages: packages.map((entry) => ({
        capabilityKeys: entry.capabilityKeys,
        fileSnapshotIds: entry.fileSnapshotIds,
      })),
      expectedScopeKeys: ["example/project"],
    })).toEqual([]);
  });

  it("gives each area one representative before spending capacity on depth", () => {
    const manifest = Array.from({ length: 40 }, (_, index) => ({
      key: `project_domain:domain-${index}`,
      label: `Domain ${index}`,
      scopeKey: "example/large",
      requiredSemanticPathCount: 3,
      files: Array.from({ length: 3 }, (_unused, fileIndex) => ({
        id: `${index}-${fileIndex}`,
        path: `src/domain-${index}/part-${fileIndex}.ts`,
        score: 50 - fileIndex,
      })),
    }));
    const packages = enforceMandatoryCoverage({
      packages: Array.from({ length: 5 }, shell),
      manifest,
    });
    const selected = new Set(packages.flatMap((entry) => entry.fileSnapshotIds));
    expect(selected.size).toBe(32);
    expect(packages.every((entry) => entry.fileSnapshotIds.length <= 8)).toBe(true);
    expect(Array.from(selected).every((id) => id.endsWith("-0"))).toBe(true);
  });

  it("derives import centrality from relative references", () => {
    const counts = repositoryIncomingReferenceCounts([
      { path: "src/core/ledger.ts", analysis: { dependencies: [] } },
      { path: "src/api/route.ts", analysis: { dependencies: ["../core/ledger"] } },
      { path: "src/jobs/settle.ts", analysis: { dependencies: ["../core/ledger"] } },
      { path: "src/ui/view.ts", analysis: { dependencies: ["../api/route"] } },
    ]);
    expect(counts.get("src/core/ledger.ts")).toBe(2);
    expect(counts.get("src/api/route.ts")).toBe(1);
  });

  it("scores substantive, central implementation above test and documentation context", () => {
    const analysis = (path: string, fact: string): RepositoryFileAnalysis => ({
      path,
      summary: fact,
      subsystemKeys: ["application_logic"],
      responsibilities: [fact],
      symbols: ["LedgerService"],
      dependencies: [],
      architectureSignals: ["database persistence"],
      userFacingCapabilities: [],
      facts: [{
        statement: fact,
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 1,
        lineEnd: 5,
        productImportance: 4,
        implementationBreadth: 4,
        technicalDifficulty: 3,
        subsystemKeys: ["application_logic"],
        evidenceMode: "static",
        path,
      }],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
    });
    const implementation = scoreAdaptiveRepresentative({
      capabilityKey: "application_logic",
      path: "src/ledger/ledger-service.ts",
      analysis: analysis("src/ledger/ledger-service.ts", "Persists balanced contributions."),
      incomingReferences: 3,
    });
    const test = scoreAdaptiveRepresentative({
      capabilityKey: "application_logic",
      path: "tests/ledger-service.test.ts",
      analysis: analysis("tests/ledger-service.test.ts", "Tests balanced contributions."),
      incomingReferences: 0,
    });
    expect(implementation).toBeGreaterThan(test);
  });

  it("produces only repository-neutral semantic signals", () => {
    expect(semanticSignalKeysForFile({
      path: "src/api/payments/controller.ts",
      capabilityKeys: ["interfaces_integrations", "project_domain:payments"],
    })).toEqual([
      "interfaces_integrations.request_boundary",
      "project_domain:payments.implementation",
    ]);
    expect(semanticSignalKeysForFile({
      path: "src/main/java/com/acme/loans/model/Loan.java",
      capabilityKeys: ["domain_data"],
    })).toEqual(["domain_data.schema_boundary"]);
  });

  it("builds generic file tasks with an explicit shipped-versus-planned boundary", () => {
    const task = buildFileSemanticTask({
      path: "src/jobs/recommendations.py",
      workPackageCapabilityKeys: ["automation_workflows", "intelligence_search"],
      staticSubsystemKeys: ["automation_workflows", "intelligence_search", "module:src/jobs"],
    });
    expect(task).toMatchObject({
      capabilityKeys: ["automation_workflows", "intelligence_search"],
      semanticSignalKeys: expect.arrayContaining([
        "automation_workflows.execution_boundary",
        "intelligence_search.query_boundary",
      ]),
    });
    expect(task?.expectedOutputs.join(" ")).toMatch(/planned.*context|planned|generated/i);
  });
});
