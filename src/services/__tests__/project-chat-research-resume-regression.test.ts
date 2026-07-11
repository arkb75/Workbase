import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectKnowledgeCitation,
  ProjectKnowledgeHit,
  ProjectResearchResult,
} from "@/src/domain/project-chat";

const JULY_SHA = "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5";
const JULY_COMMIT_AT = "2026-07-09T23:02:00.000Z";
const JULY_RESEARCH_AT = "2026-07-10T20:30:00.000Z";
const APRIL_IMPORT_AT = new Date("2026-04-06T02:05:31.418Z");

const currentFactCitations: ProjectKnowledgeCitation[] = [
  {
    kind: "project_fact",
    label: "Durable approval resumes the same researched chat run.",
    excerpt: "Durable approval resumes the same researched chat run.",
    projectFactId: "fact-current-1",
  },
  {
    kind: "project_fact",
    label: "Repository answers are pinned to an immutable commit SHA.",
    excerpt: "Repository answers are pinned to an immutable commit SHA.",
    projectFactId: "fact-current-2",
  },
];

const oldHighlights: ProjectKnowledgeHit[] = Array.from({ length: 14 }, (_, index) => ({
  id: `highlight-old-${index + 1}`,
  kind: "highlight" as const,
  authority: "verified_highlight" as const,
  title: `Imported highlight ${index + 1}`,
  content: `Project memory imported on April 6, 2026 (${index + 1}).`,
  score: 100 - index,
  citations: [{
    kind: "highlight" as const,
    label: `Imported highlight ${index + 1}`,
    excerpt: `Project memory imported on April 6, 2026 (${index + 1}).`,
    highlightId: `highlight-old-${index + 1}`,
  }],
}));

const currentFacts: ProjectKnowledgeHit[] = currentFactCitations.map((citation, index) => ({
  id: citation.projectFactId!,
  kind: "project_fact",
  authority: "verified_project_fact",
  title: citation.label,
  content: citation.excerpt,
  // Reproduce the reported failure: generic historical memory outranks facts
  // approved specifically for this research turn.
  score: 5 - index,
  citations: [citation],
}));

const persistedRun = vi.hoisted(() => ({
  environmentSnapshot: {
    capabilities: {
      repositoryResearch: {
        repositories: [{
          sourceId: "source-1",
          name: "arkb75/Workbase",
          importedAt: "2026-04-06T02:05:31.418Z",
          pinnedSha: "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5",
          committedAt: "2026-07-09T23:02:00.000Z",
          resolvedAt: "2026-07-10T20:30:00.000Z",
        }],
      },
    },
  } as unknown,
  researchState: {
    phase: "awaiting_review",
    partial: true,
    coverage: {
      planned: ["service architecture", "workflow durability", "UI and routes"],
      achieved: ["service architecture", "workflow durability"],
      uninspected: ["UI and routes were not inspected under the bounded read budget."],
      omittedRepositories: [],
    },
    notebook: {
      citations: [{
        type: "github_file",
        title: "src/services/project-chat-agent-service.ts",
        repository: "arkb75/Workbase",
        commitSha: "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5",
        path: "src/services/project-chat-agent-service.ts",
        startLine: 1,
        endLine: 160,
      }],
    },
    updatedAt: "2026-07-10T20:30:00.000Z",
  } as unknown,
  provisionalResult: {
    content: "Two current Project Facts are awaiting review.",
    citations: [
      {
        ordinal: 1,
        kind: "project_fact",
        label: "Durable approval resumes the same researched chat run.",
        projectFactId: "fact-current-1",
      },
      {
        ordinal: 2,
        kind: "project_fact",
        label: "Repository answers are pinned to an immutable commit SHA.",
        projectFactId: "fact-current-2",
      },
    ],
    capturedAt: "2026-07-10T20:30:00.000Z",
  } as unknown,
}));

