import type { GitHubConnectionSnapshot } from "@/src/domain/types";
import { prisma } from "@/src/lib/prisma";
import { encryptString } from "@/src/lib/encryption";
import { resolveGitHubConfig } from "@/src/lib/github-config";
import {
  githubTokenResponseSchema,
  githubViewerSchema,
} from "@/src/lib/github-schemas";
import type { GitHubAuthService } from "@/src/services/types";
import { listGitHubRepositoriesForUser } from "@/src/services/github-client";

function mapGitHubConnection(connection: {
  id: string;
  userId: string;
  githubUserId: string;
  login: string;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GitHubConnectionSnapshot {
  return {
    id: connection.id,
    userId: connection.userId,
    githubUserId: connection.githubUserId,
    login: connection.login,
    scope: connection.scope,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function exchangeCodeForToken(code: string) {
  const config = resolveGitHubConfig();
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Workbase Prototype",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      ...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed (${response.status}).`);
  }

  return githubTokenResponseSchema.parse(await response.json());
}

async function fetchViewer(accessToken: string) {
  const response = await fetch(`${resolveGitHubConfig().apiBaseUrl}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Workbase Prototype",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub viewer lookup failed (${response.status}).`);
  }

  return githubViewerSchema.parse(await response.json());
}

export const githubAuthService: GitHubAuthService = {
  async getConnection(userId) {
    const connection = await prisma.gitHubConnection.findUnique({
      where: {
        userId,
      },
    });

    return connection ? mapGitHubConnection(connection) : null;
  },

  async listRepositories({ userId, query, limit }) {
    return listGitHubRepositoriesForUser(userId, query, limit);
  },

  async exchangeCodeForUser({ userId, code }) {
    const tokenResponse = await exchangeCodeForToken(code);
    const viewer = await fetchViewer(tokenResponse.access_token);
    const encryptedToken = encryptString(tokenResponse.access_token);

    const connection = await prisma.gitHubConnection.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        githubUserId: viewer.id,
        login: viewer.login,
        accessTokenEncrypted: encryptedToken,
        scope: tokenResponse.scope ?? null,
      },
      update: {
        githubUserId: viewer.id,
        login: viewer.login,
        accessTokenEncrypted: encryptedToken,
        scope: tokenResponse.scope ?? null,
      },
    });

    return mapGitHubConnection(connection);
  },
};
