import type { JsonValue, SourceSnapshot } from "@/src/domain/types";
import { githubImportLimits } from "@/src/lib/github-config";
import { buildEvidenceSearchText } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import type { GitHubRepoImportService } from "@/src/services/types";
import {
  fetchGitHubCommitChangedFiles,
  fetchGitHubCommitList,
  fetchGitHubIssues,
  fetchGitHubPullRequestFiles,
  fetchGitHubPullRequests,
  fetchGitHubReadme,
  fetchGitHubReleases,
  fetchGitHubRepositoryDetail,
  mapRepositorySummary,
} from "@/src/services/github-client";
import { summarizeEvidenceContent } from "@/src/lib/evidence-items";

function toRepositoryJsonValue(repository: {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  url: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string | null;
}): JsonValue {
  return {
    id: repository.id,
    fullName: repository.fullName,
    owner: repository.owner,
    name: repository.name,
    description: repository.description,
    url: repository.url,
    defaultBranch: repository.defaultBranch,
    private: repository.private,
    updatedAt: repository.updatedAt,
  };
}

function mapSourceSnapshot(source: {
  id: string;
  workItemId: string;
  type: "manual_note" | "github_repo";
  label: string;
  externalId: string | null;
  rawContent: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SourceSnapshot {
  return {
    id: source.id,
    workItemId: source.workItemId,
    type: source.type,
    label: source.label,
    externalId: source.externalId,
    rawContent: source.rawContent,
    metadata: (source.metadata as JsonValue | null) ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export const githubRepoImportService: GitHubRepoImportService = {
  async importRepository({ userId, workItem, repositoryId, repositoryFullName }) {
    const { token, owner, repo, repository } = await fetchGitHubRepositoryDetail({
      userId,
      repositoryFullName,
    });
    const repositorySummary = mapRepositorySummary(repository);
    const readme = await fetchGitHubReadme({ token, owner, repo });
    const commits = await fetchGitHubCommitList({
      token,
      owner,
      repo,
      branch: repository.default_branch,
      perPage: githubImportLimits.commits,
    });
    const pulls = await fetchGitHubPullRequests({
      token,
      owner,
      repo,
      perPage: githubImportLimits.pulls,
    });
    const issues = (await fetchGitHubIssues({
      token,
      owner,
      repo,
      perPage: githubImportLimits.issues,
    }))
      .filter((issue) => !issue.pull_request)
      .slice(0, githubImportLimits.issues);
    const releases = (await fetchGitHubReleases({
      token,
      owner,
      repo,
      perPage: githubImportLimits.releases,
    })).slice(0, githubImportLimits.releases);

    const commitChangedFiles = new Map<string, string[]>();

    await Promise.all(
      commits.slice(0, githubImportLimits.changedFileFetchCommits).map(async (commit) => {
        try {
          const files = await fetchGitHubCommitChangedFiles({
            token,
            owner,
            repo,
            sha: commit.sha,
          });
          commitChangedFiles.set(
            commit.sha,
            files.slice(0, githubImportLimits.changedFilesPerRecord),
          );
        } catch {
          commitChangedFiles.set(commit.sha, []);
        }
      }),
    );

    const pullChangedFiles = new Map<string, string[]>();

    await Promise.all(
      pulls.slice(0, githubImportLimits.changedFileFetchPulls).map(async (pull) => {
        try {
          const files = await fetchGitHubPullRequestFiles({
            token,
            owner,
            repo,
            number: pull.number,
          });
          pullChangedFiles.set(
            pull.id,
            files.slice(0, githubImportLimits.changedFilesPerRecord),
          );
        } catch {
          pullChangedFiles.set(pull.id, []);
        }
      }),
    );

    const source = await prisma.source.upsert({
      where: {
        workItemId_type_externalId: {
          workItemId: workItem.id,
          type: "github_repo",
          externalId: repositoryId,
        },
      },
      create: {
        workItemId: workItem.id,
        type: "github_repo",
        label: repository.full_name,
        externalId: repositoryId,
        metadata: {
          repository: toRepositoryJsonValue(repositorySummary),
          status: "imported",
        },
      },
      update: {
        label: repository.full_name,
        metadata: {
          repository: toRepositoryJsonValue(repositorySummary),
          status: "imported",
        },
      },
    });

    const importedAt = new Date().toISOString();
    const importedEvidenceItems = [
      ...(readme?.content
        ? [
            (() => {
              const content = Buffer.from(
                readme.content,
                readme.encoding === "base64" ? "base64" : "utf8",
              )
                .toString("utf8")
                .slice(0, githubImportLimits.readmeChars);
              const metadata = {
                htmlUrl: readme.html_url ?? repository.html_url,
                path: readme.path,
                importedAt,
              };

              return {
                workItemId: workItem.id,
                sourceId: source.id,
                externalId: `readme:${readme.path}`,
                sourceType: source.type,
                type: "github_readme" as const,
                title: `${repository.name} README`,
                content,
                searchText: buildEvidenceSearchText({
                  title: `${repository.name} README`,
                  content,
                  metadata,
                }),
                parentKind: "source",
                parentKey: source.id,
                included: true,
                metadata,
                source: {
                  id: source.id,
                  label: source.label,
                  type: source.type,
                  externalId: source.externalId,
                },
              };
            })(),
          ]
        : []),
      ...commits.map((commit) => {
        const title = commit.commit.message.split("\n")[0];
        const content = summarizeEvidenceContent(commit.commit.message, 1200);
        const metadata = {
          sha: commit.sha,
          htmlUrl: commit.html_url ?? null,
          author: commit.commit.author?.name ?? null,
          authoredAt: commit.commit.author?.date ?? null,
          changedFiles: commitChangedFiles.get(commit.sha) ?? [],
          importedAt,
        };

        return {
          workItemId: workItem.id,
          sourceId: source.id,
          externalId: `commit:${commit.sha}`,
          sourceType: source.type,
          type: "github_commit" as const,
          title,
          content,
          searchText: buildEvidenceSearchText({ title, content, metadata }),
          parentKind: "source",
          parentKey: source.id,
          included: true,
          metadata,
          source: {
            id: source.id,
            label: source.label,
            type: source.type,
            externalId: source.externalId,
          },
        };
      }),
      ...pulls.map((pull) => {
        const title = `PR #${pull.number}: ${pull.title}`;
        const content = summarizeEvidenceContent(
          [pull.title, pull.body ?? ""].filter(Boolean).join("\n\n"),
          1800,
        );
        const metadata = {
          number: pull.number,
          htmlUrl: pull.html_url,
          state: pull.state,
          mergedAt: pull.merged_at ?? null,
          author: pull.user?.login ?? null,
          updatedAt: pull.updated_at ?? null,
          changedFiles: pullChangedFiles.get(pull.id) ?? [],
          importedAt,
        };

        return {
          workItemId: workItem.id,
          sourceId: source.id,
          externalId: `pull:${pull.id}`,
          sourceType: source.type,
          type: "github_pull_request" as const,
          title,
          content,
          searchText: buildEvidenceSearchText({ title, content, metadata }),
          parentKind: "pull_request",
          parentKey: `${source.id}:pull:${pull.number}`,
          included: true,
          metadata,
          source: {
            id: source.id,
            label: source.label,
            type: source.type,
            externalId: source.externalId,
          },
        };
      }),
      ...issues.map((issue) => {
        const title = `Issue #${issue.number}: ${issue.title}`;
        const content = summarizeEvidenceContent(
          [issue.title, issue.body ?? ""].filter(Boolean).join("\n\n"),
          1600,
        );
        const metadata = {
          number: issue.number,
          htmlUrl: issue.html_url,
          state: issue.state,
          author: issue.user?.login ?? null,
          updatedAt: issue.updated_at ?? null,
          importedAt,
        };

        return {
          workItemId: workItem.id,
          sourceId: source.id,
          externalId: `issue:${issue.id}`,
          sourceType: source.type,
          type: "github_issue" as const,
          title,
          content,
          searchText: buildEvidenceSearchText({ title, content, metadata }),
          parentKind: "issue",
          parentKey: `${source.id}:issue:${issue.number}`,
          included: true,
          metadata,
          source: {
            id: source.id,
            label: source.label,
            type: source.type,
            externalId: source.externalId,
          },
        };
      }),
      ...releases.map((release) => {
        const title = release.name?.trim() || release.tag_name;
        const content = summarizeEvidenceContent(
          [release.name ?? release.tag_name, release.body ?? ""].filter(Boolean).join("\n\n"),
          1800,
        );
        const metadata = {
          htmlUrl: release.html_url,
          tagName: release.tag_name,
          publishedAt: release.published_at ?? null,
          draft: release.draft,
          prerelease: release.prerelease,
          importedAt,
        };

        return {
          workItemId: workItem.id,
          sourceId: source.id,
          externalId: `release:${release.id}`,
          sourceType: source.type,
          type: "github_release" as const,
          title,
          content,
          searchText: buildEvidenceSearchText({ title, content, metadata }),
          parentKind: "release",
          parentKey: `${source.id}:release:${release.tag_name}`,
          included: true,
          metadata,
          source: {
            id: source.id,
            label: source.label,
            type: source.type,
            externalId: source.externalId,
          },
        };
      }),
    ];

    return {
      source: mapSourceSnapshot(source),
      importedEvidenceItems,
      importSummary: {
        repository: repositorySummary,
        importedAt,
        counts: {
          github_readme: readme?.content ? 1 : 0,
          github_commit: commits.length,
          github_pull_request: pulls.length,
          github_issue: issues.length,
          github_release: releases.length,
        },
      },
    };
  },
};
