import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { prisma } from "@/src/lib/prisma";
import {
  getGitHubAccessTokenForUser,
  resolveGitHubCommit,
} from "@/src/services/github-client";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";
import {
  compactProjectRepositoryEvidence,
  createProjectRepositoryRawEvidence,
  expandProjectRepositoryEvidence,
  PROJECT_REPOSITORY_REDACTION_POLICY_VERSION,
  type ProjectRepositoryEvidenceTarget,
  type ProjectRepositoryRawEvidence,
} from "@/src/services/project-chat-repository-evidence-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";

export interface ProjectRepositoryInspectionLimits {
  maxQueriesPerCall: number;
  maxQueriesPerTurn: number;
  maxArgumentsPerQuery: number;
  maxArgumentCharacters: number;
  maxTotalArgumentCharacters: number;
  maxOutputBytesPerQuery: number;
  maxEvidenceBytesPerQuery: number;
  maxEvidenceSegmentsPerQuery: number;
  maxExpansionRequestsPerCall: number;
  maxExpansionRequestsPerTurn: number;
  maxExpansionLines: number;
  maxExpandedBytesPerRequest: number;
  maxVisibleBytesPerTurn: number;
  commandTimeoutMs: number;
  preparationTimeoutMs: number;
}

export const projectChatRepositoryInspectionLimits: Readonly<
  ProjectRepositoryInspectionLimits
> = Object.freeze({
  maxQueriesPerCall: 4,
  maxQueriesPerTurn: 10,
  maxArgumentsPerQuery: 40,
  maxArgumentCharacters: 1_000,
  maxTotalArgumentCharacters: 6_000,
  maxOutputBytesPerQuery: 128 * 1024,
  maxEvidenceBytesPerQuery: 8 * 1024,
  maxEvidenceSegmentsPerQuery: 3,
  maxExpansionRequestsPerCall: 2,
  maxExpansionRequestsPerTurn: 4,
  maxExpansionLines: 120,
  maxExpandedBytesPerRequest: 8 * 1024,
  maxVisibleBytesPerTurn: 32 * 1024,
  commandTimeoutMs: 20_000,
  preparationTimeoutMs: 90_000,
});

/**
 * Durable refreshes admit source blobs up to 256 KiB. Keep raw Git output
 * outside the model context, but leave enough process-buffer headroom to read
 * the complete largest eligible blob before compacting it into evidence.
 */
export const durableRepositoryInspectionLimits: Readonly<
  ProjectRepositoryInspectionLimits
> = Object.freeze({
  ...projectChatRepositoryInspectionLimits,
  maxOutputBytesPerQuery: 320 * 1024,
});

export interface ProjectChatAttachedSource {
  id: string;
  type: string;
  label: string;
  metadata: unknown;
  updatedAt: Date;
  resolvedRevision?: string | null;
}

export interface ProjectRepositoryInspectionSnapshot {
  sourceId: string;
  repository: string;
  commitSha: string;
  defaultBranch: string;
  committedAt: string | null;
  commitUrl: string;
}

export interface PreparedProjectRepository {
  gitDir: string;
  privateHome: string;
  snapshot: ProjectRepositoryInspectionSnapshot;
  dispose(): Promise<void>;
}

export type PrepareProjectRepository = (input: {
  userId: string;
  workItemId: string;
  source: ProjectChatAttachedSource;
  limits: Readonly<ProjectRepositoryInspectionLimits>;
}) => Promise<PreparedProjectRepository>;

function resolvedInspectionLimits(
  overrides: Partial<ProjectRepositoryInspectionLimits> | undefined,
  defaults: Readonly<ProjectRepositoryInspectionLimits> =
    projectChatRepositoryInspectionLimits,
) {
  const limits: ProjectRepositoryInspectionLimits = {
    ...defaults,
    ...overrides,
  };
  if (Object.values(limits).some((value) =>
    !Number.isSafeInteger(value) || value <= 0
  )) {
    throw new Error("invalid_repository_inspection_limits");
  }
  return Object.freeze(limits);
}

const attachedRepositoryMetadataSchema = z.object({
  repository: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    fullName: z.string().trim().min(3).max(200),
    owner: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    defaultBranch: z.string().trim().min(1).max(200),
    private: z.boolean(),
  }),
});

