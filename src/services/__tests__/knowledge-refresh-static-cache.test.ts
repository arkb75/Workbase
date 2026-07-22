import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshFind: vi.fn(),
  refreshUpdate: vi.fn(),
  fileFind: vi.fn(),
  fileUpdate: vi.fn(),
  fileCount: vi.fn(),
  transaction: vi.fn(),
  readFile: vi.fn(),
  analyzeFiles: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    knowledgeRefreshRun: {
      findUniqueOrThrow: mocks.refreshFind,
      update: mocks.refreshUpdate,
    },
    repositoryFileSnapshot: {
      findMany: mocks.fileFind,
      update: mocks.fileUpdate,
      count: mocks.fileCount,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/src/services/repository-coverage-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/services/repository-coverage-service")>();
  return { ...actual, analyzeRepositoryFilesHierarchically: mocks.analyzeFiles };
});

vi.mock("@/src/services/repository-knowledge-sync-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/services/repository-knowledge-sync-service")>();
  return {
    ...actual,
    repositoryKnowledgeSyncService: { ...actual.repositoryKnowledgeSyncService, readFile: mocks.readFile },
  };
});

import {
  analyzeKnowledgeRefreshBatch,
  selectLatestStaticAnalysisCacheCandidates,
} from "@/src/services/knowledge-refresh-service";

describe("repository static-analysis cache selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshUpdate.mockResolvedValue({});
    mocks.fileUpdate.mockResolvedValue({});
    mocks.fileCount.mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    mocks.transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
    mocks.readFile.mockImplementation(async ({ entry }: { entry: { path: string } }) => ({
      content: `export const value = ${JSON.stringify(entry.path)};`,
      contentHash: `hash:${entry.path}`,
      redacted: false,
      redactionCategories: [],
    }));
    mocks.analyzeFiles.mockImplementation(async (files: Array<{ path: string }>) =>
      files.map((file) => ({ path: file.path }))
    );
  });

  it("keeps the newest preordered candidate for each source, path, and blob", () => {
    const newest = {
      id: "newest",
      path: "src/service.ts",
      blobSha: "blob-1",
      snapshot: { sourceId: "source-a" },
    };
    const older = { ...newest, id: "older" };
    const selected = selectLatestStaticAnalysisCacheCandidates([newest, older]);

    expect(selected.get("source-a:src/service.ts:blob-1")).toBe(newest);
    expect(selected).toHaveLength(1);
  });

  it("does not cross repository-source boundaries for identical paths and blobs", () => {
    const sourceA = {
      id: "source-a-cache",
      path: "src/service.ts",
      blobSha: "shared-blob",
      snapshot: { sourceId: "source-a" },
    };
    const sourceB = {
      id: "source-b-cache",
      path: "src/service.ts",
      blobSha: "shared-blob",
      snapshot: { sourceId: "source-b" },
    };
    const selected = selectLatestStaticAnalysisCacheCandidates([sourceA, sourceB]);

    expect(selected.get("source-a:src/service.ts:shared-blob")).toBe(sourceA);
    expect(selected.get("source-b:src/service.ts:shared-blob")).toBe(sourceB);
    expect(selected).toHaveLength(2);
  });

  it("processes nine cold-cache misses in analyzer-safe waves and persists every file", async () => {
    const files = Array.from({ length: 9 }, (_, index) => ({
      id: `file-${index}`,
      snapshotId: "snapshot-1",
      path: `src/file-${index}.ts`,
      blobSha: `blob-${index}`,
      sizeBytes: 100,
      disposition: "eligible",
      analysis: null,
      analyzerVersion: null,
      snapshot: { id: "snapshot-1", sourceId: "source-1" },
    }));
    mocks.refreshFind.mockResolvedValue({
      id: "refresh-1",
      workItemId: "work-1",
      status: "analyzing",
      targetHeads: [{
        sourceId: "source-1",
        repository: "owner/repo",
        branch: "main",
        commitSha: "head-1",
        treeSha: "tree-1",
        committedAt: null,
        resolvedAt: "2026-07-21T00:00:00.000Z",
      }],
      snapshots: [{
        id: "snapshot-1",
        sourceId: "source-1",
        inventoryComplete: true,
        analysisComplete: false,
      }],
      workItem: { userId: "user-1" },
    });
    mocks.fileFind.mockResolvedValueOnce(files).mockResolvedValueOnce([]);

    const result = await analyzeKnowledgeRefreshBatch({ runId: "refresh-1", batchSize: 128 });

    expect(mocks.analyzeFiles).toHaveBeenCalledTimes(2);
    expect(mocks.analyzeFiles.mock.calls.map(([wave]) => wave.map((entry: { path: string }) => entry.path))).toEqual([
      files.slice(0, 8).map((file) => file.path),
      files.slice(8).map((file) => file.path),
    ]);
    expect(mocks.readFile).toHaveBeenCalledTimes(9);
    expect(mocks.fileUpdate).toHaveBeenCalledTimes(9);
    expect(mocks.fileUpdate.mock.calls.map(([call]) => call.where.id)).toEqual(files.map((file) => file.id));
    expect(result).toEqual(expect.objectContaining({
      remaining: 0,
      analyzed: 9,
      cacheHits: 0,
      cacheMisses: 9,
    }));
  });
});
