import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  source: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

const githubClientMocks = vi.hoisted(() => {
  class GitHubApiError extends Error {
    readonly status: number | null;
    readonly path: string;
    readonly retryable: boolean;

    constructor(input: {
      message: string;
      status: number | null;
      path: string;
      retryable: boolean;
    }) {
      super(input.message);
      this.name = "GitHubApiError";
      this.status = input.status;
      this.path = input.path;
      this.retryable = input.retryable;
    }
  }
  return {
    fetchGitHubRepositoryDetail: vi.fn(),
    fetchGitHubReadme: vi.fn(),
    fetchGitHubCommitList: vi.fn(),
    fetchGitHubCommitChangedFiles: vi.fn(),
    fetchGitHubPullRequests: vi.fn(),
    fetchGitHubPullRequestFiles: vi.fn(),
    fetchGitHubIssues: vi.fn(),
    fetchGitHubReleases: vi.fn(),
    mapRepositorySummary: vi.fn(),
    GitHubApiError,
  };
});
const configureRepositoryPushWebhookMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/src/services/github-client", () => githubClientMocks);
vi.mock("@/src/services/github-webhook-service", () => ({
  configureRepositoryPushWebhook: configureRepositoryPushWebhookMock,
}));

import { githubRepoImportService } from "@/src/services/github-repo-import-service";

