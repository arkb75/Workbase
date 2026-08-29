import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/src/lib/prisma";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  buildRepositorySynthesisBatches,
  deterministicSynthesisAnchorSubsystems,
  derivedRepositoryKnowledgeLifecycleFact,
  exactSinglePathProjectDomainSynthesis,
  fallbackSubsystemSynthesis,
  finalizeRepositorySubsystemSynthesis,
  isBroadSemanticRepositoryLifecycleFact,
  isWorkbaseRepositoryIdentity,
  matchesWorkbaseDeterministicDefinitionIdentity,
  modelEligibleSynthesisNotebook,
  mergeRepositorySynthesisCriticAfterRevision,
  normalizeRepositoryHighlightText,
  applyRepositorySynthesisCritic,
  applyRepositorySynthesisRevision,
  rejectedRepositorySynthesisClaimKeys,
  repositoryEvidenceBoundaryGuidance,
  repositoryHighlightSelectionGuidance,
  repositorySynthesisCriticClaims,
  repositorySynthesisCriticPayload,
  repositorySynthesisCriticValidationErrors,
  repositorySynthesisRevisionErrors,
  repositorySynthesisRevisionCriticClaims,
  repositorySynthesisRevisionEvidenceIndexes,
  repositorySynthesisStructuralErrors,
  repositoryUserFacingCapabilityGuidance,
  reusableSynthesisEvidenceFilters,
  requiredSemanticBaselineFacts,
  resolveRepositorySynthesisMode,
  repositorySynthesisSafetyGuidance,
  repositorySynthesisSchema,
  runOrderedSynthesisBatches,
  selectSubsystemSynthesisNotebook,
  semanticFactsForSubsystem,
  selectedProjectDomainKeysFromOrchestration,
  substantialFactHighlightFallback,
  synthesisNotebookSourceCoverageGaps,
  synthesisNotebookReferenceKey,
  synthesizeRepositoryKnowledge,
} from "@/src/services/repository-knowledge-synthesis-service";
import {
  analyzeRepositoryFiles,
  type RepositoryFileAnalysis,
} from "@/src/services/repository-coverage-service";
import {
  REPOSITORY_SEMANTIC_ANALYZER_VERSION,
  REPOSITORY_STATIC_ANALYZER_VERSION,
} from "@/src/services/repository-knowledge-sync-service";

