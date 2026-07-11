import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeHit } from "@/src/domain/project-chat";
import {
  buildProjectAgentTurnContext,
  routeProjectTurn,
  toModelCapabilityManifest,
} from "@/src/services/project-agent-harness";

const approvedFact: ProjectKnowledgeHit = {
  id: "fact-1",
  kind: "project_fact",
  authority: "verified_project_fact",
  title: "Typed application services",
  content: "The application uses typed services.",
  score: 0.9,
  citations: [{ kind: "project_fact", label: "Typed application services", excerpt: "The application uses typed services.", projectFactId: "fact-1" }],
};

describe("project agent harness", () => {
  it("answers from approved memory without repository research", () => {
    expect(routeProjectTurn({
      question: "How does the architecture work?",
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).toBe("direct_answer");
  });

  it("forces repository research for freshness and explicit inspection", () => {
    const intent = routeProjectTurn({
      question: "Inspect the repository and make sure this is up to date.",
      memoryHits: [approvedFact],
      allowResearch: true,
    });
    expect(intent).toMatchObject({
      kind: "repository_research",
      freshness: "required",
      coverage: "targeted",
    });
  });

  it("classifies strongest-accomplishment summaries as broad synthesis", () => {
    const intent = routeProjectTurn({
      question: "Summarize my strongest accomplishments and make sure this is up to date.",
      memoryHits: [approvedFact],
      allowResearch: true,
    });
    expect(intent).toMatchObject({
      kind: "repository_research",
      freshness: "required",
      coverage: "broad_synthesis",
    });
  });

  it("routes provenance questions without repository research", () => {
    expect(routeProjectTurn({
      question: "Did you inspect the repo in your previous answer?",
      memoryHits: [],
      allowResearch: true,
    }).kind).toBe("prior_turn_provenance");
  });

  it("does not confuse a normal accomplishment question with provenance inspection", () => {
    expect(routeProjectTurn({
      question: "What did you build in this project?",
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).toBe("direct_answer");
  });

  it("prevents a post-review finalizer from starting another research pass", () => {
    const intent = routeProjectTurn({
      question: "Give me the latest repository architecture.",
      memoryHits: [approvedFact],
      allowResearch: false,
    });
    expect(intent.kind).toBe("direct_answer");
    expect(intent.reason).toContain("post-review");
  });

  it("publishes the same bounded capabilities used for runtime enforcement", () => {
    const intent = routeProjectTurn({
      question: "Search everything in the repo.",
      memoryHits: [],
      allowResearch: true,
    });
    const context = buildProjectAgentTurnContext({
      question: "Search everything in the repo.",
      intent,
      hits: [],
      repositories: Array.from({ length: 4 }, (_, index) => ({
        sourceId: `source-${index + 1}`,
        name: `repo-${index + 1}`,
        importedAt: `2026-07-0${index + 1}T00:00:00.000Z`,
      })),
    });
    const manifest = toModelCapabilityManifest(context);
    expect(manifest.capabilities.repositoryResearch.repositories).toHaveLength(3);
    expect(manifest.capabilities.repositoryResearch).toMatchObject({
      readOnly: true,
      rawFilesAreProvenanceOnly: true,
      requiresProjectFactApproval: true,
      maxRepositories: 3,
    });
    expect(manifest.run.remaining).toMatchObject({ searches: 2, fileReads: 8, visibleBytes: 65_536 });
  });

  it("separates source import, repository commit, and inspection freshness", () => {
    const intent = routeProjectTurn({
      question: "Give me a current overview.",
      memoryHits: [approvedFact],
      allowResearch: false,
    });
    const context = buildProjectAgentTurnContext({
      question: "Give me a current overview.",
      intent,
      hits: [approvedFact],
      repositories: [{
        sourceId: "source-1",
        name: "workbase/demo",
        importedAt: "2026-04-06T02:05:31.418Z",
        pinnedSha: "a".repeat(40),
        committedAt: "2026-07-09T23:02:00.000Z",
        resolvedAt: "2026-07-10T20:30:00.000Z",
      }],
    });
    expect(context.knowledge).toMatchObject({
      latestSourceImportedAt: "2026-04-06T02:05:31.418Z",
      latestRepositoryCommitAt: "2026-07-09T23:02:00.000Z",
      latestRepositoryInspectedAt: "2026-07-10T20:30:00.000Z",
      latestFactApprovedAt: null,
      latestDurableMemoryAt: "2026-07-10T20:30:00.000Z",
    });
  });
});
