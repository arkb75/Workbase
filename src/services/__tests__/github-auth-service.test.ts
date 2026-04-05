import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  gitHubConnection: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

import { decryptString } from "@/src/lib/encryption";
import { githubAuthService } from "@/src/services/github-auth-service";

describe("githubAuthService", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GITHUB_CLIENT_ID = "github-client-id";
    process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
    process.env.WORKBASE_ENCRYPTION_KEY =
      "workbase-github-auth-test-secret-key-material";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("upserts the demo user's connection with an encrypted token", async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "gho_test_token",
          scope: "read:user repo",
          token_type: "bearer",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "github-user-1",
          login: "workbase-demo",
        }),
      } as Response);

    prismaMock.gitHubConnection.upsert.mockImplementation(async ({ create }) => ({
      id: "connection-1",
      userId: create.userId,
      githubUserId: create.githubUserId,
      login: create.login,
      accessTokenEncrypted: create.accessTokenEncrypted,
      scope: create.scope ?? null,
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
      updatedAt: new Date("2026-04-04T00:00:00.000Z"),
    }));

    const connection = await githubAuthService.exchangeCodeForUser({
      userId: "demo-user",
      code: "oauth-code",
    });

    expect(connection.login).toBe("workbase-demo");
    expect(prismaMock.gitHubConnection.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = prismaMock.gitHubConnection.upsert.mock.calls[0]?.[0];
    expect(upsertArgs.create.accessTokenEncrypted).not.toBe("gho_test_token");
    expect(decryptString(upsertArgs.create.accessTokenEncrypted)).toBe("gho_test_token");
  });

  it("fails safely when encryption configuration is missing", async () => {
    delete process.env.WORKBASE_ENCRYPTION_KEY;

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "gho_test_token",
          scope: "read:user repo",
          token_type: "bearer",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "github-user-1",
          login: "workbase-demo",
        }),
      } as Response);

    await expect(
      githubAuthService.exchangeCodeForUser({
        userId: "demo-user",
        code: "oauth-code",
      }),
    ).rejects.toThrow("WORKBASE_ENCRYPTION_KEY");

    expect(prismaMock.gitHubConnection.upsert).not.toHaveBeenCalled();
  });
});
