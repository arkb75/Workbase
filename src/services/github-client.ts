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
  githubRepositoryWebhookSchema,
  githubRepositorySummarySchema,
} from "@/src/lib/github-schemas";
import type { GitHubRepositorySummary } from "@/src/services/types";

const defaultHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Workbase Prototype",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_GITHUB_RETRY_DELAY_MS = 30_000;

export class GitHubApiError extends Error {
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

function githubRequestTimeoutMs() {
  const configured = Number(process.env.WORKBASE_GITHUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
}

function requestSignal(callerSignal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(githubRequestTimeoutMs());
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

function githubRetryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedDelay)) {
      return Math.min(
        MAX_GITHUB_RETRY_DELAY_MS,
        Math.max(0, Math.ceil(requestedDelay)),
      );
    }
  }
  return 100 * (2 ** attempt);
}

function waitForGitHubRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function rateLimitResetAt(value: string | null) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1_000).toISOString()
    : "unknown";
}

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
  const callerSignal = init?.signal ?? undefined;
  const method = (init?.method ?? "GET").toUpperCase();

  for (let attempt = 0; ; attempt += 1) {
    const signal = requestSignal(callerSignal);
    const mayRetry = method === "GET" && attempt < transientRetries;
    let response: Response;
    try {
      response = await fetch(`${resolveGitHubConfig().apiBaseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          ...defaultHeaders,
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
      });
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (mayRetry) {
        await waitForGitHubRetry(githubRetryDelayMs(null, attempt), callerSignal);
        continue;
      }
      throw new GitHubApiError({
        message: signal.aborted
          ? `GitHub API request timed out for ${path}.`
          : `GitHub API request failed before a response was received for ${path}.`,
        status: null,
        path,
        retryable: true,
      });
    }

    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const rateLimited = response.status === 429 ||
        (response.status === 403 && remaining === "0");
      if (
        mayRetry &&
        (response.status === 429 || (response.status >= 500 && response.status <= 599))
      ) {
        await waitForGitHubRetry(
          githubRetryDelayMs(response, attempt),
          callerSignal,
        );
        continue;
      }
      if (rateLimited) {
        throw new GitHubApiError({
          message: `GitHub API rate limit exceeded for ${path}; reset at ${rateLimitResetAt(reset)}.`,
          status: response.status,
          path,
          retryable: true,
        });
      }
      throw new GitHubApiError({
        message: `GitHub API request failed (${response.status}) for ${path}`,
        status: response.status,
        path,
        retryable: response.status >= 500 && response.status <= 599,
      });
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

export async function fetchGitHubRepositoryById(input: {
  token: string;
  repositoryId: string;
}) {
  const repositoryId = input.repositoryId.trim();
  if (!/^\d+$/u.test(repositoryId)) {
    throw new Error("GitHub repository ID must be numeric.");
  }

  // GitHub repository IDs remain stable across owner transfers and renames.
  // Resolve the canonical owner/name at request time so callers never submit
  // stale repository metadata or depend on a bounded recent-repository page.
  const repository = await fetchJson({
    path: `/repositories/${encodeURIComponent(repositoryId)}`,
    token: input.token,
    schema: githubRepositorySummarySchema,
  });
  if (repository.id !== repositoryId) {
    throw new GitHubApiError({
      message: `GitHub returned repository ID ${repository.id} for requested ID ${repositoryId}.`,
      status: null,
      path: `/repositories/${repositoryId}`,
      retryable: false,
    });
  }

  return mapRepositorySummary(repository);
}

export async function fetchGitHubRepositoryByIdForUser(
  userId: string,
  repositoryId: string,
) {
  const token = await getGitHubAccessTokenForUser(userId);
  return token
    ? fetchGitHubRepositoryById({ token, repositoryId })
    : null;
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

export async function ensureGitHubRepositoryPushWebhook(input: {
  token: string;
  owner: string;
  repo: string;
  callbackUrl: string;
  secret: string;
}) {
  const owner = encodeURIComponent(input.owner);
  const repo = encodeURIComponent(input.repo);
  const hooks = await fetchJson({
    path: `/repos/${owner}/${repo}/hooks?per_page=100`,
    token: input.token,
    schema: z.array(githubRepositoryWebhookSchema),
  });
  const existing = hooks.find((hook) =>
    hook.name === "web" && hook.config.url === input.callbackUrl
  );
  const body = JSON.stringify({
    name: "web",
    active: true,
    events: ["push"],
    config: {
      url: input.callbackUrl,
      content_type: "json",
      insecure_ssl: "0",
      secret: input.secret,
    },
  });
  if (existing) {
    const updated = await fetchJson({
      path: `/repos/${owner}/${repo}/hooks/${encodeURIComponent(existing.id)}`,
      token: input.token,
      schema: githubRepositoryWebhookSchema,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      },
    });
    return { hookId: updated.id, created: false };
  }
  const created = await fetchJson({
    path: `/repos/${owner}/${repo}/hooks`,
    token: input.token,
    schema: githubRepositoryWebhookSchema,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  });
  return { hookId: created.id, created: true };
}

export async function fetchGitHubReadme(input: {
  token: string;
  owner: string;
  repo: string;
}) {
  try {
    return await fetchJson({
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
        input.repo,
      )}/readme`,
      token: input.token,
      schema: githubContentFileSchema,
    });
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
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
