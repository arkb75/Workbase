import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: {
    upsert: vi.fn(),
  },
}));

const githubClientMocks = vi.hoisted(() => ({
  fetchGitHubRepositoryDetail: vi.fn(),
  fetchGitHubReadme: vi.fn(),
  fetchGitHubCommitList: vi.fn(),
  fetchGitHubCommitChangedFiles: vi.fn(),
  fetchGitHubPullRequests: vi.fn(),
  fetchGitHubPullRequestFiles: vi.fn(),
  fetchGitHubIssues: vi.fn(),
  fetchGitHubReleases: vi.fn(),
  mapRepositorySummary: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/src/services/github-client", () => githubClientMocks);

import { githubRepoImportService } from "@/src/services/github-repo-import-service";

describe("githubRepoImportService", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.source.upsert.mockResolvedValue({
      id: "source-1",
      workItemId: "work-item-1",
      type: "github_repo",
      label: "workbase/demo-repo",
      externalId: "repo-1",
      rawContent: null,
      metadata: null,
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    githubClientMocks.fetchGitHubRepositoryDetail.mockResolvedValue({
      token: "gho_token",
      owner: "workbase",
      repo: "demo-repo",
      repository: {
        id: "repo-1",
        full_name: "workbase/demo-repo",
        name: "demo-repo",
        html_url: "https://github.com/workbase/demo-repo",
        description: "Repository description",
        default_branch: "main",
        private: false,
        updated_at: "2026-04-04T00:00:00.000Z",
      },
    });
    githubClientMocks.mapRepositorySummary.mockReturnValue({
      id: "repo-1",
      fullName: "workbase/demo-repo",
      owner: "workbase",
      name: "demo-repo",
      description: "Repository description",
      url: "https://github.com/workbase/demo-repo",
      defaultBranch: "main",
      private: false,
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
    githubClientMocks.fetchGitHubReadme.mockResolvedValue({
      path: "README.md",
      content: Buffer.from("Repository readme content").toString("base64"),
      encoding: "base64",
      html_url: "https://github.com/workbase/demo-repo/blob/main/README.md",
    });
    githubClientMocks.fetchGitHubCommitList.mockResolvedValue([
      {
        sha: "sha-1",
        html_url: "https://github.com/workbase/demo-repo/commit/sha-1",
        commit: {
          message: "Add import worker",
          author: {
            name: "Rafay",
            date: "2026-04-01T00:00:00.000Z",
          },
        },
      },
    ]);
    githubClientMocks.fetchGitHubCommitChangedFiles.mockResolvedValue([
      "src/import-worker.ts",
      "src/queue.ts",
    ]);
    githubClientMocks.fetchGitHubPullRequests.mockResolvedValue([
      {
        id: "pr-1",
        number: 12,
        title: "Improve import reliability",
        body: "Adds retries and queue visibility improvements.",
        html_url: "https://github.com/workbase/demo-repo/pull/12",
        state: "closed",
        merged_at: "2026-04-02T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z",
        user: {
          login: "workbase-demo",
        },
      },
    ]);
    githubClientMocks.fetchGitHubPullRequestFiles.mockResolvedValue([
      "src/import-worker.ts",
      "src/retries.ts",
    ]);
    githubClientMocks.fetchGitHubIssues.mockResolvedValue([
      {
        id: "issue-1",
        number: 44,
        title: "Support bounded README ingestion",
        body: "Need repo evidence import to keep README content bounded.",
        html_url: "https://github.com/workbase/demo-repo/issues/44",
        state: "open",
        updated_at: "2026-04-03T00:00:00.000Z",
        user: {
          login: "workbase-demo",
        },
      },
      {
        id: "issue-pr-shadow",
        number: 45,
        title: "Shadowed PR record",
        body: "This should not import as an issue.",
        html_url: "https://github.com/workbase/demo-repo/issues/45",
        state: "open",
        updated_at: "2026-04-03T00:00:00.000Z",
        user: {
          login: "workbase-demo",
        },
        pull_request: {
          url: "https://api.github.com/repos/workbase/demo-repo/pulls/45",
        },
      },
    ]);
    githubClientMocks.fetchGitHubReleases.mockResolvedValue([
      {
        id: "release-1",
        tag_name: "v1.0.0",
        name: "v1.0.0",
        body: "First stable import release.",
        html_url: "https://github.com/workbase/demo-repo/releases/tag/v1.0.0",
        published_at: "2026-04-03T00:00:00.000Z",
      },
    ]);
  });

  it("upserts the repo source and returns bounded evidence records", async () => {
    const result = await githubRepoImportService.importRepository({
      userId: "demo-user",
      workItem: {
        id: "work-item-1",
        userId: "demo-user",
        title: "Import pipeline",
        type: "project",
        description: "Repo-backed evidence import",
        startDate: null,
        endDate: null,
      },
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo-repo",
    });

    expect(prismaMock.source.upsert).toHaveBeenCalledTimes(1);
    expect(result.source.externalId).toBe("repo-1");
    expect(result.importSummary.counts.github_issue).toBe(1);
    expect(result.importedEvidenceItems.map((item) => item.type)).toEqual([
      "github_readme",
      "github_commit",
      "github_pull_request",
      "github_issue",
      "github_release",
    ]);
    expect(result.importedEvidenceItems[1]?.metadata).toMatchObject({
      changedFiles: ["src/import-worker.ts", "src/queue.ts"],
    });
  });

  it("filters issue payloads that are actually pull requests", async () => {
    const result = await githubRepoImportService.importRepository({
      userId: "demo-user",
      workItem: {
        id: "work-item-1",
        userId: "demo-user",
        title: "Import pipeline",
        type: "project",
        description: "Repo-backed evidence import",
        startDate: null,
        endDate: null,
      },
      repositoryId: "repo-1",
      repositoryFullName: "workbase/demo-repo",
    });

    const issueExternalIds = result.importedEvidenceItems
      .filter((item) => item.type === "github_issue")
      .map((item) => item.externalId);

    expect(issueExternalIds).toEqual(["issue:issue-1"]);
  });
});
