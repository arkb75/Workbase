import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    gitHubConnection: { findUnique: vi.fn() },
  },
}));
vi.mock("@/src/lib/encryption", () => ({
  decryptString: vi.fn(),
}));
vi.mock("@/src/lib/github-config", () => ({
  resolveGitHubConfig: () => ({ apiBaseUrl: "https://api.github.test" }),
}));

import {
  fetchGitHubBlob,
  fetchGitHubFileAtRevision,
} from "@/src/services/github-client";

const sha = "a".repeat(40);
const encoded = Buffer.from("export const bounded = true;").toString("base64");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub read resilience", () => {
  it("retries transient blob 5xx responses inside one client operation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha,
        size: Buffer.from(encoded, "base64").byteLength,
        url: `https://api.github.test/blob/${sha}`,
        content: encoded,
        encoding: "base64",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubBlob({
      token: "token",
      owner: "workbase",
      repo: "demo",
      blobSha: sha,
    })).resolves.toMatchObject({ sha, encoding: "base64" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads an immutable contents fallback at the requested commit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: "agent.ts",
      path: "src/agent.ts",
      type: "file",
      sha,
      size: Buffer.from(encoded, "base64").byteLength,
      content: encoded,
      encoding: "base64",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubFileAtRevision({
      token: "token",
      owner: "workbase",
      repo: "demo",
      path: "src/agent.ts",
      commitSha: sha,
    })).resolves.toMatchObject({ sha, content: encoded });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/contents/src/agent.ts?ref=${sha}`,
    );
  });
});