function entry(path: string, statement = `${path} defines supported repository behavior.`): SynthesisNotebookEntry {
  return {
    sourceId: "source-1",
    repository: "arkb75/Workbase",
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

describe("repository synthesis model-path limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults synthesis to model mode and rejects mistyped modes", () => {
    expect(resolveRepositorySynthesisMode(undefined)).toBe("model");
    expect(resolveRepositorySynthesisMode("model")).toBe("model");
    expect(resolveRepositorySynthesisMode("deterministic")).toBe("deterministic");
    for (const invalid of ["", "fallback", "MODEL", "model "]) {
      expect(() => resolveRepositorySynthesisMode(invalid)).toThrow(
        "WORKBASE_REPOSITORY_SYNTHESIS_MODE must be exactly 'model' or 'deterministic'.",
      );
    }
  });

  it("fails before loading repository data when synthesis mode is invalid", async () => {
    vi.stubEnv("WORKBASE_REPOSITORY_SYNTHESIS_MODE", "deterministic-fallback");
    const loadRun = vi.spyOn(prisma.knowledgeRefreshRun, "findUniqueOrThrow");

    await expect(synthesizeRepositoryKnowledge("refresh-1")).rejects.toThrow(
      "WORKBASE_REPOSITORY_SYNTHESIS_MODE must be exactly 'model' or 'deterministic'.",
    );
    expect(loadRun).not.toHaveBeenCalled();
  });

  it("finishes each bounded synthesis wave before admitting the next and returns input order", async () => {
    const started: number[] = [];
    const releases = new Map<number, () => void>();
    let active = 0;
    let maximumActive = 0;
    const execution = runOrderedSynthesisBatches(
      [0, 1, 2, 3, 4],
      async (value) => {
        started.push(value);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.set(value, resolve));
        active -= 1;
        return `batch-${value}`;
      },
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(maximumActive).toBe(3);
    releases.get(1)!();
    releases.get(2)!();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    releases.get(0)!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases.get(4)!();
    releases.get(3)!();

    await expect(execution).resolves.toEqual([
      "batch-0",
      "batch-1",
      "batch-2",
      "batch-3",
      "batch-4",
    ]);
    expect(maximumActive).toBe(3);
  });

  it("aligns model synthesis wording with the deterministic absolute-claim safety gate", () => {
    expect(repositorySynthesisSafetyGuidance).toContain("exact executable");
    for (const qualifier of ["always", "never", "exclusively", "every", "all", "only", "guarantees"]) {
      expect(repositorySynthesisSafetyGuidance).toContain(qualifier);
    }
    expect(repositorySynthesisSafetyGuidance).toContain("narrower non-absolute description");
    expect(repositorySynthesisSafetyGuidance).toContain("exact positive condition");
    expect(repositorySynthesisSafetyGuidance).toContain("global prevention or prohibition");
  });

  it("prioritizes broad implemented workflows over low-level highlight candidates", () => {
    expect(repositoryHighlightSelectionGuidance).toContain("end-to-end state-changing workflows");
    expect(repositoryHighlightSelectionGuidance).toContain("single-page parameter wiring");
    expect(repositoryHighlightSelectionGuidance).toContain("one cross-layer Highlight");
    expect(repositoryHighlightSelectionGuidance).toContain("every claimed stage has implementation evidence");
    expect(repositoryHighlightSelectionGuidance).toContain("do not emit duplicate layer-specific Highlights");
    expect(repositoryHighlightSelectionGuidance).toContain("Never combine sibling entity workflows");
    expect(repositoryHighlightSelectionGuidance).toContain("two broadest distinct supported capabilities");
  });

  it("requires product-surface synthesis to name the interface and supported user workflow", () => {
    expect(repositoryUserFacingCapabilityGuidance).toContain("without filenames, class names, or framework knowledge");
    for (const surface of ["desktop UI", "web UI", "API", "CLI"]) {
      expect(repositoryUserFacingCapabilityGuidance).toContain(surface);
    }
    expect(repositoryUserFacingCapabilityGuidance).toContain("concrete user action or outcome");
    expect(repositoryUserFacingCapabilityGuidance).toContain("not a user-facing capability");
    expect(repositoryUserFacingCapabilityGuidance).toContain("action-handler or mutation evidence");
    expect(repositoryUserFacingCapabilityGuidance).toContain("one Fact per distinct supported user goal or entity");
    expect(repositoryUserFacingCapabilityGuidance).toContain("Do not merge sibling entity workflows");
    expect(repositoryUserFacingCapabilityGuidance).toContain("distinct supported workflows");
    expect(repositoryUserFacingCapabilityGuidance).toContain("Navigation evidence proves");
    expect(repositoryUserFacingCapabilityGuidance).toContain("separately supported workflows");
    expect(repositoryUserFacingCapabilityGuidance).toContain("cited action evidence");
  });

  it("keeps exact implementation details inside their cited evidence boundary", () => {
    for (const detail of ["endpoint", "route", "state name", "numeric value", "unit", "threshold", "persistence action", "lifecycle transition", "type relationship"]) {
      expect(repositoryEvidenceBoundaryGuidance).toContain(detail);
    }
    expect(repositoryEvidenceBoundaryGuidance).toContain("cite every entry needed to support a compound claim");
    expect(repositoryEvidenceBoundaryGuidance).toContain("does not by itself prove that its class implements an interface");
    expect(repositoryEvidenceBoundaryGuidance).toContain("cite the declaration for that relationship");
    expect(repositoryEvidenceBoundaryGuidance).toContain("A client or interface entry proves that layer only");
    expect(repositoryEvidenceBoundaryGuidance).toContain("server, service, storage, or model behavior");
  });

  it("deduplicates critic evidence per subsystem while preserving claim citation indexes", () => {
    const notebook = [
      {
        ...entry("src/payments/store.ts", "The service persists a payment receipt."),
        sourceExcerpt: "12: await receipts.insert(receipt);",
        evidenceMode: "semantic" as const,
      },
      {
        ...entry("src/payments/read.ts", "The service loads a payment receipt by identifier."),
        sourceExcerpt: "8: return receipts.find(receiptId);",
        evidenceMode: "semantic" as const,
      },
      {
        ...entry("src/payments/admin.ts", "The admin service lists audit records."),
        sourceExcerpt: "5: return auditRecords.list();",
        evidenceMode: "semantic" as const,
      },
    ];
    const result = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service persists a payment receipt.",
          category: "behavior" as const,
          confidence: "high" as const,
          sensitivityFlag: false,
          citationIndexes: [1],
          reviewNotes: null,
          productImportance: 4,
          implementationBreadth: 3,
          technicalDifficulty: 3,
          distinctiveness: 3,
        }],
        highlights: [{
          text: "Built durable payment receipt storage",
          summary: "The service persists payment receipts for later retrieval.",
          confidence: "high" as const,
          sensitivityFlag: false,
          visibility: "private" as const,
          citationIndexes: [1, 2],
          productImportance: 4,
          implementationBreadth: 4,
          technicalDifficulty: 3,
          distinctiveness: 3,
        }],
        unresolvedQuestions: [],
      }],
    };

    const payload = repositorySynthesisCriticPayload(result, [{
      subsystemKey: "project_domain:payments",
      synthesisKey: "project_domain:payments#scope",
      notebook,
    }]);
    const claims = repositorySynthesisCriticClaims(result);

    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      claimKey: "project_domain:payments#scope:fact:1",
      citationIndexes: [1],
    });
    expect(claims[1]?.citationIndexes).toEqual([1, 2]);
    expect(payload.subsystems).toEqual([expect.objectContaining({
      subsystemKey: "project_domain:payments#scope",
      notebook: [
        {
          index: 1,
          sourceExcerpt: "12: await receipts.insert(receipt);",
        },
        {
          index: 2,
          sourceExcerpt: "8: return receipts.find(receiptId);",
        },
      ],
      claims,
    })]);
    expect(payload.subsystems[0]?.claims[0]).not.toHaveProperty("citations");
  });

  it("keeps terminal critic rejections diagnostic when a supported claim survives", () => {
    const fact = {
      statement: "The service persists and encrypts every payment receipt.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const supportedFact = {
      ...fact,
      statement: "The service persists a payment receipt.",
      citationIndexes: [2],
    };
    const highlight = {
      text: "Built the complete payment lifecycle",
      summary: "The workflow always handles every payment operation end to end.",
      confidence: "high" as const,
      sensitivityFlag: false,
      visibility: "private" as const,
      citationIndexes: [3],
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 4,
      distinctiveness: 4,
    };
    const result = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [fact, supportedFact],
        highlights: [highlight],
        unresolvedQuestions: [],
      }],
    };
    const filtered = applyRepositorySynthesisCritic(result, {
      assessments: [
        {
          claimKey: "project_domain:payments#scope:fact:1",
          supported: false,
          issues: ["unsupported_compound_action"],
        },
        {
          claimKey: "project_domain:payments#scope:fact:2",
          supported: true,
          issues: [],
        },
        {
          claimKey: "project_domain:payments#scope:highlight:1",
          supported: false,
          issues: ["unsupported_broad_qualifier"],
        },
      ],
    });

    expect(filtered.subsystems[0]?.facts).toEqual([supportedFact]);
    expect(filtered.subsystems[0]?.facts[0]?.citationIndexes).toEqual([2]);
    expect(filtered.subsystems[0]?.highlights).toEqual([]);
    expect(filtered.subsystems[0]?.unresolvedQuestions).toEqual(expect.arrayContaining([
      "Entailment verification rejected fact 1: unsupported compound action.",
      "Entailment verification rejected highlight 1: unsupported broad qualifier.",
    ]));
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Workbase",
      subsystemKey: "project_domain:payments",
      notebook: [1, 2, 3].map((index) => ({
        ...entry(`src/payments/step-${index}.ts`),
        evidenceMode: "semantic" as const,
      })),
      coverageGaps: [],
      result: filtered.subsystems[0]!,
      tokenUsage: null,
    });
    expect(finalized.coverageGaps).toEqual([]);
    expect(finalized.unresolvedQuestions).toEqual(expect.arrayContaining([
      "Entailment verification rejected fact 1: unsupported compound action.",
      "Entailment verification rejected highlight 1: unsupported broad qualifier.",
    ]));
  });

  it("turns terminal critic rejection into one repository-scoped gap when no claim survives", () => {
    const fact = {
      statement: "The service persists and encrypts every payment receipt.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const highlight = {
      text: "Built the complete payment lifecycle",
      summary: "The workflow always handles every payment operation end to end.",
      confidence: "high" as const,
      sensitivityFlag: false,
      visibility: "private" as const,
      citationIndexes: [2],
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 4,
      distinctiveness: 4,
    };
    const filtered = applyRepositorySynthesisCritic({
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [fact],
        highlights: [highlight],
        unresolvedQuestions: [],
      }],
    }, {
      assessments: [
        {
          claimKey: "project_domain:payments#scope:fact:1",
          supported: false,
          issues: ["unsupported_compound_action"],
        },
        {
          claimKey: "project_domain:payments#scope:highlight:1",
          supported: false,
          issues: ["unsupported_broad_qualifier"],
        },
      ],
    });
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Workbase",
      subsystemKey: "project_domain:payments",
      notebook: [1, 2].map((index) => ({
        ...entry(`src/payments/step-${index}.ts`),
        evidenceMode: "semantic" as const,
      })),
      coverageGaps: [],
      result: filtered.subsystems[0]!,
      tokenUsage: null,
    });

    expect(finalized.facts).toEqual([]);
    expect(finalized.highlights).toEqual([]);
    expect(finalized.unresolvedQuestions).toEqual(expect.arrayContaining([
      "Entailment verification rejected fact 1: unsupported compound action.",
      "Entailment verification rejected highlight 1: unsupported broad qualifier.",
    ]));
    expect(finalized.coverageGaps).toHaveLength(1);
    expect(finalized.coverageGaps[0]).toMatch(/^Repository arkb75\/Workbase /u);
    expect(finalized.coverageGaps[0]).toMatch(
      /no supported Project Facts for project_domain:payments/iu,
    );

    const absentFactFinalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/payments",
      subsystemKey: "project_domain:payments",
      notebook: [1, 2].map((index) => ({
        ...entry(`src/payments/step-${index}.ts`),
        repository: "example/payments",
        evidenceMode: "semantic" as const,
      })),
      coverageGaps: [],
      result: { facts: [], highlights: [highlight], unresolvedQuestions: [] },
      tokenUsage: null,
    });
    expect(absentFactFinalized.highlights).toEqual([highlight]);
    expect(absentFactFinalized.coverageGaps).toEqual([
      expect.stringMatching(
        /^Repository example\/payments produced no supported Project Facts for project_domain:payments/u,
      ),
    ]);
  });

  it("reports a repository-scoped gap when model synthesis returns no Project Facts", () => {
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/empty",
      subsystemKey: "project_domain:empty",
      notebook: [{
        ...entry("src/empty/service.ts"),
        repository: "example/empty",
        evidenceMode: "semantic" as const,
      }],
      coverageGaps: [],
      result: { facts: [], highlights: [], unresolvedQuestions: [] },
      tokenUsage: null,
    });

    expect(finalized.facts).toEqual([]);
    expect(finalized.highlights).toEqual([]);
    expect(finalized.coverageGaps).toHaveLength(1);
    expect(finalized.coverageGaps[0]).toMatch(/^Repository example\/empty /u);
    expect(finalized.coverageGaps[0]).toMatch(
      /no supported Project Facts for project_domain:empty/iu,
    );
    expect(finalized.unresolvedQuestions).toEqual(finalized.coverageGaps);
  });

  it("retains source scope after anchor-only evidence is removed from the model notebook", () => {
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-worker",
      repository: "example/worker",
      subsystemKey: "workflow_orchestration",
      notebook: [],
      coverageGaps: [
        "Repository example/worker had no semantic notebook evidence for workflow_orchestration; deterministic anchors were not eligible for model synthesis.",
      ],
      result: {
        facts: [],
        highlights: [],
        unresolvedQuestions: [],
        approvalEligible: false,
      },
      tokenUsage: null,
    });

    expect(finalized).toMatchObject({
      sourceId: "source-worker",
      repository: "example/worker",
      subsystemKey: "workflow_orchestration",
      notebook: [],
      approvalEligible: false,
    });
    expect(finalized.coverageGaps).toEqual(expect.arrayContaining([
      expect.stringContaining("no semantic notebook evidence"),
      expect.stringContaining("no supported Project Facts"),
    ]));
  });

  it("does not let a surviving Highlight certify coverage without a supported Project Fact", () => {
    const fact = {
      statement: "The service encrypts every payment receipt.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const highlight = {
      text: "Built payment receipt persistence",
      summary: "The service persists payment receipts for later retrieval.",
      confidence: "high" as const,
      sensitivityFlag: false,
      visibility: "private" as const,
      citationIndexes: [2],
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
    };
    const filtered = applyRepositorySynthesisCritic({
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [fact],
        highlights: [highlight],
        unresolvedQuestions: [],
      }],
    }, {
      assessments: [
        {
          claimKey: "project_domain:payments#scope:fact:1",
          supported: false,
          issues: ["unsupported_broad_qualifier"],
        },
        {
          claimKey: "project_domain:payments#scope:highlight:1",
          supported: true,
          issues: [],
        },
      ],
    });
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/payments",
      subsystemKey: "project_domain:payments",
      notebook: [1, 2].map((index) => ({
        ...entry(`src/payments/step-${index}.ts`),
        repository: "example/payments",
        evidenceMode: "semantic" as const,
      })),
      coverageGaps: [],
      result: filtered.subsystems[0]!,
      tokenUsage: null,
    });

    expect(finalized.facts).toEqual([]);
    expect(finalized.highlights).toEqual([highlight]);
    expect(finalized.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 1: unsupported broad qualifier.",
    );
    expect(finalized.coverageGaps).toHaveLength(1);
    expect(finalized.coverageGaps[0]).toMatch(/^Repository example\/payments /u);
    expect(finalized.coverageGaps[0]).toMatch(
      /no supported Project Facts for project_domain:payments/iu,
    );
  });

  it("rejects a claim when its critic verdict is missing or structurally contradictory", () => {
    const fact = {
      statement: "The worker publishes a receipt event.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const result = {
      subsystems: [{
        subsystemKey: "project_domain:events#scope",
        facts: [fact],
        highlights: [],
        unresolvedQuestions: [],
      }],
    };

    expect(applyRepositorySynthesisCritic(result, { assessments: [] }).subsystems[0]?.facts).toEqual([]);
    expect(repositorySynthesisCriticValidationErrors({
      assessments: [{
        claimKey: "project_domain:events#scope:fact:1",
        supported: true,
        issues: ["unsupported_detail"],
      }],
    }, new Set(["project_domain:events#scope:fact:1"]))).toEqual([
      "Supported assessments must have no issues; unsupported assessments must name at least one issue.",
    ]);
  });

  it("isolates oversized two-subsystem synthesis pairs without splitting a subsystem", () => {
    const inputs = [
      { id: "data", notebook: Array.from({ length: 9 }) },
      { id: "surface", notebook: Array.from({ length: 6 }) },
      { id: "intelligence", notebook: Array.from({ length: 6 }) },
      { id: "quality", notebook: Array.from({ length: 3 }) },
      { id: "integration", notebook: Array.from({ length: 1 }) },
    ];

    expect(buildRepositorySynthesisBatches(inputs).map((batch) =>
      batch.map((entry) => entry.id)
    )).toEqual([
      ["data"],
      ["surface"],
      ["intelligence", "quality"],
      ["integration"],
    ]);
    expect(buildRepositorySynthesisBatches([
      { id: "large-single", notebook: Array.from({ length: 20 }) },
    ]).map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["large-single"],
    ]);
    expect(buildRepositorySynthesisBatches([
      { id: "boundary-a", notebook: Array.from({ length: 6 }) },
      { id: "boundary-b", notebook: Array.from({ length: 6 }) },
      { id: "over-a", notebook: Array.from({ length: 7 }) },
      { id: "over-b", notebook: Array.from({ length: 6 }) },
    ]).map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["boundary-a", "boundary-b"],
      ["over-a"],
      ["over-b"],
    ]);
    expect(() => buildRepositorySynthesisBatches(inputs, 0)).toThrow(
      "Repository synthesis batch notebook limit must be a positive integer.",
    );
  });

  it("applies compact rejected-claim patches while preserving accepted drafts", () => {
    const fact = (statement: string, citationIndexes = [1]) => ({
      statement,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes,
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    });
    const highlight = (text: string, citationIndexes = [1]) => ({
      text,
      summary: text,
      confidence: "high" as const,
      sensitivityFlag: false,
      visibility: "private" as const,
      citationIndexes,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    });
    const prior = {
      subsystems: [{
        subsystemKey: "project_domain:inventory#scope",
        facts: [
          fact("The screen removes and encrypts an inventory record.", [1, 2]),
          fact("The store writes an inventory record."),
        ],
        highlights: [highlight("Built the complete inventory lifecycle", [1, 2])],
        unresolvedQuestions: [],
      }],
    };
    const critic = {
      assessments: [
        {
          claimKey: "project_domain:inventory#scope:fact:1",
          supported: false,
          issues: ["unsupported_compound_action" as const],
        },
        {
          claimKey: "project_domain:inventory#scope:fact:2",
          supported: true,
          issues: [],
        },
        {
          claimKey: "project_domain:inventory#scope:highlight:1",
          supported: false,
          issues: ["unsupported_broad_qualifier" as const],
        },
      ],
    };
    const revision = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: fact("The screen removes an inventory record.", [1, 2]),
      }],
      highlightRevisions: [{
        claimKey: "project_domain:inventory#scope:highlight:1",
        replacement: highlight("Built inventory record removal", [1, 2]),
      }],
    };
    const notebook = [
      {
        ...entry("src/inventory/remove.ts", "The screen removes an inventory record."),
        repository: "example/inventory",
        sourceExcerpt: "12: records.remove(recordId);",
        evidenceMode: "semantic" as const,
      },
      {
        ...entry("src/inventory/store.ts", "The store contains inventory records."),
        repository: "example/inventory",
        sourceExcerpt: "8: const records = new Map();",
        evidenceMode: "semantic" as const,
      },
    ];
    const inputs = [{
      subsystemKey: "project_domain:inventory",
      synthesisKey: "project_domain:inventory#scope",
      notebook,
    }];

    expect(rejectedRepositorySynthesisClaimKeys(critic)).toEqual(new Set([
      "project_domain:inventory#scope:fact:1",
      "project_domain:inventory#scope:highlight:1",
    ]));
    expect(repositorySynthesisRevisionErrors(revision, prior, critic, inputs)).toEqual([]);
    const merged = applyRepositorySynthesisRevision(prior, revision);
    expect(merged.subsystems[0]?.facts.map((candidate) => candidate.statement)).toEqual([
      "The screen removes an inventory record.",
      "The store writes an inventory record.",
    ]);
    expect(merged.subsystems[0]?.highlights[0]?.text).toBe("Built inventory record removal");
    expect(merged.subsystems[0]?.facts[1]).toBe(prior.subsystems[0]?.facts[1]);
    const cosmeticRevision = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: { ...prior.subsystems[0]!.facts[0]!, productImportance: 5 },
      }],
      highlightRevisions: [{
        claimKey: "project_domain:inventory#scope:highlight:1",
        replacement: {
          ...prior.subsystems[0]!.highlights[0]!,
          distinctiveness: 4,
        },
      }],
    };
    expect(repositorySynthesisRevisionErrors(cosmeticRevision, prior, critic, inputs)).toEqual([
      "Substantively revise each rejected claim or return null: project_domain:inventory#scope:fact:1, project_domain:inventory#scope:highlight:1.",
    ]);
    const citationPermutation = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: { ...prior.subsystems[0]!.facts[0]!, citationIndexes: [2, 1] },
      }],
      highlightRevisions: [{
        claimKey: "project_domain:inventory#scope:highlight:1",
        replacement: {
          ...prior.subsystems[0]!.highlights[0]!,
          citationIndexes: [2, 1],
        },
      }],
    };
    expect(repositorySynthesisRevisionErrors(citationPermutation, prior, critic, inputs)).toEqual([
      "Substantively revise each rejected claim or return null: project_domain:inventory#scope:fact:1, project_domain:inventory#scope:highlight:1.",
    ]);
    const citationOnlyRevision = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: { ...prior.subsystems[0]!.facts[0]!, citationIndexes: [1] },
      }],
      highlightRevisions: [{
        claimKey: "project_domain:inventory#scope:highlight:1",
        replacement: { ...prior.subsystems[0]!.highlights[0]!, citationIndexes: [1] },
      }],
    };
    expect(repositorySynthesisRevisionErrors(citationOnlyRevision, prior, critic, inputs)).toEqual([
      "Substantively revise each rejected claim or return null: project_domain:inventory#scope:fact:1, project_domain:inventory#scope:highlight:1.",
    ]);
    const removal = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: null,
      }],
      highlightRevisions: [{
        claimKey: "project_domain:inventory#scope:highlight:1",
        replacement: null,
      }],
    };
    expect(repositorySynthesisRevisionErrors(removal, prior, critic, inputs)).toEqual([]);
    const removed = applyRepositorySynthesisRevision(prior, removal);
    expect(removed.subsystems[0]?.facts).toEqual([prior.subsystems[0]!.facts[1]]);
    expect(removed.subsystems[0]?.highlights).toEqual([]);

    const citationMismatchCritic = {
      assessments: critic.assessments.map((assessment) =>
        assessment.claimKey.endsWith(":fact:1")
          ? { ...assessment, issues: ["citation_mismatch" as const] }
          : { ...assessment, supported: true, issues: [] }
      ),
    };
    const citationRepair = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: { ...prior.subsystems[0]!.facts[0]!, citationIndexes: [1] },
      }],
      highlightRevisions: [],
    };
    expect(repositorySynthesisRevisionErrors(
      citationRepair,
      prior,
      citationMismatchCritic,
      inputs,
    )).toEqual([]);

    expect(repositorySynthesisRevisionErrors({
      factRevisions: [...revision.factRevisions, ...revision.factRevisions],
      highlightRevisions: revision.highlightRevisions,
    }, prior, critic, inputs)).toContain(
      "Return exactly one same-kind patch for every rejected claimKey and no other keys.",
    );
    expect(repositorySynthesisRevisionErrors({
      factRevisions: [],
      highlightRevisions: [
        {
          claimKey: "project_domain:inventory#scope:fact:1",
          replacement: prior.subsystems[0]!.highlights[0]!,
        },
        revision.highlightRevisions[0]!,
      ],
    }, prior, critic, inputs)).toContain(
      "Patch project_domain:inventory#scope:fact:1 does not match its original claim kind.",
    );
    expect(repositorySynthesisRevisionErrors({
      ...revision,
      factRevisions: [{
        ...revision.factRevisions[0]!,
        replacement: {
          ...revision.factRevisions[0]!.replacement!,
          citationIndexes: [3],
        },
      }],
    }, prior, critic, inputs)).toContain(
      "Patch project_domain:inventory#scope:fact:1 cites an index outside its supplied revision evidence.",
    );
    expect(repositorySynthesisRevisionEvidenceIndexes(
      prior.subsystems[0]!,
      critic,
      8,
    )).toEqual([1, 2]);
    expect(repositorySynthesisRevisionEvidenceIndexes(
      prior.subsystems[0]!,
      citationMismatchCritic,
      8,
    )).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps null revision removals diagnostic and gaps only an emptied subsystem", () => {
    const unsupportedFact = {
      statement: "The inventory service encrypts every stored record.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const supportedFact = {
      ...unsupportedFact,
      statement: "The inventory service stores an inventory record.",
      citationIndexes: [2],
    };
    const notebook = [
      {
        ...entry("src/inventory/encryption.ts"),
        repository: "example/inventory",
        evidenceMode: "semantic" as const,
      },
      {
        ...entry("src/inventory/store.ts"),
        repository: "example/inventory",
        evidenceMode: "semantic" as const,
      },
    ];
    const critic = {
      assessments: [
        {
          claimKey: "project_domain:inventory#scope:fact:1",
          supported: false,
          issues: ["unsupported_broad_qualifier" as const],
        },
        {
          claimKey: "project_domain:inventory#scope:fact:2",
          supported: true,
          issues: [],
        },
      ],
    };
    const removal = {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: null,
      }],
      highlightRevisions: [],
    };
    const withSibling = applyRepositorySynthesisRevision({
      subsystems: [{
        subsystemKey: "project_domain:inventory#scope",
        facts: [unsupportedFact, supportedFact],
        highlights: [],
        unresolvedQuestions: [],
      }],
    }, removal, critic);
    const finalizedWithSibling = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/inventory",
      subsystemKey: "project_domain:inventory",
      notebook,
      coverageGaps: [],
      result: withSibling.subsystems[0]!,
      tokenUsage: null,
    });

    expect(finalizedWithSibling.facts).toEqual([supportedFact]);
    expect(finalizedWithSibling.coverageGaps).toEqual([]);
    expect(finalizedWithSibling.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 1: unsupported broad qualifier.",
    );

    const lastClaimCritic = { assessments: [critic.assessments[0]!] };
    const withoutSibling = applyRepositorySynthesisRevision({
      subsystems: [{
        subsystemKey: "project_domain:inventory#scope",
        facts: [unsupportedFact],
        highlights: [],
        unresolvedQuestions: [],
      }],
    }, removal, lastClaimCritic);
    const finalizedWithoutSibling = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/inventory",
      subsystemKey: "project_domain:inventory",
      notebook,
      coverageGaps: [],
      result: withoutSibling.subsystems[0]!,
      tokenUsage: null,
    });

    expect(finalizedWithoutSibling.facts).toEqual([]);
    expect(finalizedWithoutSibling.highlights).toEqual([]);
    expect(finalizedWithoutSibling.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 1: unsupported broad qualifier.",
    );
    expect(finalizedWithoutSibling.coverageGaps).toHaveLength(1);
    expect(finalizedWithoutSibling.coverageGaps[0]).toMatch(
      /^Repository example\/inventory /u,
    );
    expect(finalizedWithoutSibling.coverageGaps[0]).toMatch(
      /no supported Project Facts for project_domain:inventory/iu,
    );
  });

  it("keeps distinct null-removal diagnostics when claim indexes shift across rounds", () => {
    const rejectedFact = (statement: string) => ({
      statement,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    });
    const firstRound = applyRepositorySynthesisRevision({
      subsystems: [{
        subsystemKey: "project_domain:inventory#scope",
        facts: [
          rejectedFact("The service encrypts every record."),
          rejectedFact("The service validates every record."),
        ],
        highlights: [],
        unresolvedQuestions: [],
      }],
    }, {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: null,
      }],
      highlightRevisions: [],
    }, {
      assessments: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        supported: false,
        issues: ["unsupported_broad_qualifier"],
      }],
    }, 1);

    const secondRound = applyRepositorySynthesisRevision(firstRound, {
      factRevisions: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        replacement: null,
      }],
      highlightRevisions: [],
    }, {
      assessments: [{
        claimKey: "project_domain:inventory#scope:fact:1",
        supported: false,
        issues: ["unsupported_broad_qualifier"],
      }],
    }, 2);

    expect(secondRound.subsystems[0]?.facts).toEqual([]);
    expect(secondRound.subsystems[0]?.unresolvedQuestions).toEqual([
      "Entailment verification rejected fact 1 in revision round 1: unsupported broad qualifier.",
      "Entailment verification rejected fact 1 in revision round 2: unsupported broad qualifier.",
    ]);
  });

  it("rekeys retained and changed verdicts after an earlier null removal", () => {
    const fact = (statement: string, citationIndexes: number[]) => ({
      statement,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes,
      reviewNotes: null,
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    });
    const subsystemKey = "project_domain:inventory#scope";
    const prior = {
      subsystems: [{
        subsystemKey,
        facts: [
          fact("The service stores an inventory record.", [1]),
          fact("The service encrypts every inventory record.", [2]),
          fact("The service validates and publishes each record.", [3]),
        ],
        highlights: [],
        unresolvedQuestions: [],
      }],
    };
    const priorCritic = {
      assessments: [
        {
          claimKey: subsystemKey + ":fact:1",
          supported: true,
          issues: [],
        },
        {
          claimKey: subsystemKey + ":fact:2",
          supported: false,
          issues: ["unsupported_broad_qualifier" as const],
        },
        {
          claimKey: subsystemKey + ":fact:3",
          supported: false,
          issues: ["unsupported_compound_action" as const],
        },
      ],
    };
    const replacement = fact("The service validates an inventory record.", [3]);
    const revision = {
      factRevisions: [
        {
          claimKey: subsystemKey + ":fact:2",
          replacement: null,
        },
        {
          claimKey: subsystemKey + ":fact:3",
          replacement,
        },
      ],
      highlightRevisions: [],
    };

    expect(repositorySynthesisRevisionCriticClaims(prior, revision)).toEqual([
      {
        claimKey: subsystemKey + ":fact:3",
        kind: "fact",
        claim: { statement: replacement.statement },
        citationIndexes: [3],
      },
    ]);
    const merged = applyRepositorySynthesisRevision(
      prior,
      revision,
      priorCritic,
      1,
    );
    const cumulativeCritic = mergeRepositorySynthesisCriticAfterRevision(
      prior,
      priorCritic,
      revision,
      {
        assessments: [{
          claimKey: subsystemKey + ":fact:3",
          supported: false,
          issues: ["unsupported_detail"],
        }],
      },
    );

    expect(merged.subsystems[0]?.facts).toEqual([
      prior.subsystems[0]!.facts[0],
      replacement,
    ]);
    expect(cumulativeCritic.assessments).toEqual([
      {
        claimKey: subsystemKey + ":fact:1",
        supported: true,
        issues: [],
      },
      {
        claimKey: subsystemKey + ":fact:2",
        supported: false,
        issues: ["unsupported_detail"],
      },
    ]);
    expect(rejectedRepositorySynthesisClaimKeys(cumulativeCritic)).toEqual(
      new Set([subsystemKey + ":fact:2"]),
    );
    expect(
      applyRepositorySynthesisCritic(merged, cumulativeCritic)
        .subsystems[0]?.facts,
    ).toEqual([prior.subsystems[0]!.facts[0]]);
  });

  it("requires synthesis citations to stay within the semantic notebook", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:exports#scope",
        facts: [{
          statement: "The exporter writes a signed archive.",
          category: "behavior" as const,
          confidence: "high" as const,
          sensitivityFlag: false,
          citationIndexes: [2],
          reviewNotes: null,
          productImportance: 4,
          implementationBreadth: 3,
          technicalDifficulty: 3,
          distinctiveness: 3,
        }],
        highlights: [],
        unresolvedQuestions: [],
      }],
    };
    const input = [{
      subsystemKey: "project_domain:exports",
      synthesisKey: "project_domain:exports#scope",
      notebook: [{
        ...entry("src/export/archive.ts", "The exporter writes an archive."),
        evidenceMode: "semantic" as const,
      }],
    }];

    expect(repositorySynthesisStructuralErrors(synthesis, input)).toEqual([
      "Every claim in project_domain:exports#scope must cite only indexes present in that subsystem's notebook.",
    ]);
  });

  it("normalizes provider title overshoot without rejecting the supported synthesis", () => {
    const concise = "Built an idempotent payment workflow.";
    expect(normalizeRepositoryHighlightText(concise)).toBe(concise);

    const longTitle = `Built an idempotent payment workflow that preserves receipt state across retries and coordinates downstream publication ${"with bounded recovery controls ".repeat(8)}`;
    const normalized = normalizeRepositoryHighlightText(longTitle);
    expect(normalized.length).toBeLessThanOrEqual(240);
    expect(normalized).toMatch(/…$/u);
    expect(longTitle.startsWith(normalized.slice(0, -1))).toBe(true);

    const parsed = repositorySynthesisSchema.safeParse({
      subsystems: [{
        subsystemKey: "project_domain:payments",
        facts: [],
        highlights: [{
          text: longTitle,
          summary: longTitle,
          confidence: "high",
          sensitivityFlag: false,
          visibility: "private",
          citationIndexes: [1],
          productImportance: 5,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          distinctiveness: 4,
        }],
        unresolvedQuestions: [],
      }],
    });
    expect(parsed.success).toBe(true);
  });

  it("normalizes integer ranking-scale overshoot without replaying supported synthesis", () => {
    const parsed = repositorySynthesisSchema.safeParse({
      subsystems: [{
        subsystemKey: "project_domain:payments",
        facts: [{
          statement: "The payment workflow persists an idempotency key before receipt publication.",
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          citationIndexes: [1],
          reviewNotes: null,
          productImportance: 8,
          implementationBreadth: 7,
          technicalDifficulty: 6,
          distinctiveness: 9,
        }],
        highlights: [],
        unresolvedQuestions: [],
      }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.subsystems[0]?.facts[0]).toMatchObject({
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
      distinctiveness: 5,
    });

    expect(repositorySynthesisSchema.safeParse({
      subsystems: [{
        subsystemKey: "project_domain:payments",
        facts: [{
          statement: "The payment workflow persists an idempotency key before receipt publication.",
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          citationIndexes: [1],
          reviewNotes: null,
          productImportance: 4.5,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          distinctiveness: 4,
        }],
        highlights: [],
        unresolvedQuestions: [],
      }],
    }).success).toBe(false);
  });

  it("applies the title bound before a model Highlight reaches reconciliation", () => {
    const statement = "The payment workflow records idempotency before publishing a receipt.";
    const longTitle = `Implemented an idempotent payment workflow ${"with durable receipt publication and bounded retry coordination ".repeat(6)}`;
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Workbase",
      subsystemKey: "project_domain:payments",
      notebook: [{
        ...entry("src/payments/charge-service.ts", statement),
        evidenceMode: "semantic",
        semanticStatus: "succeeded",
      }],
      coverageGaps: [],
      result: {
        facts: [],
        highlights: [{
          text: longTitle,
          summary: statement,
          confidence: "high",
          sensitivityFlag: false,
          visibility: "private",
          citationIndexes: [1],
          productImportance: 5,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          distinctiveness: 4,
        }],
        unresolvedQuestions: [],
      },
      tokenUsage: null,
    });

    expect(finalized.highlights[0]?.text.length).toBeLessThanOrEqual(240);
    expect(finalized.highlights[0]?.summary).toBe(statement);
  });

  it("admits only exact high-confidence static lifecycle anchors", () => {
    const anchor = {
      path: "src/services/knowledge-refresh-service.ts",
      statement: "src/services/knowledge-refresh-service.ts defines the symbol startKnowledgeRefresh.",
      category: "code_location" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      lineStart: 10,
      lineEnd: 10,
      productImportance: 2,
      implementationBreadth: 2,
      technicalDifficulty: 2,
      subsystemKeys: ["repository_knowledge_lifecycle"],
      evidenceMode: "static" as const,
    };

    expect(deterministicSynthesisAnchorSubsystems(anchor, anchor.path)).toEqual(["repository_knowledge_lifecycle"]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "workflows/project-chat.ts uses a durable approval hook to pause and resume work.",
    }, "workflows/project-chat.ts")).toEqual(["workflow_orchestration"]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "src/services/agent-run-workflow-start-service.ts conditionally reserves an unstarted queued run, reuses an attached workflow identifier, cancels an unattached workflow after a terminal-state race, and clears its reservation when startup fails.",
    }, "src/services/agent-run-workflow-start-service.ts")).toEqual(["workflow_orchestration"]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "src/services/project-chat-store.ts serializes chat-run creation by locking the thread, returning an existing user-scoped idempotency-key run, and rejecting a second active run.",
    }, "src/services/project-chat-store.ts")).toEqual(["workflow_orchestration"]);
    expect(deterministicSynthesisAnchorSubsystems({ ...anchor, evidenceMode: "semantic" }, anchor.path)).toEqual([]);
    expect(deterministicSynthesisAnchorSubsystems(anchor, "src/services/unrelated-service.ts")).toEqual([]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "src/services/misc.ts defines the symbol unrelatedUtility.",
    }, anchor.path)).toEqual([]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "README.md states: 5. Auto-apply supported, non-sensitive Project Facts and Highlights as private project memory",
    }, "README.md")).toEqual(["product_surface"]);
    expect(deterministicSynthesisAnchorSubsystems({
      ...anchor,
      statement: "README.md states: An arbitrary project promise that has not been explicitly allowlisted",
    }, "README.md")).toEqual([]);
  });

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

  it("promotes one substantial semantic fact when model synthesis returns no Highlight", () => {
    const notebook = [
      {
        ...entry(
          "src/auth/session-service.ts",
          "The session service validates signed credentials and rotates durable refresh state across requests.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
      },
      {
        ...entry(
          "src/auth/policy.ts",
          "The authorization policy enforces scoped access before protected project data is returned.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
      },
    ];
    const highlights = substantialFactHighlightFallback([{
      statement:
        "The application combines signed-session rotation with scoped authorization for protected project data.",
      category: "architecture",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1, 2],
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
      reviewNotes: null,
    }], notebook);

    expect(highlights).toEqual([expect.objectContaining({
      text: expect.stringContaining("signed-session rotation"),
      citationIndexes: [1, 2],
      visibility: "private",
      confidence: "high",
    })]);
  });

  it("keeps the Resume workflow fallback stable across synthesis score drift", () => {
    const statement =
      "The documented resume-tailoring workflow starts from a job description, reviews available resume branches, and selects the closest existing variant as the basis for adaptation.";
    const notebook = [{
      ...entry(
        "README.md",
        "The documented product workflow is: take a job description, inspect all branches, and choose the closest existing resume variant.",
      ),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["product_surface.product_loop"],
      productImportance: 4,
      implementationBreadth: 2,
      technicalDifficulty: 3,
    }];
    const variants = [
      { productImportance: 4, implementationBreadth: 2, technicalDifficulty: 3, distinctiveness: 3 },
      { productImportance: 2, implementationBreadth: 1, technicalDifficulty: 1, distinctiveness: 1 },
      { productImportance: 3, implementationBreadth: 5, technicalDifficulty: 2, distinctiveness: 2 },
    ];

    for (const scores of variants) {
      const fact = {
        statement,
        category: "behavior" as const,
        confidence: "high" as const,
        sensitivityFlag: false,
        citationIndexes: [1],
        reviewNotes: null,
        ...scores,
      };
      const original = structuredClone(fact);

      expect(substantialFactHighlightFallback([fact], notebook)).toEqual([
        expect.objectContaining({
          text: statement,
          citationIndexes: [1],
          visibility: "private",
        }),
      ]);
      expect(fact).toEqual(original);
    }
  });

  it("does not infer automatic product salience from two ordinary behavior findings", () => {
    const statement =
      "The repository manages resume variants through long-lived branches and selects the closest variant before making minimal edits.";
    const notebook = [
      {
        ...entry(
          "README.md",
          "Each resume variant lives on its own long-lived branch with main.tex as its source of truth.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        lineStart: 8,
        lineEnd: 10,
      },
      {
        ...entry(
          "README.md",
          "The agent finds the closest existing resume branch before choosing minimal edits or a justified new variant.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        lineStart: 12,
        lineEnd: 18,
      },
    ];

    expect(substantialFactHighlightFallback([{
      statement,
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1, 2],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      distinctiveness: 3,
    }], notebook)).toEqual([]);
  });

  it("keeps a corroborated product fallback when synthesis distributes citations across facts", () => {
    const notebook = [
      {
        ...entry(
          "README.md",
          "Each resume variant lives on its own branch with main.tex as its source of truth.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        semanticSignals: ["product_surface.product_loop"],
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        lineStart: 3,
        lineEnd: 4,
      },
      {
        ...entry(
          "README.md",
          "The agent selects the closest existing branch before making minimal edits.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        semanticSignals: ["product_surface.product_loop"],
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        lineStart: 12,
        lineEnd: 18,
      },
    ];
    const firstStatement =
      "The repository organizes resume variants by branch, each with a branch-specific main.tex source file.";
    const secondStatement =
      "The tailoring workflow selects a close resume branch before applying minimal edits.";

    expect(substantialFactHighlightFallback([
      {
        statement: firstStatement,
        category: "architecture",
        confidence: "high",
        sensitivityFlag: false,
        citationIndexes: [1],
        reviewNotes: null,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 2,
        distinctiveness: 2,
      },
      {
        statement: secondStatement,
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        citationIndexes: [2],
        reviewNotes: null,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        distinctiveness: 3,
      },
    ], notebook)).toEqual([expect.objectContaining({
      text: firstStatement,
      citationIndexes: [1],
      visibility: "private",
    })]);
  });

  it("does not promote one medium-value product signal without corroboration", () => {
    const notebook = [{
      ...entry("README.md", "The README describes one small product behavior."),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["product_surface.product_loop"],
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
    }];

    expect(substantialFactHighlightFallback([{
      statement: "The product exposes one small documented behavior.",
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      distinctiveness: 2,
    }], notebook)).toEqual([]);
  });

  it("does not borrow product corroboration from another repository", () => {
    const first = {
      ...entry("README.md", "Repository one documents a single product behavior."),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["product_surface.product_loop"],
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      repository: "example/one",
    };
    const second = {
      ...entry("README.md", "Repository two documents a different product behavior."),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["product_surface.product_loop"],
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      repository: "example/two",
    };

    expect(substantialFactHighlightFallback([{
      statement: "Repository one exposes one documented product behavior.",
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      distinctiveness: 2,
    }], [first, second])).toEqual([]);
  });

  it("does not use duplicate citations as corroboration", () => {
    const repeated = {
      ...entry(
        "README.md",
        "The agent finds the closest resume branch before making minimal edits.",
      ),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["product_surface.product_loop"],
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
    };

    expect(substantialFactHighlightFallback([{
      statement: "The product documents one resume-selection behavior.",
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1, 2],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 2,
      technicalDifficulty: 3,
      distinctiveness: 2,
    }], [repeated, { ...repeated }])).toEqual([]);
  });

  it("preserves the model's no-Highlight decision for candidate-level reconciliation", () => {
    const statement =
      "The application combines signed-session rotation with scoped authorization for protected project data.";
    const notebook = [
      {
        ...entry("src/auth/session-service.ts", statement),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
      },
      {
        ...entry(
          "src/auth/policy.ts",
          "The authorization policy enforces scoped access before protected project data is returned.",
        ),
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
      },
    ];
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Workbase",
      subsystemKey: "project_domain:auth",
      notebook,
      coverageGaps: [],
      result: {
        facts: [{
          statement,
          category: "architecture",
          confidence: "high",
          sensitivityFlag: false,
          citationIndexes: [1, 2],
          productImportance: 5,
          implementationBreadth: 4,
          technicalDifficulty: 4,
          distinctiveness: 4,
          reviewNotes: null,
        }],
        highlights: [],
        unresolvedQuestions: ["Model synthesis fell back after a structured-output failure."],
        approvalEligible: false,
      },
      tokenUsage: [],
    });

    expect(finalized).toMatchObject({
      approvalEligible: false,
      highlights: [],
    });
  });

  it("does not prepend deterministic baselines to a model synthesis result", () => {
    const notebook = [
      {
        ...entry("src/workflows/job-runner.ts", "The runner resumes a checkpointed job."),
        semanticSignals: ["workflow_orchestration.shared_refresh_owner_recovery"],
      },
      {
        ...entry("src/workflows/job-policy.ts", "The policy bounds automatic retry."),
        semanticSignals: ["workflow_orchestration.reconciliation_retry_boundary"],
      },
    ];
    expect(requiredSemanticBaselineFacts("workflow_orchestration", notebook)).not.toEqual([]);
    const modelFact = {
      statement: "The workflow resumes checkpointed jobs under a bounded retry policy.",
      category: "architecture" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1, 2],
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
      reviewNotes: null,
    };

    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Workbase",
      subsystemKey: "workflow_orchestration",
      notebook,
      coverageGaps: [],
      result: { facts: [modelFact], highlights: [], unresolvedQuestions: [] },
      tokenUsage: null,
    });

    expect(finalized.facts).toEqual([modelFact]);
  });

  it("turns synthesis fallback into a repository-scoped coverage gap", () => {
    const statement =
      "The application combines signed-session rotation with scoped authorization for protected project data.";
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "acme/ledger-platform",
      subsystemKey: "project_domain:auth",
      notebook: [{
        ...entry("src/auth/session-service.ts", statement),
        repository: "acme/ledger-platform",
        evidenceMode: "semantic",
        semanticStatus: "succeeded",
      }],
      coverageGaps: [],
      result: {
        ...fallbackSubsystemSynthesis("project_domain:auth", [{
          ...entry("src/auth/session-service.ts", statement),
          repository: "acme/ledger-platform",
          evidenceMode: "semantic",
          semanticStatus: "succeeded",
        }]),
        approvalEligible: false,
        synthesisFallbackReason:
          "high-effort synthesis did not return a supported structured result.",
      },
      tokenUsage: null,
    });

    expect(finalized.approvalEligible).toBe(false);
    expect(finalized.coverageGaps).toEqual([
      "Repository acme/ledger-platform used deterministic subsystem synthesis because high-effort synthesis did not return a supported structured result.",
    ]);
    expect(finalized.unresolvedQuestions).toEqual(expect.arrayContaining(finalized.coverageGaps));
  });

  it("does not promote low-value or deterministic-anchor facts", () => {
    const lowValue = {
      statement: "The repository includes a small formatting helper.",
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      productImportance: 2,
      implementationBreadth: 1,
      technicalDifficulty: 1,
      distinctiveness: 1,
      reviewNotes: null,
    };
    expect(substantialFactHighlightFallback(
      [lowValue],
      [{
        ...entry("src/format.ts"),
        evidenceMode: "semantic",
        semanticStatus: "succeeded",
        semanticSignals: [],
        productImportance: 2,
        implementationBreadth: 1,
        technicalDifficulty: 1,
      }],
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{
        ...lowValue,
        productImportance: 5,
        implementationBreadth: 5,
        technicalDifficulty: 5,
        distinctiveness: 5,
      }],
      [{
        ...entry("src/format.ts"),
        evidenceMode: "semantic",
        semanticStatus: "succeeded",
        semanticSignals: [],
        productImportance: 2,
        implementationBreadth: 1,
        technicalDifficulty: 1,
      }],
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{
        ...lowValue,
        productImportance: 5,
        implementationBreadth: 5,
        technicalDifficulty: 5,
        distinctiveness: 5,
      }],
      [{
        ...entry("src/format.ts"),
        evidenceMode: "semantic",
        semanticStatus: "succeeded",
        semanticSignals: ["product_surface.product_loop"],
        productImportance: 1,
        implementationBreadth: 2,
        technicalDifficulty: 3,
      }],
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{
        ...lowValue,
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 4,
        distinctiveness: 4,
      }],
      [{ ...entry("README.md"), evidenceMode: "deterministic_anchor" }],
    )).toEqual([]);
  });

  it("fails closed for sensitive, uncertain, degraded, invalid, or overlong fact promotion", () => {
    const semanticNotebook = [{
      ...entry("src/auth/session-service.ts"),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
    }];
    const substantial = {
      statement: "The session service rotates durable signed-session state across authenticated requests.",
      category: "architecture" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
      reviewNotes: null,
    };

    expect(substantialFactHighlightFallback(
      [{ ...substantial, sensitivityFlag: true }],
      semanticNotebook,
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{ ...substantial, confidence: "medium" }],
      semanticNotebook,
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [substantial],
      [{ ...semanticNotebook[0]!, semanticStatus: "degraded" }],
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{ ...substantial, citationIndexes: [2] }],
      semanticNotebook,
    )).toEqual([]);
    expect(substantialFactHighlightFallback(
      [{ ...substantial, statement: `A substantial claim ${"with supported detail ".repeat(20)}` }],
      semanticNotebook,
    )).toEqual([]);
  });

  it("promotes a substantial exact fact for a generic selected project domain", () => {
    const notebook = [{
      ...entry(
        "src/payments/charge-service.ts",
        "The charge service idempotently records a payment before publishing its receipt.",
      ),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
    }];
    const synthesis = exactSinglePathProjectDomainSynthesis(
      "project_domain:payments",
      notebook,
    );

    expect(substantialFactHighlightFallback(
      synthesis?.facts ?? [],
      notebook,
    )).toEqual([expect.objectContaining({
      text: notebook[0]!.statement,
      citationIndexes: [1],
      visibility: "private",
    })]);
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
    expect(semanticFactsForSubsystem({ ...base, path: "README.md" }, "ai_runtime")).toEqual([]);
    expect(semanticFactsForSubsystem({ ...base, path: "poc/export/index.js" }, "ai_runtime")).toHaveLength(1);
    expect(semanticFactsForSubsystem({ ...base, path: "examples/quickstart/server.ts" }, "ai_runtime")).toHaveLength(1);
    expect(semanticFactsForSubsystem({ ...base, path: "examples/config/request.json" }, "ai_runtime")).toEqual([]);
    expect(semanticFactsForSubsystem({ ...base, path: "fixtures/server.ts" }, "ai_runtime")).toEqual([]);
  });

  it("creates a capability-level AI runtime fact from clause-level semantic observations", () => {
    const result = fallbackSubsystemSynthesis("ai_runtime", [
      entry("src/lib/openrouter-client.ts", "OpenRouter chat and tool-loop transports enforce strict ZDR and required-parameter routing with reported usage cost."),
      entry("src/services/bedrock-runtime.ts", "Configured OpenRouter profiles are primary while the Bedrock transport remains a controlled rollback."),
      entry("src/lib/bedrock-converse-agent.ts", "Provider-neutral stop and usage normalization enforces maxIterations, maxToolCalls, and maxTotalTokens."),
      entry("src/lib/bedrock-converse-agent.ts", "Credential-safe event telemetry removes credentials before events are exposed."),
    ]);

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining("supports OpenRouter"),
      confidence: "high",
      citationIndexes: [1, 2, 3, 4],
    })]);
    expect(result.highlights).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("supports OpenRouter"),
        visibility: "private",
        confidence: "high",
        citationIndexes: [1, 2, 3, 4],
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
    const structuralEntries = [
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol startKnowledgeRefresh."),
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol analyzeKnowledgeRefreshBatch."),
      entry("src/services/repository-knowledge-synthesis-service.ts", "src/services/repository-knowledge-synthesis-service.ts defines the symbol synthesizeRepositoryKnowledge."),
      entry("src/services/knowledge-reconciliation-service.ts", "src/services/knowledge-reconciliation-service.ts defines the symbol reconcileRepositoryKnowledge."),
      entry("src/services/knowledge-staleness-service.ts", "src/services/knowledge-staleness-service.ts defines the symbol reconcileStaleKnowledge."),
    ];
    const result = derivedRepositoryKnowledgeLifecycleFact([
      ...structuralEntries,
      entry("src/services/knowledge-refresh-service.ts", "repairKnowledgeCoverageGaps attempts semantic orchestration and uses the legacy implementation as a fallback."),
    ]);

    expect(result).toMatchObject({
      category: "architecture",
      confidence: "high",
      productImportance: 5,
      implementationBreadth: 5,
      distinctiveness: 5,
      citationIndexes: [1, 2, 3, 4, 5, 6],
    });
    expect(result?.statement).toContain("orchestrated semantic coverage repair");
    expect(derivedRepositoryKnowledgeLifecycleFact(structuralEntries)).toBeNull();

    const synthesisSupported = derivedRepositoryKnowledgeLifecycleFact([
      ...structuralEntries,
      entry(
        "src/services/repository-knowledge-synthesis-service.ts",
        "SynthesisNotebookEntry tracks full provenance for repository, commitSha, blobSha, path, line range, and changeType supporting incremental knowledge updates.",
      ),
    ]);
    expect(synthesisSupported?.statement).toContain("commit-pinned file and line provenance");
    expect(synthesisSupported?.citationIndexes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(derivedRepositoryKnowledgeLifecycleFact([
      ...structuralEntries,
      {
        ...entry(
          "src/services/repository-knowledge-synthesis-service.ts",
          "SynthesisNotebookEntry tracks full provenance for repository, commitSha, blobSha, path, line range, and changeType supporting incremental knowledge updates.",
        ),
        confidence: "low",
      },
    ])).toBeNull();
    expect(derivedRepositoryKnowledgeLifecycleFact([
      ...structuralEntries,
      {
        ...entry(
          "src/services/repository-knowledge-synthesis-service.ts",
          "SynthesisNotebookEntry tracks full provenance for repository, commitSha, blobSha, path, line range, and changeType supporting incremental knowledge updates.",
        ),
        sensitivityFlag: true,
      },
    ])).toBeNull();
  });

  it("admits Workbase system memory only for the canonical repository identity", () => {
    expect(isWorkbaseRepositoryIdentity("arkb75/Workbase")).toBe(true);
    expect(isWorkbaseRepositoryIdentity("/ARKB75/Workbase.git/")).toBe(true);
    expect(isWorkbaseRepositoryIdentity("attacker/Workbase")).toBe(false);

    const statement = "Workbase's documented product flow connects Work Items and attached sources to repository knowledge refresh, automatically applies safe facts and Highlights for later review, quarantines unsafe candidates, and generates career artifacts from approved non-sensitive Highlights.";
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "project_fact",
      subsystemKey: "product_surface",
      statement,
    })).toBe(true);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "highlight",
      subsystemKey: "product_surface",
      text: "Connected Work Items, repository knowledge, review-later memory, and approved career artifacts in one product workflow",
      summary: statement,
    })).toBe(true);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "highlight",
      subsystemKey: "ingestion_integrations",
      text: "Built project-scoped GitHub evidence ingestion with bounded repository import and code exploration",
      summary: "Repository exploration enforces tree/search/read/byte/time budgets and returns typed failures for exhausted budgets, oversized or binary files, unsupported encodings, and unavailable paths.",
    })).toBe(true);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "highlight",
      subsystemKey: "review_ui",
      text: "The project workspace review UI combines URL-addressable views, multi-field Highlight lifecycle state, artifact-to-Highlight traceability, structured candidate-review metadata, and inline citation navigation to project evidence.",
      summary: "The project workspace review UI combines URL-addressable views, multi-field Highlight lifecycle state, artifact-to-Highlight traceability, structured candidate-review metadata, and inline citation navigation to project evidence.",
    })).toBe(true);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "project_fact",
      subsystemKey: "product_surface",
      statement: `${statement} User note.`,
    })).toBe(false);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "project_fact",
      subsystemKey: "product_surface",
      statement: "Workbase is a career-content application that ingests project evidence, supports human review, and generates resume bullets, LinkedIn entries, and project summaries.",
    })).toBe(true);
    expect(matchesWorkbaseDeterministicDefinitionIdentity({
      kind: "highlight",
      subsystemKey: "ai_runtime",
      text: "The AI runtime wraps Bedrock Converse with normalized stop and usage metadata, abort support, enforced iteration/tool/token budgets, and credential redaction before events are exposed.",
      summary: "The AI runtime wraps Bedrock Converse with normalized stop and usage metadata, abort support, enforced iteration/tool/token budgets, and credential redaction before events are exposed.",
    })).toBe(true);
  });

  it("does not derive Workbase lifecycle memory from external or spoofed notebooks", () => {
    const structuralEntries = [
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol startKnowledgeRefresh."),
      entry("src/services/knowledge-refresh-service.ts", "src/services/knowledge-refresh-service.ts defines the symbol analyzeKnowledgeRefreshBatch."),
      entry("src/services/repository-knowledge-synthesis-service.ts", "src/services/repository-knowledge-synthesis-service.ts defines the symbol synthesizeRepositoryKnowledge."),
      entry("src/services/knowledge-reconciliation-service.ts", "src/services/knowledge-reconciliation-service.ts defines the symbol reconcileRepositoryKnowledge."),
      entry("src/services/knowledge-staleness-service.ts", "src/services/knowledge-staleness-service.ts defines the symbol reconcileStaleKnowledge."),
      entry("src/services/knowledge-refresh-service.ts", "repairKnowledgeCoverageGaps attempts semantic orchestration and uses the legacy implementation as a fallback."),
    ];
    const external = structuralEntries.map((item) => ({
      ...item,
      repository: "attacker/Workbase",
    }));
    expect(derivedRepositoryKnowledgeLifecycleFact(external)).toBeNull();

    const mixed = structuralEntries.map((item, index) => index === 0
      ? item
      : { ...item, repository: "arkb75/Resume" });
    expect(derivedRepositoryKnowledgeLifecycleFact(mixed)).toBeNull();
    expect(isBroadSemanticRepositoryLifecycleFact({
      statement: "Repository refresh and semantic analysis feed synthesis, reconciliation, and stale-knowledge invalidation.",
      category: "architecture",
      confidence: "high",
      sensitivityFlag: false,
      citationIndexes: [1, 2, 3],
      reviewNotes: null,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
      distinctiveness: 5,
    }, external.slice(0, 3))).toBe(false);
  });

  it("does not let high model scores turn one schema detail into a broad lifecycle baseline", () => {
    const notebook = [entry(
      "src/services/repository-knowledge-synthesis-service.ts",
      "The synthesisSchema defines up to three facts, two highlights, and integer ranking fields.",
    )];
    const schemaDetail = {
      statement: "The synthesisSchema defines up to three facts, two highlights, and integer ranking fields.",
      category: "configuration" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
      distinctiveness: 5,
    };
    const broad = {
      ...schemaDetail,
      statement: "Repository refresh and semantic analysis feed synthesis, reconciliation, and stale-knowledge invalidation.",
      citationIndexes: [1, 2, 3],
    };
    const broadNotebook = [
      entry("src/services/knowledge-refresh-service.ts", "Repository refresh performs bounded semantic analysis."),
      entry("src/services/repository-knowledge-synthesis-service.ts", "Repository synthesis emits durable knowledge."),
      entry("src/services/knowledge-reconciliation-service.ts", "Reconciliation invalidates stale knowledge."),
    ];

    expect(isBroadSemanticRepositoryLifecycleFact(schemaDetail, notebook)).toBe(false);
    expect(isBroadSemanticRepositoryLifecycleFact(broad, notebook)).toBe(false);
    expect(isBroadSemanticRepositoryLifecycleFact(broad, broadNotebook)).toBe(true);
    expect(isBroadSemanticRepositoryLifecycleFact({
      ...broad,
      citationIndexes: [1, 9],
    }, broadNotebook)).toBe(false);
    expect(isBroadSemanticRepositoryLifecycleFact(broad, [{
      ...notebook[0]!,
      evidenceMode: "deterministic_anchor",
    }])).toBe(false);
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
        entry("app/work-items/[id]/page.tsx", "URL search params drive tab selection and context within the project workspace."),
        entry("app/work-items/[id]/page.tsx", "Highlights use a multi-field lifecycle model supporting per-highlight review decisions."),
        entry("app/work-items/[id]/page.tsx", "Artifact results track usedHighlightIds and their contributing Highlights."),
        entry("components/chat/project-chat-workspace.tsx", "ChatWorkspaceCandidate models kind, status, and candidate-review metadata."),
        entry("components/chat/project-chat-workspace.tsx", "citationHref maps citations to a work-item tab URL for review evidence."),
      ],
      "review UI",
    ],
    [
      "workflow_orchestration",
      [
        entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol projectChatTurnWorkflow."),
        entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol repositoryKnowledgeRefreshWorkflow."),
        entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol artifactGenerationWorkflow."),
        entry("workflows/project-chat.ts", "workflows/project-chat.ts defines a durable workflow entrypoint."),
        entry("workflows/project-chat.ts", "workflows/project-chat.ts uses a durable approval hook to pause and resume work."),
      ],
      "durable workflow entrypoints",
    ],
    [
      "tests_operations",
      [
        entry("src/evals/__tests__/project-chat-application-runner.test.ts", "The project-chat-application-runner test asserts exactly 11 scenario IDs."),
        entry("src/evals/__tests__/project-chat-application-runner.test.ts", "The project-chat-application-runner zeroMetrics fixture enforces zero-call cache-reuse behavior."),
        entry("src/evals/__tests__/project-chat-application-runner.test.ts", "The project-chat-application-runner automatically prepends prerequisite conversation turns."),
      ],
      "Application-level automated tests",
    ],
  ])("creates a broad deterministic baseline for %s", (subsystemKey, notebook, expected) => {
    const result = fallbackSubsystemSynthesis(subsystemKey, notebook);

    expect(result.facts).toEqual([expect.objectContaining({
      statement: expect.stringContaining(expected),
      confidence: "high",
    })]);
    expect(result.facts[0]?.citationIndexes.length).toBeGreaterThanOrEqual(3);
  });

  it("does not promote anchor-only inventory into an open-ended Highlight", () => {
    const notebook = [
      entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol projectChatTurnWorkflow."),
      entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol repositoryKnowledgeRefreshWorkflow."),
      entry("workflows/project-chat.ts", "workflows/project-chat.ts defines the symbol artifactGenerationWorkflow."),
      entry("workflows/project-chat.ts", "workflows/project-chat.ts defines a durable workflow entrypoint."),
      entry("workflows/project-chat.ts", "workflows/project-chat.ts uses a durable approval hook to pause and resume work."),
    ].map((item) => ({ ...item, evidenceMode: "deterministic_anchor" as const }));

    const result = fallbackSubsystemSynthesis("workflow_orchestration", notebook);

    expect(modelEligibleSynthesisNotebook(notebook)).toEqual([]);
    const semantic = { ...entry("src/workflows/run.ts"), evidenceMode: "semantic" as const };
    expect(modelEligibleSynthesisNotebook([entry("unknown.ts"), semantic])).toEqual([semantic]);
    expect(result.facts[0]?.statement).toContain("defines durable workflow entrypoints");
    expect(result.highlights).toEqual([]);
  });

  it("synthesizes the canonical product flow from exact README anchors without creating a Highlight", async () => {
    const readme = [
      "# Workbase",
      "",
      "## Product loop",
      "",
      "2. Create a Work Item",
      "3. Attach manual notes and import a real GitHub repository",
      "4. Refresh commit-pinned repository knowledge and cluster Evidence into work themes",
      "5. Auto-apply supported, non-sensitive Project Facts and Highlights as private project memory",
      "6. Surface every new, revised, stale, or superseded item in the review inbox while quarantining unsafe or insufficiently supported candidates",
      "8. Generate resume bullets, a LinkedIn-style entry, or a short project summary from approved, non-sensitive Highlights only",
    ].join("\n");
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "arkb75/Workbase",
      commitSha: "a".repeat(40),
      path: "README.md",
      content: readme,
    }]);
    const anchorFacts = (analysis?.facts ?? []).filter((fact) =>
      deterministicSynthesisAnchorSubsystems(fact, "README.md").includes("product_surface")
    );
    const notebook = anchorFacts.map((fact) => ({
      ...entry("README.md", fact.statement),
      lineStart: fact.lineStart,
      lineEnd: fact.lineEnd,
      category: fact.category,
      evidenceMode: "deterministic_anchor" as const,
    }));

    expect(anchorFacts).toHaveLength(6);
    expect(requiredSemanticBaselineFacts("product_surface", notebook)).toEqual([
      expect.objectContaining({
        statement: expect.stringContaining("connects Work Items and attached sources"),
        confidence: "high",
        citationIndexes: [1, 4, 5, 6, 2, 3],
      }),
    ]);
    const result = fallbackSubsystemSynthesis("product_surface", notebook);
    expect(result.facts).toEqual([
      expect.objectContaining({
        statement: expect.stringContaining("generates career artifacts from approved non-sensitive Highlights"),
        citationIndexes: [1, 4, 5, 6, 2, 3],
      }),
    ]);
    expect(result.highlights).toEqual([]);

    const incompleteHybridNotebook = [
      {
        ...notebook[0]!,
        evidenceMode: "semantic" as const,
        semanticSignals: ["product_surface.product_loop"],
      },
      ...notebook.slice(1, 4),
    ];
    expect(requiredSemanticBaselineFacts("product_surface", incompleteHybridNotebook)).toEqual([]);
  });

  it("does not inject product-specific anchors without a cartographer-selected runtime domain", async () => {
    const readme = [
      "2. Create a Work Item",
      "3. Attach manual notes and import a real GitHub repository",
      "4. Refresh commit-pinned repository knowledge and cluster Evidence into work themes",
      "5. Auto-apply supported, non-sensitive Project Facts and Highlights as private project memory",
      "6. Surface every new, revised, stale, or superseded item in the review inbox while quarantining unsafe or insufficiently supported candidates",
      "8. Generate resume bullets, a LinkedIn-style entry, or a short project summary from approved, non-sensitive Highlights only",
    ].join("\n");
    const [analysis] = await analyzeRepositoryFiles([{
      repository: "arkb75/Workbase",
      commitSha: "a".repeat(40),
      path: "README.md",
      content: readme,
    }]);
    vi.spyOn(prisma.knowledgeRefreshRun, "findUniqueOrThrow").mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      qualityStatus: "degraded",
      orchestration: null,
      targetHeads: [{
        sourceId: "source-1",
        repository: "arkb75/Workbase",
        branch: "main",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      workItem: { title: "Workbase" },
      snapshots: [{
        sourceId: "source-1",
        commitSha: "a".repeat(40),
        files: [{
          path: "README.md",
          blobSha: "blob-readme",
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          analysis,
          semanticRefreshRunId: null,
          semanticAnalyzerVersion: null,
          semanticStatus: "failed",
          semanticAnalysis: null,
          changeType: "modified",
        }],
      }],
    } as never);

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1", { fallbackOnly: true });

    expect(synthesis).toEqual([]);
  });

  it("makes resumed deterministic synthesis review-only and audibly degraded", async () => {
    const statement =
      "The charge service records an idempotency key before publishing a payment receipt.";
    const path = "src/payments/charge-service.ts";
    const semanticAnalysis: RepositoryFileAnalysis = {
      path,
      summary: "Idempotent payment receipt publication.",
      subsystemKeys: ["project_domain:payments"],
      responsibilities: [],
      symbols: [],
      dependencies: [],
      architectureSignals: [],
      userFacingCapabilities: [],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
      analysisMode: "semantic",
      facts: [{
        statement,
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 10,
        lineEnd: 18,
        productImportance: 5,
        implementationBreadth: 3,
        technicalDifficulty: 4,
        path,
        subsystemKeys: ["project_domain:payments"],
        semanticSignals: ["domain.payment_idempotency"],
        evidenceMode: "semantic",
      }],
    };
    vi.spyOn(prisma.knowledgeRefreshRun, "findUniqueOrThrow").mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-item-1",
      orchestration: {
        packages: [{ capabilityKeys: ["project_domain:payments"] }],
      },
      targetHeads: [{
        sourceId: "source-1",
        repository: "acme/ledger-platform",
        branch: "main",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        committedAt: null,
        resolvedAt: new Date().toISOString(),
      }],
      workItem: { title: "Ledger Platform" },
      snapshots: [{
        sourceId: "source-1",
        commitSha: "a".repeat(40),
        files: [{
          path,
          blobSha: "blob-charge-service",
          analyzerVersion: null,
          analysis: null,
          semanticRefreshRunId: "refresh-1",
          semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
          semanticStatus: "succeeded",
          semanticAnalysis,
          changeType: "modified",
        }],
      }],
    } as never);

    const synthesis = await synthesizeRepositoryKnowledge("refresh-1", { fallbackOnly: true });

    expect(synthesis).toEqual([
      expect.objectContaining({
        subsystemKey: "project_domain:payments",
        approvalEligible: false,
        facts: [expect.objectContaining({ statement, citationIndexes: [1] })],
        coverageGaps: [
          expect.stringMatching(/^Repository acme\/ledger-platform used deterministic subsystem synthesis/),
        ],
      }),
    ]);

    vi.stubEnv("WORKBASE_REPOSITORY_SYNTHESIS_MODE", "deterministic");
    const explicitDeterministic = await synthesizeRepositoryKnowledge("refresh-1");
    expect(explicitDeterministic).toEqual([
      expect.objectContaining({
        subsystemKey: "project_domain:payments",
        approvalEligible: false,
        facts: [expect.objectContaining({ statement, citationIndexes: [1] })],
      }),
    ]);
  });

  it("never injects Workbase product memory into another repository", () => {
    const notebook = [
      {
        ...entry(
          "README.md",
          "The resume agent selects the closest branch for a job description and edits main.tex with minimal changes.",
        ),
        repository: "arkb75/Resume",
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        semanticSignals: ["product_surface.product_loop"],
      },
      {
        ...entry(
          "README.md",
          "Compiled PDFs are build artifacts; main.tex is the approved source artifact.",
        ),
        repository: "arkb75/Resume",
        evidenceMode: "semantic" as const,
        semanticStatus: "succeeded" as const,
        semanticSignals: [
          "product_surface.safe_auto_apply",
          "product_surface.unsafe_quarantine",
          "product_surface.approved_artifacts",
        ],
      },
    ];

    expect(requiredSemanticBaselineFacts("product_surface", notebook)).toEqual([]);
    const fallback = fallbackSubsystemSynthesis("product_surface", notebook);
    expect(fallback.facts).toEqual([
      expect.objectContaining({
        statement: notebook[0]!.statement,
        citationIndexes: [1],
      }),
    ]);
    expect(fallback.facts.map((fact) => fact.statement).join(" "))
      .not.toMatch(/Workbase|career artifacts|Work Items/u);

    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "arkb75/Resume",
      subsystemKey: "product_surface",
      notebook,
      coverageGaps: [],
      result: {
        facts: [{
          statement: notebook[0]!.statement,
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          citationIndexes: [1],
          reviewNotes: null,
          productImportance: 3,
          implementationBreadth: 2,
          technicalDifficulty: 3,
          distinctiveness: 3,
        }],
        highlights: [],
        unresolvedQuestions: [],
      },
      tokenUsage: null,
    });
    expect(finalized.facts.map((fact) => fact.statement).join(" "))
      .not.toMatch(/Workbase|career artifacts|Work Items/u);
  });

  it("preserves supported workflow retry, idempotency, and recovery facets across all three boundaries", () => {
    const withSignal = (
      path: string,
      statement: string,
      semanticSignals: string[],
    ) => ({ ...entry(path, statement), semanticSignals });
    const notebook = [
      withSignal("workflows/project-chat.ts", "Project chat runs as a durable workflow.", ["workflow_orchestration.chat_workflow"]),
      withSignal("workflows/project-chat.ts", "Repository refresh runs as a durable workflow.", ["workflow_orchestration.repository_refresh_workflow"]),
      withSignal("workflows/project-chat.ts", "Artifact generation runs as a durable workflow.", ["workflow_orchestration.artifact_workflow"]),
      withSignal("workflows/project-chat.ts", "A durable review hook pauses and resumes work.", ["workflow_orchestration.approval_pause_resume"]),
      withSignal("workflows/project-chat.ts", "Repository reconciliation disables automatic retries because its versioned knowledge writes are not independently checkpointed.", ["workflow_orchestration.reconciliation_retry_boundary"]),
      withSignal("workflows/project-chat.ts", "A waiting workflow can claim a released shared refresh and resume checkpointed work.", ["workflow_orchestration.shared_refresh_owner_recovery"]),
      withSignal("src/services/agent-run-workflow-start-service.ts", "Workflow startup conditionally reserves an unstarted queued run and reuses an attached workflow identifier.", ["workflow_orchestration.workflow_start_reservation"]),
      withSignal("src/services/project-chat-store.ts", "Chat-run creation locks the thread, returns a user-scoped idempotency-key match, and rejects another active run.", ["workflow_orchestration.chat_run_idempotency"]),
      withSignal("src/services/project-chat-store.ts", "Agent-run event appends are serialized under a run lock.", ["workflow_orchestration.event_sequence_guard"]),
      withSignal("src/services/project-chat-store.ts", "Completion locks persisted state and does not rewrite terminal runs.", ["workflow_orchestration.terminal_write_guard"]),
    ];

    const result = fallbackSubsystemSynthesis("workflow_orchestration", notebook);
    expect(result.facts).toEqual([
      expect.objectContaining({
        statement: expect.stringContaining("durable workflow entrypoints"),
        citationIndexes: [1, 2, 3, 4],
      }),
      expect.objectContaining({
        statement: expect.stringContaining("persistence boundaries"),
        citationIndexes: [7, 8, 9, 10],
      }),
      expect.objectContaining({
        statement: expect.stringContaining("released shared refresh"),
        citationIndexes: [6, 5],
      }),
    ]);

    // Explicit deterministic mode can still recover every supported facet.
    expect(requiredSemanticBaselineFacts("workflow_orchestration", notebook))
      .toEqual(result.facts);

    const withoutTerminalGuard = notebook.filter((entry) =>
      !entry.semanticSignals?.includes("workflow_orchestration.terminal_write_guard")
    );
    const partial = requiredSemanticBaselineFacts("workflow_orchestration", withoutTerminalGuard);
    expect(partial.some((fact) => fact.statement.includes("persistence boundaries"))).toBe(false);
    expect(partial.some((fact) => fact.statement.includes("released shared refresh"))).toBe(true);
  });

  it("rebuilds the broad review workspace from current semantic concepts instead of promoting one narrow source action", () => {
    const notebook = [
      {
        ...entry(
          "app/work-items/[id]/page.tsx",
          "GitHub repository sources can be attached or re-imported through a source-row action.",
        ),
        productImportance: 5,
        implementationBreadth: 5,
        technicalDifficulty: 5,
      },
      entry(
        "app/work-items/[id]/page.tsx",
        "Highlights are mapped with a multi-field lifecycle model supporting per-highlight review decisions in the UI.",
      ),
      entry(
        "app/work-items/[id]/page.tsx",
        "URL search params fully drive tab selection and context within the workspace.",
      ),
      entry(
        "app/work-items/[id]/page.tsx",
        "Artifact results track usedHighlightIds, linking generated artifacts back to their contributing Highlights.",
      ),
      entry(
        "components/chat/project-chat-workspace.tsx",
        "ChatWorkspaceCandidate models knowledge-update candidate kind, status, visibility, sensitivity, and confidence metadata.",
      ),
      entry(
        "components/chat/project-chat-workspace.tsx",
        "citationHref routes each citation kind to a specific work-item tab, exposing durable memory as navigable review targets.",
      ),
    ];

    const result = fallbackSubsystemSynthesis("review_ui", notebook);

    expect(result.facts[0]).toMatchObject({
      statement: expect.stringContaining("project workspace review UI"),
      productImportance: 5,
      implementationBreadth: 5,
    });
    expect(new Set(result.facts[0]?.citationIndexes)).toEqual(new Set([2, 3, 4, 5, 6]));
    expect(result.facts[0]?.statement).not.toContain("attached or re-imported");
    expect(result.highlights[0]).toMatchObject({
      summary: expect.stringContaining("artifact-to-Highlight traceability"),
    });
    expect(new Set(result.highlights[0]?.citationIndexes)).toEqual(new Set([2, 3, 4, 5, 6]));
    expect(result.highlights[0]?.text.length).toBeLessThanOrEqual(240);
  });

  it("rebuilds broad capabilities from stable semantic signals despite model paraphrasing", () => {
    const notebook = [
      {
        ...entry("app/work-items/[id]/page.tsx", "Query parameters preserve the selected project view across navigation."),
        semanticSignals: ["review_ui.url_addressable_views"],
      },
      {
        ...entry("app/work-items/[id]/page.tsx", "Each accomplishment carries independent review and lifecycle attributes."),
        semanticSignals: ["review_ui.highlight_lifecycle"],
      },
      {
        ...entry("app/work-items/[id]/page.tsx", "Generated outputs retain links to the accomplishments that supplied them."),
        semanticSignals: ["review_ui.artifact_highlight_traceability"],
      },
      {
        ...entry("components/chat/project-chat-workspace.tsx", "Review rows expose typed state and policy fields for proposed knowledge."),
        semanticSignals: ["review_ui.candidate_metadata"],
      },
      {
        ...entry("components/chat/project-chat-workspace.tsx", "Source badges navigate into the relevant project evidence view."),
        semanticSignals: ["review_ui.citation_navigation"],
      },
    ];

    const result = fallbackSubsystemSynthesis("review_ui", notebook);

    expect(result.facts[0]).toMatchObject({
      statement: expect.stringContaining("project workspace review UI"),
      citationIndexes: [1, 2, 3, 4, 5],
    });
    expect(result.highlights[0]?.summary).toContain("inline citation navigation");
  });

  it("completes a partially signaled broad capability with per-facet regex fallback", () => {
    const notebook = [
      {
        ...entry("app/work-items/[id]/page.tsx", "Query parameters preserve the selected project view across navigation."),
        semanticSignals: ["review_ui.url_addressable_views"],
      },
      {
        ...entry("app/work-items/[id]/page.tsx", "Each accomplishment carries independent review and lifecycle attributes."),
        semanticSignals: ["review_ui.highlight_lifecycle"],
      },
      {
        ...entry("app/work-items/[id]/page.tsx", "Generated outputs retain links to the accomplishments that supplied them."),
        semanticSignals: ["review_ui.artifact_highlight_traceability"],
      },
      {
        ...entry("components/chat/project-chat-workspace.tsx", "Review rows expose typed state and policy fields for proposed knowledge."),
        semanticSignals: ["review_ui.candidate_metadata"],
      },
      entry(
        "components/chat/project-chat-workspace.tsx",
        "citationHref routes each citation to a work-item tab with review evidence.",
      ),
    ];

    const selected = selectSubsystemSynthesisNotebook("review_ui", notebook);
    const result = fallbackSubsystemSynthesis("review_ui", selected);

    expect(selected).toHaveLength(5);
    expect(result.facts[0]).toMatchObject({
      statement: expect.stringContaining("project workspace review UI"),
      citationIndexes: [1, 2, 3, 4, 5],
    });
  });

  it("reserves every broad review-UI facet before high-scoring notebook distractors", () => {
    const required = [
      entry("app/work-items/[id]/page.tsx", "URL search params fully drive tab selection and context within the workspace."),
      entry("app/work-items/[id]/page.tsx", "Highlights use a multi-field lifecycle model supporting per-highlight review decisions."),
      entry("app/work-items/[id]/page.tsx", "Artifact results track usedHighlightIds and their contributing Highlights."),
      entry("components/chat/project-chat-workspace.tsx", "ChatWorkspaceCandidate models candidate kind, status, and candidate-review metadata."),
      entry("components/chat/project-chat-workspace.tsx", "citationHref routes each citation to a work-item tab with review evidence."),
    ];
    const distractors = Array.from({ length: 20 }, (_, index) => ({
      ...entry(`components/unrelated-${index}.tsx`, `A high-scoring unrelated UI observation ${index}.`),
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
    }));

    const selected = selectSubsystemSynthesisNotebook("review_ui", [...distractors, ...required]);

    expect(selected).toHaveLength(20);
    for (const facet of required) {
      expect(selected.some((entry) => entry.statement === facet.statement)).toBe(true);
    }
    expect(fallbackSubsystemSynthesis("review_ui", selected).facts[0]?.statement)
      .toContain("project workspace review UI");
  });

  it("reserves secondary system facets before high-scoring notebook distractors", () => {
    const required = [
      entry("src/services/project-chat-agent-service.ts", "selectHistory retains the latest 12 messages within a bounded history budget."),
      entry("src/services/project-agent-harness.ts", "highAuthorityMemory admits verified_highlight and verified_project_fact sources."),
      entry("src/services/project-chat-agent-service.ts", "The latest-commit refresh target SHAs ground current answers."),
      entry("src/services/project-chat-agent-service.ts", "A retry request without supporting evidence fails closed, preventing hallucinated behavior."),
      entry("src/services/project-execution-router-service.ts", "The project execution router uses deterministic rules for high-confidence intent."),
      entry("src/services/project-execution-router-service.ts", "The project execution router selects routes within safety, budget, and attached-repository constraints."),
    ];
    const distractors = Array.from({ length: 24 }, (_, index) => ({
      ...entry(`src/services/unrelated-${index}.ts`, `A high-scoring unrelated chat observation ${index}.`),
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
    }));

    const selected = selectSubsystemSynthesisNotebook("project_chat_grounding", [...distractors, ...required]);
    const synthesis = fallbackSubsystemSynthesis("project_chat_grounding", selected);

    for (const facet of required) {
      expect(selected.some((candidate) => candidate.statement === facet.statement)).toBe(true);
    }
    expect(synthesis.facts.some((fact) =>
      fact.statement.includes("deterministic intent and safety constraints")
    )).toBe(true);
  });

  it("reserves semantic evidence before deterministic anchors across many repositories", () => {
    const semantic = Array.from({ length: 10 }, (_, index) => ({
      ...entry(
        `src/services/semantic-${index}.ts`,
        `Current-head behavior observation ${index}.`,
      ),
      sourceId: `semantic-source-${index}`,
      semanticSignals: index < 4
        ? [[
            "repository_knowledge_lifecycle.refresh_analysis",
            "repository_knowledge_lifecycle.synthesis",
            "repository_knowledge_lifecycle.reconciliation",
            "repository_knowledge_lifecycle.staleness",
          ][index]!]
        : [],
    }));
    const anchors = Array.from({ length: 20 }, (_, index) => ({
      ...entry(
        `src/services/anchor-${index}.ts`,
        `src/services/anchor-${index}.ts defines the symbol anchor${index}.`,
      ),
      sourceId: `anchor-source-${index}`,
      evidenceMode: "deterministic_anchor" as const,
    }));

    const selected = selectSubsystemSynthesisNotebook(
      "repository_knowledge_lifecycle",
      [...anchors, ...semantic],
    );

    expect(selected).toHaveLength(20);
    expect(selected.filter((candidate) => candidate.evidenceMode !== "deterministic_anchor"))
      .toHaveLength(10);
    expect(selected.filter((candidate) => candidate.evidenceMode === "deterministic_anchor"))
      .toHaveLength(10);
  });

  it("keeps required facets ahead of per-source representatives and reports overflow", () => {
    const required = [
      entry("app/work-items/[id]/page.tsx", "URL search params fully drive tab selection and context within the workspace."),
      entry("app/work-items/[id]/page.tsx", "Highlights use a multi-field lifecycle model supporting per-highlight review decisions."),
      entry("app/work-items/[id]/page.tsx", "Artifact results track usedHighlightIds and their contributing Highlights."),
      entry("components/chat/project-chat-workspace.tsx", "ChatWorkspaceCandidate models candidate kind, status, and candidate-review metadata."),
      entry("components/chat/project-chat-workspace.tsx", "citationHref routes each citation to a work-item tab with review evidence."),
    ];
    const repositories = Array.from({ length: 24 }, (_, index) => ({
      ...entry(`src/repository-${index}.ts`, `Repository ${index} contributes a current-head semantic observation.`),
      sourceId: `source-${index.toString().padStart(2, "0")}`,
      repository: `owner/repository-${index}`,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
    }));

    const selected = selectSubsystemSynthesisNotebook("review_ui", [...repositories, ...required]);
    const gaps = synthesisNotebookSourceCoverageGaps([...repositories, ...required], selected);

    expect(selected).toHaveLength(20);
    for (const facet of required) {
      expect(selected.some((candidate) => candidate.statement === facet.statement)).toBe(true);
    }
    expect(fallbackSubsystemSynthesis("review_ui", selected).facts[0]?.statement)
      .toContain("project workspace review UI");
    expect(gaps).toHaveLength(9);
    expect(gaps.every((gap) => gap.includes("could not fit"))).toBe(true);
  });

  it("keeps immutable provenance distinct and deterministically ordered across repositories", () => {
    const statement = "The workspace exposes reviewed project knowledge.";
    const repoB = {
      ...entry("app/work-items/[id]/page.tsx", statement),
      sourceId: "source-b",
      repository: "owner/repo-b",
      commitSha: "b".repeat(40),
      blobSha: "blob-shared",
    };
    const repoA = {
      ...entry("app/work-items/[id]/page.tsx", statement),
      sourceId: "source-a",
      repository: "owner/repo-a",
      commitSha: "a".repeat(40),
      blobSha: "blob-shared",
    };

    const selected = selectSubsystemSynthesisNotebook("review_ui", [repoB, repoA]);

    expect(selected).toHaveLength(2);
    expect(selected.map((candidate) => candidate.repository)).toEqual([
      "owner/repo-a",
      "owner/repo-b",
    ]);
    expect(synthesisNotebookReferenceKey(repoA)).not.toBe(
      synthesisNotebookReferenceKey({ ...repoA, path: "components/chat/project-chat-workspace.tsx" }),
    );
  });

  it("limits reusable citation lookup to requested immutable ranges and legacy blobs", () => {
    const first = entry("src/runtime.ts");
    const sameBlobSecondRange = {
      ...first,
      lineStart: 20,
      lineEnd: 25,
    };
    const secondRepository = {
      ...entry("src/runtime.ts"),
      sourceId: "source-2",
      repository: "other/repo",
      blobSha: first.blobSha,
    };

    const filters = reusableSynthesisEvidenceFilters([
      first,
      sameBlobSecondRange,
      secondRepository,
      first,
    ]);

    expect(filters).toHaveLength(5);
    expect(filters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "source-1",
        logicalKey: "github_file:src/runtime.ts:1:1",
        metadata: { path: ["blobSha"], equals: first.blobSha },
      }),
      expect.objectContaining({
        sourceId: "source-1",
        logicalKey: "github_file:src/runtime.ts:20:25",
      }),
      expect.objectContaining({
        sourceId: "source-1",
        logicalKey: null,
        metadata: { path: ["blobSha"], equals: first.blobSha },
      }),
      expect.objectContaining({
        sourceId: "source-2",
        logicalKey: null,
        metadata: { path: ["blobSha"], equals: first.blobSha },
      }),
    ]));
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
