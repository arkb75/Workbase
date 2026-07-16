import { describe, expect, it } from "vitest";
import {
  buildContextualRetrievalQuery,
  buildMemoryCatalog,
  buildStandaloneResearchQuestion,
  requiresLiveRepositoryResearch,
} from "@/src/services/project-chat-agent-service";

describe("project chat repository intent", () => {
  it.each([
    "Pull more recent information from the repo.",
    "Inspect the GitHub repository before answering.",
    "Inspect arkb75/PrivateOtherRepo and compare its architecture.",
    "Can you check the repo for the latest implementation?",
    "Summarize my strongest accomplishments and make sure your information is up to date.",
  ])("forces live research for %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(true);
  });

  it("does not force repository access for an ordinary memory-backed question", () => {
    expect(requiresLiveRepositoryResearch("Summarize my strongest accomplishments.")).toBe(false);
  });

  it("resolves a follow-up into a standalone research objective", () => {
    expect(
      buildStandaloneResearchQuestion({
        currentQuestion: "Pull more recent information from the repo too.",
        delegatedQuestion: "Find what changed recently.",
        history: [
          {
            id: "user-1",
            role: "user",
            content: "Summarize my strongest accomplishments.",
            citations: [],
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Earlier summary.",
            citations: [],
          },
        ],
      }),
    ).toBe(
      [
        "Prior user objective: Summarize my strongest accomplishments.",
        "Prior assistant answer: Earlier summary.",
        "Current follow-up: Pull more recent information from the repo too.",
        "Specific research request: Find what changed recently.",
      ].join("\n"),
    );
  });

  it("rewrites an elliptical follow-up with bounded prior context and citation manifests", () => {
    const query = buildContextualRetrievalQuery({
      currentQuestion: "Which part of that flow is retried, and why?",
      history: [
        {
          id: "user-1",
          role: "user",
          content: "How does the main architecture work?",
          citations: [],
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "A durable workflow coordinates project chat and artifact generation.",
          citations: [{ ordinal: 1, kind: "project_fact", label: "Durable workflow orchestration" }],
        },
      ],
    });

    expect(query).toContain("Current question: Which part of that flow is retried, and why?");
    expect(query).toContain("Prior user objective: How does the main architecture work?");
    expect(query).toContain("Prior assistant answer: A durable workflow coordinates project chat and artifact generation.");
    expect(query).toContain('"type":"project_fact","title":"Durable workflow orchestration"');
    expect(query.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps an independent turn free of unrelated history", () => {
    expect(buildContextualRetrievalQuery({
      currentQuestion: "Explain the database schema.",
      history: [{ id: "assistant-1", role: "assistant", content: "Unrelated prior answer.", citations: [] }],
    })).toBe("Explain the database schema.");
  });

  it("reserves current-run Project Facts and keeps GitHub excerpts as nested provenance", () => {
    const catalog = buildMemoryCatalog({
      currentRunProjectFactIds: ["fact-current"],
      hits: [
        ...Array.from({ length: 14 }, (_, index) => ({
          id: `highlight-${index}`,
          kind: "highlight" as const,
          authority: "verified_highlight" as const,
          title: `Historical highlight ${index}`,
          content: `Historical content ${index}`,
          score: 100 - index,
          citations: [{
            kind: "highlight" as const,
            label: `Historical highlight ${index}`,
            excerpt: `Historical content ${index}`,
            highlightId: `highlight-${index}`,
          }],
        })),
        {
          id: "fact-current",
          kind: "project_fact" as const,
          authority: "verified_project_fact" as const,
          title: "Current reviewed fact",
          content: "Current reviewed fact content",
          score: 1,
          citations: [
            { kind: "project_fact" as const, label: "Current reviewed fact", excerpt: "Current reviewed fact content", projectFactId: "fact-current" },
            { kind: "github_file" as const, label: "src/current.ts", excerpt: "raw code", path: "src/current.ts", commitSha: "a".repeat(40) },
          ],
        },
      ],
    });

    expect(catalog.entries[0]).toMatchObject({
      kind: "project_fact",
      currentRun: true,
      supportingSources: [{ type: "github_file", title: "src/current.ts" }],
    });
    expect(catalog.citations).toEqual([
      expect.objectContaining({ kind: "project_fact", projectFactId: "fact-current" }),
      ...catalog.citations.slice(1),
    ]);
    expect(catalog.citations.some((citation) => citation.kind === "github_file")).toBe(false);
  });

  it("builds a subsystem-balanced catalog for a main-architecture question", () => {
    const ranking = {
      evidenceStrength: 5,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 4,
      ownershipAuthority: 0,
      distinctiveness: 4,
      freshness: 5,
      impactBonus: 0,
      uncertainty: null,
    };
    const subsystems = [
      "product_surface",
      "repository_knowledge_lifecycle",
      "project_chat_grounding",
      "artifact_generation",
      "workflow_orchestration",
    ];
    const hits = [
      ...subsystems.map((subsystemKey, index) => ({
        id: `fact-${index}`,
        kind: "project_fact" as const,
        authority: "verified_project_fact" as const,
        title: `${subsystemKey} architecture`,
        content: `${subsystemKey} is a supported system capability.`,
        score: 20 - index,
        subsystemKey,
        validatedThroughSha: "a".repeat(40),
        accomplishmentRanking: ranking,
        citations: [{
          kind: "project_fact" as const,
          label: `${subsystemKey} architecture`,
          excerpt: `${subsystemKey} is a supported system capability.`,
          projectFactId: `fact-${index}`,
        }],
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `duplicate-${index}`,
        kind: "project_fact" as const,
        authority: "verified_project_fact" as const,
        title: `High-score chat detail ${index}`,
        content: `A project chat implementation detail ${index}.`,
        score: 1_000 - index,
        subsystemKey: "project_chat_grounding",
        validatedThroughSha: "a".repeat(40),
        accomplishmentRanking: ranking,
        citations: [{
          kind: "project_fact" as const,
          label: `High-score chat detail ${index}`,
          excerpt: `A project chat implementation detail ${index}.`,
          projectFactId: `duplicate-${index}`,
        }],
      })),
    ];

    const catalog = buildMemoryCatalog({
      hits,
      query: "How does the main architecture work?",
    });

    expect(new Set(catalog.entries.slice(0, 5).map((entry) => entry.subsystemKey))).toEqual(new Set(subsystems));
  });
});
