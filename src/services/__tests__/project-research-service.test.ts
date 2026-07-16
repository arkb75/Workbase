import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: { findMany: vi.fn() },
  agentRun: { updateMany: vi.fn(), findUnique: vi.fn() },
  agentRunCandidate: { findMany: vi.fn() },
  projectFact: { findMany: vi.fn() },
}));

const retrievalMock = vi.hoisted(() => vi.fn());
const factCandidateMock = vi.hoisted(() => vi.fn());
const listPathsMock = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
const appendEventMock = vi.hoisted(() => vi.fn());
const usage = vi.hoisted(() => ({ treeLookups: 0, searches: 0, fileReads: 0, visibleBytes: 0 }));
const representativePaths = [
  "README.md",
  "prisma/schema.prisma",
  "src/lib/bedrock-converse-agent.ts",
  "src/services/github-repository-exploration-service.ts",
  "src/services/project-knowledge-retrieval-service.ts",
  "workflows/project-chat.ts",
  "app/work-items/[id]/chat/project-chat-panel.tsx",
  "src/services/__tests__/project-research-service.test.ts",
  "src/services/artifact-workflow-service.ts",
];

function fileReadResult(path: string) {
  return {
    path,
    content: `export const value = ${JSON.stringify(path)};`,
    lineStart: 1,
    lineEnd: 1,
    totalLines: 1,
    truncated: false,
    redacted: false,
    redactionCategories: [],
    contentSafety: "untrusted_repository_content" as const,
    citation: {
      type: "github_file" as const,
      sourceId: "source-1",
      repositoryFullName: "workbase/demo",
      commitSha: "a".repeat(40),
      blobSha: `blob-${path}`,
      path,
      lineStart: 1,
      lineEnd: 1,
      url: `https://github.com/workbase/demo/blob/${"a".repeat(40)}/${path}#L1`,
    },
    usage: { ...usage },
  };
}

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/project-knowledge-retrieval-service", () => ({
  projectKnowledgeRetrievalService: { retrieve: retrievalMock },
}));
vi.mock("@/src/services/project-fact-service", () => ({
  createProjectFactCandidates: factCandidateMock,
}));
vi.mock("@/src/services/project-chat-store", () => ({
  appendAgentRunEvent: appendEventMock,
}));
vi.mock("@/src/services/github-repository-exploration-service", () => ({
  GitHubRepositoryExplorationError: class GitHubRepositoryExplorationError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
  githubRepositoryExplorationService: {
    createBudget: () => ({ expiresAt: "2026-07-10T20:00:00.000Z", getUsage: () => ({ ...usage }) }),
    start: startMock,
  },
}));

import { GitHubRepositoryExplorationError } from "@/src/services/github-repository-exploration-service";
import {
  classifyRepositoryResearchScope,
  deterministicResearchQueries,
  hasHighConfidenceDeterministicResearchPlan,
  repositoryExcerptFocusTerms,
  repositoryPathScore,
  researchProject,
} from "@/src/services/project-research-service";

