import type {
  GitHubAuthService,
  GitHubRepositorySummary,
} from "@/src/services/types";

type RepositorySelectionService = Pick<
  GitHubAuthService,
  "getRepositoryById" | "listRepositories"
>;

export async function loadNewWorkItemRepositorySelection(input: {
  service: RepositorySelectionService;
  userId: string;
  query?: string;
  repositoryId?: string;
  limit?: number;
}): Promise<{
  repositories: GitHubRepositorySummary[];
  selectedRepository: GitHubRepositorySummary | null;
  selectionUnavailable: boolean;
}> {
  const repositoryId = input.repositoryId?.trim() ?? "";

  // Stable-ID resolution is authoritative and starts independently of the
  // bounded picker list. A transfer/rename or a repository outside the recent
  // list can therefore never inherit stale or missing picker metadata.
  const selectedRepositoryPromise = repositoryId
    ? input.service.getRepositoryById({
        userId: input.userId,
        repositoryId,
      })
    : Promise.resolve(null);
  const repositoriesPromise = input.service.listRepositories({
    userId: input.userId,
    query: input.query,
    limit: input.limit,
  });

  const [selectedRepository, repositories] = await Promise.all([
    selectedRepositoryPromise,
    repositoriesPromise,
  ]);

  return {
    repositories,
    selectedRepository,
    selectionUnavailable: Boolean(repositoryId && !selectedRepository),
  };
}
