import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesizedKnowledge, SynthesisNotebookEntry } from "@/src/services/repository-knowledge-synthesis-service";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
  audited: vi.fn(async (input: {
    execute: () => Promise<unknown>;
    inputSummary: { phase: string };
  }) => ({
    ...(await input.execute() as object),
    generationRunId: null,
  })),
}));

vi.mock("@/src/services/bedrock-runtime", () => ({
  getStructuredLlmClient: () => ({ generateStructured: mocks.generateStructured }),
}));

vi.mock("@/src/services/structured-generation-audit-service", () => ({
  runAuditedStructuredGeneration: mocks.audited,
}));

import {
  materializeRepositoryHighlights,
  repositoryHighlightCandidates,
  repositoryHighlightCriticValidationErrors,
  repositoryHighlightSelectionValidationErrors,
  selectRepositoryHighlightsFromVerifiedFacts,
} from "@/src/services/repository-highlight-selection-service";

function notebook(index: number, overrides: Partial<SynthesisNotebookEntry> = {}): SynthesisNotebookEntry {
  return {
    sourceId: `source-${index}`,
    repository: "org/project",
    commitSha: "commit",
    blobSha: `blob-${index}`,
    path: `src/features/feature-${index}.ts`,
    lineStart: 1,
    lineEnd: 2,
    statement: `Feature ${index} executes a distinct implemented workflow.`,
    category: "behavior",
    confidence: "high",
    sensitivityFlag: false,
    productImportance: 4,
    implementationBreadth: 3,
    technicalDifficulty: 3,
    changeType: "unchanged",
    semanticStatus: "succeeded",
    semanticKind: "user_capability",
    semanticSignals: [`product_surface.feature_${index}`],
    sourceExcerpt: `1: export function feature${index}() {\n2:   return ${index};\n3: }`,
    evidenceMode: "semantic",
    ...overrides,
  };
}

function synthesis(count: number, overrides: Partial<SynthesizedKnowledge> = {}): SynthesizedKnowledge[] {
  return [{
    sourceId: "source",
    repository: "org/project",
    subsystemKey: "repository_area:product_surface",
    facts: Array.from({ length: count }, (_, index) => ({
      statement: `The project executes distinct workflow number ${index + 1} for its users.`,
      category: "behavior" as const,
      confidence: "high" as const,
      sensitivityFlag: index === 0,
      citationIndexes: [index + 1],
      reviewNotes: null,
      productImportance: 5,
      implementationBreadth: 3,
      technicalDifficulty: 4,
      distinctiveness: 4,
    })),
    highlights: [{
      text: "Old subsystem Highlight must be replaced",
      summary: "Old subsystem Highlight must be replaced by repository selection.",
      confidence: "high",
      sensitivityFlag: false,
      visibility: "private",
      citationIndexes: [1],
      productImportance: 1,
      implementationBreadth: 1,
      technicalDifficulty: 1,
      distinctiveness: 1,
    }],
    unresolvedQuestions: [],
    coverageGaps: [],
    notebook: Array.from({ length: count }, (_, index) => notebook(index + 1)),
    tokenUsage: null,
    approvalEligible: true,
    ...overrides,
  }];
}

