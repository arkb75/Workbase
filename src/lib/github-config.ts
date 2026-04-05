export const githubImportLimits = {
  repositoryList: 24,
  readmeChars: 8000,
  commits: 30,
  pulls: 15,
  issues: 15,
  releases: 5,
  changedFilesPerRecord: 20,
  changedFileFetchCommits: 12,
  changedFileFetchPulls: 8,
} as const;

export function resolveGitHubConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for GitHub integration.",
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI,
    authorizeBaseUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    apiBaseUrl: "https://api.github.com",
    scope: "read:user repo",
  };
}
