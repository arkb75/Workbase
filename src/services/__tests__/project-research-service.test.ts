import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: { findMany: vi.fn() },
  agentRun: { updateMany: vi.fn(), findUnique: vi.fn() },
  agentRunCandidate: { findMany: vi.fn() },
}));

const retrievalMock = vi.hoisted(() => vi.fn());
const factCandidateMock = vi.hoisted(() => vi.fn());
const listPathsMock = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
const usage = vi.hoisted(() => ({ treeLookups: 0, searches: 0, fileReads: 0, visibleBytes: 0 }));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/project-knowledge-retrieval-service", () => ({
  projectKnowledgeRetrievalService: { retrieve: retrievalMock },
}));
vi.mock("@/src/services/project-fact-service", () => ({
  createProjectFactCandidates: factCandidateMock,
}));
vi.mock("@/src/services/project-chat-store", () => ({
  appendAgentRunEvent: vi.fn(),
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

import { researchProject } from "@/src/services/project-research-service";

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
        paths: Array.from({ length: 8 }, (_, index) => ({
          path: `src/service-${index + 1}.ts`,
          blobSha: `blob-${index + 1}`,
          size: 120,
          immutableUrl: `https://example.test/src/service-${index + 1}.ts`,
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
          path: query.includes("data flow") ? "src/service-2.ts" : "src/service-1.ts",
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
    factCandidateMock.mockResolvedValue({ candidateIds: ["candidate-1", "candidate-2"], coverageGaps: [] });
    prismaMock.agentRunCandidate.findMany.mockResolvedValue([
      { ordinal: 1, projectFact: { id: "fact-1", statement: "The chat service uses a deterministic intent router.", category: "architecture", confidence: "high" } },
      { ordinal: 2, projectFact: { id: "fact-2", statement: "Repository reads are pinned to an immutable commit.", category: "behavior", confidence: "high" } },
    ]);
  });

  it("lists once, searches twice, reads selected files, and exposes only draft facts as answer citations", async () => {
    const result = await researchProject({
      runId: "run-1",
      userId: "user-1",
      workItemId: "work-item-1",
      question: "Inspect the repo for a comprehensive up-to-date architecture assessment.",
      purpose: "answer_question",
    });

    expect(listPathsMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(readFileMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(readFileMock.mock.calls.length).toBeLessThanOrEqual(5);
    expect(result.status).toBe("awaiting_review");
    expect(result.citations.map((citation) => citation.kind)).toEqual(["project_fact", "project_fact"]);
    expect(result.exploredEvidence.every((citation) => citation.kind === "github_file")).toBe(true);
    expect(result.answer).toContain("provisional");
    expect(result.answer).toContain("[citation:1]");
    expect(result.coverage?.achieved.length).toBeGreaterThanOrEqual(3);
    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ environmentSnapshot: expect.any(Object) }),
    }));
  });
});
