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
  GitHubApiError,
  mapRepositorySummary,
} from "@/src/services/github-client";
import { configureRepositoryPushWebhook } from "@/src/services/github-webhook-service";
import { summarizeEvidenceContent } from "@/src/lib/evidence-items";
import type { Prisma } from "@/src/generated/prisma/client";

export const GITHUB_IMPORT_DETAIL_CONCURRENCY = 6;
const SOURCE_WRITE_MAX_ATTEMPTS = 2;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function changedFilesOrEmptyOnMissing(load: () => Promise<string[]>) {
  try {
    return await load();
  } catch (error) {
    // A force-push can remove an activity record between the bounded list and
    // detail reads. Only that expected race is optional; auth, rate-limit,
    // timeout, and provider failures must fail the import visibly.
    if (error instanceof GitHubApiError && error.status === 404) return [];
    throw error;
  }
}

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

function metadataRecord(metadata: unknown) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue>
    : {};
}

function importedRepositoryMetadata(input: {
  existing?: unknown;
  repository: ReturnType<typeof toRepositoryJsonValue>;
  revision: JsonValue;
}): Prisma.InputJsonValue {
  const existing = metadataRecord(input.existing);
  const hasDurableImportFence = Object.prototype.hasOwnProperty.call(
    existing,
    "repositoryImport",
  );
  return {
    ...existing,
    repository: input.repository,
    revision: input.revision,
    // Durable imports own their lifecycle status. Legacy synchronous imports
    // retain the original top-level `imported` marker.
    ...(hasDurableImportFence ? {} : { status: "imported" }),
  };
}

function retryableSourceWriteConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "P2002" || code === "P2034";
}

async function persistRepositorySource(input: {
  workItemId: string;
  repositoryId: string;
  repositoryLabel: string;
  repository: ReturnType<typeof toRepositoryJsonValue>;
  revision: JsonValue;
}) {
  const where = {
    workItemId_type_externalId: {
      workItemId: input.workItemId,
      type: "github_repo" as const,
      externalId: input.repositoryId,
    },
  };
  const createMetadata = importedRepositoryMetadata({
    repository: input.repository,
    revision: input.revision,
  });

  for (let attempt = 0; attempt < SOURCE_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // The durable workflow creates the Source before remote I/O. Lock and
        // re-read it so a newer request-generation fence cannot be overwritten
        // by stale metadata captured earlier in this import.
        for (let resolutionAttempt = 0; resolutionAttempt < 3; resolutionAttempt += 1) {
          const candidate = await tx.source.findUnique({
            where,
            select: { id: true },
          });
          if (!candidate) {
            return tx.source.create({
              data: {
                workItemId: input.workItemId,
                type: "github_repo",
                label: input.repositoryLabel,
                externalId: input.repositoryId,
                metadata: createMetadata,
              },
            });
          }

          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Source" WHERE "id" = ${candidate.id} FOR UPDATE
          `;
          if (!locked.length) continue;

          const current = await tx.source.findUnique({
            where: { id: candidate.id },
            select: { metadata: true },
          });
          if (!current) continue;

          return tx.source.update({
            where: { id: candidate.id },
            data: {
              label: input.repositoryLabel,
              metadata: importedRepositoryMetadata({
                existing: current.metadata,
                repository: input.repository,
                revision: input.revision,
              }),
            },
          });
        }
        throw new Error("The repository Source changed repeatedly during import persistence.");
      }, { timeout: 10_000 });
    } catch (error) {
      if (
        attempt + 1 < SOURCE_WRITE_MAX_ATTEMPTS &&
        retryableSourceWriteConflict(error)
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("The repository Source could not be persisted.");
}

function mapSourceSnapshot(source: {
  id: string;
  workItemId: string;
  type: "manual_note" | "github_repo" | "chat_context";
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
    if (repositorySummary.id !== repositoryId) {
      throw new Error("The selected GitHub repository ID does not match the fetched repository.");
    }
    const readmePromise = fetchGitHubReadme({ token, owner, repo });
    const commitsPromise = fetchGitHubCommitList({
      token,
      owner,
      repo,
      branch: repository.default_branch,
      perPage: githubImportLimits.commits,
    });
    const pullsPromise = fetchGitHubPullRequests({
      token,
      owner,
      repo,
      perPage: githubImportLimits.pulls,
    });
    const issuesPromise = fetchGitHubIssues({
      token,
      owner,
      repo,
      perPage: githubImportLimits.issues,
    });
    const releasesPromise = fetchGitHubReleases({
      token,
      owner,
      repo,
      perPage: githubImportLimits.releases,
    });
    const detailResultsPromise = Promise.all([commitsPromise, pullsPromise]).then(
      ([commits, pulls]) => {
        const detailTasks = [
          ...commits
            .slice(0, githubImportLimits.changedFileFetchCommits)
            .map((commit) => ({
              kind: "commit" as const,
              key: commit.sha,
              load: () => fetchGitHubCommitChangedFiles({
                token,
                owner,
                repo,
                sha: commit.sha,
              }),
            })),
          ...pulls
            .slice(0, githubImportLimits.changedFileFetchPulls)
            .map((pull) => ({
              kind: "pull" as const,
              key: pull.id,
              load: () => fetchGitHubPullRequestFiles({
                token,
                owner,
                repo,
                number: pull.number,
              }),
            })),
        ];
        return mapWithConcurrency(
          detailTasks,
          GITHUB_IMPORT_DETAIL_CONCURRENCY,
          async (task) => ({
            kind: task.kind,
            key: task.key,
            files: (await changedFilesOrEmptyOnMissing(task.load)).slice(
              0,
              githubImportLimits.changedFilesPerRecord,
            ),
          }),
        );
      },
    );
    const [readme, commits, pulls, rawIssues, rawReleases, detailResults] =
      await Promise.all([
        readmePromise,
        commitsPromise,
        pullsPromise,
        issuesPromise,
        releasesPromise,
        detailResultsPromise,
      ]);
    const issues = rawIssues
      .filter((issue) => !issue.pull_request)
      .slice(0, githubImportLimits.issues);
    const releases = rawReleases.slice(0, githubImportLimits.releases);

    const commitChangedFiles = new Map<string, string[]>();
    const pullChangedFiles = new Map<string, string[]>();
    for (const detail of detailResults) {
      if (detail.kind === "commit") commitChangedFiles.set(detail.key, detail.files);
      else pullChangedFiles.set(detail.key, detail.files);
    }

    const importedAt = new Date().toISOString();
    const revision = commits[0]
      ? {
          commitSha: commits[0].sha,
          committedAt: commits[0].commit.author?.date ?? null,
          resolvedAt: importedAt,
        }
      : null;
    const sourcePromise = persistRepositorySource({
      workItemId: workItem.id,
      repositoryId,
      repositoryLabel: repository.full_name,
      repository: toRepositoryJsonValue(repositorySummary),
      revision,
    });
    const webhookPromise = configureRepositoryPushWebhook({
      token,
      owner,
      repo,
    });
    const [source, webhook] = await Promise.all([sourcePromise, webhookPromise]);
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
        webhook,
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
