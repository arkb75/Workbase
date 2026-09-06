import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  findSource: vi.fn(),
  getGitHubAccessToken: vi.fn(),
  resolveGitHubCommit: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: { source: { findFirst: serviceMocks.findSource } },
}));

vi.mock("@/src/services/github-client", () => ({
  getGitHubAccessTokenForUser: serviceMocks.getGitHubAccessToken,
  resolveGitHubCommit: serviceMocks.resolveGitHubCommit,
}));

import {
  durableRepositoryInspectionLimits,
  preparePinnedProjectRepository,
  ProjectChatRepositoryInspector,
  projectChatGitHttpAuthorizationHeader,
  projectChatRepositoryInspectionLimits,
  validateProjectRepositoryGitArgs,
  type PreparedProjectRepository,
} from "@/src/services/project-chat-repository-inspection-service";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("project chat repository inspection", () => {
  let root: string;
  let repository: string;
  let bare: string;
  let head: string;
  let initialHead: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "project-chat-git-test-"));
    repository = join(root, "robot-controller");
    bare = join(root, "robot-controller.git");
    mkdirSync(repository);
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Workbase Test"]);
    git(repository, ["config", "user.email", "workbase@example.test"]);
    mkdirSync(join(repository, "src"));
    writeFileSync(
      join(repository, "src", "controller.ts"),
      "export function route(input: string) { return `stable:${input}`; }\n",
    );
    writeFileSync(join(repository, "README.md"), "# Robot controller\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "build stable routing controller"]);
    initialHead = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["tag", "v1.0.0"]);
    git(repository, ["checkout", "-b", "feature/telemetry"]);
    writeFileSync(
      join(repository, "src", "telemetry.ts"),
      "export const metric = 'route_latency_ms';\n",
    );
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "add controller telemetry"]);
    git(repository, ["checkout", "main"]);
    git(repository, ["merge", "--no-ff", "feature/telemetry", "-m", "merge telemetry capability"]);
    head = git(repository, ["rev-parse", "HEAD"]);
    git(root, ["clone", "--bare", repository, bare]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function inspector(input?: {
    onEvidence?: ConstructorParameters<typeof ProjectChatRepositoryInspector>[0]["onEvidence"];
    loadEvidence?: ConstructorParameters<typeof ProjectChatRepositoryInspector>[0]["loadEvidence"];
    limits?: ConstructorParameters<typeof ProjectChatRepositoryInspector>[0]["limits"];
  }) {
    return new ProjectChatRepositoryInspector({
      userId: "user-1",
      workItemId: "work-1",
      sources: [{
        id: "source-robot",
        type: "github_repo",
        label: "acme/robot-controller",
        metadata: {},
        updatedAt: new Date("2026-08-13T00:00:00.000Z"),
        resolvedRevision: head,
      }],
      onEvidence: input?.onEvidence,
      loadEvidence: input?.loadEvidence,
      limits: input?.limits,
    }, async (): Promise<PreparedProjectRepository> => ({
      gitDir: bare,
      privateHome: join(root, "private-home"),
      snapshot: {
        sourceId: "source-robot",
        repository: "acme/robot-controller",
        commitSha: head,
        defaultBranch: "main",
        committedAt: null,
        commitUrl: `https://github.com/acme/robot-controller/commit/${head}`,
      },
      dispose: async () => undefined,
    }));
  }

  it("uses GitHub's password-style token authentication without placing the token in clone arguments", () => {
    const token = "github-token-value";
    const header = projectChatGitHttpAuthorizationHeader(token);

    expect(header).toMatch(/^Authorization: Basic /);
    expect(header).not.toContain(token);
    expect(Buffer.from(header.replace(/^Authorization: Basic /, ""), "base64").toString("utf8"))
      .toBe(`x-access-token:${token}`);
  });

  it("answers varied history, file, search, and diff questions through one tool", async () => {
    const result = await inspector().inspect({
      sourceId: "source-robot",
      queries: [
        { args: ["log", "--oneline", "--merges", "-5"] },
        { args: ["show", "HEAD:src/controller.ts"] },
        { args: ["grep", "-n", "route_latency", "HEAD", "--", "src"] },
        { args: ["diff", "v1.0.0..HEAD", "--", "src"] },
      ],
    });

    expect(result).toMatchObject({
      status: "completed",
      snapshot: {
        repository: "acme/robot-controller",
        commitSha: head,
      },
      results: Array.from({ length: 4 }, () => ({ status: "success" })),
    });
    if (result.status !== "completed") throw new Error("inspection rejected");
    const visible = result.results.map((entry) =>
      entry.status === "success"
        ? entry.segments.map((segment) => segment.excerpt).join("\n")
        : ""
    );
    expect(visible[0]).toContain("merge telemetry capability");
    expect(visible[1]).toContain("stable:${input}");
    expect(visible[2]).toContain("route_latency_ms");
    expect(visible[3]).toContain("telemetry.ts");
    expect(result.results.every((entry) => !("output" in entry))).toBe(true);
    expect(result.results[0]).toMatchObject({ target: null });
    expect(result.results[1]).toMatchObject({
      target: {
        kind: "blob",
        commitSha: head,
        path: "src/controller.ts",
        blobSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      },
    });
    expect(result.results[3]).toMatchObject({
      target: { kind: "compare", baseCommitSha: initialHead, headCommitSha: head },
    });
  });

  it("accepts a harmless leading git token and explains malformed command arrays", async () => {
    const archived: Array<{ args: string[] }> = [];
    const result = await inspector({
      onEvidence: (evidence) => { archived.push(evidence); },
    }).inspect({
      sourceId: "source-robot",
      queries: [
        { args: ["git", "ls-tree", "-r", "--name-only", "HEAD"] },
        { args: ["git", "show", "HEAD:src/controller.ts"] },
        {
          args: [
            "git grep",
            "-n",
            "route_latency",
            "HEAD",
            "--",
            "src",
          ],
        },
        { args: ["git", "show", "--output=/tmp/leak", "HEAD"] },
      ],
    });

    expect(result).toMatchObject({
      status: "completed",
      results: [
        {
          status: "success",
          args: ["ls-tree", "-r", "--name-only", "HEAD"],
        },
        {
          status: "success",
          args: ["show", "HEAD:src/controller.ts"],
        },
        {
          status: "rejected",
          args: [
            "git grep",
            "-n",
            "route_latency",
            "HEAD",
            "--",
            "src",
          ],
          code: "unsupported_command",
          instruction: expect.stringContaining(
            'Pass the Git subcommand as args[0], without a leading "git" token',
          ),
        },
        {
          status: "rejected",
          args: ["git", "show", "--output=/tmp/leak", "HEAD"],
          code: "unsafe_argument",
        },
      ],
    });
    expect(archived.map((evidence) => evidence.args)).toEqual([
      ["ls-tree", "-r", "--name-only", "HEAD"],
      ["show", "HEAD:src/controller.ts"],
    ]);
  });

  it("normalizes tree-less grep queries to HEAD and preserves explicit revisions", async () => {
    const archived: Array<{ args: string[]; exitCode?: number }> = [];
    const result = await inspector({
      onEvidence: (evidence) => { archived.push(evidence); },
    }).inspect({
      sourceId: "source-robot",
      queries: [
        { args: ["grep", "-n", "route_latency", "--", "src"] },
        { args: ["grep", "-n", "route_latency", "src"] },
        { args: ["grep", "-n", "-e", "route_latency", "src"] },
        {
          args: [
            "grep",
            "-n",
            "route_latency",
            initialHead,
            "--",
            "src",
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      status: "completed",
      results: [
        {
          status: "success",
          args: ["grep", "-n", "route_latency", "HEAD", "--", "src"],
          exitCode: 0,
        },
        {
          status: "success",
          args: ["grep", "-n", "route_latency", "HEAD", "--", "src"],
          exitCode: 0,
        },
        {
          status: "success",
          args: [
            "grep",
            "-n",
            "-e",
            "route_latency",
            "HEAD",
            "--",
            "src",
          ],
          exitCode: 0,
        },
        {
          status: "command_error",
          args: [
            "grep",
            "-n",
            "route_latency",
            initialHead,
            "--",
            "src",
          ],
          exitCode: 1,
        },
      ],
    });
    expect(archived.map((evidence) => evidence.exitCode)).toEqual([0, 0, 0, 1]);
    expect(archived.map((evidence) => evidence.args)).toEqual(
      result.status === "completed"
        ? result.results.map((entry) => entry.args)
        : [],
    );
  });

  it("preserves explicitly supplied grep revisions with and without a separator", async () => {
    const treeish = `${initialHead}^{tree}`;
    const result = await inspector().inspect({
      sourceId: "source-robot",
      queries: [
        {
          args: ["grep", "-n", "stable", treeish, "--", "src/controller.ts"],
        },
        {
          args: ["grep", "-n", "stable", initialHead, "src/controller.ts"],
        },
      ],
    });

    expect(result).toMatchObject({
      status: "completed",
      results: [
        {
          status: "success",
          args: ["grep", "-n", "stable", treeish, "--", "src/controller.ts"],
        },
        {
          status: "success",
          args: [
            "grep",
            "-n",
            "stable",
            initialHead,
            "--",
            "src/controller.ts",
          ],
        },
      ],
    });
  });

  it("reads a requested pinned line range directly without losing raw evidence or relaxing budgets", async () => {
    const lines = Array.from({ length: 180 }, (_, index) => `// source line ${index + 1}`);
    lines[21] = "export const access = 'authenticated';";
    writeFileSync(join(repository, "src", "controller.ts"), lines.join("\n"));
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "add a larger control module"]);
    head = git(repository, ["rev-parse", "HEAD"]);
    git(bare, ["fetch", repository, "main:main"]);
    const archived: string[] = [];
    const reader = inspector({ onEvidence: (evidence) => { archived.push(evidence.output); },
      limits: { maxEvidenceBytesPerQuery: 1024, maxVisibleBytesPerTurn: 1024, maxQueriesPerTurn: 2 } });
    const result = await reader.inspect({ sourceId: "source-robot", queries: [{
      args: ["show", "HEAD:src/controller.ts"], range: { startLine: 20, maxLines: 5 },
    }] });
    expect(result).toMatchObject({ status: "completed", usage: { queries: 1, expansions: 0 },
      results: [{ status: "success", target: { kind: "blob", commitSha: head },
        segments: [{ startLine: 20, endLine: 24, totalLines: 180,
          excerpt: lines.slice(19, 24).join("\n"), truncated: true }] }] });
    expect(archived).toEqual([lines.join("\n")]);
    const limited = await reader.inspect({ sourceId: "source-robot", queries: [{
      args: ["show", "HEAD:src/controller.ts"], range: { startLine: 30, maxLines: 240 },
    }] });
    if (limited.status !== "completed") throw new Error("inspection rejected");
    expect(limited.usage.visibleBytes).toBeLessThanOrEqual(1024);
    expect(limited.results[0]).toMatchObject({ status: "success", segments: [{ startLine: 30, truncated: true }] });
    await expect(reader.inspect({ sourceId: "source-robot", queries: [{ args: ["show", "HEAD:README.md"] }] }))
      .resolves.toMatchObject({ status: "rejected", code: "query_budget_exhausted" });
  });

  it("rejects invalid, missing, discovery and non-pinned direct ranges", async () => {
    for (const query of [
      { args: ["show", "HEAD:src/controller.ts"], range: { startLine: 0, maxLines: 2 } },
      { args: ["show", "HEAD:src/controller.ts"], range: { startLine: 1, maxLines: 0 } },
    ]) {
      await expect(inspector().inspect({ sourceId: "source-robot", queries: [query] }))
        .resolves.toMatchObject({ results: [{ status: "rejected", code: "invalid_source_range" }] });
    }
    for (const args of [["grep", "-n", "route", "HEAD", "--", "src"],
      ["show", `${initialHead}:src/controller.ts`]]) {
      await expect(inspector().inspect({ sourceId: "source-robot", queries: [{ args, range: { startLine: 1, maxLines: 2 } }] }))
        .resolves.toMatchObject({ results: [{ status: "rejected", code: "source_range_requires_pinned_blob" }] });
    }
    await expect(inspector().inspect({ sourceId: "source-robot", queries: [{
      args: ["show", "HEAD:src/controller.ts"], range: { startLine: 500, maxLines: 2 },
    }] })).resolves.toMatchObject({ results: [{ status: "rejected", code: "empty_source_range" }] });
  });

  it("keeps failed grep diagnostics out of exact citable segments", async () => {
    const archived = new Map<string, { exitCode?: number }>();
    const repositoryInspector = inspector({
      onEvidence: (evidence) => { archived.set(evidence.evidenceId, evidence); },
    });
    const inspected = await repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [{ args: ["grep", "-n", "[", "--", "src"] }],
    });
    expect(inspected).toMatchObject({
      status: "completed",
      results: [{
        status: "command_error",
        exitCode: 128,
        segments: [],
      }],
    });
    if (inspected.status !== "completed") throw new Error("inspection rejected");
    const failed = inspected.results[0];
    if (!failed || !("evidenceId" in failed) || !failed.evidenceId) {
      throw new Error("missing failed inspection evidence");
    }
    const evidenceId = failed.evidenceId;
    expect(archived.get(evidenceId)?.exitCode).toBe(128);

    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [],
      expansions: [{
        evidenceId,
        startLine: 1,
        maxLines: 10,
      }],
    })).resolves.toMatchObject({
      status: "completed",
      expansions: [{
        evidenceId,
        status: "rejected",
        code: "evidence_command_failed",
      }],
    });
  });

  it("resolves a historical show target independently from the inspected HEAD snapshot", async () => {
    const result = await inspector().inspect({
      sourceId: "source-robot",
      queries: [{ args: ["show", "--stat", "--oneline", "--summary", initialHead] }],
    });

    expect(result).toMatchObject({
      status: "completed",
      snapshot: { commitSha: head },
      results: [{
        status: "success",
        target: { kind: "commit", commitSha: initialHead },
        segments: [{
          target: { kind: "commit", commitSha: initialHead },
        }],
      }],
    });
    expect(initialHead).not.toBe(head);
  });

  it("keeps raw output outside the model result and restores exact expansions by handle", async () => {
    const archived = new Map<string, Parameters<NonNullable<ConstructorParameters<
      typeof ProjectChatRepositoryInspector
    >[0]["onEvidence"]>>[0]>();
    const firstInspector = inspector({
      onEvidence: (evidence) => { archived.set(evidence.evidenceId, evidence); },
    });
    const first = await firstInspector.inspect({
      sourceId: "source-robot",
      objective: "Who added route telemetry and what changed?",
      queries: [{ args: ["log", "--stat", "--oneline", "-5"] }],
    });
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("inspection rejected");
    const result = first.results[0];
    expect(result).toMatchObject({ status: "success" });
    if (!result || result.status !== "success") throw new Error("query failed");
    expect(archived.get(result.evidenceId)?.output).toContain("add controller telemetry");
    expect("output" in result).toBe(false);

    const replayInspector = inspector({
      loadEvidence: (evidenceId) => archived.get(evidenceId) ?? null,
    });
    const expanded = await replayInspector.inspect({
      sourceId: "source-robot",
      queries: [],
      expansions: [{
        evidenceId: result.evidenceId,
        startLine: 1,
        maxLines: 20,
      }],
    });
    expect(expanded).toMatchObject({
      status: "completed",
      expansions: [{
        evidenceId: result.evidenceId,
        status: "success",
        segment: { startLine: 1 },
      }],
    });
  });

  it.each([
    [["status"], "unsupported_command"],
    [["fetch", "origin"], "unsupported_command"],
    [["show", "--textconv", "HEAD:file"], "unsafe_argument"],
    [["diff", "--no-index", "a", "b"], "unsafe_argument"],
    [["grep", "--recurse-submodules", "secret"], "unsafe_argument"],
    [["grep", "-f", "/etc/passwd", "--", "src"], "unsafe_argument"],
    [["grep", "--cached", "secret"], "unsafe_argument"],
    [["blame", "--ignore-revs-file=/etc/passwd", "HEAD", "--", "src/controller.ts"], "unsafe_argument"],
    [["show", "--output=/tmp/leak", "HEAD"], "unsafe_argument"],
    [["rev-parse", "--absolute-git-dir"], "unsafe_argument"],
    [["rev-parse", "--show-toplevel"], "unsafe_argument"],
    [["rev-parse", "--path-format=absolute", "HEAD"], "unsafe_argument"],
  ])("rejects mutation, network, execution, or host-write capability: %j", (args, reason) => {
    expect(validateProjectRepositoryGitArgs(args)).toEqual({ valid: false, reason });
  });

  it("passes arguments directly to Git without shell interpretation", async () => {
    const marker = join(root, "shell-was-executed");
    const result = await inspector().inspect({
      sourceId: "source-robot",
      queries: [{ args: ["show", `HEAD;touch ${marker}`] }],
    });
    expect(result).toMatchObject({
      status: "completed",
      results: [{ status: "command_error" }],
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed at the per-call and per-turn query budgets", async () => {
    const repositoryInspector = inspector();
    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: Array.from(
        { length: projectChatRepositoryInspectionLimits.maxQueriesPerCall + 1 },
        () => ({ args: ["show", "HEAD:README.md"] }),
      ),
    })).resolves.toMatchObject({ status: "rejected", code: "query_budget_exhausted" });

    await repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: Array.from({ length: 4 }, () => ({ args: ["show", "HEAD:README.md"] })),
    });
    await repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: Array.from({ length: 4 }, () => ({ args: ["show", "HEAD:README.md"] })),
    });
    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: Array.from({ length: 3 }, () => ({ args: ["show", "HEAD:README.md"] })),
    })).resolves.toMatchObject({ status: "rejected", code: "query_budget_exhausted" });
  });

  it("honors constructor-specific query and argument budgets without changing chat defaults", async () => {
    const repositoryInspector = inspector({
      limits: {
        maxQueriesPerCall: 1,
        maxQueriesPerTurn: 2,
        maxArgumentsPerQuery: 2,
      },
    });

    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [
        { args: ["show", "HEAD:README.md"] },
        { args: ["show", "HEAD:README.md"] },
      ],
    })).resolves.toMatchObject({ status: "rejected", code: "query_budget_exhausted" });
    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [{ args: ["show", "--stat", "HEAD"] }],
    })).resolves.toMatchObject({
      status: "completed",
      results: [{ status: "rejected", code: "invalid_argument_count" }],
      remainingQueryBudget: 1,
    });
    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [{ args: ["show", "HEAD:README.md"] }],
    })).resolves.toMatchObject({ status: "completed", remainingQueryBudget: 0 });
    await expect(repositoryInspector.inspect({
      sourceId: "source-robot",
      queries: [{ args: ["show", "HEAD:README.md"] }],
    })).resolves.toMatchObject({ status: "rejected", code: "query_budget_exhausted" });

    expect(projectChatRepositoryInspectionLimits.maxQueriesPerCall).toBe(4);
    expect(projectChatRepositoryInspectionLimits.maxQueriesPerTurn).toBe(10);
  });

  it("keeps enough durable raw-output headroom for every eligible 256 KiB blob", async () => {
    const largePath = join(root, "largest-eligible-source.txt");
    const content = "x".repeat(256 * 1024);
    writeFileSync(largePath, content);
    const blobSha = execFileSync(
      "/usr/bin/git",
      [`--git-dir=${bare}`, "hash-object", "-w", largePath],
      { encoding: "utf8" },
    ).trim();
    const result = await inspector({
      limits: durableRepositoryInspectionLimits,
    }).inspect({
      sourceId: "source-robot",
      queries: [{ args: ["cat-file", "blob", blobSha] }],
    });

    expect(durableRepositoryInspectionLimits.maxOutputBytesPerQuery)
      .toBeGreaterThan(256 * 1024);
    expect(result).toMatchObject({
      status: "completed",
      results: [{
        status: "success",
        totalBytes: content.length,
        truncated: true,
      }],
    });
  });

  it("prepares the resolved commit even after the repository branch has advanced", async () => {
    serviceMocks.findSource.mockResolvedValue({
      id: "source-robot",
      externalId: "123",
      metadata: {
        repository: {
          id: "123",
          fullName: "acme/robot-controller",
          owner: "acme",
          name: "robot-controller",
          defaultBranch: "main",
          private: true,
        },
      },
    });
    serviceMocks.getGitHubAccessToken.mockResolvedValue("github-test-token");
    serviceMocks.resolveGitHubCommit.mockClear();

    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, [
      "#!/bin/sh",
      "script_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "local_remote=\"$script_dir/../robot-controller.git\"",
      "if [ \"$2\" = remote ] && [ \"$3\" = add ] && [ \"$4\" = origin ]; then",
      "  exec /usr/bin/git \"$1\" remote add origin \"$local_remote\"",
      "fi",
      "if [ \"$2\" = fetch ]; then",
      "  exec /usr/bin/git -c protocol.file.allow=always \"$@\"",
      "fi",
      "exec /usr/bin/git \"$@\"",
      "",
    ].join("\n"));
    chmodSync(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? "/usr/bin:/bin"}`;

    const source = {
      id: "source-robot",
      type: "github_repo",
      label: "acme/robot-controller",
      metadata: {},
      updatedAt: new Date("2026-08-13T00:00:00.000Z"),
    };
    const preparedRoot: string[] = [];
    try {
      const prepared = await preparePinnedProjectRepository({
        userId: "user-1",
        workItemId: "work-1",
        source,
        target: {
          sourceId: source.id,
          repository: "acme/robot-controller",
          branch: "main",
          commitSha: initialHead,
          treeSha: git(repository, ["rev-parse", `${initialHead}^{tree}`]),
          committedAt: null,
          resolvedAt: "2026-08-13T00:00:00.000Z",
        },
      });
      preparedRoot.push(dirname(prepared.gitDir));
      expect(initialHead).not.toBe(head);
      expect(git(prepared.gitDir, ["rev-parse", "HEAD"])).toBe(initialHead);
      expect(git(prepared.gitDir, ["remote"])).toBe("");
      expect(() => git(prepared.gitDir, ["symbolic-ref", "-q", "HEAD"]))
        .toThrow();
      expect(git(prepared.gitDir, ["show", "HEAD:src/controller.ts"]))
        .toContain("stable:${input}");
      expect(() => git(prepared.gitDir, ["show", "HEAD:src/telemetry.ts"]))
        .toThrow();
      expect(prepared.snapshot.commitSha).toBe(initialHead);
      expect(serviceMocks.resolveGitHubCommit).not.toHaveBeenCalled();
      await prepared.dispose();
    } finally {
      process.env.PATH = previousPath;
    }
    expect(preparedRoot.every((path) => !existsSync(path))).toBe(true);
  });
});
