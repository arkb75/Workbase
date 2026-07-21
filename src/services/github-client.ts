import { z } from "zod";
import { prisma } from "@/src/lib/prisma";
import { decryptString } from "@/src/lib/encryption";
import { resolveGitHubConfig } from "@/src/lib/github-config";
import {
  githubCodeSearchSchema,
  githubCommitDetailSchema,
  githubCommitResolutionSchema,
  githubCommitListItemSchema,
  githubContentFileSchema,
  githubGitBlobSchema,
  githubGitTreeSchema,
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
  "X-GitHub-Api-Version": "2022-11-28",
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
  transientRetries = 0,
}: {
  path: string;
  token: string;
  schema: z.ZodType<T>;
  init?: RequestInit;
  transientRetries?: number;
}) {
  for (let attempt = 0; ; attempt += 1) {
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
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      if (response.status === 429 || (response.status === 403 && remaining === "0")) {
        const resetAt = reset ? new Date(Number(reset) * 1_000).toISOString() : "unknown";
        throw new Error(`GitHub API rate limit exceeded for ${path}; reset at ${resetAt}.`);
      }
      if (
        response.status >= 500 &&
        response.status <= 599 &&
        attempt < transientRetries
      ) {
        // GitHub's blob endpoint occasionally returns a short-lived 5xx for a
        // single object. Keep retries bounded and inside the same logical
        // repository read so they cannot consume the agent's file-read budget.
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };
          const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 100 * (2 ** attempt));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        continue;
      }
      throw new Error(`GitHub API request failed (${response.status}) for ${path}`);
    }

    const json = await response.json();
    return schema.parse(json);
  }
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

export async function resolveGitHubCommit(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  signal?: AbortSignal;
}) {
  return fetchJson({
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
      input.repo,
    )}/commits/${encodeURIComponent(input.ref)}`,
    token: input.token,
    schema: githubCommitResolutionSchema,
    init: {
      signal: input.signal,
    },
  });
}

export async function fetchGitHubTree(input: {
  token: string;
  owner: string;
  repo: string;
  treeSha: string;
  recursive?: boolean;
  signal?: AbortSignal;
}) {
  return fetchJson({
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
      input.repo,
    )}/git/trees/${encodeURIComponent(input.treeSha)}${
      input.recursive ? "?recursive=1" : ""
    }`,
    token: input.token,
    schema: githubGitTreeSchema,
    init: {
      signal: input.signal,
    },
  });
}

export async function searchGitHubCode(input: {
  token: string;
  owner: string;
  repo: string;
  query: string;
  perPage: number;
  signal?: AbortSignal;
}) {
  const scopedQuery = `${input.query} repo:${input.owner}/${input.repo}`;

  return fetchJson({
    path: `/search/code?q=${encodeURIComponent(scopedQuery)}&per_page=${Math.min(
      Math.max(input.perPage, 1),
      100,
    )}`,
    token: input.token,
    schema: githubCodeSearchSchema,
    init: {
      signal: input.signal,
    },
  });
}

export async function fetchGitHubBlob(input: {
  token: string;
  owner: string;
  repo: string;
  blobSha: string;
  signal?: AbortSignal;
}) {
  return fetchJson({
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
      input.repo,
    )}/git/blobs/${encodeURIComponent(input.blobSha)}`,
    token: input.token,
    schema: githubGitBlobSchema,
    init: {
      signal: input.signal,
    },
    transientRetries: 2,
  });
}

const pinnedContentFileSchema = githubContentFileSchema.extend({
  sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
  size: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.string().min(1),
});

export async function fetchGitHubFileAtRevision(input: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  commitSha: string;
  signal?: AbortSignal;
}) {
  const encodedPath = input.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const file = await fetchJson({
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
      input.repo,
    )}/contents/${encodedPath}?ref=${encodeURIComponent(input.commitSha)}`,
    token: input.token,
    schema: pinnedContentFileSchema,
    init: { signal: input.signal },
    transientRetries: 1,
  });
  return {
    sha: file.sha,
    size: file.size,
    content: file.content,
    encoding: file.encoding,
  };
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
