import { z } from "zod";
import { prisma } from "@/src/lib/prisma";
import { decryptString } from "@/src/lib/encryption";
import { resolveGitHubConfig } from "@/src/lib/github-config";
import {
  githubCommitDetailSchema,
  githubCommitListItemSchema,
  githubContentFileSchema,
  githubIssueSchema,
  githubPullRequestFileSchema,
  githubPullRequestSchema,
  githubReleaseSchema,
  githubRepositoryDetailSchema,
  githubRepositorySummarySchema,
} from "@/src/lib/github-schemas";
import type { GitHubRepositorySummary } from "@/src/services/types";

const defaultHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Workbase Prototype",
} as const;

function mapRepositorySummary(
  repository: z.infer<typeof githubRepositorySummarySchema>,
): GitHubRepositorySummary {
  return {
    id: repository.id,
    fullName: repository.full_name,
    owner: repository.owner.login,
    name: repository.name,
    description: repository.description ?? null,
    url: repository.html_url,
    defaultBranch: repository.default_branch,
    private: repository.private,
    updatedAt: repository.updated_at ?? null,
  };
}

async function fetchJson<T>({
  path,
  token,
  schema,
  init,
}: {
  path: string;
  token: string;
  schema: z.ZodType<T>;
  init?: RequestInit;
}) {
  const response = await fetch(`${resolveGitHubConfig().apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...defaultHeaders,
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
  }

  const json = await response.json();
  return schema.parse(json);
}

export async function getGitHubAccessTokenForUser(userId: string) {
  const connection = await prisma.gitHubConnection.findUnique({
    where: {
      userId,
    },
  });

  if (!connection) {
    return null;
  }

  return decryptString(connection.accessTokenEncrypted);
}

export async function listGitHubRepositoriesForUser(userId: string, query?: string, limit = 24) {
  const token = await getGitHubAccessTokenForUser(userId);

  if (!token) {
    return [];
  }

  const repositories = await fetchJson({
    path: `/user/repos?sort=updated&direction=desc&per_page=${Math.min(
      Math.max(limit * 2, 30),
      100,
    )}&affiliation=owner,collaborator,organization_member`,
    token,
    schema: z.array(githubRepositorySummarySchema),
  });

  const normalizedQuery = query?.trim().toLowerCase();

  return repositories
    .filter((repository) => {
      if (!normalizedQuery) {
        return true;
      }

      return [repository.name, repository.full_name, repository.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, limit)
    .map(mapRepositorySummary);
}

export async function fetchGitHubRepositoryDetail(input: {
  userId: string;
  repositoryFullName: string;
}) {
  const token = await getGitHubAccessTokenForUser(input.userId);

  if (!token) {
    throw new Error("GitHub is not connected for this user.");
  }

  const [owner, repo] = input.repositoryFullName.split("/");

  if (!owner || !repo) {
    throw new Error("Repository full name is invalid.");
  }

  const repository = await fetchJson({
    path: `/repos/${owner}/${repo}`,
    token,
    schema: githubRepositoryDetailSchema,
  });

  return {
    token,
    owner,
    repo,
    repository,
  };
}

export async function fetchGitHubReadme(input: {
  token: string;
  owner: string;
  repo: string;
}) {
  const readmeCandidates = [
    "README.md",
    "README.mdx",
    "README.rst",
    "README.txt",
    "readme.md",
  ];

  for (const path of readmeCandidates) {
    try {
      const file = await fetchJson({
        path: `/repos/${input.owner}/${input.repo}/contents/${path}`,
        token: input.token,
        schema: githubContentFileSchema,
      });

      return file;
    } catch {
      continue;
    }
  }

  return null;
}

export async function fetchGitHubCommitList(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  perPage: number;
}) {
  return fetchJson({
    path: `/repos/${input.owner}/${input.repo}/commits?sha=${encodeURIComponent(
      input.branch,
    )}&per_page=${input.perPage}`,
    token: input.token,
    schema: z.array(githubCommitListItemSchema),
  });
}

export async function fetchGitHubCommitChangedFiles(input: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
}) {
  const commit = await fetchJson({
    path: `/repos/${input.owner}/${input.repo}/commits/${input.sha}`,
    token: input.token,
    schema: githubCommitDetailSchema,
  });

  return (commit.files ?? []).map((file) => file.filename);
}

export async function fetchGitHubPullRequests(input: {
  token: string;
  owner: string;
  repo: string;
  perPage: number;
}) {
  return fetchJson({
    path: `/repos/${input.owner}/${input.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${input.perPage}`,
    token: input.token,
    schema: z.array(githubPullRequestSchema),
  });
}

export async function fetchGitHubPullRequestFiles(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}) {
  const files = await fetchJson({
    path: `/repos/${input.owner}/${input.repo}/pulls/${input.number}/files?per_page=100`,
    token: input.token,
    schema: z.array(githubPullRequestFileSchema),
  });

  return files.map((file) => file.filename);
}

export async function fetchGitHubIssues(input: {
  token: string;
  owner: string;
  repo: string;
  perPage: number;
}) {
  return fetchJson({
    path: `/repos/${input.owner}/${input.repo}/issues?state=all&sort=updated&direction=desc&per_page=${Math.min(
      input.perPage * 2,
      100,
    )}`,
    token: input.token,
    schema: z.array(githubIssueSchema),
  });
}

export async function fetchGitHubReleases(input: {
  token: string;
  owner: string;
  repo: string;
  perPage: number;
}) {
  return fetchJson({
    path: `/repos/${input.owner}/${input.repo}/releases?per_page=${input.perPage}`,
    token: input.token,
    schema: z.array(githubReleaseSchema),
  });
}

export { mapRepositorySummary };
