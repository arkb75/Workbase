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
      target: { kind: "blob", commitSha: head, path: "src/controller.ts" },
    });
    expect(result.results[3]).toMatchObject({
      target: { kind: "compare", baseCommitSha: initialHead, headCommitSha: head },
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
