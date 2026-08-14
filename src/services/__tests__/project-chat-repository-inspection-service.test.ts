import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

  function inspector() {
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
      results: [
        { status: "success", output: expect.stringContaining("merge telemetry capability") },
        { status: "success", output: expect.stringContaining("stable:${input}") },
        { status: "success", output: expect.stringContaining("route_latency_ms") },
        { status: "success", output: expect.stringContaining("telemetry.ts") },
      ],
    });
  });

  it.each([
    [["status"], "unsupported_command"],
    [["fetch", "origin"], "unsupported_command"],
    [["show", "--textconv", "HEAD:file"], "unsafe_argument"],
    [["diff", "--no-index", "a", "b"], "unsafe_argument"],
    [["grep", "--recurse-submodules", "secret"], "unsafe_argument"],
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
});
