import { describe, expect, it, vi } from "vitest";
import type {
  GroundedAnswerBlock,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import {
  verifyProjectAnswerWithRecovery,
} from "@/src/services/project-answer-recovery-service";
import {
  selectProjectAnswerEditorialThemes,
} from "@/src/services/project-answer-editorial-service";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";
import { groundProjectAnswer } from "@/src/services/project-answer-grounding-service";

function citation(index: number): ProjectKnowledgeCitation {
  return {
    kind: "project_fact",
    label: `Fact ${index}`,
    excerpt: `Supported project fact ${index}.`,
    projectFactId: `fact-${index}`,
  };
}

function entry(
  index: number,
  subsystemKey: string,
  overrides: Partial<ProjectAnswerGroundingEntry> = {},
): ProjectAnswerGroundingEntry {
  return {
    kind: "project_fact",
    authority: "verified_project_fact",
    title: `Capability ${index}`,
    content: `The project implements supported capability ${index} through a reviewed project knowledge workflow.`,
    currentRun: true,
    citationIndexes: [index],
    ownershipAuthority: 0,
    supportingSources: [],
    subsystemKey,
    accomplishmentRanking: {
      evidenceStrength: 5,
      productImportance: 5,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      ownershipAuthority: 0,
      distinctiveness: 4,
      freshness: 5,
      impactBonus: 0,
      uncertainty: null,
    },
    ...overrides,
  };
}

function verifierResult(blocks: GroundedAnswerBlock[], issues: string[] = []) {
  return {
    blocks,
    issues,
    tokenUsage: null,
  };
}

function verifierReturning(blocks: GroundedAnswerBlock[], issues: string[] = []) {
  return vi.fn(async () => verifierResult(blocks, issues)) as unknown as typeof groundProjectAnswer;
}

const threeEntries = [
  entry(1, "product_surface"),
  entry(2, "repository_knowledge_lifecycle"),
  entry(3, "project_chat_grounding"),
];
const threeCitations = [citation(1), citation(2), citation(3)];

describe("project answer verification recovery", () => {
  it("recovers from a verifier exception with exact approved memory and sanitized telemetry", async () => {
    const secretMessage = "provider failed with token ghp_do_not_persist";
    const verifier = vi.fn(async () => {
      throw new Error(secretMessage);
    }) as unknown as typeof groundProjectAnswer;

    const result = await verifyProjectAnswerWithRecovery({
      question: "How does the project knowledge workflow work?",
      draftAnswer: "It uses reviewed project knowledge. [citation:1]",
      entries: threeEntries,
      catalog: threeCitations,
      requiredBlockCount: { minimum: 1, maximum: 3 },
      verifier,
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "source_exact_fallback",
      verifier: {
        status: "failed",
        returnedBlockCount: 0,
        acceptedBlockCount: 0,
        failure: { name: "Error", code: null },
      },
      fallback: { attempted: true },
    });
    expect(result.finalized.citations.length).toBeGreaterThan(0);
    expect(result.finalized.markdown).toContain("[citation:1]");
    expect(JSON.stringify(result.telemetry)).not.toContain(secretMessage);
    expect(JSON.stringify(result)).not.toContain("The answer could not be verified against its sources");
  });

  it("recovers when the verifier returns no supported blocks", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Summarize the project architecture.",
      draftAnswer: "The project has an architecture. [citation:1]",
      entries: threeEntries,
      catalog: threeCitations,
      requiredBlockCount: { minimum: 2, maximum: 3 },
      verifier: verifierReturning([], ["unsupported: draft"]),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry.outcome).toBe("source_exact_fallback");
    expect(result.telemetry.verifier).toMatchObject({
      status: "empty",
      returnedBlockCount: 0,
      issueCount: 1,
    });
    expect(result.telemetry.finalBlockCount).toBeGreaterThanOrEqual(2);
    expect(result.telemetry.requestedBlockCountSatisfied).toBe(true);
  });

  it("does not append canned analysis after exact assessment recovery", async () => {
    const question =
      "Assess the architecture's three most important strengths, limitations, and trade-offs.";
    const selection = selectProjectAnswerEditorialThemes({
      question,
      entries: threeEntries,
    });
    const result = await verifyProjectAnswerWithRecovery({
      question,
      draftAnswer: "",
      entries: threeEntries,
      catalog: threeCitations,
      selection,
      requiredBlockCount: { minimum: 3, maximum: 3 },
      forceExactFallback: true,
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.finalized.markdown).not.toContain(
      "Assessment (inference from the cited design)",
    );
    expect(result.finalized.markdown).not.toMatch(/strength and trade-off/i);
    for (const block of result.blocks) {
      expect(threeEntries.map((candidate) => candidate.content)).toContain(
        block.bodyMarkdown,
      );
    }
    expect(result.finalized.markdown).toMatch(/\[citation:[1-3]\]/);
  });

  it("publishes a safe verifier subset and drops invalid blocks", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Where is the reviewed project knowledge workflow?",
      draftAnswer: [
        "The reviewed project knowledge workflow is implemented. [citation:1]",
        "An unrelated unsupported claim. [citation:2]",
      ].join("\n\n"),
      entries: threeEntries,
      catalog: threeCitations,
      requiredBlockCount: { minimum: 1, maximum: 3 },
      verifier: verifierReturning([
        {
          heading: "Reviewed project knowledge",
          bodyMarkdown: "The reviewed project knowledge workflow is implemented.",
          citationIndexes: [1],
        },
        {
          heading: "Invalid citation",
          bodyMarkdown: "This block cites a source outside the catalog.",
          citationIndexes: [99],
        },
      ]),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "verified_safe_subset",
      verifier: {
        status: "partial",
        returnedBlockCount: 2,
        acceptedBlockCount: 1,
        rejectedBlockCount: 1,
      },
      fallback: { attempted: false },
      finalBlockCount: 1,
    });
    expect(result.finalized.markdown).toContain("Reviewed project knowledge");
    expect(result.finalized.markdown).not.toContain("Invalid citation");
    expect(result.finalized.markdown).not.toContain("citation:99");
  });

  it("uses approved exact-source fallback instead of preserving invented citation indexes", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Explain the project's strongest capability.",
      draftAnswer: "The project has a supported capability. [citation:1]",
      entries: [threeEntries[0]!],
      catalog: [threeCitations[0]!],
      requiredBlockCount: { minimum: 1, maximum: 1 },
      verifier: verifierReturning([{
        heading: "Invented",
        bodyMarkdown: "This claim points beyond the active source catalog.",
        citationIndexes: [9],
      }]),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "source_exact_fallback",
      verifier: {
        status: "partial",
        rejectedBlockCount: 1,
      },
    });
    expect(result.finalized.markdown).toContain(threeEntries[0]!.content);
    expect(result.finalized.markdown).not.toContain("Invented");
  });

  it("returns a specific evidence gap when no active source can support an answer", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Explain the deployment architecture.",
      draftAnswer: "It has a deployment architecture.",
      entries: [],
      catalog: [],
      verifier: verifierReturning([]),
    });

    expect(result).toMatchObject({
      status: "insufficient_context",
      telemetry: {
        outcome: "insufficient_context",
        finalBlockCount: 0,
        finalCitationCount: 0,
        requestedBlockCountSatisfied: false,
      },
    });
    if (result.status !== "insufficient_context") return;
    expect(result.message).toContain("active approved Project Facts, Highlights, or included evidence");
    expect(result.message).not.toContain("could not be verified");
  });

  it("does not recover an unsupported focused question from unrelated approved memory", async () => {
    const unrelatedEntries = [
      entry(1, "product_surface"),
      entry(2, "repository_knowledge_lifecycle"),
    ];
    const result = await verifyProjectAnswerWithRecovery({
      question: "What CDN and production deployment topology does Workbase use?",
      draftAnswer: "The answer could not be verified against its sources.",
      entries: unrelatedEntries,
      catalog: [citation(1), citation(2)],
      verifier: vi.fn(async () => {
        throw new Error("provider verifier unavailable");
      }) as unknown as typeof groundProjectAnswer,
    });

    expect(result).toMatchObject({
      status: "insufficient_context",
      telemetry: {
        outcome: "insufficient_context",
        finalBlockCount: 0,
        finalCitationCount: 0,
      },
    });
    if (result.status !== "insufficient_context") return;
    expect(result.message).toContain(
      "did not contain citation-valid support for “What CDN and production deployment topology",
    );
    expect(result.message).not.toContain("could not be verified");
    expect(JSON.stringify(result)).not.toContain(unrelatedEntries[0]!.content);
  });

  it("honors an explicit item count by supplementing a partial verifier result", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Give me exactly three strongest accomplishments.",
      draftAnswer: "The product implements its career workflow. [citation:1]",
      entries: threeEntries,
      catalog: threeCitations,
      verifier: verifierReturning([{
        heading: "Career workflow",
        bodyMarkdown: "The product implements its career workflow.",
        citationIndexes: [1],
      }]),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "hybrid_recovery",
      requestedBlockCount: { minimum: 3, maximum: 3 },
      requestedBlockCountSatisfied: true,
      finalBlockCount: 3,
      fallback: {
        attempted: true,
        acceptedBlockCount: 2,
      },
    });
    expect(result.finalized.groundedClaims).toHaveLength(3);
    expect(result.finalized.citations).toHaveLength(3);
  });

  it("shows a specific coverage limit when approved memory cannot satisfy an exact count", async () => {
    const entries = threeEntries.slice(0, 2);
    const catalog = threeCitations.slice(0, 2);
    const result = await verifyProjectAnswerWithRecovery({
      question: "Give me exactly four strongest accomplishments.",
      draftAnswer: entries
        .map((item) => `${item.content} [citation:${item.citationIndexes[0]}]`)
        .join("\n\n"),
      entries,
      catalog,
      requiredBlockCount: { minimum: 4, maximum: 4 },
      verifier: verifierReturning(entries.map((item) => ({
        heading: item.title,
        bodyMarkdown: item.content,
        citationIndexes: item.citationIndexes,
      }))),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      finalBlockCount: 2,
      requestedBlockCountSatisfied: false,
    });
    expect(result.finalized.markdown).toContain(
      "Current approved project memory supports 2 of the requested 4 independently cited items.",
    );
    expect(result.finalized.markdown).toContain(
      "I kept the supported subset instead of inventing the remainder.",
    );
  });

  it("caps otherwise safe verifier blocks at an explicit maximum", async () => {
    const result = await verifyProjectAnswerWithRecovery({
      question: "Give me exactly two strongest accomplishments.",
      draftAnswer: [
        "Supported capability 1. [citation:1]",
        "Supported capability 2. [citation:2]",
        "Supported capability 3. [citation:3]",
      ].join("\n\n"),
      entries: threeEntries,
      catalog: threeCitations,
      verifier: verifierReturning(threeEntries.map((item, index) => ({
        heading: item.title,
        bodyMarkdown: `Supported capability ${index + 1}.`,
        citationIndexes: [index + 1],
      }))),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "verified_safe_subset",
      requestedBlockCount: { minimum: 2, maximum: 2 },
      requestedBlockCountSatisfied: true,
      finalBlockCount: 2,
      verifier: {
        returnedBlockCount: 3,
        acceptedBlockCount: 2,
        trimmedForItemLimit: 1,
      },
    });
    expect(result.finalized.groundedClaims).toHaveLength(2);
  });

  it("deduplicates verifier and fallback themes, stabilizes headings, and enforces the visible maximum", async () => {
    const question = "Give me exactly six strongest accomplishments.";
    const entries = [
      entry(1, "product_surface", {
        title: "Career content product",
        content: "Workbase turns reviewed project knowledge into career artifacts while keeping unapproved raw inputs out of generation.",
      }),
      entry(2, "repository_knowledge_lifecycle", {
        title: "Repository semantic analysis",
        content: "Repository semantic analysis uses bounded capability work packages and commit-pinned provenance to refresh durable project knowledge.",
      }),
      entry(3, "project_chat_grounding", {
        title: "Grounded project chat",
        content: "Project chat combines multi-turn history with reviewed durable memory and source-backed answers.",
      }),
      entry(4, "knowledge_review_lifecycle", {
        title: "Reviewable project knowledge",
        content: "Project knowledge edits create reviewable immutable successors and preserve the prior version for audit.",
      }),
      entry(5, "workflow_orchestration", {
        title: "Durable workflows",
        content: "Durable workflows persist progress and resume long-running chat and artifact work across interruptions.",
      }),
      entry(6, "domain_data", {
        title: "Durable data model",
        content: "The data model persists evidence, highlights, project facts, artifacts, conversations, citations, and agent runs.",
      }),
    ];
    const catalog = entries.map((_item, index) => citation(index + 1));
    const selection = selectProjectAnswerEditorialThemes({ question, entries });
    expect(selection.selectedThemes).toHaveLength(6);

    // The model covered five themes. Its repository block includes a nested
    // Markdown heading, while exact-source recovery also has a semantically
    // equivalent repository block available before the missing sixth theme.
    const verifierBlocks = selection.selectedThemes.slice(0, 5).map((theme) => {
      const source = theme.representativeMembers[0]!.entry;
      return {
        heading: theme.key === "repository_intelligence"
          ? "Repository knowledge"
          : source.title,
        bodyMarkdown: theme.key === "repository_intelligence"
          ? `${source.content}\n\n### ${theme.label}`
          : source.content,
        citationIndexes: source.citationIndexes,
      } satisfies GroundedAnswerBlock;
    });
    const result = await verifyProjectAnswerWithRecovery({
      question,
      draftAnswer: entries
        .map((item) => `${item.content} [citation:${item.citationIndexes[0]}]`)
        .join("\n\n"),
      entries,
      catalog,
      selection,
      requiredBlockCount: { minimum: 6, maximum: 6 },
      verifier: verifierReturning(verifierBlocks),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.telemetry).toMatchObject({
      outcome: "hybrid_recovery",
      finalBlockCount: 6,
      requestedBlockCountSatisfied: true,
      fallback: {
        attempted: true,
        acceptedBlockCount: 1,
      },
    });
    expect(result.blocks.map((block) => block.heading)).toEqual(
      selection.selectedThemes.map((theme) => theme.label),
    );
    expect(result.finalized.markdown.match(/^### /gm)).toHaveLength(6);
    expect(
      result.blocks.filter((block) =>
        block.heading === "Incremental Repository Intelligence"
      ),
    ).toHaveLength(1);
    expect(result.finalized.citations.map((item) => item.projectFactId).sort()).toEqual(
      catalog.map((item) => item.projectFactId).sort(),
    );
  });

  it("removes semantically duplicated unplanned verifier blocks without attaching the unused source", async () => {
    const entries = [
      entry(1, "repository_knowledge_lifecycle", {
        content: "Repository semantic analysis divides code into bounded capability work packages and consolidates supported findings.",
      }),
      entry(2, "module:semantic_analyzer", {
        content: "Repository semantic analysis divides the codebase into bounded capability work packages, then consolidates its supported findings.",
      }),
    ];
    const baseSelection = selectProjectAnswerEditorialThemes({
      question: "Summarize the repository intelligence implementation.",
      entries,
    });
    const result = await verifyProjectAnswerWithRecovery({
      question: "Summarize the repository intelligence implementation.",
      draftAnswer: entries
        .map((item) => `${item.content} [citation:${item.citationIndexes[0]}]`)
        .join("\n\n"),
      entries,
      catalog: [citation(1), citation(2)],
      selection: {
        ...baseSelection,
        selectedThemes: [],
      },
      requiredBlockCount: { minimum: 1, maximum: 6 },
      verifier: verifierReturning(entries.map((item) => ({
        heading: item.title,
        bodyMarkdown: item.content,
        citationIndexes: item.citationIndexes,
      }))),
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.blocks).toHaveLength(1);
    expect(result.finalized.citations).toEqual([citation(1)]);
    expect(result.finalized.markdown).not.toContain("citation:2");
  });

  it("preserves arbitrary comparison order and passes compact request context to the verifier", async () => {
    const question =
      "Contrast batch imports with streaming updates in terms of latency, failure recovery, and operational complexity.";
    const entries = [
      entry(1, "module:batch_imports", {
        title: "Batch imports",
        content:
          "Batch imports use bounded jobs to reduce latency overhead and retry failed batches, with an operational coordination trade-off.",
      }),
      entry(2, "module:streaming_updates", {
        title: "Streaming updates",
        content:
          "Streaming updates process events continuously for lower latency and isolate failure recovery, with a consumer coordination trade-off.",
      }),
    ];
    const selection = selectProjectAnswerEditorialThemes({ question, entries });
    const verifier = verifierReturning([
      {
        heading: "Internal streaming theme",
        bodyMarkdown: entries[1]!.content,
        citationIndexes: [2],
      },
      {
        heading: "Internal batch theme",
        bodyMarkdown: entries[0]!.content,
        citationIndexes: [1],
      },
    ]);
    const result = await verifyProjectAnswerWithRecovery({
      question,
      draftAnswer: `${entries[0]!.content} [citation:1]\n\n${entries[1]!.content} [citation:2]`,
      entries,
      catalog: [citation(1), citation(2)],
      selection,
      verifier,
      comparisonContext: {
        priorUserObjective: "Choose an update strategy.",
      },
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.blocks.map((block) => block.heading)).toEqual([
      "Batch imports",
      "Streaming updates",
    ]);
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      requestContext: {
        question,
        comparisonContract: selection.profile.comparisonContract,
        conversation: {
          priorUserObjective: "Choose an update strategy.",
        },
      },
    }));
  });

  it("keeps exact recovery for same-theme comparison sides source-disjoint", async () => {
    const question =
      "Compare batch imports with streaming updates in terms of latency.";
    const entries = [
      entry(1, "module:data_ingestion", {
        title: "Batch imports",
        content: "Batch imports reduce per-record latency.",
      }),
      entry(2, "module:data_ingestion", {
        title: "Streaming updates",
        content: "Streaming updates reduce event latency.",
      }),
    ];
    const selection = selectProjectAnswerEditorialThemes({ question, entries });
    const result = await verifyProjectAnswerWithRecovery({
      question,
      draftAnswer: "",
      entries,
      catalog: [citation(1), citation(2)],
      selection,
      forceExactFallback: true,
      requiredBlockCount: { minimum: 2, maximum: 2 },
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.blocks).toEqual([
      expect.objectContaining({
        heading: "Batch imports",
        bodyMarkdown: "Batch imports reduce per-record latency.",
        citationIndexes: [1],
      }),
      expect.objectContaining({
        heading: "Streaming updates",
        bodyMarkdown: "Streaming updates reduce event latency.",
        citationIndexes: [2],
      }),
    ]);
  });
});
