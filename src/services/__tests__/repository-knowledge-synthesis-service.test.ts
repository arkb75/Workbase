import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/src/lib/prisma";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  allocateRepositorySynthesisClaimLimits,
  buildRepositorySynthesisBatches,
  exactSinglePathProjectDomainSynthesis,
  exactSynthesisCitationExcerpt,
  isCompleteSynthesisCitationExcerpt,
  isRepositoryOperationCommunityCandidate,
  isRepositoryOperationCommunityScope,
  fallbackSubsystemSynthesis,
  finalizeRepositorySubsystemSynthesis,
  materializeRepositoryOperationCommunities,
  modelEligibleSynthesisNotebook,
  mergeRepositorySynthesisCriticAfterRevision,
  naturalRepositorySynthesisClaimLimits,
  normalizeRepositoryHighlightText,
  projectRepositorySynthesisClaimBudget,
  applyRepositorySynthesisCritic,
  applyRepositorySynthesisRevision,
  rejectedRepositorySynthesisClaimKeys,
  repositoryOperationCommunityBudgetLimits,
  repositoryOperationCommunityCount,
  repositoryOperationCommunityCountForScope,
  repositoryOperationCommunityValidationErrors,
  repositoryEvidenceBoundaryGuidance,
  repositoryModelEligibleSynthesisInputCount,
  repositorySynthesisCriticClaims,
  repositorySynthesisCriticPayload,
  repositorySynthesisCriticValidationErrors,
  repositorySynthesisFactFloorRevisionClaimKeys,
  repositorySynthesisBatchPromptBytes,
  repositorySynthesisPromptNotebook,
  repositorySynthesisRevisionErrors,
  repositorySynthesisRevisionReplacementIsNoOp,
  repositorySynthesisRevisionCriticClaims,
  repositorySynthesisRevisionEvidenceIndexes,
  repositorySynthesisStructuralErrors,
  repositoryUserFacingCapabilityGuidance,
  reusableSynthesisEvidenceFilters,
  resolveRepositorySynthesisMode,
  repositorySynthesisSafetyGuidance,
  repositorySynthesisSchema,
  runRepositorySynthesisPrimaryBarrier,
  runOrderedSynthesisBatches,
  selectRepositoryOperationCommunityExpansions,
  selectRepositoryOperationCommunityNotebook,
  selectSubsystemSynthesisNotebook,
  semanticFactsForSubsystem,
  selectedProjectDomainKeysFromOrchestration,
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