const prismaMock = vi.hoisted(() => ({
  source: { findMany: vi.fn() },
  agentRun: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  agentRunCandidate: { findMany: vi.fn() },
}));
const retrievalMock = vi.hoisted(() => vi.fn());
const researchMock = vi.hoisted(() => vi.fn());
const reviewState = vi.hoisted(() => ({ approved: false }));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/project-knowledge-retrieval-service", () => ({
  projectKnowledgeRetrievalService: { retrieve: retrievalMock },
}));
vi.mock("@/src/services/project-research-service", () => ({
  projectResearchService: { research: researchMock },
}));
vi.mock("@/src/services/prior-turn-provenance-service", () => ({
  priorTurnProvenanceService: { inspect: vi.fn() },
}));

import {
  finalizeProjectChatAfterFactReview,
  runProjectChatAgent,
} from "@/src/services/project-chat-agent-service";

function awaitingReviewResult(): ProjectResearchResult {
  return {
    status: "awaiting_review",
    answer: [
      `${currentFactCitations[0].excerpt} [citation:1]`,
      `${currentFactCitations[1].excerpt} [citation:2]`,
    ].join("\n\n"),
    findings: currentFactCitations.map((citation, index) => ({
      statement: citation.excerpt,
      confidence: "high",
      isInference: false,
      citationIndexes: [index],
    })),
    citations: currentFactCitations,
    coverageGaps: ["UI and routes were not inspected under the bounded read budget."],
    warnings: ["The result is current but bounded."],
    candidateIds: ["candidate-1", "candidate-2"],
    generationRunIds: [],
    partial: true,
    exploredEvidence: [{
      kind: "github_file",
      label: "src/services/project-chat-agent-service.ts",
      excerpt: "export async function runProjectChatAgent(...) { ... }",
      repository: "arkb75/Workbase",
      commitSha: JULY_SHA,
      path: "src/services/project-chat-agent-service.ts",
      startLine: 1,
      endLine: 160,
    }],
    coverage: {
      planned: ["service architecture", "workflow durability", "UI and routes"],
      achieved: ["service architecture", "workflow durability"],
      uninspected: ["UI and routes were not inspected under the bounded read budget."],
      omittedRepositories: [],
    },
  };
}

