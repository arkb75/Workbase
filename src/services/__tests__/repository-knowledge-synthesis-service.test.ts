import { describe, expect, it } from "vitest";
import {
  deterministicSynthesisAnchorSubsystems,
  exactSinglePathProjectDomainSynthesis,
  fallbackSubsystemSynthesis,
  finalizeRepositorySubsystemSynthesis,
  modelEligibleSynthesisNotebook,
  reusableSynthesisEvidenceFilters,
  repositorySynthesisSafetyGuidance,
  selectSubsystemSynthesisNotebook,
  selectedProjectDomainKeysFromOrchestration,
  semanticFactsForSubsystem,
  synthesisNotebookReferenceKey,
  synthesisNotebookSourceCoverageGaps,
  type SynthesisNotebookEntry,
} from "@/src/services/repository-knowledge-synthesis-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";

function entry(input: Partial<SynthesisNotebookEntry> & Pick<SynthesisNotebookEntry, "path" | "statement">): SynthesisNotebookEntry {
  return {
    sourceId: input.sourceId ?? "source-1",
    repository: input.repository ?? "example/project",
    commitSha: input.commitSha ?? "a".repeat(40),
    blobSha: input.blobSha ?? `blob:${input.path}`,
    path: input.path,
    lineStart: input.lineStart ?? 1,
    lineEnd: input.lineEnd ?? 5,
    statement: input.statement,
    category: input.category ?? "architecture",
    confidence: input.confidence ?? "high",
    sensitivityFlag: input.sensitivityFlag ?? false,
    productImportance: input.productImportance ?? 4,
    implementationBreadth: input.implementationBreadth ?? 4,
    technicalDifficulty: input.technicalDifficulty ?? 3,
    changeType: input.changeType ?? "modified",
    semanticStatus: input.semanticStatus ?? "succeeded",
    semanticSignals: input.semanticSignals ?? [],
    evidenceMode: input.evidenceMode ?? "semantic",
  };
}