describe("githubRepoImportService", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    const source = {
      id: "source-1",
      workItemId: "work-item-1",
      type: "github_repo",
      label: "workbase/demo-repo",
      externalId: "repo-1",
      rawContent: null,
      metadata: null,
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
    };
    prismaMock.source.findUnique.mockResolvedValue(source);
    prismaMock.source.update.mockResolvedValue(source);
    prismaMock.source.create.mockResolvedValue(source);
    prismaMock.$queryRaw.mockResolvedValue([{ id: source.id }]);
    prismaMock.$transaction.mockImplementation(
      async (task: (tx: typeof prismaMock) => Promise<unknown>) => task(prismaMock),
    );

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
    configureRepositoryPushWebhookMock.mockResolvedValue({
      status: "configured",
      hookId: "hook-1",
      created: true,
      configuredAt: "2026-04-04T00:00:01.000Z",
    });
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

    expect(prismaMock.source.update).toHaveBeenCalledTimes(1);
    expect(result.source.externalId).toBe("repo-1");
    expect(result.importSummary.counts.github_issue).toBe(1);
    expect(result.importSummary.webhook).toMatchObject({
      status: "configured",
      hookId: "hook-1",
    });
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

  it("creates a legacy Source with imported metadata when no reservation exists", async () => {
    prismaMock.source.findUnique.mockResolvedValue(null);

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

    expect(prismaMock.source.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workItemId: "work-item-1",
        type: "github_repo",
        externalId: "repo-1",
        metadata: expect.objectContaining({
          status: "imported",
          repository: expect.objectContaining({ id: "repo-1" }),
          revision: expect.objectContaining({ commitSha: "sha-1" }),
        }),
      }),
    });
    expect(prismaMock.source.update).not.toHaveBeenCalled();
    expect(result.source.id).toBe("source-1");
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

  it("starts independent repository activity reads together", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = <T>(label: string, value: T) => async () => {
      started.push(label);
      await gate;
      return value;
    };
    githubClientMocks.fetchGitHubReadme.mockImplementation(delayed("readme", null));
    githubClientMocks.fetchGitHubCommitList.mockImplementation(delayed("commits", []));
    githubClientMocks.fetchGitHubPullRequests.mockImplementation(delayed("pulls", []));
    githubClientMocks.fetchGitHubIssues.mockImplementation(delayed("issues", []));
    githubClientMocks.fetchGitHubReleases.mockImplementation(delayed("releases", []));

    const importPromise = githubRepoImportService.importRepository({
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

    await vi.waitFor(() => {
      expect(new Set(started)).toEqual(
        new Set(["readme", "commits", "pulls", "issues", "releases"]),
      );
    });
    release();
    await importPromise;
  });

  it("pipelines changed-file enrichment without waiting for unrelated activity reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    githubClientMocks.fetchGitHubReadme.mockImplementation(async () => {
      await gate;
      return null;
    });
    githubClientMocks.fetchGitHubIssues.mockImplementation(async () => {
      await gate;
      return [];
    });
    githubClientMocks.fetchGitHubReleases.mockImplementation(async () => {
      await gate;
      return [];
    });

    const importPromise = githubRepoImportService.importRepository({
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

    await vi.waitFor(() => {
      expect(githubClientMocks.fetchGitHubCommitChangedFiles).toHaveBeenCalledTimes(1);
      expect(githubClientMocks.fetchGitHubPullRequestFiles).toHaveBeenCalledTimes(1);
    });
    expect(prismaMock.source.update).not.toHaveBeenCalled();
    release();
    await importPromise;
  });

  it("bounds max-shape changed-file enrichment and preserves evidence ordering", async () => {
    const commits = Array.from({ length: 30 }, (_, index) => ({
      sha: `sha-${index}`,
      html_url: `https://github.com/workbase/demo-repo/commit/sha-${index}`,
      commit: {
        message: `Commit ${index}`,
        author: { name: "Rafay", date: "2026-04-01T00:00:00.000Z" },
      },
    }));
    const pulls = Array.from({ length: 15 }, (_, index) => ({
      id: `pr-${index}`,
      number: index + 1,
      title: `Pull ${index}`,
      body: null,
      html_url: `https://github.com/workbase/demo-repo/pull/${index + 1}`,
      state: "closed",
      merged_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      user: { login: "workbase-demo" },
    }));
    githubClientMocks.fetchGitHubCommitList.mockResolvedValue(commits);
    githubClientMocks.fetchGitHubPullRequests.mockResolvedValue(pulls);
    githubClientMocks.fetchGitHubIssues.mockResolvedValue(
      Array.from({ length: 15 }, (_, index) => ({
        id: `issue-${index}`,
        number: index + 100,
        title: `Issue ${index}`,
        body: null,
        html_url: `https://github.com/workbase/demo-repo/issues/${index + 100}`,
        state: "open",
        updated_at: "2026-04-03T00:00:00.000Z",
        user: { login: "workbase-demo" },
      })),
    );
    githubClientMocks.fetchGitHubReleases.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `release-${index}`,
        tag_name: `v${index}`,
        name: `Release ${index}`,
        body: null,
        html_url: `https://github.com/workbase/demo-repo/releases/tag/v${index}`,
        published_at: "2026-04-03T00:00:00.000Z",
        draft: false,
        prerelease: false,
      })),
    );
    let active = 0;
    let maximumActive = 0;
    const detailRead = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return [];
    };
    githubClientMocks.fetchGitHubCommitChangedFiles.mockImplementation(detailRead);
    githubClientMocks.fetchGitHubPullRequestFiles.mockImplementation(detailRead);

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

    expect(githubClientMocks.fetchGitHubCommitChangedFiles).toHaveBeenCalledTimes(12);
    expect(githubClientMocks.fetchGitHubPullRequestFiles).toHaveBeenCalledTimes(8);
    expect(maximumActive).toBe(6);
    expect(result.importedEvidenceItems).toHaveLength(66);
    expect(result.importedEvidenceItems.slice(0, 4).map((item) => item.externalId)).toEqual([
      "readme:README.md",
      "commit:sha-0",
      "commit:sha-1",
      "commit:sha-2",
    ]);
  });

  it("does not hide non-404 changed-file failures", async () => {
    githubClientMocks.fetchGitHubCommitChangedFiles.mockRejectedValueOnce(
      new githubClientMocks.GitHubApiError({
        message: "GitHub API request failed (503)",
        status: 503,
        path: "/repos/workbase/demo-repo/commits/sha-1",
        retryable: true,
      }),
    );

    await expect(githubRepoImportService.importRepository({
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
    })).rejects.toMatchObject({ status: 503 });
    expect(prismaMock.source.update).not.toHaveBeenCalled();
  });

  it("degrades a disappeared changed-file record only on 404", async () => {
    githubClientMocks.fetchGitHubCommitChangedFiles.mockRejectedValueOnce(
      new githubClientMocks.GitHubApiError({
        message: "GitHub API request failed (404)",
        status: 404,
        path: "/repos/workbase/demo-repo/commits/sha-1",
        retryable: false,
      }),
    );

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

    expect(result.importedEvidenceItems[1]?.metadata).toMatchObject({
      changedFiles: [],
    });
  });

  it("preserves a newer durable import request fence while updating repository metadata", async () => {
    const durableMetadata = {
      repository: { id: "repo-1", fullName: "workbase/demo-repo" },
      repositoryImport: {
        requestId: "newer-request",
        status: "importing",
        requestedAt: "2026-04-04T00:00:02.000Z",
      },
      status: "importing",
      unrelated: { keep: true },
    };
    prismaMock.source.findUnique.mockResolvedValue({
      id: "source-1",
      metadata: durableMetadata,
    });
    prismaMock.source.update.mockImplementation(async ({ data }) => ({
      id: "source-1",
      workItemId: "work-item-1",
      type: "github_repo",
      label: "workbase/demo-repo",
      externalId: "repo-1",
      rawContent: null,
      metadata: data.metadata,
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:03.000Z"),
    }));

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

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.source.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        label: "workbase/demo-repo",
        metadata: expect.objectContaining({
          repositoryImport: durableMetadata.repositoryImport,
          status: "importing",
          unrelated: { keep: true },
          revision: expect.objectContaining({ commitSha: "sha-1" }),
        }),
      },
    });
    expect(result.source.metadata).toMatchObject({
      repositoryImport: { requestId: "newer-request" },
      status: "importing",
      unrelated: { keep: true },
    });
  });
});
