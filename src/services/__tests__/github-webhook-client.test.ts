import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/prisma", () => ({
  prisma: { gitHubConnection: { findUnique: vi.fn() } },
}));
vi.mock("@/src/lib/encryption", () => ({ decryptString: vi.fn() }));
vi.mock("@/src/lib/github-config", () => ({
  resolveGitHubConfig: () => ({ apiBaseUrl: "https://api.github.test" }),
}));

import { ensureGitHubRepositoryPushWebhook } from "@/src/services/github-client";

afterEach(() => vi.unstubAllGlobals());

function webhook(id: number, url: string) {
  return {
    id,
    name: "web",
    active: true,
    events: ["push"],
    config: { url, content_type: "json", insecure_ssl: "0" },
  };
}

describe("GitHub repository webhook client", () => {
  it("updates an existing Workbase hook and always rotates the configured secret", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        webhook(42, "https://workbase.example/api/github/webhook"),
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        webhook(42, "https://workbase.example/api/github/webhook"),
      ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitHubRepositoryPushWebhook({
      token: "token",
      owner: "workbase",
      repo: "demo",
      callbackUrl: "https://workbase.example/api/github/webhook",
      secret: "s".repeat(32),
    })).resolves.toEqual({ hookId: "42", created: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: "https://workbase.example/api/github/webhook",
        content_type: "json",
        insecure_ssl: "0",
        secret: "s".repeat(32),
      },
    });
  });

  it("creates a push-only hook when the callback is not registered", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        webhook(43, "https://workbase.example/api/github/webhook"),
      ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitHubRepositoryPushWebhook({
      token: "token",
      owner: "workbase",
      repo: "demo",
      callbackUrl: "https://workbase.example/api/github/webhook",
      secret: "s".repeat(32),
    })).resolves.toEqual({ hookId: "43", created: true });

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});
