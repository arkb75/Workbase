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

export function resolveGitHubWebhookSecret() {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "GITHUB_WEBHOOK_SECRET must be configured with at least 32 characters.",
    );
  }
  return secret;
}

export function resolveGitHubWebhookRegistrationConfig() {
  const configuredUrl = process.env.WORKBASE_GITHUB_WEBHOOK_URL?.trim();
  if (!configuredUrl) {
    return {
      configured: false as const,
      reason: "WORKBASE_GITHUB_WEBHOOK_URL is not configured.",
    };
  }
  const callbackUrl = new URL(configuredUrl);
  if (callbackUrl.protocol !== "https:") {
    throw new Error("WORKBASE_GITHUB_WEBHOOK_URL must use HTTPS.");
  }
  const secret = resolveGitHubWebhookSecret();
  return {
    configured: true as const,
    callbackUrl: callbackUrl.toString(),
    secret,
    configurationFingerprint: createHash("sha256")
      .update(`${callbackUrl.toString()}\0${secret}`)
      .digest("hex")
      .slice(0, 24),
  };
}

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
import { createHash } from "node:crypto";
