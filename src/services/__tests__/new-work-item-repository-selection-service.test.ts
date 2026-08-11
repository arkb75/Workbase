import { describe, expect, it, vi } from "vitest";
import { loadNewWorkItemRepositorySelection } from "@/src/services/new-work-item-repository-selection-service";
import type { GitHubRepositorySummary } from "@/src/services/types";

function repository(input: {
  id: string;
  fullName: string;
}): GitHubRepositorySummary {
  const [owner, name] = input.fullName.split("/");
  return {
    id: input.id,
    fullName: input.fullName,
    owner,
    name,
    description: null,
    url: `https://github.com/${input.fullName}`,
    defaultBranch: "main",
    private: true,
    updatedAt: null,
  };
}

describe("new Work Item repository selection", () => {
  it("resolves the stable ID directly without trusting or waiting on the bounded list", async () => {
    const canonical = repository({
      id: "1075120340",
      fullName: "arkb75/Resume",
    });
    const staleListEntry = repository({
      id: "1075120340",
      fullName: "rafaykhurram/Resume",
    });
    let releaseList!: (repositories: GitHubRepositorySummary[]) => void;
    const listRepositories = vi.fn(() =>
      new Promise<GitHubRepositorySummary[]>((resolve) => {
        releaseList = resolve;
      })
    );
    const getRepositoryById = vi.fn().mockResolvedValue(canonical);

    const pending = loadNewWorkItemRepositorySelection({
      service: { getRepositoryById, listRepositories },
      userId: "user-1",
      repositoryId: canonical.id,
      limit: 18,
    });

    expect(getRepositoryById).toHaveBeenCalledWith({
      userId: "user-1",
      repositoryId: canonical.id,
    });
    expect(listRepositories).toHaveBeenCalledOnce();
    releaseList([staleListEntry]);

    await expect(pending).resolves.toEqual({
      repositories: [staleListEntry],
      selectedRepository: canonical,
      selectionUnavailable: false,
    });
  });

  it("marks a stale or malformed direct selection unavailable", async () => {
    const service = {
      getRepositoryById: vi.fn().mockResolvedValue(null),
      listRepositories: vi.fn().mockResolvedValue([]),
    };

    await expect(loadNewWorkItemRepositorySelection({
      service,
      userId: "user-1",
      repositoryId: "not-a-stable-id",
    })).resolves.toEqual({
      repositories: [],
      selectedRepository: null,
      selectionUnavailable: true,
    });
  });
});