const repositoryPartPattern = /^[a-z0-9_.-]+$/i;
const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const allowedCommands = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
]);
const forbiddenArguments = [
  /^-c$/i,
  /^--config-env(?:=|$)/i,
  /^--contents(?:=|$)/i,
  /^--exec-path(?:=|$)/i,
  /^--ext-diff$/i,
  /^-f$/i,
  /^--file(?:=|$)/i,
  /^--filters?(?:=|$)/i,
  /^--html-path$/i,
  /^--info-path$/i,
  /^--ignore-revs-file(?:=|$)/i,
  /^--(?:absolute-)?git-dir(?:=|$)/i,
  /^--git-common-dir(?:=|$)/i,
  /^--man-path$/i,
  /^--no-index$/i,
  /^--open-files-in-pager(?:=|$)/i,
  /^--output(?:=|$)/i,
  /^--pathspec-file-nul$/i,
  /^--pathspec-from-file(?:=|$)/i,
  /^--path-format(?:=|$)/i,
  /^--recurse-submodules(?:=|$)/i,
  /^--submodule(?:=|$)/i,
  /^--textconv$/i,
  /^--upload-pack(?:=|$)/i,
  /^--show-(?:cdup|prefix|toplevel)$/i,
  /^--cached$/i,
  /^--untracked$/i,
];
const grepOptionsWithSeparateValue = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "--after-context",
  "--before-context",
  "--context",
  "--max-count",
  "--max-depth",
  "--threads",
]);
const grepPatternExpressionArguments = new Set([
  "--and",
  "--not",
  "--or",
  "(",
  ")",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedString(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

export function projectChatRepositorySummary(source: ProjectChatAttachedSource) {
  return {
    sourceId: source.id,
    type: source.type,
    label: source.label,
    repository: nestedString(source.metadata, ["repository", "fullName"]),
    importedRevision: source.resolvedRevision ??
      nestedString(source.metadata, ["revision", "commitSha"]) ??
      nestedString(source.metadata, ["commitSha"]),
    updatedAt: source.updatedAt.toISOString(),
    capabilities: source.type === "github_repo"
      ? ["git_inspection", "durable_knowledge_refresh"]
      : ["knowledge_search"],
  };
}

function gitEnvironment(input: {
  privateHome: string;
  token?: string;
}): NodeJS.ProcessEnv {
  const config: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.pager", "cat"],
    ["core.attributesFile", "/dev/null"],
    ["credential.helper", ""],
    ["protocol.allow", "never"],
  ];
  if (input.token) {
    config.push(["protocol.https.allow", "always"]);
    config.push(["http.extraHeader", projectChatGitHttpAuthorizationHeader(input.token)]);
  }
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: input.privateHome,
    XDG_CONFIG_HOME: input.privateHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
  };
}

export function projectChatGitHttpAuthorizationHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

function executeGit(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
}) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    execFile(
      "git",
      input.args,
      {
        env: input.env,
        encoding: "utf8",
        timeout: input.timeoutMs,
        maxBuffer: input.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error === "object" && "code" in error &&
            typeof error.code === "number"
          ? error.code
          : error
            ? 1
            : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

async function authorizeAttachedGitHubRepository(input: {
  userId: string;
  workItemId: string;
  source: ProjectChatAttachedSource;
}) {
  const source = await prisma.source.findFirst({
    where: {
      id: input.source.id,
      workItemId: input.workItemId,
      type: "github_repo",
      workItem: { userId: input.userId },
    },
    select: { id: true, externalId: true, metadata: true },
  });
  if (!source) throw new Error("attached_repository_not_found");
  const parsed = attachedRepositoryMetadataSchema.safeParse(source.metadata);
  if (!parsed.success) throw new Error("invalid_repository_metadata");
  const repository = parsed.data.repository;
  if (
    source.externalId !== repository.id ||
    repository.fullName.toLowerCase() !==
      `${repository.owner}/${repository.name}`.toLowerCase() ||
    !repositoryPartPattern.test(repository.owner) ||
    !repositoryPartPattern.test(repository.name)
  ) {
    throw new Error("invalid_repository_metadata");
  }
  const token = await getGitHubAccessTokenForUser(input.userId);
  if (!token) throw new Error("github_not_connected");
  return { source, repository, token };
}

async function prepareGitHubRepository(input: Parameters<
  PrepareProjectRepository
>[0]): Promise<PreparedProjectRepository> {
  const authorized = await authorizeAttachedGitHubRepository(input);
  const { source, repository, token } = authorized;
  const commit = await resolveGitHubCommit({
    token,
    owner: repository.owner,
    repo: repository.name,
    ref: repository.defaultBranch,
    signal: AbortSignal.timeout(
      input.limits.preparationTimeoutMs,
    ),
  });
  if (!objectIdPattern.test(commit.sha)) throw new Error("invalid_revision");

  const root = await mkdtemp(join(tmpdir(), "workbase-git-inspection-"));
  const gitDir = join(root, "repository.git");
  const privateHome = join(root, "home");
  await mkdir(privateHome, { recursive: true });
  const env = gitEnvironment({ privateHome, token });
  const clone = await executeGit({
    args: [
      "clone",
      "--bare",
      "--depth=200",
      "--single-branch",
      "--branch",
      repository.defaultBranch,
      `https://github.com/${repository.owner}/${repository.name}.git`,
      gitDir,
    ],
    env,
    timeoutMs: input.limits.preparationTimeoutMs,
    maxBuffer: 64 * 1024,
  });
  if (clone.exitCode !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error("repository_clone_failed");
  }
  const object = await executeGit({
    args: [`--git-dir=${gitDir}`, "cat-file", "-e", `${commit.sha}^{commit}`],
    env,
    timeoutMs: input.limits.commandTimeoutMs,
    maxBuffer: 4 * 1024,
  });
  if (object.exitCode !== 0) {
    const fetched = await executeGit({
      args: [`--git-dir=${gitDir}`, "fetch", "origin", commit.sha],
      env,
      timeoutMs: input.limits.preparationTimeoutMs,
      maxBuffer: 64 * 1024,
    });
    if (fetched.exitCode !== 0) {
      await rm(root, { recursive: true, force: true });
      throw new Error("repository_snapshot_unavailable");
    }
  }
  for (const args of [
    [`--git-dir=${gitDir}`, "update-ref", "HEAD", commit.sha],
    [`--git-dir=${gitDir}`, "remote", "remove", "origin"],
  ]) {
    const result = await executeGit({
      args,
      env,
      timeoutMs: input.limits.commandTimeoutMs,
      maxBuffer: 8 * 1024,
    });
    if (result.exitCode !== 0) {
      await rm(root, { recursive: true, force: true });
      throw new Error("repository_snapshot_preparation_failed");
    }
  }
  return {
    gitDir,
    privateHome,
    snapshot: {
      sourceId: source.id,
      repository: repository.fullName,
      commitSha: commit.sha,
      defaultBranch: repository.defaultBranch,
      committedAt: commit.commit.committer?.date ?? null,
      commitUrl: `https://github.com/${repository.fullName}/commit/${commit.sha}`,
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Prepares the exact commit already selected by the durable freshness barrier.
 * Unlike the chat preparer above, this function never resolves a branch head.
 * The temporary bare repository ends with a direct HEAD and no remote, so a
 * later branch advance cannot change what the inspector reads.
 */
export async function preparePinnedProjectRepository(input: {
  userId: string;
  workItemId: string;
  source: ProjectChatAttachedSource;
  target: RepositoryTargetHead;
  limits?: Partial<ProjectRepositoryInspectionLimits>;
}): Promise<PreparedProjectRepository> {
  const limits = resolvedInspectionLimits(
    input.limits,
    durableRepositoryInspectionLimits,
  );
  const { source, repository, token } =
    await authorizeAttachedGitHubRepository(input);
  if (
    input.target.sourceId !== source.id ||
    input.target.repository.toLowerCase() !== repository.fullName.toLowerCase() ||
    input.target.branch !== repository.defaultBranch ||
    !objectIdPattern.test(input.target.commitSha) ||
    !objectIdPattern.test(input.target.treeSha)
  ) {
    throw new Error("invalid_repository_target");
  }

  const root = await mkdtemp(join(tmpdir(), "workbase-git-inspection-"));
  const gitDir = join(root, "repository.git");
  const privateHome = join(root, "home");
  await mkdir(privateHome, { recursive: true });
  const env = gitEnvironment({ privateHome, token });
  const remoteUrl = `https://github.com/${repository.owner}/${repository.name}.git`;
  const commands: Array<{ args: string[]; timeoutMs: number; maxBuffer: number }> = [
    {
      args: ["init", "--bare", gitDir],
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 8 * 1024,
    },
    {
      args: [`--git-dir=${gitDir}`, "remote", "add", "origin", remoteUrl],
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 8 * 1024,
    },
    {
      args: [
        `--git-dir=${gitDir}`,
        "fetch",
        "--depth=200",
        "--no-tags",
        "origin",
        input.target.commitSha,
      ],
      timeoutMs: limits.preparationTimeoutMs,
      maxBuffer: 64 * 1024,
    },
    {
      args: [
        `--git-dir=${gitDir}`,
        "cat-file",
        "-e",
        `${input.target.commitSha}^{commit}`,
      ],
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 4 * 1024,
    },
  ];
  try {
    for (const command of commands) {
      const result = await executeGit({ ...command, env });
      if (result.exitCode !== 0) throw new Error("repository_snapshot_unavailable");
    }
    const tree = await executeGit({
      args: [
        `--git-dir=${gitDir}`,
        "rev-parse",
        "--verify",
        `${input.target.commitSha}^{tree}`,
      ],
      env,
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 4 * 1024,
    });
    if (
      tree.exitCode !== 0 ||
      tree.stdout.trim().toLowerCase() !== input.target.treeSha.toLowerCase()
    ) {
      throw new Error("repository_snapshot_tree_mismatch");
    }
    const pinned = await executeGit({
      args: [
        `--git-dir=${gitDir}`,
        "update-ref",
        "--no-deref",
        "HEAD",
        input.target.commitSha,
      ],
      env,
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 8 * 1024,
    });
    const detached = await executeGit({
      args: [`--git-dir=${gitDir}`, "symbolic-ref", "-q", "HEAD"],
      env,
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 4 * 1024,
    });
    const removed = await executeGit({
      args: [`--git-dir=${gitDir}`, "remote", "remove", "origin"],
      env,
      timeoutMs: limits.commandTimeoutMs,
      maxBuffer: 8 * 1024,
    });
    if (pinned.exitCode !== 0 || detached.exitCode === 0 || removed.exitCode !== 0) {
      throw new Error("repository_snapshot_preparation_failed");
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    gitDir,
    privateHome,
    snapshot: {
      sourceId: source.id,
      repository: repository.fullName,
      commitSha: input.target.commitSha,
      defaultBranch: repository.defaultBranch,
      committedAt: input.target.committedAt,
      commitUrl:
        `https://github.com/${repository.fullName}/commit/${input.target.commitSha}`,
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export function validateProjectRepositoryGitArgs(
  args: string[],
  limits: Readonly<ProjectRepositoryInspectionLimits> =
    projectChatRepositoryInspectionLimits,
) {
  if (!args.length || args.length > limits.maxArgumentsPerQuery) {
    return { valid: false, reason: "invalid_argument_count" } as const;
  }
  if (!allowedCommands.has(args[0]!)) {
    return { valid: false, reason: "unsupported_command" } as const;
  }
  const totalCharacters = args.reduce((sum, argument) => sum + argument.length, 0);
  if (
    totalCharacters > limits.maxTotalArgumentCharacters ||
    args.some((argument) =>
      !argument ||
      argument.length > limits.maxArgumentCharacters ||
      /[\u0000-\u001f\u007f]/.test(argument) ||
      forbiddenArguments.some((pattern) => pattern.test(argument))
    )
  ) {
    return { valid: false, reason: "unsafe_argument" } as const;
  }
  return { valid: true } as const;
}

async function resolveCommitish(input: {
  gitDir: string;
  env: NodeJS.ProcessEnv;
  value: string;
  limits: Readonly<ProjectRepositoryInspectionLimits>;
}) {
  if (!input.value || input.value.startsWith("-")) return null;
  const result = await executeGit({
    args: [
      `--git-dir=${input.gitDir}`,
      "rev-parse",
      "--verify",
      `${input.value}^{commit}`,
    ],
    env: input.env,
    timeoutMs: input.limits.commandTimeoutMs,
    maxBuffer: 4 * 1024,
  });
  const resolved = result.stdout.trim().split("\n")[0] ?? "";
  return result.exitCode === 0 && objectIdPattern.test(resolved) ? resolved : null;
}

async function resolveGrepTreeish(input: {
  gitDir: string;
  env: NodeJS.ProcessEnv;
  value: string;
  limits: Readonly<ProjectRepositoryInspectionLimits>;
}) {
  if (!input.value || input.value.startsWith("-")) return null;
  const result = await executeGit({
    args: [
      `--git-dir=${input.gitDir}`,
      "rev-parse",
      "--verify",
      `${input.value}^{tree}`,
    ],
    env: input.env,
    timeoutMs: input.limits.commandTimeoutMs,
    maxBuffer: 4 * 1024,
  });
  const resolved = result.stdout.trim().split("\n")[0] ?? "";
  return result.exitCode === 0 && objectIdPattern.test(resolved) ? resolved : null;
}

function grepOperandIndexes(args: readonly string[], endIndex: number) {
  const indexes: number[] = [];
  let hasPattern = false;
  for (let index = 1; index < endIndex; index += 1) {
    const argument = args[index]!;
    if (argument === "-e" || argument === "--regexp") {
      if (index + 1 >= endIndex) return { hasPattern: false, indexes: [] };
      hasPattern = true;
      index += 1;
      continue;
    }
    if (/^-e.+/u.test(argument) || argument.startsWith("--regexp=")) {
      hasPattern = true;
      continue;
    }
    if (grepOptionsWithSeparateValue.has(argument)) {
      if (index + 1 >= endIndex) return { hasPattern: false, indexes: [] };
      index += 1;
      continue;
    }
    if (
      /^-[ABCMm]\d+$/u.test(argument) ||
      /^(?:--after-context|--before-context|--context|--max-count|--max-depth|--threads)=/u
        .test(argument) ||
      grepPatternExpressionArguments.has(argument) ||
      argument.startsWith("-")
    ) {
      continue;
    }
    if (!hasPattern) {
      hasPattern = true;
      continue;
    }
    indexes.push(index);
  }
  return { hasPattern, indexes };
}

async function normalizeProjectRepositoryGitArgs(input: {
  args: string[];
  gitDir: string;
  env: NodeJS.ProcessEnv;
  limits: Readonly<ProjectRepositoryInspectionLimits>;
}) {
  if (input.args[0] !== "grep") {
    return { valid: true as const, args: [...input.args] };
  }

  const separatorIndex = input.args.indexOf("--");
  const operands = grepOperandIndexes(
    input.args,
    separatorIndex >= 0 ? separatorIndex : input.args.length,
  );
  if (!operands.hasPattern) {
    return { valid: false as const, reason: "invalid_grep_arguments" };
  }

  if (separatorIndex >= 0) {
    return operands.indexes.length
      ? { valid: true as const, args: [...input.args] }
      : {
          valid: true as const,
          args: [
            ...input.args.slice(0, separatorIndex),
            "HEAD",
            ...input.args.slice(separatorIndex),
          ],
        };
  }

  if (!operands.indexes.length) {
    return { valid: true as const, args: [...input.args, "HEAD"] };
  }

  const resolvedOperands = await Promise.all(operands.indexes.map((index) =>
    resolveGrepTreeish({ ...input, value: input.args[index]! })
  ));
  const firstPathIndex = resolvedOperands.findIndex((resolved) => !resolved);
  if (firstPathIndex < 0) {
    return { valid: true as const, args: [...input.args] };
  }
  if (resolvedOperands.slice(firstPathIndex + 1).some(Boolean)) {
    return { valid: false as const, reason: "ambiguous_grep_arguments" };
  }

  const insertionIndex = operands.indexes[firstPathIndex]!;
  return {
    valid: true as const,
    args: [
      ...input.args.slice(0, insertionIndex),
      ...(firstPathIndex === 0 ? ["HEAD"] : []),
      "--",
      ...input.args.slice(insertionIndex),
    ],
  };
}

function blameLineRange(args: readonly string[]) {
  const inline = args.find((argument) => /^-L\d+(?:,\d+)?$/.test(argument));
  const separateIndex = args.findIndex((argument) => argument === "-L");
  const raw = inline?.slice(2) ?? (separateIndex >= 0 ? args[separateIndex + 1] : null);
  const match = raw?.match(/^(\d+)(?:,(\d+))?$/);
  if (!match) return {};
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  return { startLine, endLine };
}

async function resolveProjectRepositoryEvidenceTarget(input: {
  args: string[];
  gitDir: string;
  env: NodeJS.ProcessEnv;
  snapshotCommitSha: string;
  limits: Readonly<ProjectRepositoryInspectionLimits>;
}): Promise<ProjectRepositoryEvidenceTarget | null> {
  const [command, ...rest] = input.args;
  if (command === "show") {
    const beforeSeparator = rest.slice(0, rest.indexOf("--") >= 0 ? rest.indexOf("--") : rest.length);
    for (const candidate of [...beforeSeparator].reverse()) {
      if (candidate.startsWith("-")) continue;
      const colon = candidate.indexOf(":");
      const commitish = colon > 0 ? candidate.slice(0, colon) : candidate;
      const commitSha = await resolveCommitish({ ...input, value: commitish });
      if (!commitSha) continue;
      if (colon > 0) {
        const path = candidate.slice(colon + 1);
        if (!path) return { kind: "commit", commitSha };
        const blob = await executeGit({
          args: [
            `--git-dir=${input.gitDir}`,
            "rev-parse",
            "--verify",
            `${commitSha}:${path}`,
          ],
          env: input.env,
          timeoutMs: input.limits.commandTimeoutMs,
          maxBuffer: 4 * 1024,
        });
        const blobSha = blob.stdout.trim().split("\n")[0] ?? "";
        return {
          kind: "blob",
          commitSha,
          path,
          ...(blob.exitCode === 0 && objectIdPattern.test(blobSha) ? { blobSha } : {}),
        };
      }
      return { kind: "commit", commitSha };
    }
    return { kind: "commit", commitSha: input.snapshotCommitSha };
  }

  if (command === "diff") {
    const candidates = rest.filter((argument) => !argument.startsWith("-") && argument !== "--");
    const range = candidates.find((candidate) => candidate.includes(".."));
    if (range) {
      const delimiter = range.includes("...") ? "..." : "..";
      const [base, head] = range.split(delimiter);
      if (base && head) {
        const [baseCommitSha, headCommitSha] = await Promise.all([
          resolveCommitish({ ...input, value: base }),
          resolveCommitish({ ...input, value: head }),
        ]);
        if (baseCommitSha && headCommitSha) {
          return { kind: "compare", baseCommitSha, headCommitSha };
        }
      }
    }
    const resolved: string[] = [];
    for (const candidate of candidates) {
      const commitSha = await resolveCommitish({ ...input, value: candidate });
      if (commitSha) resolved.push(commitSha);
      if (resolved.length === 2) break;
    }
    if (resolved.length === 1) resolved.push(input.snapshotCommitSha);
    return resolved.length === 2
      ? { kind: "compare", baseCommitSha: resolved[0]!, headCommitSha: resolved[1]! }
      : null;
  }

  if (command === "blame") {
    const separatorIndex = rest.indexOf("--");
    const path = separatorIndex >= 0 ? rest[separatorIndex + 1] : rest.at(-1);
    if (!path || path.startsWith("-")) return null;
    const commitCandidates = rest
      .slice(0, separatorIndex >= 0 ? separatorIndex : -1)
      .filter((candidate) => !candidate.startsWith("-") && !/^\d+(?:,\d+)?$/.test(candidate));
    let commitSha = input.snapshotCommitSha;
    for (const candidate of [...commitCandidates].reverse()) {
      const resolved = await resolveCommitish({ ...input, value: candidate });
      if (resolved) {
        commitSha = resolved;
        break;
      }
    }
    return { kind: "blame", commitSha, path, ...blameLineRange(rest) };
  }
  return null;
}

export class ProjectChatRepositoryInspector {
  readonly #repositories = new Map<string, Promise<PreparedProjectRepository>>();
  readonly #evidence = new Map<string, ProjectRepositoryRawEvidence>();
  readonly limits: Readonly<ProjectRepositoryInspectionLimits>;
  #queryCount = 0;
  #visibleBytes = 0;
  #expansionCount = 0;

  constructor(
    readonly input: {
      userId: string;
      workItemId: string;
      sources: ProjectChatAttachedSource[];
      onEvidence?: (evidence: ProjectRepositoryRawEvidence) => void | Promise<void>;
      loadEvidence?: (
        evidenceId: string,
      ) => ProjectRepositoryRawEvidence | null | Promise<ProjectRepositoryRawEvidence | null>;
      limits?: Partial<ProjectRepositoryInspectionLimits>;
    },
    readonly prepareRepository: PrepareProjectRepository = prepareGitHubRepository,
  ) {
    this.limits = resolvedInspectionLimits(input.limits);
  }

  summaries() {
    return this.input.sources.map(projectChatRepositorySummary);
  }

  async #repository(sourceId: string) {
    const source = this.input.sources.find((candidate) => candidate.id === sourceId);
    if (!source || source.type !== "github_repo") return null;
    const existing = this.#repositories.get(sourceId);
    if (existing) return existing;
    const prepared = this.prepareRepository({
      userId: this.input.userId,
      workItemId: this.input.workItemId,
      source,
      limits: this.limits,
    });
    this.#repositories.set(sourceId, prepared);
    return prepared;
  }

  async inspect(input: {
    sourceId: string;
    objective?: string;
    queries: Array<{ args: string[] }>;
    expansions?: Array<{ evidenceId: string; startLine: number; maxLines: number }>;
  }) {
    const expansions = input.expansions ?? [];
    if (
      (!input.queries.length && !expansions.length) ||
      input.queries.length > this.limits.maxQueriesPerCall ||
      this.#queryCount + input.queries.length >
        this.limits.maxQueriesPerTurn ||
      expansions.length >
        this.limits.maxExpansionRequestsPerCall ||
      this.#expansionCount + expansions.length >
        this.limits.maxExpansionRequestsPerTurn
    ) {
      return {
        status: "rejected" as const,
        code: "query_budget_exhausted",
        instruction: "The bounded repository-inspection query budget is exhausted. Use existing results and state any remaining limitation.",
      };
    }
    const repository = await this.#repository(input.sourceId);
    if (!repository) {
      return {
        status: "rejected" as const,
        code: "unsupported_source",
        instruction: "The selected attached source does not support Git inspection.",
      };
    }
    const results = [];
    const expanded = [];
    const env = gitEnvironment({ privateHome: repository.privateHome });
    for (const query of input.queries) {
      this.#queryCount += 1;
      const validation = validateProjectRepositoryGitArgs(query.args, this.limits);
      if (!validation.valid) {
        results.push({
          args: query.args,
          status: "rejected" as const,
          code: validation.reason,
          instruction: "Use a supported read-only Git command and safe arguments.",
        });
        continue;
      }
      const normalized = await normalizeProjectRepositoryGitArgs({
        args: query.args,
        gitDir: repository.gitDir,
        env,
        limits: this.limits,
      });
      if (!normalized.valid) {
        results.push({
          args: query.args,
          status: "rejected" as const,
          code: normalized.reason,
          instruction: "Use an explicit grep pattern and place paths after --.",
        });
        continue;
      }
      const normalizedValidation = validateProjectRepositoryGitArgs(
        normalized.args,
        this.limits,
      );
      if (!normalizedValidation.valid) {
        results.push({
          args: query.args,
          status: "rejected" as const,
          code: normalizedValidation.reason,
          instruction: "Use a supported read-only Git command and safe arguments.",
        });
        continue;
      }
      const args = normalized.args;
      const executed = await executeGit({
        args: [`--git-dir=${repository.gitDir}`, ...args],
        env,
        timeoutMs: this.limits.commandTimeoutMs,
        maxBuffer: this.limits.maxOutputBytesPerQuery,
      });
      const target = executed.exitCode === 0
        ? await resolveProjectRepositoryEvidenceTarget({
            args,
            gitDir: repository.gitDir,
            env,
            snapshotCommitSha: repository.snapshot.commitSha,
            limits: this.limits,
          })
        : null;
      const canonicalBlobRead = target?.kind === "blob" &&
        args.length === 2 &&
        args[0] === "show";
      // Exact blob evidence must preserve source line coordinates. Git stderr
      // is reported separately so a warning can never become line-addressable
      // source or shift a citation range.
      const evidenceOutput = canonicalBlobRead
        ? executed.stdout
        : [executed.stdout, executed.stderr].filter(Boolean).join("\n");
      const redacted = redactRepositorySecrets(evidenceOutput).content;
      const evidence = createProjectRepositoryRawEvidence({
        sourceId: input.sourceId,
        repository: repository.snapshot.repository,
        commitSha: repository.snapshot.commitSha,
        args,
        output: redacted,
        target,
        exitCode: executed.exitCode,
        redactionPolicyVersion: PROJECT_REPOSITORY_REDACTION_POLICY_VERSION,
      });
      this.#evidence.set(evidence.evidenceId, evidence);
      await this.input.onEvidence?.(evidence);
      const remaining = Math.max(
        0,
        this.limits.maxVisibleBytesPerTurn -
          this.#visibleBytes,
      );
      const segments = executed.exitCode === 0
        ? compactProjectRepositoryEvidence({
            evidence,
            objective: input.objective ?? "",
            maximumBytes: Math.min(
              remaining,
              this.limits.maxEvidenceBytesPerQuery,
            ),
            maximumSegments:
              this.limits.maxEvidenceSegmentsPerQuery,
          })
        : [];
      const visibleBytes = segments.reduce(
        (sum, segment) => sum + Buffer.byteLength(segment.excerpt, "utf8"),
        0,
      );
      this.#visibleBytes += visibleBytes;
      results.push({
        args,
        status: executed.exitCode === 0 ? "success" as const : "command_error" as const,
        exitCode: executed.exitCode,
        evidenceId: evidence.evidenceId,
        outputHash: evidence.outputHash,
        totalBytes: evidence.totalBytes,
        totalLines: evidence.totalLines,
        stderrBytes: Buffer.byteLength(executed.stderr, "utf8"),
        target: evidence.target,
        segments,
        truncated: segments.some((segment) => segment.truncated) ||
          visibleBytes < evidence.totalBytes,
      });
    }
    for (const request of expansions) {
      this.#expansionCount += 1;
      let evidence = this.#evidence.get(request.evidenceId);
      if (!evidence && this.input.loadEvidence) {
        const restored = await this.input.loadEvidence(request.evidenceId);
        if (restored) {
          this.#evidence.set(restored.evidenceId, restored);
          evidence = restored;
        }
      }
      if (
        !evidence ||
        evidence.sourceId !== input.sourceId ||
        evidence.repository !== repository.snapshot.repository ||
        evidence.commitSha !== repository.snapshot.commitSha
      ) {
        expanded.push({
          evidenceId: request.evidenceId,
          status: "rejected" as const,
          code: "evidence_not_found",
        });
        continue;
      }
      if (evidence.exitCode !== undefined && evidence.exitCode !== 0) {
        expanded.push({
          evidenceId: request.evidenceId,
          status: "rejected" as const,
          code: "evidence_command_failed",
        });
        continue;
      }
      const remaining = Math.max(
        0,
        this.limits.maxVisibleBytesPerTurn -
          this.#visibleBytes,
      );
      const segment = expandProjectRepositoryEvidence({
        evidence,
        startLine: request.startLine,
        maximumLines: Math.min(
          request.maxLines,
          this.limits.maxExpansionLines,
        ),
        maximumBytes: Math.min(
          remaining,
          this.limits.maxExpandedBytesPerRequest,
        ),
      });
      if (segment) {
        this.#visibleBytes += Buffer.byteLength(segment.excerpt, "utf8");
      }
      if (segment) {
        expanded.push({
          evidenceId: request.evidenceId,
          status: "success" as const,
          segment,
        });
      } else {
        expanded.push({
          evidenceId: request.evidenceId,
          status: "rejected" as const,
          code: "empty_evidence_range",
        });
      }
    }
    return {
      status: "completed" as const,
      snapshot: repository.snapshot,
      results,
      expansions: expanded,
      usage: {
        queries: this.#queryCount,
        expansions: this.#expansionCount,
        visibleBytes: this.#visibleBytes,
      },
      remainingQueryBudget:
        this.limits.maxQueriesPerTurn - this.#queryCount,
      instruction: "Treat each successful command result as evidence from the pinned repository snapshot. Refine with another bounded Git query only when needed; otherwise answer now.",
    };
  }

  async dispose() {
    const repositories = await Promise.allSettled(this.#repositories.values());
    await Promise.all(repositories.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.dispose()] : []
    ));
    this.#repositories.clear();
    this.#evidence.clear();
  }
}