describe("project chat research approval resume regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewState.approved = false;
    persistedRun.environmentSnapshot = {
      capabilities: {
        repositoryResearch: {
          repositories: [{
            sourceId: "source-1",
            name: "arkb75/Workbase",
            importedAt: "2026-04-06T02:05:31.418Z",
            pinnedSha: JULY_SHA,
            committedAt: JULY_COMMIT_AT,
            resolvedAt: JULY_RESEARCH_AT,
          }],
        },
      },
    };
    persistedRun.researchState = {
      phase: "awaiting_review",
      partial: true,
      coverage: {
        planned: ["service architecture", "workflow durability", "UI and routes"],
        achieved: ["service architecture", "workflow durability"],
        uninspected: ["UI and routes were not inspected under the bounded read budget."],
        omittedRepositories: [],
      },
      notebook: {
        citations: [{
          type: "github_file",
          title: "src/services/project-chat-agent-service.ts",
          repository: "arkb75/Workbase",
          commitSha: JULY_SHA,
          path: "src/services/project-chat-agent-service.ts",
          startLine: 1,
          endLine: 160,
        }],
      },
      updatedAt: JULY_RESEARCH_AT,
    };
    prismaMock.source.findMany.mockResolvedValue([{
      id: "source-1",
      label: "arkb75/Workbase",
      metadata: { repository: { fullName: "arkb75/Workbase" } },
      updatedAt: APRIL_IMPORT_AT,
    }]);
    prismaMock.agentRunCandidate.findMany.mockImplementation(async ({ where }: {
      where?: { status?: string };
    }) => where?.status === "pending"
      ? []
      : currentFacts.map((fact, index) => ({
          id: `candidate-${index + 1}`,
          status: "approved",
          projectFactId: fact.id,
          projectFact: { id: fact.id, status: "approved" },
        })));
    prismaMock.agentRun.findFirst.mockImplementation(async () => ({
      environmentSnapshot: persistedRun.environmentSnapshot,
      researchState: persistedRun.researchState,
      provisionalResult: persistedRun.provisionalResult,
      candidates: reviewState.approved
        ? currentFacts.map((fact) => ({ projectFactId: fact.id }))
        : [],
    }));
    prismaMock.agentRun.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if ("environmentSnapshot" in data) persistedRun.environmentSnapshot = data.environmentSnapshot;
      if ("researchState" in data) persistedRun.researchState = data.researchState;
      if ("provisionalResult" in data) persistedRun.provisionalResult = data.provisionalResult;
      return { count: 1 };
    });
    researchMock.mockResolvedValue(awaitingReviewResult());
  });

  it("retains July repository freshness, approved current-run facts, and partial gaps after review", async () => {
    const originalEnvironmentSnapshot = structuredClone(persistedRun.environmentSnapshot);
    retrievalMock
      .mockResolvedValueOnce({
        query: "Summarize my strongest accomplishments and make sure your information is up to date.",
        purpose: "private_chat",
        hits: oldHighlights,
        selectedHighlightIds: oldHighlights.map((hit) => hit.id),
        selectedProjectFactIds: [],
        selectedEvidenceItemIds: [],
        selectedArtifactIds: [],
        warnings: [],
      })
      .mockResolvedValueOnce({
        query: "Summarize my strongest accomplishments and make sure your information is up to date.",
        purpose: "private_chat",
        // Deliberately leave current-run facts below the old global top-14 cutoff.
        hits: [...oldHighlights, ...currentFacts],
        selectedHighlightIds: oldHighlights.map((hit) => hit.id),
        selectedProjectFactIds: currentFacts.map((hit) => hit.id),
        selectedEvidenceItemIds: [],
        selectedArtifactIds: [],
        warnings: [],
      });

    const input = {
      runId: "run-july",
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      messageId: "message-1",
      question: "Summarize my strongest accomplishments and make sure your information is up to date.",
    };
    const researched = await runProjectChatAgent({ ...input, allowResearch: true });
    expect(researched).toMatchObject({
      status: "awaiting_review",
      research: {
        partial: true,
        coverageGaps: ["UI and routes were not inspected under the bounded read budget."],
      },
    });

    reviewState.approved = true;

    // This is the same call the durable workflow makes after the complete review
    // batch. It must resume the saved turn rather than start a generic memory-only
    // answer whose only explicit date is the April source import timestamp.
    const finalized = await finalizeProjectChatAfterFactReview(input);

    expect(finalized.status).toBe("answered");
    if (finalized.status === "artifact_requested") throw new Error("Unexpected artifact request");
    expect(finalized.citations.map((citation) => citation.projectFactId)).toEqual(
      expect.arrayContaining(["fact-current-1", "fact-current-2"]),
    );
    expect(finalized.answer).not.toMatch(/as of April 6, 2026/i);
    expect(finalized.research).toMatchObject({
      partial: true,
      coverageGaps: ["UI and routes were not inspected under the bounded read budget."],
      groundedClaims: expect.arrayContaining([
        expect.objectContaining({ citationIndexes: [1] }),
        expect.objectContaining({ citationIndexes: [2] }),
      ]),
    });

    expect(retrievalMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      preferredProjectFactIds: ["fact-current-1", "fact-current-2"],
    }));

    expect(persistedRun.environmentSnapshot).toEqual(originalEnvironmentSnapshot);
    expect(persistedRun.environmentSnapshot).toEqual(expect.objectContaining({
      capabilities: expect.objectContaining({
        repositoryResearch: expect.objectContaining({
          repositories: expect.arrayContaining([
            expect.objectContaining({
              pinnedSha: JULY_SHA,
              committedAt: JULY_COMMIT_AT,
              resolvedAt: JULY_RESEARCH_AT,
            }),
          ]),
        }),
      }),
    }));
    expect(persistedRun.researchState).toEqual(expect.objectContaining({
      phase: "finalizing",
      partial: true,
      coverage: expect.objectContaining({
        uninspected: ["UI and routes were not inspected under the bounded read budget."],
      }),
    }));
  });
});
