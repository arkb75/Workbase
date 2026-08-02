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
      question: "How do the typed application services work?",
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).toBe("direct_answer");
  });

  it("does not treat a merely related approved fact as adequate for a targeted code question", () => {
    expect(routeProjectTurn({
      question: "Where is retry backoff enforced, and what terminates the loop?",
      memoryHits: [{
        ...approvedFact,
        title: "Durable workflow architecture",
        content: "The application has durable workflow orchestration.",
      }],
      allowResearch: true,
    }).kind).toBe("repository_research");
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

  it.each([
    "Compare repository knowledge refresh with targeted repository research.",
    "How does the repository refresh scheduler differ from incremental ingestion?",
    "Explain the trade-off between a codebase refresh and a targeted search.",
    "Refresh rate in the repository pipeline versus targeted research latency.",
    "How does Workbase inspect the repository during a knowledge refresh?",
    "Why does the workflow read the codebase during refresh?",
    "Read versus write behavior in the repository refresh.",
    "Read-vs-write behavior in the repository refresh.",
    "Read/write behavior in the repository refresh.",
    "Read behavior versus write behavior in repository refresh.",
    "Compare reading source files with writing durable facts during repository refresh.",
  ])("keeps conceptual refresh comparisons on approved memory: %s", (question) => {
    expect(routeProjectTurn({
      question,
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).toBe("direct_answer");
  });

  it.each([
    "Refresh knowledge from the repository before answering.",
    "Please refresh Workbase repository knowledge.",
    "I need you to refresh the repository before answering.",
    "Go ahead and refresh the repo, then answer.",
    "Could you refresh Workbase repository knowledge?",
    "Before answering, please refresh the repository.",
    "First, refresh the codebase and then answer.",
    "Before you answer, refresh the repository.",
    "Before responding, refresh the repository.",
    "Next, refresh the repository.",
    "Please, refresh the repository.",
  ])("routes an explicit knowledge-refresh action as fresh repository work: %s", (question) => {
    expect(routeProjectTurn({
      question,
      memoryHits: [approvedFact],
      allowResearch: true,
    })).toMatchObject({
      kind: "repository_research",
      freshness: "required",
    });
  });

  it.each([
    "Before answering, please read the repository.",
    "First, inspect the codebase and then answer.",
  ])("routes a prefixed explicit inspection as repository work: %s", (question) => {
    expect(routeProjectTurn({
      question,
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).toBe("repository_research");
  });

  it("routes provenance questions without repository research", () => {
    expect(routeProjectTurn({
      question: "Did you inspect the repo in your previous answer?",
      memoryHits: [],
      allowResearch: true,
    }).kind).toBe("prior_turn_provenance");
  });

  it.each([
    "Did you use any information that was not already present?",
    "What sources did you use?",
    "Were repository tools called?",
    "Was a fallback used in the last run?",
    "Which sources supported your previous answer?",
  ])("routes explicit prior-turn process questions as provenance: %s", (question) => {
    expect(routeProjectTurn({
      question,
      memoryHits: [],
      allowResearch: true,
    }).kind).toBe("prior_turn_provenance");
  });

  it.each([
    "How does artifact fallback generation work?",
    "Explain the partial result recovery path.",
    "What source code handles imports?",
    "Which sources feed artifact generation?",
  ])("does not misroute project behavior as prior-turn provenance: %s", (question) => {
    expect(routeProjectTurn({
      question,
      memoryHits: [approvedFact],
      allowResearch: true,
    }).kind).not.toBe("prior_turn_provenance");
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
    expect(manifest.capabilities.repositoryResearch.repositories).toHaveLength(4);
    expect(manifest.capabilities.repositoryResearch).toMatchObject({
      readOnly: true,
      rawFilesAreProvenanceOnly: true,
      requiresProjectFactApproval: false,
      maxRepositories: null,
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