describe("repository-wide Highlight selection", () => {
  beforeEach(() => {
    mocks.generateStructured.mockReset();
    mocks.audited.mockClear();
  });

  it("admits only verified Facts with exact semantic implementation evidence", () => {
    const input = synthesis(5);
    input[0]!.notebook[1] = notebook(2, { semanticStatus: "degraded" });
    input[0]!.notebook[2] = notebook(3, { evidenceMode: "deterministic_anchor" });
    input[0]!.notebook[3] = notebook(4, { path: "README.md" });
    input[0]!.notebook[4] = notebook(5, {
      path: "docs/roadmap.md",
      statement: "This workflow is planned for a future release.",
    });

    expect(repositoryHighlightCandidates(input).map(({ candidateId, factIndex }) => ({
      candidateId,
      factIndex,
    }))).toEqual([{ candidateId: "HC1", factIndex: 0 }]);
    expect(repositoryHighlightCandidates(synthesis(1, { approvalEligible: false }))).toEqual([]);
  });

  it("keeps candidate references distinct across sibling operation communities", () => {
    const first = synthesis(1, {
      synthesisKey: "project_domain:orders#community-1",
    })[0]!;
    const second = synthesis(1, {
      synthesisKey: "project_domain:orders#community-2",
    })[0]!;

    const candidates = repositoryHighlightCandidates([first, second]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.candidateRef).not.toBe(candidates[1]!.candidateRef);
  });

  it("rejects unknown, duplicate, over-candidate, and incomplete model identities", () => {
    const candidates = repositoryHighlightCandidates(synthesis(1));
    expect(repositoryHighlightSelectionValidationErrors([
      { candidateId: "HC1", title: "A grounded title" },
      { candidateId: "HC1", title: "A duplicate title" },
      { candidateId: "HC9", title: "An unknown title" },
    ], candidates)).toEqual([
      "Selections cannot exceed the supplied eligible candidate set.",
      "Select each candidateId at most once.",
      "Every selected candidateId must come from the supplied candidate set.",
    ]);
    expect(repositoryHighlightSelectionValidationErrors([
      { candidateId: "HC1", title: "First candidate title" },
      { candidateId: "HC2", title: "Second candidate title" },
    ], repositoryHighlightCandidates(synthesis(1)))).toContain(
      "Selections cannot exceed the supplied eligible candidate set.",
    );
    expect(repositoryHighlightCriticValidationErrors([], [
      { candidateId: "HC1", title: "A grounded title" },
    ])).toContain("Return exactly one title assessment for every supplied candidateId.");
    const thirteenCandidates = repositoryHighlightCandidates(synthesis(13));
    expect(repositoryHighlightSelectionValidationErrors(
      thirteenCandidates.map(({ candidateId }, index) => ({
        candidateId,
        title: `Grounded candidate title ${index + 1}`,
      })),
      thirteenCandidates,
    )).toEqual([]);
    expect(repositoryHighlightSelectionValidationErrors(
      [{ candidateId: "HC1", title: "A selected candidate" }],
      repositoryHighlightCandidates(synthesis(2)),
      [{ candidateId: "HC2", reason: "routine_supporting_detail" }],
    )).toEqual([]);
    expect(repositoryHighlightSelectionValidationErrors(
      [{ candidateId: "HC1", title: "A selected candidate" }],
      repositoryHighlightCandidates(synthesis(2)),
      [],
    )).toContain("Return exactly one selected or omitted decision for every supplied candidateId.");
  });

  it("copies every evidence-bearing field from the Fact and removes old Highlights", () => {
    const input = synthesis(2);
    const candidates = repositoryHighlightCandidates(input);
    const output = materializeRepositoryHighlights(input, candidates, [
      { candidateId: "HC1", title: "Adaptive selected workflow" },
      { candidateId: "HC2", title: "Rejected title is omitted" },
    ], [
      { candidateId: "HC1", supported: true, issues: [] },
      { candidateId: "HC2", supported: false, issues: ["unsupported_title"] },
    ]);

    expect(output[0]!.highlights).toHaveLength(1);
    expect(output[0]!.highlights[0]).toEqual({
      text: "Adaptive selected workflow",
      summary: input[0]!.facts[0]!.statement,
      confidence: input[0]!.facts[0]!.confidence,
      sensitivityFlag: input[0]!.facts[0]!.sensitivityFlag,
      visibility: "private",
      citationIndexes: input[0]!.facts[0]!.citationIndexes,
      productImportance: input[0]!.facts[0]!.productImportance,
      implementationBreadth: input[0]!.facts[0]!.implementationBreadth,
      technicalDifficulty: input[0]!.facts[0]!.technicalDifficulty,
      distinctiveness: input[0]!.facts[0]!.distinctiveness,
    });
  });

  it("selects a natural set above twelve and batches strict title critique at ten", async () => {
    const distinctNouns = [
      "invoice settlement", "dataset parsing", "message routing", "identity enrollment",
      "inventory reconciliation", "search indexing", "document conversion", "payment capture",
      "release orchestration", "policy enforcement", "media transcoding", "shipment tracking",
      "audit reconciliation", "catalog synchronization",
    ];
    const distinctActions = [
      "settles captured balances against issued invoices",
      "parses uploaded tables into queryable records",
      "dispatches conversations through participant channels",
      "enrolls accounts through verified identity steps",
      "reconciles warehouse stock after recorded movements",
      "indexes searchable documents with normalized fields",
      "converts authored documents into downloadable formats",
      "captures authorized payments through provider callbacks",
      "orchestrates deployable revisions across release stages",
      "enforces access policies at protected action boundaries",
      "transcodes uploaded media into playable renditions",
      "tracks dispatched shipments through carrier updates",
      "reconciles audit records against immutable event histories",
      "synchronizes catalog changes across connected storefronts",
    ];
    const input = distinctActions.flatMap((statement, index) => {
      const [subsystem] = synthesis(1, {
        sourceId: `source-${index + 1}`,
        repository: `org/project-${index + 1}`,
        subsystemKey: `project_domain:domain_${index + 1}`,
        notebook: [notebook(index + 1)],
      });
      subsystem!.facts[0] = {
        ...subsystem!.facts[0]!,
        statement: `The project ${statement}.`,
      };
      return [subsystem!];
    });
    mocks.generateStructured.mockImplementation(async (request: { schemaName: string; userPrompt: string }) => {
      if (request.schemaName === "repository_highlight_selection") {
        return {
          data: {
            selections: Array.from({ length: distinctActions.length }, (_, index) => ({
              candidateId: `HC${index + 1}`,
              title: `${distinctNouns[index]} capability`,
            })),
            omissions: [],
          },
          parsedOutput: {},
          tokenUsage: null,
          provider: "test",
          modelId: "selector",
        };
      }
      const supplied = JSON.parse(request.userPrompt) as {
        selections: Array<{ candidateId: string }>;
      };
      return {
        data: {
          assessments: supplied.selections.map(({ candidateId }) => ({
            candidateId,
            supported: true,
            issues: [],
          })),
        },
        parsedOutput: {},
        tokenUsage: null,
        provider: "test",
        modelId: "critic",
      };
    });

    const result = await selectRepositoryHighlightsFromVerifiedFacts({
      workItemId: "work-item",
      refreshRunId: "refresh",
      projectTitle: "Project",
      synthesis: input,
    });

    expect(mocks.generateStructured).toHaveBeenCalledTimes(3);
    expect(mocks.generateStructured.mock.calls.map(([request]) => request.schemaName)).toEqual([
      "repository_highlight_selection",
      "repository_highlight_title_critic",
      "repository_highlight_title_critic",
    ]);
    expect(result.synthesis.reduce(
      (total, subsystem) => total + subsystem.highlights.length,
      0,
    )).toBe(14);
    expect(result.synthesis.reduce(
      (total, subsystem) => total + (subsystem.capabilityFunnel?.highlights.selected ?? 0),
      0,
    )).toBe(14);
    expect(mocks.audited.mock.calls.map(([request]) => request.inputSummary.phase)).toEqual([
      "repository_highlight_selection",
      "repository_highlight_critic",
      "repository_highlight_critic",
    ]);
  });

  it("returns zero Highlights without a floor when no Fact is eligible", async () => {
    const result = await selectRepositoryHighlightsFromVerifiedFacts({
      workItemId: "work-item",
      refreshRunId: "refresh",
      projectTitle: "Project",
      synthesis: synthesis(1, { approvalEligible: false }),
    });

    expect(result.synthesis[0]!.highlights).toEqual([]);
    expect(result.synthesis[0]!.capabilityFunnel).toMatchObject({
      version: 1,
      facts: { verified: 1 },
      highlights: {
        eligibleCandidates: 0,
        selected: 0,
        decisions: [expect.objectContaining({
          outcome: "omitted",
          reasons: ["not_approval_eligible"],
        })],
      },
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("accepts an explicit adaptive zero selection without invoking a critic or floor", async () => {
    mocks.generateStructured.mockResolvedValue({
      data: {
        selections: [],
        omissions: [{
          candidateId: "HC1",
          reason: "routine_supporting_detail",
        }],
      },
      parsedOutput: {},
      tokenUsage: null,
      provider: "test",
      modelId: "selector",
    });

    const result = await selectRepositoryHighlightsFromVerifiedFacts({
      workItemId: "work-item",
      refreshRunId: "refresh",
      projectTitle: "Project",
      synthesis: synthesis(1),
    });

    expect(result.synthesis[0]!.highlights).toEqual([]);
    expect(result.synthesis[0]!.capabilityFunnel?.highlights).toMatchObject({
      eligibleCandidates: 1,
      selected: 0,
      decisions: [expect.objectContaining({ reasons: ["selector_routine_supporting_detail"] })],
    });
    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    expect(mocks.generateStructured.mock.calls[0]![0].schemaName).toBe(
      "repository_highlight_selection",
    );
  });
});
