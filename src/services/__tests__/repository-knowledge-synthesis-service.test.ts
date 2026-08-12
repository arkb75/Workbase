import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/src/lib/prisma";
import type { SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";
import {
  deterministicSynthesisAnchorSubsystems,
  derivedRepositoryKnowledgeLifecycleFact,
  exactSinglePathProjectDomainSynthesis,
  fallbackSubsystemSynthesis,
  finalizeRepositorySubsystemSynthesis,
  isBroadSemanticRepositoryLifecycleFact,
  isWorkbaseRepositoryIdentity,
  matchesWorkbaseDeterministicDefinitionIdentity,
  modelEligibleSynthesisNotebook,
  reusableSynthesisEvidenceFilters,
  requiredSemanticBaselineFacts,
  repositorySynthesisSafetyGuidance,
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
import { REPOSITORY_STATIC_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

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

describe("repository synthesis limit fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aligns model synthesis wording with the deterministic absolute-claim safety gate", () => {
    expect(repositorySynthesisSafetyGuidance).toContain("exact executable");
    for (const qualifier of ["always", "never", "exclusively", "every", "all", "only", "guarantees"]) {
      expect(repositorySynthesisSafetyGuidance).toContain(qualifier);
    }
    expect(repositorySynthesisSafetyGuidance).toContain("narrower non-absolute description");
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

  it("promotes a corroborated product workflow across semantic importance-label drift", () => {
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
        semanticSignals: ["product_surface.product_loop"],
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
        semanticSignals: ["product_surface.product_loop"],
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
    }], notebook)).toEqual([expect.objectContaining({
      text: statement,
      citationIndexes: [1, 2],
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

  it("applies the substantial-fact fallback in final synthesis while preserving failed-model eligibility", () => {
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
      highlights: [{
        text: statement,
        citationIndexes: [1, 2],
        confidence: "high",
        sensitivityFlag: false,
        visibility: "private",
      }],
    });
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

  it("retains exact product anchors when unrelated semantic coverage makes the refresh degraded", async () => {
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

    const [product] = await synthesizeRepositoryKnowledge("refresh-1", { fallbackOnly: true });

    expect(product).toMatchObject({
      subsystemKey: "product_surface",
      approvalEligible: true,
      facts: [expect.objectContaining({
        statement: expect.stringContaining("connects Work Items and attached sources"),
      })],
      highlights: [],
    });
    expect(product?.notebook).toHaveLength(6);
    expect(product?.notebook.every((item) => item.evidenceMode === "deterministic_anchor")).toBe(true);
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

    // This is the merge used after model synthesis: the model cannot erase a
    // supported required facet merely by returning one generic broad fact.
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
