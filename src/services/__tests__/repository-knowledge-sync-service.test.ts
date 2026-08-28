import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));
const githubMock = vi.hoisted(() => ({
  getGitHubAccessTokenForUser: vi.fn(),
  resolveGitHubCommit: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/github-client", async () => {
  const actual = await vi.importActual<typeof import("@/src/services/github-client")>(
    "@/src/services/github-client",
  );
  return {
    ...actual,
    getGitHubAccessTokenForUser: githubMock.getGitHubAccessTokenForUser,
    resolveGitHubCommit: githubMock.resolveGitHubCommit,
  };
});

import { resolveRepositoryTargetHeads } from "@/src/services/repository-knowledge-sync-service";

describe("repository knowledge target resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.source.findMany.mockResolvedValue([{ id: "source-1" }]);
    githubMock.getGitHubAccessTokenForUser.mockResolvedValue("token");
  });

  it("resolves an explicit pinned target ref while preserving the repository branch", async () => {
    const pinnedCommit = "a".repeat(40);
    prismaMock.source.findFirst.mockResolvedValue({
      id: "source-1",
      workItemId: "work-item-1",
      externalId: "repo-1",
      metadata: {
        repository: {
          id: "repo-1",
          fullName: "example/project",
          owner: "example",
          name: "project",
          defaultBranch: "main",
          targetRef: pinnedCommit,
          private: false,
        },
      },
    });
    githubMock.resolveGitHubCommit.mockResolvedValue({
      sha: pinnedCommit,
      commit: {
        tree: { sha: "b".repeat(40) },
        committer: { date: "2026-08-01T12:00:00.000Z" },
      },
    });

    const targets = await resolveRepositoryTargetHeads({
      userId: "user-1",
      workItemId: "work-item-1",
    });

    expect(githubMock.resolveGitHubCommit).toHaveBeenCalledWith(expect.objectContaining({
      owner: "example",
      repo: "project",
      ref: pinnedCommit,
    }));
    expect(targets).toEqual([
      expect.objectContaining({
        branch: "main",
        commitSha: pinnedCommit,
      }),
    ]);
  });
});