describe("generic repository synthesis", () => {
  it("keeps static inventory out of promotable synthesis", () => {
    const staticFact = {
      statement: "README.md states: ## Future: add repayment history.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      lineStart: 1,
      lineEnd: 1,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 2,
      subsystemKeys: ["product_surface"],
      evidenceMode: "static" as const,
      path: "README.md",
    };
    expect(deterministicSynthesisAnchorSubsystems(staticFact, "README.md")).toEqual([]);
    expect(modelEligibleSynthesisNotebook([
      entry({ path: "README.md", statement: staticFact.statement, evidenceMode: "deterministic_anchor" }),
    ])).toEqual([]);
  });

  it("scopes semantic facts to the capability that each finding supports", () => {
    const analysis: RepositoryFileAnalysis = {
      path: "src/payments/service.ts",
      summary: "Payments.",
      subsystemKeys: ["application_logic", "project_domain:payments"],
      responsibilities: [],
      symbols: [],
      dependencies: [],
      architectureSignals: [],
      userFacingCapabilities: [],
      facts: [
        {
          statement: "Settles a contribution inside a transaction.",
          category: "data_flow",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 2,
          lineEnd: 8,
          productImportance: 4,
          implementationBreadth: 4,
          technicalDifficulty: 3,
          subsystemKeys: ["project_domain:payments"],
          evidenceMode: "semantic",
          path: "src/payments/service.ts",
        },
        {
          statement: "Exposes the settlement service boundary.",
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          lineStart: 1,
          lineEnd: 8,
          productImportance: 3,
          implementationBreadth: 3,
          technicalDifficulty: 2,
          subsystemKeys: ["application_logic"],
          evidenceMode: "semantic",
          path: "src/payments/service.ts",
        },
      ],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
    };
    expect(semanticFactsForSubsystem(analysis, "project_domain:payments").map((fact) => fact.statement))
      .toEqual(["Settles a contribution inside a transaction."]);
  });

  it("synthesizes a single-file project domain from semantic evidence only", () => {
    const notebook = [
      entry({
        path: "src/contributions/ledger.ts",
        statement: "The ledger atomically records member contributions and updates the circle balance.",
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 3,
      }),
      entry({
        path: "src/contributions/ledger.ts",
        statement: "The ledger rejects non-positive contribution amounts.",
        productImportance: 3,
      }),
    ];
    const result = exactSinglePathProjectDomainSynthesis("project_domain:contributions", notebook);
    expect(result?.facts[0]).toMatchObject({
      statement: expect.stringContaining("atomically records"),
      citationIndexes: [1],
    });
  });

  it("does not fabricate a broad cross-file story in deterministic fallback", () => {
    const notebook = [
      entry({
        path: "src/search/retriever.ts",
        statement: "The retriever combines lexical and vector scores for candidate ranking.",
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 4,
      }),
      entry({
        path: "src/search/cache.ts",
        statement: "The cache stores query results for five minutes.",
        productImportance: 2,
        implementationBreadth: 2,
        technicalDifficulty: 2,
      }),
    ];
    const result = fallbackSubsystemSynthesis("intelligence_search", notebook);
    expect(result.facts[0]?.statement).toBe(notebook[0]!.statement);
    expect(result.facts[0]?.citationIndexes).toEqual([1]);
    expect(result.facts[0]?.statement).not.toMatch(/Workbase|career artifact|project chat/i);
  });

  it("deduplicates notebook entries and keeps repository source diversity", () => {
    const duplicate = entry({
      path: "src/orders/service.ts",
      statement: "Creates an order and reserves inventory.",
    });
    const secondSource = entry({
      sourceId: "source-2",
      repository: "example/worker",
      path: "src/orders/consumer.ts",
      statement: "Consumes order events and schedules fulfillment.",
    });
    const selected = selectSubsystemSynthesisNotebook("project_domain:orders", [
      duplicate,
      { ...duplicate },
      secondSource,
    ]);
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map((candidate) => candidate.sourceId))).toEqual(new Set(["source-1", "source-2"]));
  });

  it("reports repository sources omitted by a bounded notebook", () => {
    const first = entry({ path: "src/orders/service.ts", statement: "Creates orders." });
    const second = entry({
      sourceId: "source-2",
      repository: "example/worker",
      path: "src/orders/consumer.ts",
      statement: "Consumes orders.",
    });
    expect(synthesisNotebookSourceCoverageGaps([first, second], [first]))
      .toEqual([expect.stringContaining("example/worker")]);
  });

  it("builds stable exact-range citation identities and reuse filters", () => {
    const notebookEntry = entry({
      path: "src/orders/service.ts",
      statement: "Creates orders.",
      lineStart: 10,
      lineEnd: 20,
    });
    expect(synthesisNotebookReferenceKey(notebookEntry)).toContain("src/orders/service.ts");
    expect(reusableSynthesisEvidenceFilters([notebookEntry])).toEqual([
      expect.objectContaining({
        sourceId: "source-1",
        logicalKey: expect.stringContaining("src/orders/service.ts"),
      }),
      expect.objectContaining({
        sourceId: "source-1",
        metadata: expect.objectContaining({ equals: notebookEntry.blobSha }),
      }),
    ]);
  });

  it("reads selected project domains from persisted orchestration without repository assumptions", () => {
    expect(selectedProjectDomainKeysFromOrchestration({
      packages: [
        { capabilityKeys: ["application_logic", "project_domain:contributions"] },
        { capabilityKeys: ["project_domain:orders"] },
      ],
    })).toEqual(["project_domain:contributions", "project_domain:orders"]);
  });

  it("drops invalid citations during finalization", () => {
    const notebook = [entry({
      path: "src/orders/service.ts",
      statement: "Creates an order in a transaction.",
    })];
    const finalized = finalizeRepositorySubsystemSynthesis({
      subsystemKey: "project_domain:orders",
      notebook,
      coverageGaps: [],
      tokenUsage: null,
      result: {
        facts: [
          {
            statement: "Creates an order in a transaction.",
            category: "data_flow",
            confidence: "high",
            sensitivityFlag: false,
            citationIndexes: [1],
            reviewNotes: null,
            productImportance: 4,
            implementationBreadth: 4,
            technicalDifficulty: 3,
            distinctiveness: 3,
          },
          {
            statement: "Invalid unsupported statement.",
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            citationIndexes: [2],
            reviewNotes: null,
            productImportance: 5,
            implementationBreadth: 5,
            technicalDifficulty: 5,
            distinctiveness: 5,
          },
        ],
        highlights: [],
        unresolvedQuestions: [],
        approvalEligible: true,
      },
    });
    expect(finalized.facts.map((fact) => fact.statement)).toEqual(["Creates an order in a transaction."]);
  });

  it("keeps conservative qualifier guidance repository-neutral", () => {
    expect(repositorySynthesisSafetyGuidance).toMatch(/Avoid absolute qualifiers/);
    expect(repositorySynthesisSafetyGuidance).not.toMatch(/Workbase|GitHub|Bedrock|OpenRouter/);
  });
});
