import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepositoryById,
  fetchGitHubReadme,
  GitHubApiError,
} from "@/src/services/github-client";

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub client request deadlines and README behavior", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses GitHub's preferred README endpoint and treats only 404 as absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubReadme({
      token: "github-token",
      owner: "workbase",
      repo: "demo-repo",
    })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/workbase/demo-repo/readme",
    );
  });

  it("resolves the canonical repository identity directly from its stable numeric ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      id: 1075120340,
      name: "Resume",
      full_name: "arkb75/Resume",
      description: "Canonical repository after an owner transfer.",
      html_url: "https://github.com/arkb75/Resume",
      default_branch: "resume/ai-platform",
      private: true,
      updated_at: "2026-08-11T00:00:00.000Z",
      owner: { login: "arkb75" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubRepositoryById({
      token: "github-token",
      repositoryId: "1075120340",
    })).resolves.toMatchObject({
      id: "1075120340",
      fullName: "arkb75/Resume",
      owner: "arkb75",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repositories/1075120340",
    );
  });

  it("rejects invalid or mismatched stable repository IDs", async () => {
    await expect(fetchGitHubRepositoryById({
      token: "github-token",
      repositoryId: "owner/repository",
    })).rejects.toThrow("must be numeric");

    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      id: 1200815769,
      name: "Workbase",
      full_name: "arkb75/Workbase",
      description: null,
      html_url: "https://github.com/arkb75/Workbase",
      default_branch: "main",
      private: true,
      updated_at: null,
      owner: { login: "arkb75" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubRepositoryById({
      token: "github-token",
      repositoryId: "1075120340",
    })).rejects.toMatchObject({
      name: "GitHubApiError",
      retryable: false,
    });
  });

  it.each([
    { status: 401, headers: [] as Array<[string, string]>, retryable: false },
    { status: 429, headers: [] as Array<[string, string]>, retryable: true },
    {
      status: 403,
      headers: [
        ["x-ratelimit-remaining", "0"],
        ["x-ratelimit-reset", "invalid"],
      ] as Array<[string, string]>,
      retryable: true,
    },
    { status: 503, headers: [] as Array<[string, string]>, retryable: true },
  ])("does not hide README HTTP $status failures", async ({
    status,
    headers,
    retryable,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      status,
      headers,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchGitHubReadme({
      token: "github-token",
      owner: "workbase",
      repo: "demo-repo",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status, retryable });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an otherwise unbounded GitHub request at the configured deadline", async () => {
    vi.stubEnv("WORKBASE_GITHUB_REQUEST_TIMEOUT_MS", "15");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Missing request deadline signal."));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubReadme({
      token: "github-token",
      owner: "workbase",
      repo: "demo-repo",
    })).rejects.toMatchObject({
      name: "GitHubApiError",
      status: null,
      retryable: true,
      message: expect.stringContaining("timed out"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
