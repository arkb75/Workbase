import { describe, expect, it } from "vitest";
import {
  buildMemoryCatalog,
  buildStandaloneResearchQuestion,
  requiresLiveRepositoryResearch,
} from "@/src/services/project-chat-agent-service";

describe("project chat repository intent", () => {
  it.each([
    "Pull more recent information from the repo.",
    "Inspect the GitHub repository before answering.",
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
});