describe("deterministic project research controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(usage, { treeLookups: 0, searches: 0, fileReads: 0, visibleBytes: 0 });
    prismaMock.source.findMany.mockResolvedValue([
      { id: "source-1", label: "workbase/demo", updatedAt: new Date("2026-07-10T18:00:00.000Z") },
    ]);
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agentRun.findUnique.mockResolvedValue(null);
    retrievalMock.mockResolvedValue({
      query: "architecture",
      purpose: "private_chat",
      hits: [],
      selectedHighlightIds: [],
      selectedProjectFactIds: [],
      selectedEvidenceItemIds: [],
      selectedArtifactIds: [],
      warnings: [],
    });
    listPathsMock.mockImplementation(async () => {
      usage.treeLookups += 1;
      return {
        paths: representativePaths.map((path, index) => ({
          path,
          blobSha: `blob-${index + 1}`,
          size: 120,
          immutableUrl: `https://example.test/${path}`,
        })),
        nextCursor: "ignored-by-controller",
        treeTruncated: false,
        excludedCount: 0,
        usage: { ...usage },
      };
    });
    searchMock.mockImplementation(async ({ query }: { query: string }) => {
      usage.searches += 1;
      return {
        matches: [{
          path: query.includes("github")
            ? "src/services/github-repository-exploration-service.ts"
            : "src/services/artifact-workflow-service.ts",
          blobSha: "blob-search",
          size: 120,
          immutableUrl: "https://example.test/search",
          requiresRead: true as const,
        }],
        apiTotalCount: 1,
        searchIncomplete: false,
        treeTruncated: false,
        usage: { ...usage },
      };
    });
    readFileMock.mockImplementation(async ({ path }: { path: string }) => {
      usage.fileReads += 1;
      usage.visibleBytes += 120;
      return fileReadResult(path);
    });
    startMock.mockResolvedValue({
      snapshot: {
        sourceId: "source-1",
        workItemId: "work-item-1",
        repository: { id: "repo-1", fullName: "workbase/demo", owner: "workbase", name: "demo", defaultBranch: "main", private: true },
        revision: { requestedRef: "main", commitSha: "a".repeat(40), treeSha: "b".repeat(40), commitUrl: "https://example.test/commit", committedAt: "2026-07-10T17:00:00.000Z" },
        limits: {},
        expiresAt: "2026-07-10T20:00:00.000Z",
      },
      getUsage: () => ({ ...usage }),
      listPaths: listPathsMock,
      search: searchMock,
      readFile: readFileMock,
    });
    factCandidateMock.mockResolvedValue({
      candidateIds: ["candidate-1", "candidate-2"],
      activeProjectFactIds: ["fact-1", "fact-2"],
      coverageGaps: [],
      tokenUsage: null,
    });
    prismaMock.agentRunCandidate.findMany.mockResolvedValue([
      { ordinal: 1, projectFact: { id: "fact-1", statement: "The chat service uses a deterministic intent router.", category: "architecture", confidence: "high" } },
      { ordinal: 2, projectFact: { id: "fact-2", statement: "Repository reads are pinned to an immutable commit.", category: "behavior", confidence: "high" } },
    ]);
    prismaMock.projectFact.findMany.mockResolvedValue([]);
  });

  it("uses deterministic planning for exact code and control-flow questions", () => {
    expect(hasHighConfidenceDeterministicResearchPlan(
      "Where are retry limits enforced, and what terminates the loop?",
    )).toBe(true);
    expect(hasHighConfidenceDeterministicResearchPlan(
      "How does `maxIterations` stop the agent?",
    )).toBe(true);
    expect(hasHighConfidenceDeterministicResearchPlan(
      "Explain how the product decides what context matters.",
    )).toBe(false);
  });

  it("covers representative project areas for a comprehensive assessment", async () => {
    const result = await researchProject({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "Inspect the repo for a comprehensive up-to-date architecture assessment.",
      purpose: "answer_question",
    });

    expect(listPathsMock).toHaveBeenCalledTimes(1);
    expect(searchMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(8);
    expect(result.status).toBe("answered");
    expect(result.citations.map((citation) => citation.kind)).toEqual(["project_fact", "project_fact"]);
    expect(result.exploredEvidence.every((citation) => citation.kind === "github_file")).toBe(true);
    expect(result.answer).toContain("auto-applied");
    expect(result.answer).toContain("[citation:1]");
    expect(result.coverage?.planned).toHaveLength(8);
    expect(result.coverage?.achieved).toHaveLength(8);
    expect(result.coverageGaps).toEqual([]);
    expect(result.partial).toBe(false);
    expect(factCandidateMock).toHaveBeenCalledWith(expect.objectContaining({ maxFacts: 8 }));
    expect(appendEventMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_call",
      toolName: "search_repository",
    }));
    expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_result",
      toolName: "read_repository_file",
      payload: expect.objectContaining({
        commitSha: "a".repeat(40),
        path: expect.any(String),
        visibleBytes: expect.any(Number),
      }),
      isUserVisible: false,
    }));
    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        researchState: expect.objectContaining({
          version: 1,
          phase: "finalizing",
          candidateIds: ["candidate-1", "candidate-2"],
        }),
      }),
    }));
  });

  it("treats a current strongest-accomplishments request as broad synthesis", async () => {
    expect(classifyRepositoryResearchScope(
      "Summarize my strongest accomplishments and make sure your information is up to date.",
    )).toBe("bounded_comprehensive");

    const result = await researchProject({
      runId: "run-accomplishments",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "Summarize my strongest accomplishments and make sure your information is up to date.",
      purpose: "answer_question",
    });

    expect(readFileMock).toHaveBeenCalledTimes(8);
    expect(result.coverage?.planned).toEqual([
      "product purpose and surface",
      "data and domain model",
      "AI and model runtime",
      "repository and source ingestion",
      "retrieval and citation architecture",
      "durable workflow and orchestration",
      "review and user experience",
      "tests and operational safeguards",
    ]);
    expect(factCandidateMock).toHaveBeenCalledWith(expect.objectContaining({ maxFacts: 8 }));
  });

  it("preserves the five-file strategy for a targeted query", async () => {
    expect(classifyRepositoryResearchScope(
      "How does the artifact workflow decide whether context is adequate?",
    )).toBe("targeted");

    const result = await researchProject({
      runId: "run-targeted",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "How does the artifact workflow decide whether context is adequate?",
      purpose: "answer_question",
    });

    expect(readFileMock).toHaveBeenCalledTimes(5);
    expect(result.status).toBe("answered");
    expect(result.coverage?.planned).toEqual([
      "primary architecture",
      "request-relevant implementation",
      "data and service boundaries",
    ]);
    expect(factCandidateMock).toHaveBeenCalledWith(expect.objectContaining({ maxFacts: 4 }));
  });

  it("answers from a canonical fact reused by another run without creating a new review candidate", async () => {
    factCandidateMock.mockResolvedValue({
      candidateIds: [],
      activeProjectFactIds: ["fact-reused"],
      coverageGaps: [],
      tokenUsage: null,
    });
    prismaMock.agentRunCandidate.findMany.mockResolvedValue([]);
    prismaMock.projectFact.findMany.mockResolvedValue([{
      id: "fact-reused",
      statement: "Repository research reads files from an immutable commit revision.",
      category: "behavior",
      confidence: "high",
    }]);

    const result = await researchProject({
      runId: "run-reusing-canonical-fact",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "How are repository reads pinned?",
      purpose: "answer_question",
    });

    expect(result.status).toBe("answered");
    expect(result.candidateIds).toEqual([]);
    expect(result.answer).toContain("immutable commit revision");
    expect(result.answer).toContain("no new review item was created");
    expect(result.citations).toEqual([
      expect.objectContaining({
        kind: "project_fact",
        projectFactId: "fact-reused",
      }),
    ]);
    expect(prismaMock.projectFact.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["fact-reused"] },
        workItemId: "work-item-1",
        status: "approved",
        lifecycleStatus: "active",
      },
    });
  });

  it("uses focused control-flow searches and prefers runtime code over tests", async () => {
    const question = "Inspect the repository: where are retry limits enforced, and what terminates the loop?";
    expect(deterministicResearchQueries(question)).toEqual(["maxIterations", "stopReason"]);
    expect(repositoryPathScore("src/services/retry-runtime.ts", question, "search")).toBeGreaterThan(
      repositoryPathScore("src/services/__tests__/retry-runtime.test.ts", question, "search"),
    );
    expect(repositoryExcerptFocusTerms(question)).toEqual(expect.arrayContaining([
      "maxIterations",
      "stopReason",
      "retry",
      "while",
    ]));

    searchMock.mockImplementation(async () => {
      usage.searches += 1;
      return {
        matches: [
          {
            path: "src/lib/bedrock-converse-agent.ts",
            blobSha: "blob-runtime",
            size: 120,
            immutableUrl: "https://example.test/runtime",
            requiresRead: true as const,
          },
          {
            path: "src/lib/__tests__/bedrock-converse-agent.test.ts",
            blobSha: "blob-test",
            size: 120,
            immutableUrl: "https://example.test/test",
            requiresRead: true as const,
          },
        ],
        apiTotalCount: 2,
        searchIncomplete: false,
        treeTruncated: false,
        usage: { ...usage },
      };
    });
    factCandidateMock.mockResolvedValue({
      candidateIds: ["candidate-1", "candidate-2"],
      activeProjectFactIds: ["fact-1", "fact-2"],
      coverageGaps: ["The inspected excerpts did not establish a retry or backoff policy."],
      tokenUsage: null,
    });

    const result = await researchProject({
      runId: "run-control-flow",
      userId: "user-1",
      workItemId: "work-item-1",
      question,
      purpose: "answer_question",
    });

    expect(result.status).toBe("answered");
    expect(result.partial).toBe(true);
    expect(result.answer).toContain("did not establish a retry or backoff policy");
    expect(searchMock.mock.calls.map(([input]) => input.query)).toEqual(["maxIterations", "stopReason"]);
    expect(readFileMock).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/lib/bedrock-converse-agent.ts",
      focusTerms: expect.arrayContaining(["maxIterations", "stopReason"]),
      lineWindow: 160,
    }));
    const readPaths = readFileMock.mock.calls.map(([input]) => input.path);
    const runtimeIndex = readPaths.indexOf("src/lib/bedrock-converse-agent.ts");
    const testIndex = readPaths.indexOf("src/lib/__tests__/bedrock-converse-agent.test.ts");
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex === -1 || runtimeIndex < testIndex).toBe(true);
  });

  it("returns explicit partial coverage gaps when the broad research budget ends", async () => {
    readFileMock.mockImplementation(async ({ path }: { path: string }) => {
      if (usage.fileReads >= 5) {
        throw new GitHubRepositoryExplorationError(
          "budget_exhausted",
          "The repository model-visible content budget is exhausted.",
        );
      }
      usage.fileReads += 1;
      usage.visibleBytes += 8 * 1024;
      return fileReadResult(path);
    });

    const result = await researchProject({
      runId: "run-partial",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "Give me a comprehensive, current summary of my strongest accomplishments.",
      purpose: "answer_question",
    });

    expect(result.status).toBe("answered");
    expect(result.partial).toBe(true);
    expect(result.coverage?.achieved).toHaveLength(5);
    expect(result.coverageGaps).toContain(
      "The bounded repository budget ended before representative coverage was complete.",
    );
    expect(result.coverageGaps.some((gap) => gap.includes("review and user experience"))).toBe(true);
    expect(factCandidateMock).toHaveBeenCalledWith(expect.objectContaining({ partial: true }));
  });
});
