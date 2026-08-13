import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  createBudget: vi.fn(() => ({ expiresAt: "2026-08-13T12:00:00.000Z" })),
  listPaths: vi.fn(),
  search: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@/src/services/github-repository-exploration-service", () => ({
  githubRepositoryExplorationService: {
    start: mocks.start,
    createBudget: mocks.createBudget,
  },
}));

import {
  ProjectChatSourceExplorer,
  projectChatSourceSummary,
} from "@/src/services/project-chat-source-tools-service";

const sources = [
  {
    id: "github-1",
    type: "github_repo",
    label: "acme/robotics-controller",
    metadata: {
      repository: { fullName: "acme/robotics-controller" },
      revision: { commitSha: "1".repeat(40) },
    },
    updatedAt: new Date("2026-08-13T08:00:00.000Z"),
    resolvedRevision: "2".repeat(40),
  },
  {
    id: "manual-1",
    type: "manual_note",
    label: "Design interview notes",
    metadata: {},
    updatedAt: new Date("2026-08-13T07:00:00.000Z"),
  },
];

describe("project-chat source tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search.mockResolvedValue({
      matches: [{
        path: "src/control/loop.rs",
        blobSha: "b".repeat(40),
        size: 3_000,
        immutableUrl: "https://github.com/acme/robotics-controller/blob/222/src/control/loop.rs",
        requiresRead: true,
      }],
      apiTotalCount: 1,
      searchIncomplete: false,
      treeTruncated: false,
      usage: {},
    });
    mocks.listPaths.mockResolvedValue({
      paths: [
        {
          path: "README.md",
          blobSha: "a".repeat(40),
          size: 2_000,
          immutableUrl: "https://github.com/acme/robotics-controller/blob/222/README.md",
        },
        {
          path: "src/control/loop.rs",
          blobSha: "b".repeat(40),
          size: 3_000,
          immutableUrl: "https://github.com/acme/robotics-controller/blob/222/src/control/loop.rs",
        },
      ],
      nextCursor: null,
      treeTruncated: false,
      excludedCount: 0,
      usage: {},
    });
    mocks.readFile.mockResolvedValue({
      path: "src/control/loop.rs",
      content: "pub fn update_motor_output() { /* bounded loop */ }",
      lineStart: 40,
      lineEnd: 72,
      totalLines: 160,
      truncated: true,
      redacted: false,
      redactionCategories: [],
      contentSafety: "untrusted_repository_content",
      citation: {
        type: "github_file",
        sourceId: "github-1",
        repositoryFullName: "acme/robotics-controller",
        commitSha: "2".repeat(40),
        blobSha: "b".repeat(40),
        path: "src/control/loop.rs",
        lineStart: 40,
        lineEnd: 72,
        url: "https://github.com/acme/robotics-controller/blob/222/src/control/loop.rs#L40-L72",
      },
      usage: {},
    });
    mocks.start.mockResolvedValue({
      snapshot: {
        repository: { fullName: "acme/robotics-controller" },
        revision: { commitSha: "2".repeat(40) },
      },
      listPaths: mocks.listPaths,
      search: mocks.search,
      readFile: mocks.readFile,
    });
  });

  it("summarizes connector-neutral capabilities without leaking source metadata", () => {
    expect(projectChatSourceSummary(sources[0]!)).toEqual({
      sourceId: "github-1",
      type: "github_repo",
      label: "acme/robotics-controller",
      repository: "acme/robotics-controller",
      importedRevision: "2".repeat(40),
      updatedAt: "2026-08-13T08:00:00.000Z",
      capabilities: ["list_paths", "search", "read", "refresh"],
    });
    expect(projectChatSourceSummary(sources[1]!)).toMatchObject({
      sourceId: "manual-1",
      capabilities: ["knowledge_search"],
    });
    expect(JSON.stringify(projectChatSourceSummary(sources[1]!)))
      .not.toContain("metadata");
  });

  it("searches an authorized immutable source and returns opaque read handles", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    const result = await explorer.search({
      query: "motor control update loop",
      sourceIds: ["github-1"],
      maxResults: 5,
    });

    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      workItemId: "work-1",
      sourceId: "github-1",
    }));
    expect(mocks.start.mock.calls[0]?.[0]).not.toHaveProperty("ref");
    expect(mocks.search).toHaveBeenCalledWith({
      query: "motor control update loop",
      limit: 5,
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        handle: "source-result-1",
        repository: "acme/robotics-controller",
        commitSha: "2".repeat(40),
        path: "src/control/loop.rs",
        requiresRead: true,
      }),
    ]);
    expect(JSON.stringify(result.matches)).not.toContain("update_motor_output");
  });

  it("lists bounded current-source paths as opaque handles before content is selected", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    const result = await explorer.listPaths({
      sourceIds: ["github-1"],
      maxResults: 20,
    });

    expect(mocks.listPaths).toHaveBeenCalledWith({ limit: 20 });
    expect(result.matches).toEqual([
      expect.objectContaining({
        handle: "source-result-1",
        path: "README.md",
        commitSha: "2".repeat(40),
      }),
      expect.objectContaining({
        handle: "source-result-2",
        path: "src/control/loop.rs",
        commitSha: "2".repeat(40),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("update_motor_output");
  });

  it("reuses a current-turn handle when path browsing and content search find the same file", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    const listed = await explorer.listPaths({
      sourceIds: ["github-1"],
      maxResults: 20,
    });
    const searched = await explorer.search({
      query: "motor control",
      sourceIds: ["github-1"],
      maxResults: 5,
    });

    expect(listed.matches[1]?.handle).toBe("source-result-2");
    expect(searched.matches[0]?.handle).toBe("source-result-2");
  });

  it("returns compact reuse guidance instead of reinjecting repeated inventories and searches", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    await explorer.listPaths({ sourceIds: ["github-1"], maxResults: 60 });
    const repeatedInventory = await explorer.listPaths({
      sourceIds: ["github-1"],
      maxResults: 60,
    });
    await explorer.search({
      query: "motor control",
      sourceIds: ["github-1"],
      maxResults: 20,
    });
    const repeatedSearch = await explorer.search({
      query: "  MOTOR   control ",
      sourceIds: ["github-1"],
      maxResults: 20,
    });

    expect(mocks.listPaths).toHaveBeenCalledTimes(1);
    expect(mocks.listPaths).toHaveBeenCalledWith({ limit: 40 });
    expect(repeatedInventory).toMatchObject({
      alreadyListed: true,
      matches: [],
    });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(repeatedSearch).toMatchObject({
      alreadySearched: true,
      matches: [],
    });
  });

  it("reads only handles created in the current turn and preserves immutable citation scope", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    await explorer.search({
      query: "control loop",
      sourceIds: ["github-1"],
      maxResults: 3,
    });
    const result = await explorer.read({
      requests: [
        { handle: "invented", focusTerms: [] },
        {
          handle: "source-result-1",
          focusTerms: ["update_motor_output"],
        },
      ],
    });

    expect(result[0]).toMatchObject({ status: "invalid_handle" });
    expect(result[1]).toMatchObject({
      status: "read",
      repository: "acme/robotics-controller",
      commitSha: "2".repeat(40),
      lineStart: 40,
      lineEnd: 72,
      citation: expect.objectContaining({
        blobSha: "b".repeat(40),
        path: "src/control/loop.rs",
      }),
    });
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });

  it("contains an unreadable result so the model can continue with other selected sources", async () => {
    mocks.search.mockResolvedValueOnce({
      matches: [
        {
          path: "vendor/generated.bin",
          blobSha: "c".repeat(40),
          size: 1_000,
          immutableUrl: "https://github.com/acme/robotics-controller/blob/222/vendor/generated.bin",
          requiresRead: true,
        },
        {
          path: "src/control/loop.rs",
          blobSha: "b".repeat(40),
          size: 3_000,
          immutableUrl: "https://github.com/acme/robotics-controller/blob/222/src/control/loop.rs",
          requiresRead: true,
        },
      ],
      apiTotalCount: 2,
      searchIncomplete: false,
      treeTruncated: false,
      usage: {},
    });
    mocks.readFile
      .mockRejectedValueOnce(new Error("binary file"))
      .mockResolvedValueOnce({
        path: "src/control/loop.rs",
        content: "pub fn update_motor_output() { /* bounded loop */ }",
        lineStart: 40,
        lineEnd: 72,
        totalLines: 160,
        truncated: true,
        redacted: false,
        redactionCategories: [],
        contentSafety: "untrusted_repository_content",
        citation: {
          type: "github_file",
          sourceId: "github-1",
          repositoryFullName: "acme/robotics-controller",
          commitSha: "2".repeat(40),
          blobSha: "b".repeat(40),
          path: "src/control/loop.rs",
          lineStart: 40,
          lineEnd: 72,
          url: "https://github.com/acme/robotics-controller/blob/222/src/control/loop.rs#L40-L72",
        },
        usage: {},
      });

    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    await explorer.search({
      query: "motor output",
      sourceIds: ["github-1"],
      maxResults: 3,
    });
    const result = await explorer.read({
      requests: [
        { handle: "source-result-1", focusTerms: ["motor"] },
        { handle: "source-result-2", focusTerms: ["update_motor_output"] },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({ status: "read_error", handle: "source-result-1" }),
      expect.objectContaining({ status: "read", handle: "source-result-2" }),
    ]);
  });

  it("reports unsupported connector types instead of silently searching unrelated sources", async () => {
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    const result = await explorer.search({
      query: "interview decision",
      sourceIds: ["manual-1"],
      maxResults: 3,
    });
    expect(result).toMatchObject({
      matches: [],
      unsupportedSourceIds: ["manual-1"],
      searchedSourceIds: [],
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("turns an exhausted source search into a recoverable result instead of a tool crash", async () => {
    mocks.search.mockRejectedValueOnce(new Error("budget exhausted"));
    const explorer = new ProjectChatSourceExplorer({
      userId: "user-1",
      workItemId: "work-1",
      sources,
    });
    const result = await explorer.search({
      query: "another broad architecture search",
      sourceIds: ["github-1"],
      maxResults: 20,
    });

    expect(result).toMatchObject({
      matches: [],
      unavailableSourceIds: ["github-1"],
    });
    expect(result.instruction).toContain("Do not repeat the same search");
  });
});
