import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubRepositoryExplorationLimits } from "@/src/services/github-repository-exploration-service";

const prismaMock = vi.hoisted(() => ({
  source: {
    findFirst: vi.fn(),
  },
}));

const githubClientMocks = vi.hoisted(() => ({
  fetchGitHubBlob: vi.fn(),
  fetchGitHubFileAtRevision: vi.fn(),
  fetchGitHubTree: vi.fn(),
  getGitHubAccessTokenForUser: vi.fn(),
  resolveGitHubCommit: vi.fn(),
  searchGitHubCode: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/src/services/github-client", () => githubClientMocks);

import {
  classifyRepositoryPathForKnowledgeSync,
  GitHubRepositoryExplorationError,
  githubRepositoryExplorationService,
} from "@/src/services/github-repository-exploration-service";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const authBlobSha = "c".repeat(40);
const docsBlobSha = "d".repeat(40);
const unknownSizeBlobSha = "e".repeat(40);
const dataBlobSha = "f".repeat(40);
const secretAuthContent = [
  `export const token = '${["ghp", "123456789012345678901234567890123456"].join("_")}';`,
  "const password = \"correct horse battery staple\";",
  "export function authenticate() { return token; }",
].join("\n");

function treeEntry(input: {
  path: string;
  sha: string;
  size?: number;
  type?: "blob" | "tree" | "commit";
}) {
  return {
    path: input.path,
    mode: input.type === "tree" ? "040000" : "100644",
    type: input.type ?? "blob",
    sha: input.sha,
    size: input.size,
    url: `https://api.github.com/repos/workbase/demo/git/blobs/${input.sha}`,
  };
}

async function startSession() {
  return githubRepositoryExplorationService.start({
    userId: "user-1",
    workItemId: "work-item-1",
    sourceId: "source-1",
  });
}

describe("githubRepositoryExplorationService", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.source.findFirst.mockResolvedValue({
      id: "source-1",
      workItemId: "work-item-1",
      externalId: "repository-1",
      metadata: {
        repository: {
          id: "repository-1",
          fullName: "workbase/demo",
          owner: "workbase",
          name: "demo",
          defaultBranch: "main",
          private: true,
        },
      },
    });
    githubClientMocks.getGitHubAccessTokenForUser.mockResolvedValue("gho_private_token");
    githubClientMocks.resolveGitHubCommit.mockResolvedValue({
      sha: commitSha,
      html_url: `https://github.com/workbase/demo/commit/${commitSha}`,
      commit: {
        tree: {
          sha: treeSha,
          url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
        },
        committer: {
          date: "2026-07-08T12:00:00.000Z",
        },
      },
    });
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [
        treeEntry({ path: "docs/architecture.md", sha: docsBlobSha, size: 120 }),
        treeEntry({
          path: "src/auth.ts",
          sha: authBlobSha,
          size: Buffer.byteLength(secretAuthContent),
        }),
        treeEntry({ path: "src/unknown-size.ts", sha: unknownSizeBlobSha }),
        treeEntry({ path: "src/data.txt", sha: dataBlobSha, size: 4 }),
        treeEntry({ path: "node_modules/library/index.js", sha: "1".repeat(40), size: 80 }),
        treeEntry({ path: "src/generated/client.ts", sha: "2".repeat(40), size: 80 }),
        treeEntry({ path: "assets/logo.png", sha: "3".repeat(40), size: 80 }),
        treeEntry({
          path: "src/oversized.ts",
          sha: "4".repeat(40),
          size: githubRepositoryExplorationLimits.maxFileBytes + 1,
        }),
        treeEntry({ path: ".env", sha: "5".repeat(40), size: 80 }),
        treeEntry({ path: "package-lock.json", sha: "6".repeat(40), size: 80 }),
        treeEntry({ path: "src", sha: "7".repeat(40), type: "tree" }),
      ],
    });
  });

  it("excludes operating-system and editor metadata without hiding implementation files", () => {
    expect(classifyRepositoryPathForKnowledgeSync(".DS_Store", 8196).exclusionReason).toBe("generated");
    expect(classifyRepositoryPathForKnowledgeSync(".idea/workspace.xml", 512).exclusionReason).toBe("generated");
    expect(classifyRepositoryPathForKnowledgeSync(".vscode/settings.json", 512).exclusionReason).toBe("generated");
    expect(classifyRepositoryPathForKnowledgeSync("src/main/java/app/Main.java", 512).exclusionReason).toBeNull();
  });

  it("excludes hidden agent skill packages without hiding product skill modules", () => {
    for (const root of [".agents", ".codex", ".claude"]) {
      expect(
        classifyRepositoryPathForKnowledgeSync(`${root}/skills/database/SKILL.md`, 512)
          .exclusionReason,
      ).toBe("generated");
    }

    expect(
      classifyRepositoryPathForKnowledgeSync("skills/database/SKILL.md", 512)
        .exclusionReason,
    ).toBeNull();
    expect(
      classifyRepositoryPathForKnowledgeSync(".agents/project-rules.md", 512)
        .exclusionReason,
    ).toBeNull();
  });

  it("excludes SVG assets while retaining source components that render SVG", () => {
    expect(
      classifyRepositoryPathForKnowledgeSync("public/brand-mark.svg", 512)
        .exclusionReason,
    ).toBe("binary");
    expect(
      classifyRepositoryPathForKnowledgeSync("src/icons/BrandMarkSvg.tsx", 512)
        .exclusionReason,
    ).toBeNull();
    expect(
      classifyRepositoryPathForKnowledgeSync("src/icons/brand-mark.svg.tsx", 512)
        .exclusionReason,
    ).toBeNull();
  });

  it("excludes top-level runtime datasets without hiding source or schema files", () => {
    expect(
      classifyRepositoryPathForKnowledgeSync("data/productdetails.json", 512)
        .exclusionReason,
    ).toBe("generated");
    expect(
      classifyRepositoryPathForKnowledgeSync("data/orders.csv", 512)
        .exclusionReason,
    ).toBe("generated");
    expect(
      classifyRepositoryPathForKnowledgeSync("src/data/catalog.json", 512)
        .exclusionReason,
    ).toBeNull();
    expect(
      classifyRepositoryPathForKnowledgeSync("data/schema.sql", 512)
        .exclusionReason,
    ).toBeNull();
  });

  it("authorizes through the user, Work Item, and attached GitHub source", async () => {
    prismaMock.source.findFirst.mockResolvedValue(null);

    await expect(startSession()).rejects.toMatchObject({
      code: "attached_repository_not_found",
    });
    expect(prismaMock.source.findFirst).toHaveBeenCalledWith({
      where: {
        id: "source-1",
        workItemId: "work-item-1",
        type: "github_repo",
        workItem: {
          userId: "user-1",
        },
      },
      select: {
        id: true,
        workItemId: true,
        externalId: true,
        metadata: true,
      },
    });
    expect(githubClientMocks.getGitHubAccessTokenForUser).not.toHaveBeenCalled();
    expect(githubClientMocks.resolveGitHubCommit).not.toHaveBeenCalled();
  });

  it("pins the session to immutable commit and tree SHAs without exposing the token", async () => {
    const session = await githubRepositoryExplorationService.start({
      userId: "user-1",
      workItemId: "work-item-1",
      sourceId: "source-1",
      ref: "release/2026-07",
    });

    expect(githubClientMocks.resolveGitHubCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "gho_private_token",
        owner: "workbase",
        repo: "demo",
        ref: "release/2026-07",
      }),
    );
    expect(session.snapshot.revision).toMatchObject({
      requestedRef: "release/2026-07",
      commitSha,
      treeSha,
      commitUrl: `https://github.com/workbase/demo/commit/${commitSha}`,
    });
    expect(JSON.stringify(session)).not.toContain("gho_private_token");
  });

  it("lists only eligible paths and reuses its one pinned tree lookup", async () => {
    const session = await startSession();
    const first = await session.listPaths({ limit: 2 });
    const second = await session.listPaths({ cursor: first.nextCursor ?? undefined });

    expect(first.paths.map((entry) => entry.path)).toEqual([
      "docs/architecture.md",
      "src/auth.ts",
    ]);
    expect(second.paths.map((entry) => entry.path)).toEqual([
      "src/data.txt",
      "src/unknown-size.ts",
    ]);
    expect(first.excludedCount).toBe(7);
    expect(first.paths[0]?.immutableUrl).toBe(
      `https://github.com/workbase/demo/blob/${commitSha}/docs/architecture.md`,
    );
    expect(githubClientMocks.fetchGitHubTree).toHaveBeenCalledTimes(1);
    expect(githubClientMocks.fetchGitHubTree).toHaveBeenCalledWith(
      expect.objectContaining({
        treeSha,
        recursive: true,
      }),
    );
  });

  it("can share one research-pass budget across attached repository sessions", async () => {
    const budget = githubRepositoryExplorationService.createBudget();
    const firstSession = await githubRepositoryExplorationService.start({
      userId: "user-1",
      workItemId: "work-item-1",
      sourceId: "source-1",
      budget,
    });
    const secondSession = await githubRepositoryExplorationService.start({
      userId: "user-1",
      workItemId: "work-item-1",
      sourceId: "source-1",
      budget,
    });
    const thirdSession = await githubRepositoryExplorationService.start({
      userId: "user-1",
      workItemId: "work-item-1",
      sourceId: "source-1",
      budget,
    });
    const fourthSession = await githubRepositoryExplorationService.start({
      userId: "user-1",
      workItemId: "work-item-1",
      sourceId: "source-1",
      budget,
    });

    await firstSession.listPaths();
    await secondSession.listPaths();
    await thirdSession.listPaths();
    await expect(fourthSession.listPaths()).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    expect(firstSession.getUsage()).toEqual(secondSession.getUsage());
    expect(budget.getUsage().treeLookups).toBe(3);
    expect(firstSession.snapshot.expiresAt).toBe(secondSession.snapshot.expiresAt);
  });

  it("does not charge model planning time to repository request timeouts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
      const session = await startSession();

      // A high-effort planning call may take longer than the repository tool
      // timeout. It must not consume the tool session before the first lookup.
      vi.setSystemTime(new Date("2026-07-10T12:01:00.000Z"));
      await expect(session.listPaths({ limit: 1 })).resolves.toMatchObject({
        paths: [{ path: "docs/architecture.md" }],
      });

      vi.setSystemTime(new Date("2026-07-10T12:01:31.000Z"));
      await expect(session.listPaths({ limit: 1 })).resolves.toMatchObject({
        paths: [{ path: "docs/architecture.md" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses code search only for hints and maps matches back to pinned tree blobs", async () => {
    githubClientMocks.searchGitHubCode.mockResolvedValue({
      total_count: 4,
      incomplete_results: false,
      items: [
        {
          name: "auth.ts",
          path: "src/auth.ts",
          sha: "9".repeat(40),
          html_url: "https://github.com/workbase/demo/blob/main/src/auth.ts",
          repository: { id: "repository-1", full_name: "workbase/demo" },
        },
        {
          name: "auth.ts",
          path: "src/auth.ts",
          sha: "8".repeat(40),
          html_url: "https://github.com/other/repo/blob/main/src/auth.ts",
          repository: { id: "repository-2", full_name: "other/repo" },
        },
        {
          name: "removed.ts",
          path: "src/removed.ts",
          sha: "7".repeat(40),
          html_url: "https://github.com/workbase/demo/blob/main/src/removed.ts",
          repository: { id: "repository-1", full_name: "workbase/demo" },
        },
      ],
    });
    const session = await startSession();
    const result = await session.search({ query: "authenticate user", pathPrefix: "src" });

    expect(result.matches).toEqual([
      {
        path: "src/auth.ts",
        blobSha: authBlobSha,
        size: Buffer.byteLength(secretAuthContent),
        immutableUrl: `https://github.com/workbase/demo/blob/${commitSha}/src/auth.ts`,
        requiresRead: true,
      },
    ]);
    expect(githubClientMocks.searchGitHubCode).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "workbase",
        repo: "demo",
        query: "authenticate user",
      }),
    );

    await session.search({ query: "session" });
    await expect(session.search({ query: "third search" })).rejects.toMatchObject({
      code: "budget_exhausted",
    });
  });

  it("reads pinned blobs, redacts secrets, and returns line-specific immutable citations", async () => {
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: Buffer.byteLength(secretAuthContent),
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(secretAuthContent).toString("base64"),
      encoding: "base64",
    });
    const session = await startSession();
    const result = await session.readFile({
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 2,
    });

    expect(githubClientMocks.fetchGitHubBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        blobSha: authBlobSha,
      }),
    );
    expect(result.content).not.toContain("ghp_");
    expect(result.content).not.toContain("correct horse battery staple");
    expect(result.content).not.toContain("horse");
    expect(result.redacted).toBe(true);
    expect(result.redactionCategories).toEqual(["assigned_secret", "github_token"]);
    expect(result.contentSafety).toBe("untrusted_repository_content");
    expect(result.citation).toEqual({
      type: "github_file",
      sourceId: "source-1",
      repositoryFullName: "workbase/demo",
      commitSha,
      blobSha: authBlobSha,
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 2,
      url: `https://github.com/workbase/demo/blob/${commitSha}/src/auth.ts#L1-L2`,
    });
  });

  it("falls back to commit-pinned contents without consuming another logical read", async () => {
    githubClientMocks.fetchGitHubBlob.mockRejectedValueOnce(
      new Error("GitHub API request failed (503) for the git blob"),
    );
    githubClientMocks.fetchGitHubFileAtRevision.mockResolvedValueOnce({
      sha: authBlobSha,
      size: Buffer.byteLength(secretAuthContent),
      content: Buffer.from(secretAuthContent).toString("base64"),
      encoding: "base64",
    });

    const session = await startSession();
    const result = await session.readFile({ path: "src/auth.ts", lineStart: 1, lineEnd: 1 });

    expect(githubClientMocks.fetchGitHubFileAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/auth.ts",
        commitSha,
      }),
    );
    expect(result.citation.blobSha).toBe(authBlobSha);
    expect(session.getUsage().fileReads).toBe(1);
  });

  it("rejects a commit-pinned fallback whose SHA does not match the pinned tree", async () => {
    githubClientMocks.fetchGitHubBlob.mockRejectedValueOnce(
      new Error("GitHub API request failed (503) for the git blob"),
    );
    githubClientMocks.fetchGitHubFileAtRevision.mockResolvedValueOnce({
      sha: "9".repeat(40),
      size: Buffer.byteLength(secretAuthContent),
      content: Buffer.from(secretAuthContent).toString("base64"),
      encoding: "base64",
    });

    await expect(
      (await startSession()).readFile({ path: "src/auth.ts" }),
    ).rejects.toMatchObject({ code: "invalid_revision" });
  });

  it("selects a bounded excerpt around relevant terms instead of always reading the file head", async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `const filler${index + 1} = true;`);
    lines[220] = "while (iteration < maxIterations) {";
    lines[221] = "  if (stopReason === 'end_turn') break;";
    lines[222] = "}";
    const content = lines.join("\n");
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/runtime.ts", sha: authBlobSha, size: Buffer.byteLength(content) })],
    });
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: Buffer.byteLength(content),
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });

    const session = await startSession();
    const result = await session.readFile({
      path: "src/runtime.ts",
      focusTerms: ["maxIterations", "stopReason"],
      lineWindow: 40,
    });

    expect(result.lineStart).toBeGreaterThan(160);
    expect(result.lineEnd - result.lineStart + 1).toBe(40);
    expect(result.content).toContain("iteration < maxIterations");
    expect(result.content).toContain("stopReason === 'end_turn'");
    expect(result.citation.url).toContain(`#L${result.lineStart}-L${result.lineEnd}`);
  });

  it("keeps distinct high-priority controls together when one term repeats later", async () => {
    const lines = Array.from({ length: 420 }, (_, index) => `const filler${index + 1} = true;`);
    lines[149] = "if (iterations >= limits.maxIterations) throw new Error('bounded');";
    lines[250] = "const stopReason = response.stopReason;";
    for (let index = 251; index < 360; index += 8) {
      lines[index] = `if (stopReason === 'reason_${index}') throw new Error(stopReason);`;
    }
    const content = lines.join("\n");
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/runtime.ts", sha: authBlobSha, size: Buffer.byteLength(content) })],
    });
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: Buffer.byteLength(content),
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });

    const result = await (await startSession()).readFile({
      path: "src/runtime.ts",
      focusTerms: ["maxIterations", "stopReason"],
      lineWindow: 160,
    });

    expect(result.content).toContain("limits.maxIterations");
    expect(result.content).toContain("response.stopReason");
  });

  it("prefers a concrete late iteration guard over top-level limit declarations", async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `const filler${index + 1} = true;`);
    lines[20] = "interface RuntimeLimits { maxIterations: number; maxTotalTokens: number; }";
    lines[30] = "interface RuntimeResult { stopReason: string; budget: number; }";
    lines[319] = "if (iterations >= limits.maxIterations) {";
    lines[320] = "  throw new Error('iteration limit reached');";
    lines[321] = "}";
    const content = lines.join("\n");
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/runtime.ts", sha: authBlobSha, size: Buffer.byteLength(content) })],
    });
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: Buffer.byteLength(content),
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });

    const result = await (await startSession()).readFile({
      path: "src/runtime.ts",
      focusTerms: ["maxIterations", "stopReason", "budget", "limit"],
      lineWindow: 160,
    });

    expect(result.lineStart).toBeGreaterThan(160);
    expect(result.content).toContain("iterations >= limits.maxIterations");
    expect(result.content).not.toContain("interface RuntimeLimits");
  });

  it("rejects unlisted paths, oversized responses, and binary blob content", async () => {
    const session = await startSession();

    await expect(session.readFile({ path: "../.env" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(session.readFile({ path: ".env" })).rejects.toMatchObject({
      code: "path_not_available",
    });

    githubClientMocks.fetchGitHubBlob.mockResolvedValueOnce({
      sha: unknownSizeBlobSha,
      size: githubRepositoryExplorationLimits.maxFileBytes + 1,
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${unknownSizeBlobSha}`,
      content: "",
      encoding: "base64",
    });
    await expect(
      session.readFile({ path: "src/unknown-size.ts" }),
    ).rejects.toMatchObject({ code: "file_too_large" });

    githubClientMocks.fetchGitHubBlob.mockResolvedValueOnce({
      sha: dataBlobSha,
      size: 4,
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${dataBlobSha}`,
      content: Buffer.from([0, 1, 2, 3]).toString("base64"),
      encoding: "base64",
    });
    await expect(session.readFile({ path: "src/data.txt" })).rejects.toMatchObject({
      code: "binary_file",
    });
  });

  it("enforces the aggregate model-visible content budget", async () => {
    const content = "a".repeat(
      githubRepositoryExplorationLimits.maxVisibleBytes / 4,
    );
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/large-text.ts", sha: authBlobSha, size: content.length })],
    });
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: content.length,
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    const session = await startSession();

    for (let index = 0; index < 4; index += 1) {
      await session.readFile({ path: "src/large-text.ts" });
    }

    await expect(session.readFile({ path: "src/large-text.ts" })).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    expect(session.getUsage()).toEqual({
      treeLookups: 1,
      searches: 0,
      fileReads: 5,
      visibleBytes: githubRepositoryExplorationLimits.maxVisibleBytes,
    });
  });

  it("enforces the eight-file read budget", async () => {
    const content = "safe";
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/safe.ts", sha: authBlobSha, size: content.length })],
    });
    githubClientMocks.fetchGitHubBlob.mockResolvedValue({
      sha: authBlobSha,
      size: content.length,
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    });
    const session = await startSession();

    for (let index = 0; index < githubRepositoryExplorationLimits.fileReads; index += 1) {
      await session.readFile({ path: "src/safe.ts" });
    }

    await expect(session.readFile({ path: "src/safe.ts" })).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    expect(githubClientMocks.fetchGitHubBlob).toHaveBeenCalledTimes(8);
  });

  it("allows bounded concurrent reads without oversubscribing the shared budget", async () => {
    const content = "safe";
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/safe.ts", sha: authBlobSha, size: content.length })],
    });
    githubClientMocks.fetchGitHubBlob.mockImplementation(async () => ({
      sha: authBlobSha,
      size: content.length,
      url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64" as const,
    }));
    const session = await startSession();

    const results = await Promise.allSettled(Array.from({ length: 9 }, () =>
      session.readFile({ path: "src/safe.ts" }),
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(githubClientMocks.fetchGitHubBlob).toHaveBeenCalledTimes(8);
    expect(session.getUsage().fileReads).toBe(8);
  });

  it("transfers a released concurrency slot to its queued waiter before admitting a newcomer", async () => {
    const content = "safe";
    githubClientMocks.fetchGitHubTree.mockResolvedValue({
      sha: treeSha,
      url: `https://api.github.com/repos/workbase/demo/git/trees/${treeSha}`,
      truncated: false,
      tree: [treeEntry({ path: "src/safe.ts", sha: authBlobSha, size: content.length })],
    });
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const releases: Array<() => void> = [];
    githubClientMocks.fetchGitHubBlob.mockImplementation(() => new Promise((resolve) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      releases.push(() => {
        activeRequests -= 1;
        resolve({
          sha: authBlobSha,
          size: content.length,
          url: `https://api.github.com/repos/workbase/demo/git/blobs/${authBlobSha}`,
          content: Buffer.from(content).toString("base64"),
          encoding: "base64" as const,
        });
      });
    }));
    const session = await startSession();
    const firstWave = Array.from({ length: 5 }, () =>
      session.readFile({ path: "src/safe.ts" }),
    );

    await vi.waitFor(() => expect(githubClientMocks.fetchGitHubBlob).toHaveBeenCalledTimes(4));
    releases.shift()!();
    // Let the completed operation release its service slot, but deliberately
    // enqueue a fresh call before the awakened waiter's continuation runs.
    await Promise.resolve();
    await Promise.resolve();
    const newcomer = session.readFile({ path: "src/safe.ts" });

    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
    }
    await Promise.all([...firstWave, newcomer]);

    expect(githubClientMocks.fetchGitHubBlob).toHaveBeenCalledTimes(6);
    expect(maximumActiveRequests).toBeLessThanOrEqual(4);
  });

  it("uses typed exploration errors for callers to handle safely", () => {
    const error = new GitHubRepositoryExplorationError("budget_exhausted", "bounded");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitHubRepositoryExplorationError");
    expect(error.code).toBe("budget_exhausted");
  });
});
