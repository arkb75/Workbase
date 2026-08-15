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
  type ProjectRepositoryRawEvidence,
} from "@/src/services/project-chat-repository-evidence-service";

export const projectChatRepositoryInspectionLimits = Object.freeze({
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
} as const);

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

type PrepareRepository = (input: {
  userId: string;
  workItemId: string;
  source: ProjectChatAttachedSource;
}) => Promise<PreparedProjectRepository>;

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
];

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

async function prepareGitHubRepository(input: {
  userId: string;
  workItemId: string;
  source: ProjectChatAttachedSource;
}): Promise<PreparedProjectRepository> {
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
  const commit = await resolveGitHubCommit({
    token,
    owner: repository.owner,
    repo: repository.name,
    ref: repository.defaultBranch,
    signal: AbortSignal.timeout(
      projectChatRepositoryInspectionLimits.preparationTimeoutMs,
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
    timeoutMs: projectChatRepositoryInspectionLimits.preparationTimeoutMs,
    maxBuffer: 64 * 1024,
  });
  if (clone.exitCode !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error("repository_clone_failed");
  }
  const object = await executeGit({
    args: [`--git-dir=${gitDir}`, "cat-file", "-e", `${commit.sha}^{commit}`],
    env,
    timeoutMs: projectChatRepositoryInspectionLimits.commandTimeoutMs,
    maxBuffer: 4 * 1024,
  });
  if (object.exitCode !== 0) {
    const fetched = await executeGit({
      args: [`--git-dir=${gitDir}`, "fetch", "origin", commit.sha],
      env,
      timeoutMs: projectChatRepositoryInspectionLimits.preparationTimeoutMs,
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
      timeoutMs: projectChatRepositoryInspectionLimits.commandTimeoutMs,
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

export function validateProjectRepositoryGitArgs(args: string[]) {
  const limits = projectChatRepositoryInspectionLimits;
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

export class ProjectChatRepositoryInspector {
  readonly #repositories = new Map<string, Promise<PreparedProjectRepository>>();
  readonly #evidence = new Map<string, ProjectRepositoryRawEvidence>();
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
    },
    readonly prepareRepository: PrepareRepository = prepareGitHubRepository,
  ) {}

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
      input.queries.length > projectChatRepositoryInspectionLimits.maxQueriesPerCall ||
      this.#queryCount + input.queries.length >
        projectChatRepositoryInspectionLimits.maxQueriesPerTurn ||
      expansions.length >
        projectChatRepositoryInspectionLimits.maxExpansionRequestsPerCall ||
      this.#expansionCount + expansions.length >
        projectChatRepositoryInspectionLimits.maxExpansionRequestsPerTurn
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
      const validation = validateProjectRepositoryGitArgs(query.args);
      if (!validation.valid) {
        results.push({
          args: query.args,
          status: "rejected" as const,
          code: validation.reason,
          instruction: "Use a supported read-only Git command and safe arguments.",
        });
        continue;
      }
      const executed = await executeGit({
        args: [`--git-dir=${repository.gitDir}`, ...query.args],
        env,
        timeoutMs: projectChatRepositoryInspectionLimits.commandTimeoutMs,
        maxBuffer: projectChatRepositoryInspectionLimits.maxOutputBytesPerQuery,
      });
      const combined = [executed.stdout, executed.stderr].filter(Boolean).join("\n");
      const redacted = redactRepositorySecrets(combined).content;
      const evidence = createProjectRepositoryRawEvidence({
        sourceId: input.sourceId,
        repository: repository.snapshot.repository,
        commitSha: repository.snapshot.commitSha,
        args: query.args,
        output: redacted,
      });
      this.#evidence.set(evidence.evidenceId, evidence);
      await this.input.onEvidence?.(evidence);
      const remaining = Math.max(
        0,
        projectChatRepositoryInspectionLimits.maxVisibleBytesPerTurn -
          this.#visibleBytes,
      );
      const segments = compactProjectRepositoryEvidence({
        evidence,
        objective: input.objective ?? "",
        maximumBytes: Math.min(
          remaining,
          projectChatRepositoryInspectionLimits.maxEvidenceBytesPerQuery,
        ),
        maximumSegments:
          projectChatRepositoryInspectionLimits.maxEvidenceSegmentsPerQuery,
      });
      const visibleBytes = segments.reduce(
        (sum, segment) => sum + Buffer.byteLength(segment.excerpt, "utf8"),
        0,
      );
      this.#visibleBytes += visibleBytes;
      results.push({
        args: query.args,
        status: executed.exitCode === 0 ? "success" as const : "command_error" as const,
        exitCode: executed.exitCode,
        evidenceId: evidence.evidenceId,
        outputHash: evidence.outputHash,
        totalBytes: evidence.totalBytes,
        totalLines: evidence.totalLines,
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
      const remaining = Math.max(
        0,
        projectChatRepositoryInspectionLimits.maxVisibleBytesPerTurn -
          this.#visibleBytes,
      );
      const segment = expandProjectRepositoryEvidence({
        evidence,
        startLine: request.startLine,
        maximumLines: Math.min(
          request.maxLines,
          projectChatRepositoryInspectionLimits.maxExpansionLines,
        ),
        maximumBytes: Math.min(
          remaining,
          projectChatRepositoryInspectionLimits.maxExpandedBytesPerRequest,
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
        projectChatRepositoryInspectionLimits.maxQueriesPerTurn - this.#queryCount,
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