describe("repository operation communities", () => {
  it("uses both bounded structural communities before reporting notebook loss", () => {
    const notebook = Array.from({ length: 30 }, (_entry, index) => ({
      ...entry(`src/services/operation-${index + 1}-service.ts`),
      statement: `Operation ${index + 1} applies a distinct state transition.`,
    }));

    expect(selectRepositoryOperationCommunityNotebook(
      "repository_area:intelligence",
      notebook.slice(0, 19),
    )).toHaveLength(19);
    expect(selectRepositoryOperationCommunityNotebook(
      "repository_area:application_core",
      notebook,
    )).toHaveLength(24);
    expect(selectRepositoryOperationCommunityNotebook(
      "project_domain:operations",
      notebook,
    )).toHaveLength(30);
  });

  it("bounds community counts and mapping budgets at each notebook threshold", () => {
    expect([
      0,
      1,
      6,
      7,
      12,
      13,
      24,
      25,
      36,
      72,
    ].map(repositoryOperationCommunityCount)).toEqual([
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      3,
      3,
      3,
    ]);

    expect(repositoryOperationCommunityBudgetLimits(0)).toEqual({
      maxModelCalls: 0,
      maxRepairPasses: 0,
      maxOutputTokens: 2_500,
      maxTotalTokens: 0,
    });
    expect(repositoryOperationCommunityBudgetLimits(3)).toEqual({
      maxModelCalls: 6,
      maxRepairPasses: 3,
      maxOutputTokens: 2_500,
      maxTotalTokens: 60_000,
    });

    for (const invalidLength of [-1, 1.5]) {
      expect(() => repositoryOperationCommunityCount(invalidLength)).toThrow(
        "Repository operation-community notebook length must be a non-negative integer.",
      );
      expect(() => repositoryOperationCommunityBudgetLimits(invalidLength)).toThrow(
        "Repository operation-community mapping count must be a non-negative integer.",
      );
    }
  });

  it("admits broad product, data-flow, runtime, and discovered domain scopes", () => {
    expect(isRepositoryOperationCommunityScope("project_domain:orders")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:product_surface")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:intelligence")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:automation")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:application_core")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:data_model")).toBe(true);
    expect(isRepositoryOperationCommunityScope("repository_area:integrations")).toBe(false);
    expect(isRepositoryOperationCommunityScope("repository_area:quality")).toBe(false);
  });

  it("requires seven observations and concrete path diversity for structural scopes", () => {
    const singlePath = Array.from(
      { length: 7 },
      (_item, index) => entry("src/entities/order.ts", `Order behavior ${index + 1} is implemented.`),
    );
    const multiplePaths = singlePath.map((item, index) => ({
      ...item,
      path: index < 4 ? "src/entities/order.ts" : "src/entities/invoice.ts",
    }));

    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:data_model",
      multiplePaths.slice(0, 6),
    )).toBe(false);
    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:data_model",
      singlePath,
    )).toBe(false);
    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:data_model",
      multiplePaths,
    )).toBe(true);
    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:product_surface",
      multiplePaths,
    )).toBe(true);
    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:intelligence",
      multiplePaths,
    )).toBe(true);
    expect(isRepositoryOperationCommunityCandidate(
      "repository_area:quality",
      multiplePaths,
    )).toBe(false);
    expect(isRepositoryOperationCommunityCandidate(
      "project_domain:orders",
      singlePath,
    )).toBe(false);
    expect(isRepositoryOperationCommunityCandidate(
      "project_domain:orders",
      Array.from(
        { length: 13 },
        (_item, index) => entry("src/orders/service.ts", `Order behavior ${index + 1} is implemented.`),
      ),
    )).toBe(true);
    expect(repositoryOperationCommunityCountForScope(
      "repository_area:data_model",
      multiplePaths.length,
    )).toBe(2);
    expect(repositoryOperationCommunityCountForScope(
      "project_domain:orders",
      multiplePaths.length,
    )).toBe(1);
  });

  it("admits community children only inside the original repository claim surface", () => {
    const candidates = [
      { id: "orders", communityCount: 3 },
      { id: "billing", communityCount: 2 },
      { id: "search", communityCount: 3 },
    ];
    expect(selectRepositoryOperationCommunityExpansions(
      candidates,
      27,
      30,
    )).toEqual({
      selected: candidates.slice(0, 2),
      skipped: candidates.slice(2),
      runtimeInputCount: 30,
      runtimeInputLimit: 30,
    });
    expect(selectRepositoryOperationCommunityExpansions(
      candidates,
      31,
      30,
    )).toEqual({
      selected: [],
      skipped: candidates,
      runtimeInputCount: 31,
      runtimeInputLimit: 31,
    });
    expect(() => selectRepositoryOperationCommunityExpansions(
      [{ id: "invalid", communityCount: 1 }],
      1,
    )).toThrow("Repository operation-community expansion limits are invalid.");
  });

  it("does not reserve claim slots for anchor-only synthesis inputs", () => {
    const semantic = {
      ...entry("src/orders/service.ts"),
      evidenceMode: "semantic" as const,
    };
    const anchor = {
      ...entry("README.md"),
      evidenceMode: "deterministic_anchor" as const,
    };
    const originalModelInputCount = repositoryModelEligibleSynthesisInputCount([
      { notebook: [semantic] },
      ...Array.from({ length: 29 }, () => ({ notebook: [anchor] })),
    ]);

    expect(originalModelInputCount).toBe(1);
    expect(selectRepositoryOperationCommunityExpansions(
      [{ id: "orders", communityCount: 3 }],
      originalModelInputCount,
      3,
    )).toMatchObject({
      selected: [{ id: "orders", communityCount: 3 }],
      skipped: [],
      runtimeInputCount: 3,
      runtimeInputLimit: 3,
    });
  });

  it("accepts only an exact, non-overlapping partition of the notebook", () => {
    const validPartition = {
      communities: [
        {
          label: "Order intake",
          memberIndexes: [1, 2, 3, 4, 5, 6, 7],
        },
        {
          label: "Order fulfillment",
          memberIndexes: [8, 9, 10, 11, 12, 13],
        },
      ],
    };
    expect(repositoryOperationCommunityValidationErrors(validPartition, 13)).toEqual([]);

    expect(repositoryOperationCommunityValidationErrors({
      communities: [
        { label: "Oversized intake", memberIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
        { label: "Empty fulfillment", memberIndexes: [] },
      ],
    }, 13)).toContain("Operation communities must contain between 1 and 12 notebook entries.");

    expect(repositoryOperationCommunityValidationErrors({
      communities: [
        validPartition.communities[0],
        {
          ...validPartition.communities[1],
          memberIndexes: [8, 9, 10, 11, 12],
        },
      ],
    }, 13)).toContain(
      "Operation communities must partition every supplied notebook index without omissions or additions.",
    );

    expect(repositoryOperationCommunityValidationErrors({
      communities: [
        validPartition.communities[0],
        {
          ...validPartition.communities[1],
          memberIndexes: [7, 8, 9, 10, 11, 12, 13],
        },
      ],
    }, 13)).toContain(
      "Assign each notebook index to exactly one operation community.",
    );

    expect(repositoryOperationCommunityValidationErrors({
      communities: [
        validPartition.communities[0],
        {
          ...validPartition.communities[1],
          memberIndexes: [8, 9, 10, 11, 12, 14],
        },
      ],
    }, 13)).toContain(
      "Operation communities must partition every supplied notebook index without omissions or additions.",
    );

    expect(repositoryOperationCommunityValidationErrors({
      communities: [
        { label: "Order intake", memberIndexes: [1, 2, 3, 4] },
        { label: "Order fulfillment", memberIndexes: [5, 6, 7, 8] },
        { label: "Order reporting", memberIndexes: [9, 10, 11, 12, 13] },
      ],
    }, 13)).toContain("Return exactly 2 operation communities.");
  });

  it("materializes normalized community labels and preserves the requested notebook order", () => {
    const notebook = [
      entry("src/orders/intake.ts", "The service accepts an order."),
      entry("src/orders/audit.ts", "The service records order changes."),
      entry("src/orders/fulfillment.ts", "The service fulfills an accepted order."),
    ];

    const materialized = materializeRepositoryOperationCommunities(notebook, [
      { label: "  Order   workflow  ", memberIndexes: [3, 1] },
      { label: "Order audit", memberIndexes: [2] },
    ]);

    expect(materialized.map((community) => community.label)).toEqual([
      "Order workflow",
      "Order audit",
    ]);
    expect(materialized[0]?.notebook).toEqual([notebook[2], notebook[0]]);
    expect(materialized[0]?.notebook[0]).toBe(notebook[2]);
    expect(materialized[1]?.notebook).toEqual([notebook[1]]);
  });

  it("keeps later state-changing capability observations in a 36-row candidate notebook", () => {
    const genericObservations = Array.from({ length: 33 }, (_value, index) => ({
      ...entry(
        "src/orders/workflow.ts",
        `The order module defines internal helper ${index + 1}.`,
      ),
      sourceId: "source-commerce",
      repository: "example/commerce-platform",
      lineStart: index + 1,
      lineEnd: index + 1,
      productImportance: 1,
      implementationBreadth: 1,
      technicalDifficulty: 1,
      semanticKind: "behavior" as const,
      evidenceMode: "semantic" as const,
    }));
    const userCapability = {
      ...entry(
        "src/orders/workflow.ts",
        "A user can confirm a pending order for fulfillment.",
      ),
      sourceId: "source-commerce",
      repository: "example/commerce-platform",
      lineStart: 100,
      lineEnd: 104,
      semanticKind: "user_capability" as const,
      evidenceMode: "semantic" as const,
    };
    const stateChange = {
      ...entry(
        "src/orders/workflow.ts",
        "Confirming an order persists its transition from pending to confirmed.",
      ),
      sourceId: "source-commerce",
      repository: "example/commerce-platform",
      lineStart: 105,
      lineEnd: 110,
      semanticKind: "data_flow" as const,
      evidenceMode: "semantic" as const,
    };

    const selected = selectSubsystemSynthesisNotebook(
      "project_domain:orders",
      [...genericObservations, userCapability, stateChange],
      36,
    );

    expect(selected).toHaveLength(35);
    expect(selected[0]).toBe(userCapability);
    expect(selected[1]).toBe(stateChange);
    expect(selected).toContain(userCapability);
    expect(selected).toContain(stateChange);
  });

  it("preserves distinct safe operations before sensitive variants of one operation", () => {
    const safeParserOperation = {
      ...entry(
        "src/query/parser.ts",
        "The parser converts supported filter expressions into an executable query tree.",
      ),
      repository: "example/query-engine",
      semanticSignals: ["query.filter_parsing"],
      semanticKind: "behavior" as const,
      evidenceMode: "semantic" as const,
    };
    const sensitiveParserVariants = Array.from({ length: 6 }, (_value, index) => ({
      ...entry(
        "src/query/parser.ts",
        `Parser invariant variant ${index + 1} rejects an invalid filter shape.`,
      ),
      repository: "example/query-engine",
      lineStart: 20 + index,
      lineEnd: 20 + index,
      sensitivityFlag: true,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 5,
      semanticSignals: ["query.filter_parsing"],
      semanticKind: "invariant" as const,
      evidenceMode: "semantic" as const,
    }));
    const safeCalculatorOperation = {
      ...entry(
        "src/query/calculator.ts",
        "The calculator evaluates aggregate operations over validated query results.",
      ),
      repository: "example/query-engine",
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      semanticSignals: ["query.aggregate_calculation"],
      semanticKind: "behavior" as const,
      evidenceMode: "semantic" as const,
    };

    const selected = selectSubsystemSynthesisNotebook(
      "project_domain:query",
      [
        ...sensitiveParserVariants,
        safeParserOperation,
        safeCalculatorOperation,
      ],
      2,
    );

    expect(selected).toEqual([
      safeParserOperation,
      safeCalculatorOperation,
    ]);
    expect(selected.every((candidate) => !candidate.sensitivityFlag)).toBe(true);
  });
});

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

  it("backfills an available synthesis worker and returns input order", async () => {
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
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.get(2)!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases.get(0)!();
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

  it("stops admitting queued synthesis work after a worker fails", async () => {
    const started: number[] = [];
    let releaseSecond!: () => void;
    const execution = runOrderedSynthesisBatches(
      [0, 1, 2, 3],
      async (value) => {
        started.push(value);
        if (value === 0) throw new Error("primary synthesis failed");
        if (value === 1) {
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
        }
        return value;
      },
      2,
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releaseSecond();

    await expect(execution).rejects.toThrow("primary synthesis failed");
    expect(started).toEqual([0, 1]);
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
    expect(absentFactFinalized.highlights).toEqual([]);
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

  it("preserves downstream sensitivity and inherits protection from cited evidence", () => {
    const safeStatement = "The parser validates a structured request before evaluation.";
    const protectedStatement = "The adapter consumes a redacted credential value.";
    const ordinaryStatement = "The request router dispatches validated operations.";
    const notebook = [
      {
        ...entry("src/query/parser.ts", safeStatement),
        evidenceMode: "semantic" as const,
        sensitivityFlag: false,
      },
      {
        ...entry("src/integrations/adapter.ts", protectedStatement),
        evidenceMode: "semantic" as const,
        sensitivityFlag: true,
      },
    ];
    const finalized = finalizeRepositorySubsystemSynthesis({
      sourceId: "source-1",
      repository: "example/typed-service",
      subsystemKey: "project_domain:requests",
      notebook,
      coverageGaps: [],
      result: {
        facts: [
          {
            statement: safeStatement,
            category: "behavior",
            confidence: "high",
            sensitivityFlag: true,
            citationIndexes: [1],
            reviewNotes: null,
            productImportance: 4,
            implementationBreadth: 3,
            technicalDifficulty: 3,
            distinctiveness: 3,
          },
          {
            statement: protectedStatement,
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            citationIndexes: [2],
            reviewNotes: null,
            productImportance: 4,
            implementationBreadth: 3,
            technicalDifficulty: 3,
            distinctiveness: 3,
          },
          {
            statement: ordinaryStatement,
            category: "behavior",
            confidence: "high",
            sensitivityFlag: false,
            citationIndexes: [1],
            reviewNotes: null,
            productImportance: 3,
            implementationBreadth: 2,
            technicalDifficulty: 2,
            distinctiveness: 2,
          },
        ],
        highlights: [{
          text: "Validated structured requests before evaluation",
          summary: safeStatement,
          confidence: "high",
          sensitivityFlag: true,
          visibility: "private",
          citationIndexes: [1],
          productImportance: 4,
          implementationBreadth: 3,
          technicalDifficulty: 3,
          distinctiveness: 3,
        }],
        unresolvedQuestions: [],
      },
      tokenUsage: null,
    });

    expect(finalized.facts.map((fact) => fact.sensitivityFlag)).toEqual([
      true,
      true,
      false,
    ]);
    expect(finalized.highlights).toEqual([]);
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
    expect(finalized.highlights).toEqual([]);
    expect(finalized.unresolvedQuestions).toContain(
      "Entailment verification rejected fact 1: unsupported broad qualifier.",
    );
    expect(finalized.unresolvedQuestions).toContain(
      "Entailment verification rejected a Highlight because its promoted Project Fact did not survive verification.",
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

  it("selects one rejected Fact for empty or quality-critical non-quality subsystems", () => {
    const fact = (statement: string) => ({
      statement,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance: 3,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    });
    const value = {
      subsystems: [
        {
          subsystemKey: "project_domain:orders#scope",
          facts: [fact("Rejected first order Fact."), fact("Rejected second order Fact.")],
          highlights: [],
          unresolvedQuestions: [],
        },
        {
          subsystemKey: "project_domain:billing#scope",
          facts: [fact("Accepted billing Fact."), fact("Rejected billing sibling.")],
          highlights: [],
          unresolvedQuestions: [],
        },
        {
          subsystemKey: "repository_area:product_surface#scope",
          facts: [fact("Rejected product-surface Fact.")],
          highlights: [],
          unresolvedQuestions: [],
        },
        {
          subsystemKey: "repository_area:quality#scope",
          facts: [fact("Accepted test Fact."), fact("Rejected test sibling.")],
          highlights: [],
          unresolvedQuestions: [],
        },
      ],
    };
    const supported = (claimKey: string) => ({
      claimKey,
      supported: true,
      issues: [] as never[],
    });
    const rejected = (claimKey: string) => ({
      claimKey,
      supported: false,
      issues: ["unsupported_detail" as const],
    });

    expect(repositorySynthesisFactFloorRevisionClaimKeys(value, {
      assessments: [
        rejected("project_domain:orders#scope:fact:1"),
        rejected("project_domain:orders#scope:fact:2"),
        supported("project_domain:billing#scope:fact:1"),
        rejected("project_domain:billing#scope:fact:2"),
        rejected("repository_area:product_surface#scope:fact:1"),
        supported("repository_area:quality#scope:fact:1"),
        rejected("repository_area:quality#scope:fact:2"),
      ],
    })).toEqual([
      "project_domain:orders#scope:fact:1",
      "project_domain:billing#scope:fact:2",
      "repository_area:product_surface#scope:fact:1",
    ]);
  });

  it("keeps every synthesis scope in its own deterministic batch", () => {
    const input = (subsystemKey: string, excerptLength: number) => ({
      subsystemKey,
      synthesisKey: `${subsystemKey}#scope`,
      claimLimits: { maxFacts: 3, maxHighlights: 2 },
      notebook: [{
        ...entry(`src/${subsystemKey}.ts`),
        evidenceMode: "semantic" as const,
        semanticSignals: [`domain.${subsystemKey}`],
        sourceExcerpt: "x".repeat(excerptLength),
      }],
    });
    const first = input("first", 40);
    const second = input("second", 40);
    const oversized = input("oversized", 5_000);
    const fourth = input("fourth", 40);
    const fifth = input("fifth", 40);
    const pairBytes = repositorySynthesisBatchPromptBytes([first, second]);

    expect(buildRepositorySynthesisBatches(
      [first, second, oversized, fourth, fifth],
      pairBytes,
    ).map((batch) => batch.map((candidate) => candidate.subsystemKey))).toEqual([
      ["first"],
      ["second"],
      ["oversized"],
      ["fourth"],
      ["fifth"],
    ]);
    expect(buildRepositorySynthesisBatches(
      [first, second],
      pairBytes - 1,
    ).map((batch) => batch.map((candidate) => candidate.subsystemKey))).toEqual([
      ["first"],
      ["second"],
    ]);
    expect(() => buildRepositorySynthesisBatches([first], 0)).toThrow(
      "Repository synthesis batch input-byte limit must be a positive integer.",
    );
  });

  it("does not backfill later scopes into an existing batch", () => {
    const input = (subsystemKey: string, excerptLength: number) => ({
      subsystemKey,
      synthesisKey: `${subsystemKey}#scope`,
      claimLimits: { maxFacts: 3, maxHighlights: 2 },
      notebook: [{
        ...entry(`src/${subsystemKey}.ts`),
        evidenceMode: "semantic" as const,
        semanticSignals: [`domain.${subsystemKey}`],
        sourceExcerpt: "x".repeat(excerptLength),
      }],
    });
    const first = input("first", 1_000);
    const second = input("second", 1_000);
    const third = input("third", 40);
    const fourth = input("fourth", 40);
    const maxInputBytes = Math.max(
      repositorySynthesisBatchPromptBytes([first, third]),
      repositorySynthesisBatchPromptBytes([second, fourth]),
    );

    expect(repositorySynthesisBatchPromptBytes([first, second])).toBeGreaterThan(
      maxInputBytes,
    );
    expect(buildRepositorySynthesisBatches(
      [first, second, third, fourth],
      maxInputBytes,
    ).map((batch) => batch.map((candidate) => candidate.subsystemKey))).toEqual([
      ["first"],
      ["second"],
      ["third"],
      ["fourth"],
    ]);
  });

  it("projects only synthesis-relevant notebook fields with stable citation indexes", () => {
    const notebook = [{
      ...entry("src/payments.ts", "The service records an idempotency key."),
      evidenceMode: "semantic" as const,
      semanticStatus: "succeeded" as const,
      semanticSignals: ["domain.payment_idempotency"],
      semanticKind: "invariant" as const,
      sourceExcerpt: "10: await keys.insert(key);",
    }];

    expect(repositorySynthesisPromptNotebook(notebook)).toEqual([{
      index: 1,
      path: "src/payments.ts",
      lineStart: 1,
      lineEnd: 1,
      statement: "The service records an idempotency key.",
      category: "architecture",
      confidence: "high",
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      semanticSignals: ["domain.payment_idempotency"],
      semanticKind: "invariant",
      sourceExcerpt: "10: await keys.insert(key);",
    }]);
    const projected = repositorySynthesisPromptNotebook(notebook)[0]!;
    for (const durable of [
      "sourceId", "repository", "commitSha", "blobSha", "changeType",
      "semanticStatus", "evidenceMode",
    ]) {
      expect(projected).not.toHaveProperty(durable);
    }
  });

  it("allocates a stable Facts-only target while retaining every scope floor", () => {
    const ten = allocateRepositorySynthesisClaimLimits(
      Array.from({ length: 10 }, (_entry, index) => `scope-${index + 1}`),
    );
    expect(ten.map((entry) => entry.claimLimits)).toEqual(
      Array.from({ length: 10 }, () => ({ maxFacts: 3, maxHighlights: 0 })),
    );
    expect(ten.reduce(
      (total, entry) => total + entry.claimLimits.maxFacts + entry.claimLimits.maxHighlights,
      0,
    )).toBe(30);
    expect(allocateRepositorySynthesisClaimLimits(["a", "b"]).map(
      (entry) => entry.claimLimits
    )).toEqual([
      { maxFacts: 3, maxHighlights: 0 },
      { maxFacts: 3, maxHighlights: 0 },
    ]);
    expect(allocateRepositorySynthesisClaimLimits(
      Array.from({ length: 31 }, (_entry, index) => index),
    ).every((entry) =>
      entry.claimLimits.maxFacts === 1 && entry.claimLimits.maxHighlights === 0
    )).toBe(true);
  });

  it("scales each production Fact ceiling to its own verified evidence", () => {
    expect([1, 2, 3, 12].map((count) => naturalRepositorySynthesisClaimLimits({
      notebook: Array.from({ length: count }, (_entry, index) =>
        entry(`src/operation-${index + 1}.ts`)
      ),
    }))).toEqual([
      { maxFacts: 1, maxHighlights: 0 },
      { maxFacts: 2, maxHighlights: 0 },
      { maxFacts: 3, maxHighlights: 0 },
      { maxFacts: 3, maxHighlights: 0 },
    ]);
  });

  it("round-robins first-pass Highlight eligibility across allocation groups", () => {
    const inputs = [
      { id: "orders-community-1", scope: "orders" },
      { id: "orders-community-2", scope: "orders" },
      { id: "billing-community-1", scope: "billing" },
      { id: "search-community-1", scope: "search" },
    ];

    const allocated = allocateRepositorySynthesisClaimLimits(
      inputs,
      7,
      3,
      (input) => input.scope,
    );

    expect(allocated.map(({ input, claimLimits }) => ({
      id: input.id,
      ...claimLimits,
    }))).toEqual([
      { id: "orders-community-1", maxFacts: 1, maxHighlights: 1 },
      { id: "orders-community-2", maxFacts: 1, maxHighlights: 0 },
      { id: "billing-community-1", maxFacts: 1, maxHighlights: 1 },
      { id: "search-community-1", maxFacts: 1, maxHighlights: 1 },
    ]);
  });

  it("keeps a three-community domain from crowding five other scopes out of repository allocation", () => {
    const inputs = [
      ...Array.from({ length: 3 }, (_entry, index) => ({
        id: `commerce-community-${index + 1}`,
        sourceId: "source-1",
        subsystemKey: "project_domain:commerce",
      })),
      ...["billing", "search", "notifications", "reporting", "identity"].map(
        (domain) => ({
          id: `${domain}-community-1`,
          sourceId: "source-1",
          subsystemKey: `project_domain:${domain}`,
        }),
      ),
    ];

    const allocated = allocateRepositorySynthesisClaimLimits(
      inputs,
      30,
      6,
      (input) => JSON.stringify([input.sourceId, input.subsystemKey]),
    );
    const limitsById = new Map(allocated.map(({ input, claimLimits }) => [
      input.id,
      claimLimits,
    ]));

    expect(limitsById.get("commerce-community-1")?.maxHighlights).toBe(1);
    expect(limitsById.get("commerce-community-2")?.maxHighlights).toBe(0);
    expect(limitsById.get("commerce-community-3")?.maxHighlights).toBe(0);
    for (const domain of ["billing", "search", "notifications", "reporting", "identity"]) {
      expect(limitsById.get(`${domain}-community-1`)?.maxHighlights).toBe(1);
    }
    expect(allocated.every(({ claimLimits }) => claimLimits.maxFacts === 3)).toBe(true);
    expect(allocated.reduce(
      (total, { claimLimits }) =>
        total + claimLimits.maxFacts + claimLimits.maxHighlights,
      0,
    )).toBe(30);
  });

  it("preserves three findings per broad community before duplicating generic structural details", () => {
    const inputs = [
      ...["intake", "proposal", "review"].flatMap((scope) =>
        [1, 2].map((community) => ({
          id: `${scope}-community-${community}`,
          sourceId: "source-1",
          subsystemKey: `project_domain:${scope}`,
        }))
      ),
      ...["quality", "automation", "integrations", "application", "storage", "intelligence"].map(
        (scope) => ({
          id: `${scope}-scope`,
          sourceId: "source-1",
          subsystemKey: `repository_area:${scope}`,
        }),
      ),
    ];

    const allocated = allocateRepositorySynthesisClaimLimits(
      inputs,
      30,
      6,
      (input) => JSON.stringify([input.sourceId, input.subsystemKey]),
    );
    const limitsById = new Map(allocated.map(({ input, claimLimits }) => [
      input.id,
      claimLimits,
    ]));

    for (const scope of ["intake", "proposal", "review"]) {
      expect(limitsById.get(`${scope}-community-1`)?.maxFacts).toBe(3);
      expect(limitsById.get(`${scope}-community-2`)?.maxFacts).toBe(3);
    }
    for (const scope of [
      "quality", "automation", "integrations", "application", "storage", "intelligence",
    ]) {
      expect(limitsById.get(`${scope}-scope`)?.maxFacts).toBe(1);
    }
    expect(allocated.reduce(
      (total, { claimLimits }) =>
        total + claimLimits.maxFacts + claimLimits.maxHighlights,
      0,
    )).toBe(30);
  });

  it("enforces the allocated per-subsystem claim limits structurally", () => {
    const fact = {
      statement: "The service records a supported repository operation.",
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
      text: "Records a supported repository operation",
      summary: "The service records a supported repository operation.",
      confidence: "high" as const,
      sensitivityFlag: false,
      visibility: "private" as const,
      citationIndexes: [1],
      productImportance: 4,
      implementationBreadth: 3,
      technicalDifficulty: 3,
      distinctiveness: 3,
    };
    const inputs = [{
      subsystemKey: "project_domain:service",
      synthesisKey: "project_domain:service#scope",
      notebook: [{ ...entry("src/service.ts"), evidenceMode: "semantic" as const }],
      claimLimits: { maxFacts: 1, maxHighlights: 0 },
    }];

    expect(repositorySynthesisStructuralErrors({
      subsystems: [{
        subsystemKey: "project_domain:service#scope",
        facts: [fact, fact],
        highlights: [highlight],
        unresolvedQuestions: [],
      }],
    }, inputs)).toEqual([
      "project_domain:service#scope must return between 1 and 1 Facts.",
      "project_domain:service#scope must return no more than 0 Highlights.",
    ]);
  });

  it("projects provider output onto dynamic claim limits without separating a Highlight from its Fact", () => {
    const fact = (statement: string, productImportance: number) => ({
      statement,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: false,
      citationIndexes: [1],
      reviewNotes: null,
      productImportance,
      implementationBreadth: productImportance,
      technicalDifficulty: productImportance,
      distinctiveness: productImportance,
    });
    const low = fact("The service exposes a routine status endpoint.", 2);
    const promoted = fact("The service coordinates a durable payment workflow.", 4);
    const highestUnpromoted = fact("The service performs a complex internal migration.", 5);
    const highlight = {
      text: "Coordinates durable payments",
      summary: promoted.statement,
      confidence: promoted.confidence,
      sensitivityFlag: promoted.sensitivityFlag,
      visibility: "private" as const,
      citationIndexes: promoted.citationIndexes,
      productImportance: promoted.productImportance,
      implementationBreadth: promoted.implementationBreadth,
      technicalDifficulty: promoted.technicalDifficulty,
      distinctiveness: promoted.distinctiveness,
    };
    const inputs = [{
      subsystemKey: "project_domain:payments",
      synthesisKey: "project_domain:payments#scope",
      notebook: [{ ...entry("src/payments.ts"), evidenceMode: "semantic" as const }],
      claimLimits: { maxFacts: 1, maxHighlights: 1 },
    }];
    const projected = projectRepositorySynthesisClaimBudget({
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [low, highestUnpromoted, promoted],
        highlights: [highlight],
        unresolvedQuestions: [],
      }],
    }, inputs);

    expect(projected.subsystems[0]?.facts).toEqual([promoted]);
    expect(projected.subsystems[0]?.highlights).toEqual([highlight]);
    expect(repositorySynthesisStructuralErrors(projected, inputs)).toEqual([]);
  });


  it("finishes every primary batch before starting serialized optional refinement", async () => {
    const events: string[] = [];
    let activeRefinements = 0;
    let maximumActiveRefinements = 0;
    const results = await runRepositorySynthesisPrimaryBarrier(
      ["a", "b", "c", "d"],
      async (batch) => {
        events.push(`base:${batch}`);
        return batch.toUpperCase();
      },
      async (base) => {
        activeRefinements += 1;
        maximumActiveRefinements = Math.max(maximumActiveRefinements, activeRefinements);
        events.push(`refine:${base}`);
        await Promise.resolve();
        activeRefinements -= 1;
        return base.toLowerCase();
      },
      2,
    );

    expect(events.slice(0, 4)).toEqual(["base:a", "base:b", "base:c", "base:d"]);
    expect(events.slice(4)).toEqual(["refine:A", "refine:B", "refine:C", "refine:D"]);
    expect(maximumActiveRefinements).toBe(1);
    expect(results).toEqual(["a", "b", "c", "d"]);
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
    const highlight = (text: string, summary: string, citationIndexes = [1]) => ({
      text,
      summary,
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
        highlights: [highlight(
          "Built the complete inventory lifecycle",
          "The screen removes and encrypts an inventory record.",
          [1, 2],
        )],
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
        replacement: highlight(
          "Built inventory record removal",
          "The screen removes an inventory record.",
          [1, 2],
        ),
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

    expect(repositorySynthesisRevisionReplacementIsNoOp({
      kind: "fact",
      replacement: cosmeticRevision.factRevisions[0]!.replacement,
      priorClaim: prior.subsystems[0]!.facts[0]!,
      issues: critic.assessments[0]!.issues,
    })).toBe(true);
    expect(repositorySynthesisRevisionReplacementIsNoOp({
      kind: "highlight",
      replacement: { text: prior.subsystems[0]!.highlights[0]!.text },
      priorClaim: prior.subsystems[0]!.highlights[0]!,
      issues: critic.assessments[2]!.issues,
    })).toBe(true);
    expect(repositorySynthesisRevisionReplacementIsNoOp({
      kind: "highlight",
      replacement: { text: "Built inventory record removal" },
      priorClaim: prior.subsystems[0]!.highlights[0]!,
      issues: critic.assessments[2]!.issues,
    })).toBe(false);

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
    )).toEqual([
      "project_domain:inventory#scope Highlight 1 must promote exactly one emitted Fact with matching summary, normalized citations, confidence, sensitivity, and scores.",
    ]);

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
    expect(result.facts).toEqual([]);
    expect(result.highlights).toEqual([]);
    expect(result.unresolvedQuestions).toEqual([
      "No successful semantic evidence was available for deterministic synthesis.",
    ]);
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

    expect(selected).toHaveLength(12);
    expect(selected.filter((candidate) => candidate.evidenceMode !== "deterministic_anchor"))
      .toHaveLength(10);
    expect(selected.filter((candidate) => candidate.evidenceMode === "deterministic_anchor"))
      .toHaveLength(2);
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

  it("materializes the exact accepted citation range without dropping supported tail lines", () => {
    const content = Array.from(
      { length: 300 },
      (_unused, index) => `line ${index + 1}`,
    ).join("\n");

    const excerpt = exactSynthesisCitationExcerpt(content, 160, 285);

    expect(excerpt.split("\n")).toHaveLength(126);
    expect(excerpt).toMatch(/^line 160\n/u);
    expect(excerpt).toMatch(/\nline 285$/u);
    expect(excerpt).toContain("line 260");
    expect(isCompleteSynthesisCitationExcerpt(excerpt, 160, 285)).toBe(true);
    expect(isCompleteSynthesisCitationExcerpt(
      excerpt.split("\n").slice(0, 80).join("\n"),
      160,
      285,
    )).toBe(false);
    expect(() => exactSynthesisCitationExcerpt(content, 160, 301)).toThrow(
      "outside the immutable file content",
    );
    expect(() => exactSynthesisCitationExcerpt("x".repeat(8 * 1024 + 1), 1, 1)).toThrow(
      "exceeds the 8192-byte evidence limit",
    );
    expect(() => exactSynthesisCitationExcerpt("é".repeat(4_097), 1, 1)).toThrow(
      "exceeds the 8192-byte evidence limit",
    );
  });

  it("does not turn one matching filename into a broad multi-component capability", () => {
    const result = fallbackSubsystemSynthesis("ai_runtime", [
      entry("src/lib/bedrock-converse-agent.ts"),
    ]);

    expect(result.facts[0]?.statement).toBe("src/lib/bedrock-converse-agent.ts defines supported repository behavior.");
    expect(result.facts[0]?.statement).not.toContain("structured generation");
    expect(result.highlights).toEqual([]);
    expect(result.unresolvedQuestions).toEqual([]);
  });
});
