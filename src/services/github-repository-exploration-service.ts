import { z } from "zod";
import { prisma } from "@/src/lib/prisma";
import {
  fetchGitHubBlob,
  fetchGitHubFileAtRevision,
  fetchGitHubTree,
  getGitHubAccessTokenForUser,
  resolveGitHubCommit,
  searchGitHubCode,
} from "@/src/services/github-client";

export const githubRepositoryExplorationLimits = Object.freeze({
  // The controller lists each of at most three selected repositories once.
  treeLookups: 3,
  searches: 2,
  fileReads: 8,
  maxFileBytes: 256 * 1024,
  maxVisibleBytes: 64 * 1024,
  maxPathChars: 500,
  timeoutMs: 30_000,
  defaultPathLimit: 100,
  maxPathLimit: 200,
  defaultSearchLimit: 10,
  maxSearchLimit: 20,
  maxFocusTerms: 20,
  maxFocusWindowLines: 160,
} as const);

export type GitHubRepositoryExplorationErrorCode =
  | "attached_repository_not_found"
  | "github_not_connected"
  | "invalid_input"
  | "invalid_repository_metadata"
  | "invalid_revision"
  | "budget_exhausted"
  | "session_expired"
  | "path_not_available"
  | "file_too_large"
  | "binary_file"
  | "unsupported_encoding";

export class GitHubRepositoryExplorationError extends Error {
  readonly name = "GitHubRepositoryExplorationError";

  constructor(
    readonly code: GitHubRepositoryExplorationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubRepositoryRevision {
  requestedRef: string;
  commitSha: string;
  treeSha: string;
  commitUrl: string;
  committedAt: string | null;
}

export interface GitHubRepositoryExplorationSnapshot {
  sourceId: string;
  workItemId: string;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
  };
  revision: GitHubRepositoryRevision;
  limits: typeof githubRepositoryExplorationLimits;
  expiresAt: string;
}

export interface GitHubFileCitation {
  type: "github_file";
  sourceId: string;
  repositoryFullName: string;
  commitSha: string;
  blobSha: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  url: string;
}

export interface GitHubRepositoryExplorationUsage {
  treeLookups: number;
  searches: number;
  fileReads: number;
  visibleBytes: number;
}

export interface GitHubRepositoryExplorationBudget {
  readonly expiresAt: string;
  getUsage(): GitHubRepositoryExplorationUsage;
}

export interface GitHubRepositoryExplorationSession {
  snapshot: GitHubRepositoryExplorationSnapshot;
  getUsage(): GitHubRepositoryExplorationUsage;
  listPaths(input?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    paths: Array<{
      path: string;
      blobSha: string;
      size: number | null;
      immutableUrl: string;
    }>;
    nextCursor: string | null;
    treeTruncated: boolean;
    excludedCount: number;
    usage: GitHubRepositoryExplorationUsage;
  }>;
  search(input: {
    query: string;
    pathPrefix?: string;
    limit?: number;
  }): Promise<{
    matches: Array<{
      path: string;
      blobSha: string;
      size: number | null;
      immutableUrl: string;
      requiresRead: true;
    }>;
    apiTotalCount: number;
    searchIncomplete: boolean;
    treeTruncated: boolean;
    usage: GitHubRepositoryExplorationUsage;
  }>;
  readFile(input: {
    path: string;
    lineStart?: number;
    lineEnd?: number;
    focusTerms?: string[];
    lineWindow?: number;
  }): Promise<{
    path: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    totalLines: number;
    truncated: boolean;
    redacted: boolean;
    redactionCategories: string[];
    contentSafety: "untrusted_repository_content";
    citation: GitHubFileCitation;
    usage: GitHubRepositoryExplorationUsage;
  }>;
}

const startInputSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  workItemId: z.string().trim().min(1).max(200),
  sourceId: z.string().trim().min(1).max(200),
  ref: z.string().trim().min(1).max(200).optional(),
});

const attachedRepositoryMetadataSchema = z.object({
  repository: z.object({
    id: z.union([z.string(), z.number()]).transform((value) => String(value)),
    fullName: z.string().trim().min(3).max(200),
    owner: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    defaultBranch: z.string().trim().min(1).max(200),
    private: z.boolean(),
  }),
});

const hexObjectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const repositoryPartPattern = /^[a-z0-9_.-]+$/i;

const ignoredDirectoryNames = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".serverless",
  ".terraform",
  ".turbo",
  ".venv",
  "__generated__",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "obj",
  "out",
  "pods",
  "target",
  "vendor",
  "vendors",
  "venv",
]);

const generatedFileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

const binaryExtensions = new Set([
  "7z",
  "a",
  "avi",
  "bin",
  "bmp",
  "class",
  "db",
  "dll",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "o",
  "otf",
  "pdf",
  "png",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "sqlite3",
  "tar",
  "tiff",
  "ttf",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xz",
  "zip",
]);

const sensitiveFileNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

type ExclusionReason = "binary" | "generated" | "sensitive" | "oversized";

interface ExplorableTreeEntry {
  path: string;
  blobSha: string;
  size: number | null;
}

interface LoadedTree {
  entries: ExplorableTreeEntry[];
  entriesByPath: Map<string, ExplorableTreeEntry>;
  truncated: boolean;
  excludedCount: number;
}

interface ExplorationBudgetState {
  usage: GitHubRepositoryExplorationUsage;
  activeOperations: number;
  operationWaiters: Array<() => void>;
}

const explorationBudgetStates = new WeakMap<
  GitHubRepositoryExplorationBudget,
  ExplorationBudgetState
>();

function createExplorationBudget(): GitHubRepositoryExplorationBudget {
  const nominalExpiresAt = Date.now() + githubRepositoryExplorationLimits.timeoutMs;
  const state: ExplorationBudgetState = {
    usage: {
      treeLookups: 0,
      searches: 0,
      fileReads: 0,
      visibleBytes: 0,
    },
    activeOperations: 0,
    operationWaiters: [],
  };
  const budget: GitHubRepositoryExplorationBudget = {
    expiresAt: new Date(nominalExpiresAt).toISOString(),
    getUsage: () => ({ ...state.usage }),
  };

  explorationBudgetStates.set(budget, state);
  return Object.freeze(budget);
}

function getExplorationBudgetState(budget: GitHubRepositoryExplorationBudget) {
  const state = explorationBudgetStates.get(budget);

  if (!state) {
    invalidInput("The repository exploration budget is invalid.");
  }

  return state;
}

function invalidInput(message: string): never {
  throw new GitHubRepositoryExplorationError("invalid_input", message);
}

function normalizeRepositoryPath(path: string) {
  const normalized = path;

  if (
    !normalized ||
    normalized.length > githubRepositoryExplorationLimits.maxPathChars ||
    normalized !== normalized.trim() ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }

  return normalized;
}

function normalizePathPrefix(prefix: string | undefined) {
  if (prefix === undefined || prefix === "") {
    return "";
  }

  if (prefix !== prefix.trim()) {
    return null;
  }

  const normalized = prefix.replace(/\/+$/, "");

  if (!normalized) {
    return "";
  }

  return normalizeRepositoryPath(normalized);
}

function normalizeFocusTerms(terms: readonly string[] | undefined) {
  if (!terms?.length) return [];
  if (terms.length > githubRepositoryExplorationLimits.maxFocusTerms) {
    invalidInput(`At most ${githubRepositoryExplorationLimits.maxFocusTerms} focus terms are allowed.`);
  }
  const normalized = terms.map((term) => term.trim()).filter(Boolean);
  if (normalized.some((term) => term.length > 80 || /[\u0000-\u001f\u007f]/.test(term))) {
    invalidInput("Repository excerpt focus terms are invalid.");
  }
  return Array.from(new Set(normalized.map((term) => term.toLowerCase())));
}

function focusedLineRange(input: {
  lines: readonly string[];
  focusTerms: readonly string[];
  windowLines: number;
}) {
  const totalLines = Math.max(input.lines.length, 1);
  const windowLines = Math.min(input.windowLines, totalLines);
  if (!input.focusTerms.length || totalLines <= windowLines) {
    return { lineStart: 1, lineEnd: windowLines };
  }

  const termWeights = new Map(input.focusTerms.map((term, index) => [
    term,
    // Focus terms are ordered: exact search matches come first, followed by
    // controller expansions. Reward covering distinct high-priority terms so
    // many repeated `stopReason` mentions cannot crowd a nearby
    // `maxIterations` guard out of the single bounded window.
    (input.focusTerms.length - index) * 50 +
      (/(?:max|stop|retry|backoff|timeout|budget|limit|iteration|attempt)/i.test(term) ? 10 : 0),
  ]));
  const lineTerms = input.lines.map((line) => {
    const normalizedLine = line.toLowerCase();
    return input.focusTerms.filter((term) => normalizedLine.includes(term));
  });
  const controlFlowScores = input.lines.map((line) => {
    const normalizedLine = line.toLowerCase();
    const matchedTerms = input.focusTerms.filter((term) => normalizedLine.includes(term));
    if (!matchedTerms.length) return 0;
    const boundedTermCount = matchedTerms.filter((term) =>
      /(?:max|stop|retry|backoff|timeout|budget|limit|iteration|attempt)/i.test(term)
    ).length;
    if (!boundedTermCount) return 0;
    return /\b(?:if|while|for)\s*\([^\n)]*(?:[<>]=?|===?|!==?)[^\n)]*\)/i.test(line)
      ? (
        matchedTerms.some((term) => /(?:max|iteration|attempt|retry)/i.test(term))
          ? 20_000
          : 10_000
      ) + boundedTermCount * 500
      : /\b(?:throw|break|return)\b/i.test(line)
        ? 1_000 + boundedTermCount * 100
        : 0;
  });
  const counts = new Map<string, number>();
  const addTerms = (terms: readonly string[], direction: 1 | -1) => {
    for (const term of terms) {
      const next = (counts.get(term) ?? 0) + direction;
      if (next > 0) counts.set(term, next);
      else counts.delete(term);
    }
  };
  lineTerms.slice(0, windowLines).forEach((terms) => addTerms(terms, 1));
  const coverageScore = () => Array.from(counts.keys()).reduce(
    (score, term) => score + (termWeights.get(term) ?? 0),
    0,
  );
  const occurrenceScore = () => Array.from(counts.entries()).reduce(
    (score, [term, count]) => score + count * (/(?:max|stop|retry|backoff|timeout|budget|limit|iteration|attempt)/i.test(term) ? 6 : 2),
    0,
  );
  const controlFlowScore = (startIndex: number) => Math.max(
    0,
    ...controlFlowScores.slice(startIndex, startIndex + windowLines),
  );
  let currentControlFlowScore = controlFlowScore(0);
  let bestCoverageScore = coverageScore();
  let bestOccurrenceScore = occurrenceScore();
  let bestControlFlowScore = currentControlFlowScore;
  let bestStartIndex = 0;
  for (let startIndex = 1; startIndex <= totalLines - windowLines; startIndex += 1) {
    addTerms(lineTerms[startIndex - 1]!, -1);
    addTerms(lineTerms[startIndex + windowLines - 1]!, 1);
    currentControlFlowScore = controlFlowScore(startIndex);
    const nextCoverageScore = coverageScore();
    const nextOccurrenceScore = occurrenceScore();
    if (
      currentControlFlowScore > bestControlFlowScore ||
      (currentControlFlowScore === bestControlFlowScore && nextCoverageScore > bestCoverageScore) ||
      (
        currentControlFlowScore === bestControlFlowScore &&
        nextCoverageScore === bestCoverageScore &&
        nextOccurrenceScore > bestOccurrenceScore
      )
    ) {
      bestControlFlowScore = currentControlFlowScore;
      bestCoverageScore = nextCoverageScore;
      bestOccurrenceScore = nextOccurrenceScore;
      bestStartIndex = startIndex;
    }
  }
  if (bestCoverageScore <= 0) return { lineStart: 1, lineEnd: windowLines };
  return {
    lineStart: bestStartIndex + 1,
    lineEnd: bestStartIndex + windowLines,
  };
}

function extensionForPath(path: string) {
  const fileName = path.split("/").at(-1) ?? "";
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function classifyExcludedPath(path: string, size: number | null): ExclusionReason | null {
  const parts = path.toLowerCase().split("/");
  const fileName = parts.at(-1) ?? "";

  if (parts.slice(0, -1).some((part) => ignoredDirectoryNames.has(part))) {
    return "generated";
  }

  if (
    generatedFileNames.has(fileName) ||
    /(?:\.min\.(?:css|js)|\.bundle\.js|\.map|\.snap)$/.test(fileName)
  ) {
    return "generated";
  }

  if (
    sensitiveFileNames.has(fileName) ||
    (fileName === "config.json" && parts.slice(0, -1).includes(".docker")) ||
    /^\.env(?:\.(?!example$|sample$|template$).+)?$/.test(fileName) ||
    /(?:^|[._-])(?:private[-_]?key|secret[-_]?key)(?:[._-]|$)/.test(fileName) ||
    /\.(?:key|p12|pfx|pem)$/.test(fileName)
  ) {
    return "sensitive";
  }

  if (binaryExtensions.has(extensionForPath(path))) {
    return "binary";
  }

  if (size !== null && size > githubRepositoryExplorationLimits.maxFileBytes) {
    return "oversized";
  }

  return null;
}

export function classifyRepositoryPathForKnowledgeSync(path: string, size: number | null) {
  const normalizedPath = normalizeRepositoryPath(path);
  if (!normalizedPath) return { normalizedPath: null, exclusionReason: "invalid_path" as const };
  return {
    normalizedPath,
    exclusionReason: classifyExcludedPath(normalizedPath, size),
  };
}

function encodeGitHubPath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function immutableFileUrl(input: {
  owner: string;
  repo: string;
  commitSha: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}) {
  const lineFragment = input.lineStart
    ? `#L${input.lineStart}${input.lineEnd ? `-L${input.lineEnd}` : ""}`
    : "";

  return `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}/blob/${input.commitSha}/${encodeGitHubPath(input.path)}${lineFragment}`;
}

function isBinaryBuffer(value: Buffer) {
  if (value.includes(0)) {
    return true;
  }

  if (!value.length) {
    return false;
  }

  let suspiciousControlBytes = 0;

  for (const byte of value) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) {
      suspiciousControlBytes += 1;
    }
  }

  if (suspiciousControlBytes / value.length > 0.03) {
    return true;
  }

  const decoded = value.toString("utf8");
  const replacementCharacters = decoded.match(/\uFFFD/g)?.length ?? 0;
  return replacementCharacters > Math.max(2, decoded.length * 0.01);
}

export function isRepositoryBinaryContent(value: Buffer) {
  return isBinaryBuffer(value);
}

function isSecretAssignmentKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");

  return [
    "apikey",
    "accesstoken",
    "authtoken",
    "auth",
    "refreshtoken",
    "token",
    "clientsecret",
    "password",
    "passwd",
    "secretkey",
    "secretaccesskey",
    "privatekey",
    "databaseurl",
    "connectionstring",
    "dsn",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function redactAssignedSecret(line: string, categories: Set<string>) {
  const assignmentPattern =
    /(?:^|[\s,({;\[])(["']?([A-Za-z_][A-Za-z0-9_.-]{0,100})["']?\s*[:=]\s*)/g;
  let match: RegExpExecArray | null;

  while ((match = assignmentPattern.exec(line))) {
    const prefix = match[1];
    const key = match[2];

    if (!prefix || !key || !isSecretAssignmentKey(key)) {
      continue;
    }

    categories.add("assigned_secret");
    const prefixStart = match.index + match[0].length - prefix.length;
    return `${line.slice(0, prefixStart)}${prefix}[REDACTED]`;
  }

  return line;
}

function redactSecrets(content: string) {
  const categories = new Set<string>();
  let insidePrivateKey = false;

  const lines = content.split("\n").map((line) => {
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) {
      insidePrivateKey = true;
      categories.add("private_key");
      return "[REDACTED PRIVATE KEY]";
    }

    if (insidePrivateKey) {
      if (/-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) {
        insidePrivateKey = false;
      }

      return "[REDACTED PRIVATE KEY]";
    }

    let redacted = line;

    redacted = redacted.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
      () => {
        categories.add("github_token");
        return "[REDACTED GITHUB TOKEN]";
      },
    );
    redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => {
      categories.add("aws_access_key");
      return "[REDACTED AWS ACCESS KEY]";
    });
    redacted = redacted.replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{20,})\b/g,
      () => {
        categories.add("api_token");
        return "[REDACTED API TOKEN]";
      },
    );
    redacted = redacted.replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      () => {
        categories.add("jwt");
        return "[REDACTED JWT]";
      },
    );
    redacted = redacted.replace(
      /(\b(?:authorization|proxy-authorization)\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;]+/gi,
      (_match, prefix: string) => {
        categories.add("authorization_credential");
        return `${prefix}[REDACTED]`;
      },
    );
    redacted = redacted.replace(
      /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
      (_match, prefix: string) => {
        categories.add("url_credential");
        return `${prefix}[REDACTED]@`;
      },
    );
    redacted = redactAssignedSecret(redacted, categories);

    return redacted;
  });

  return {
    content: lines.join("\n"),
    categories: [...categories].sort(),
  };
}

export function redactRepositorySecrets(content: string) {
  return redactSecrets(content);
}

function decodeBlob(input: { content: string; encoding: string }) {
  const encoding = input.encoding.toLowerCase();

  if (encoding === "base64") {
    return Buffer.from(input.content.replace(/\s/g, ""), "base64");
  }

  if (encoding === "utf-8" || encoding === "utf8") {
    return Buffer.from(input.content, "utf8");
  }

  throw new GitHubRepositoryExplorationError(
    "unsupported_encoding",
    "GitHub returned a file encoding that Workbase does not support.",
  );
}

export function decodeRepositoryBlob(input: { content: string; encoding: string }) {
  return decodeBlob(input);
}

function parsePositiveInteger(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;

  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    invalidInput(`${label} must be a positive integer.`);
  }

  return candidate;
}

function createSession(input: {
  token: string;
  owner: string;
  repo: string;
  snapshot: GitHubRepositoryExplorationSnapshot;
  budgetState: ExplorationBudgetState;
}): GitHubRepositoryExplorationSession {
  let treePromise: Promise<LoadedTree> | null = null;

  const usageSnapshot = () => ({ ...input.budgetState.usage });

  // Bound active GitHub I/O rather than Bedrock's planning time between calls.
  // Count, byte, and agent budgets still bound the complete research pass.
  const remainingSignal = () =>
    AbortSignal.timeout(githubRepositoryExplorationLimits.timeoutMs);

  const ensureTree = async () => {
    remainingSignal();

    if (!treePromise) {
      if (
        input.budgetState.usage.treeLookups >=
        githubRepositoryExplorationLimits.treeLookups
      ) {
        throw new GitHubRepositoryExplorationError(
          "budget_exhausted",
          "The repository tree lookup budget is exhausted.",
        );
      }

      input.budgetState.usage.treeLookups += 1;
      treePromise = fetchGitHubTree({
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        treeSha: input.snapshot.revision.treeSha,
        recursive: true,
        signal: remainingSignal(),
      }).then((tree) => {
        if (tree.sha.toLowerCase() !== input.snapshot.revision.treeSha.toLowerCase()) {
          throw new GitHubRepositoryExplorationError(
            "invalid_revision",
            "GitHub returned a tree that did not match the pinned commit.",
          );
        }

        const entries: ExplorableTreeEntry[] = [];
        let excludedCount = 0;

        for (const entry of tree.tree) {
          const normalizedPath = normalizeRepositoryPath(entry.path);
          const size = entry.size ?? null;

          if (
            entry.type !== "blob" ||
            !normalizedPath ||
            !hexObjectIdPattern.test(entry.sha) ||
            classifyExcludedPath(normalizedPath, size)
          ) {
            excludedCount += 1;
            continue;
          }

          entries.push({
            path: normalizedPath,
            blobSha: entry.sha,
            size,
          });
        }

        entries.sort((left, right) => left.path.localeCompare(right.path));

        return {
          entries,
          entriesByPath: new Map(entries.map((entry) => [entry.path, entry])),
          truncated: tree.truncated,
          excludedCount,
        };
      });
    }

    return treePromise;
  };

  const withBoundedConcurrency = async <T>(operation: () => Promise<T>) => {
    if (input.budgetState.activeOperations < 4) {
      input.budgetState.activeOperations += 1;
    } else {
      // A release transfers its existing slot directly to the oldest waiter.
      // The waiter must not increment the active count after waking: a new
      // caller could otherwise claim the temporarily visible free slot first
      // and let the resumed waiter raise concurrency above the hard cap.
      await new Promise<void>((resolve) => input.budgetState.operationWaiters.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = input.budgetState.operationWaiters.shift();
      if (next) {
        next();
      } else {
        input.budgetState.activeOperations -= 1;
      }
    }
  };

  return {
    snapshot: input.snapshot,
    getUsage: usageSnapshot,

    listPaths(listInput = {}) {
      return withBoundedConcurrency(async () => {
        const prefix = normalizePathPrefix(listInput.prefix);

        if (prefix === null) {
          invalidInput("The repository path prefix is invalid.");
        }

        const limit = Math.min(
          parsePositiveInteger(
            listInput.limit,
            githubRepositoryExplorationLimits.defaultPathLimit,
            "Path limit",
          ),
          githubRepositoryExplorationLimits.maxPathLimit,
        );
        const offset = listInput.cursor ? Number.parseInt(listInput.cursor, 10) : 0;

        if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== (listInput.cursor ?? "0")) {
          invalidInput("The repository path cursor is invalid.");
        }

        const tree = await ensureTree();
        const candidates = prefix
          ? tree.entries.filter(
              (entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`),
            )
          : tree.entries;
        const selected = candidates.slice(offset, offset + limit);
        const nextOffset = offset + selected.length;

        return {
          paths: selected.map((entry) => ({
            ...entry,
            immutableUrl: immutableFileUrl({
              owner: input.owner,
              repo: input.repo,
              commitSha: input.snapshot.revision.commitSha,
              path: entry.path,
            }),
          })),
          nextCursor: nextOffset < candidates.length ? String(nextOffset) : null,
          treeTruncated: tree.truncated,
          excludedCount: tree.excludedCount,
          usage: usageSnapshot(),
        };
      });
    },

    search(searchInput) {
      return withBoundedConcurrency(async () => {
        const query = searchInput.query.trim().replace(/\s+/g, " ");
        const pathPrefix = normalizePathPrefix(searchInput.pathPrefix);

        if (query.length < 2 || query.length > 200 || /\0|\r|\n/.test(searchInput.query)) {
          invalidInput("The repository search query must contain 2 to 200 characters.");
        }

        if (/(?:^|\s)(?:repo|org|user):/i.test(query)) {
          invalidInput("Repository, organization, and user qualifiers are not allowed.");
        }

        if (pathPrefix === null) {
          invalidInput("The repository search path prefix is invalid.");
        }

        if (
          input.budgetState.usage.searches >=
          githubRepositoryExplorationLimits.searches
        ) {
          throw new GitHubRepositoryExplorationError(
            "budget_exhausted",
            "The repository search budget is exhausted.",
          );
        }

        const limit = Math.min(
          parsePositiveInteger(
            searchInput.limit,
            githubRepositoryExplorationLimits.defaultSearchLimit,
            "Search limit",
          ),
          githubRepositoryExplorationLimits.maxSearchLimit,
        );
        input.budgetState.usage.searches += 1;
        const tree = await ensureTree();
        const result = await searchGitHubCode({
          token: input.token,
          owner: input.owner,
          repo: input.repo,
          query,
          perPage: Math.min(limit * 3, 100),
          signal: remainingSignal(),
        });
        const seen = new Set<string>();
        const matches = [];

        for (const item of result.items) {
          if (item.repository.full_name.toLowerCase() !== input.snapshot.repository.fullName.toLowerCase()) {
            continue;
          }

          const normalizedPath = normalizeRepositoryPath(item.path);
          const entry = normalizedPath ? tree.entriesByPath.get(normalizedPath) : null;

          if (
            !entry ||
            seen.has(entry.path) ||
            (pathPrefix && entry.path !== pathPrefix && !entry.path.startsWith(`${pathPrefix}/`))
          ) {
            continue;
          }

          seen.add(entry.path);
          matches.push({
            path: entry.path,
            blobSha: entry.blobSha,
            size: entry.size,
            immutableUrl: immutableFileUrl({
              owner: input.owner,
              repo: input.repo,
              commitSha: input.snapshot.revision.commitSha,
              path: entry.path,
            }),
            requiresRead: true as const,
          });

          if (matches.length >= limit) {
            break;
          }
        }

        return {
          matches,
          apiTotalCount: result.total_count,
          searchIncomplete: result.incomplete_results,
          treeTruncated: tree.truncated,
          usage: usageSnapshot(),
        };
      });
    },

    readFile(readInput) {
      return withBoundedConcurrency(async () => {
        const path = normalizeRepositoryPath(readInput.path);

        if (!path) {
          invalidInput("The repository file path is invalid.");
        }

        if (
          input.budgetState.usage.fileReads >=
          githubRepositoryExplorationLimits.fileReads
        ) {
          throw new GitHubRepositoryExplorationError(
            "budget_exhausted",
            "The repository file-read budget is exhausted.",
          );
        }

        // Reserve before I/O. JavaScript executes this check/increment without
        // an intervening await, so concurrent sessions sharing the budget
        // cannot oversubscribe the eight-read cap. Failed reserved calls still
        // count, preventing retry storms.
        input.budgetState.usage.fileReads += 1;
        const tree = await ensureTree();
        const entry = tree.entriesByPath.get(path);

        if (!entry) {
          throw new GitHubRepositoryExplorationError(
            "path_not_available",
            "The requested path is not an eligible file in the pinned repository tree.",
          );
        }

        if (
          entry.size !== null &&
          entry.size > githubRepositoryExplorationLimits.maxFileBytes
        ) {
          throw new GitHubRepositoryExplorationError(
            "file_too_large",
            "The requested file exceeds the repository exploration size limit.",
          );
        }

        const signal = remainingSignal();
        const blob = await fetchGitHubBlob({
          token: input.token,
          owner: input.owner,
          repo: input.repo,
          blobSha: entry.blobSha,
          signal,
        }).catch(async (error) => {
          if (signal.aborted) throw error;
          // The commit-pinned contents endpoint is an independently served,
          // immutable recovery path for transient git-blob failures. The SHA
          // and size checks below remain mandatory before any content is used.
          return fetchGitHubFileAtRevision({
            token: input.token,
            owner: input.owner,
            repo: input.repo,
            path,
            commitSha: input.snapshot.revision.commitSha,
            signal,
          });
        });

        if (blob.sha.toLowerCase() !== entry.blobSha.toLowerCase()) {
          throw new GitHubRepositoryExplorationError(
            "invalid_revision",
            "GitHub returned content that did not match the pinned repository tree.",
          );
        }

        if (blob.size > githubRepositoryExplorationLimits.maxFileBytes) {
          throw new GitHubRepositoryExplorationError(
            "file_too_large",
            "The requested file exceeds the repository exploration size limit.",
          );
        }

        if (entry.size !== null && blob.size !== entry.size) {
          throw new GitHubRepositoryExplorationError(
            "invalid_revision",
            "GitHub returned a blob size that did not match the pinned repository tree.",
          );
        }

        const decoded = decodeBlob(blob);

        if (decoded.byteLength !== blob.size) {
          throw new GitHubRepositoryExplorationError(
            "invalid_revision",
            "GitHub returned incomplete content for the pinned repository blob.",
          );
        }

        if (decoded.byteLength > githubRepositoryExplorationLimits.maxFileBytes) {
          throw new GitHubRepositoryExplorationError(
            "file_too_large",
            "The decoded file exceeds the repository exploration size limit.",
          );
        }

        if (isBinaryBuffer(decoded)) {
          throw new GitHubRepositoryExplorationError(
            "binary_file",
            "The requested GitHub blob appears to contain binary data.",
          );
        }

        const normalizedContent = decoded
          .toString("utf8")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        const redaction = redactSecrets(normalizedContent);
        const lines = redaction.content.endsWith("\n")
          ? redaction.content.slice(0, -1).split("\n")
          : redaction.content.split("\n");
        const totalLines = Math.max(lines.length, 1);
        const focusTerms = normalizeFocusTerms(readInput.focusTerms);
        if (focusTerms.length && (readInput.lineStart !== undefined || readInput.lineEnd !== undefined)) {
          invalidInput("Use either a fixed line range or focus terms, not both.");
        }
        const lineWindow = Math.min(
          parsePositiveInteger(
            readInput.lineWindow,
            githubRepositoryExplorationLimits.maxFocusWindowLines,
            "Line window",
          ),
          githubRepositoryExplorationLimits.maxFocusWindowLines,
        );
        const focusedRange = focusTerms.length || readInput.lineWindow !== undefined
          ? focusedLineRange({ lines, focusTerms, windowLines: lineWindow })
          : null;
        const lineStart = focusedRange?.lineStart ?? parsePositiveInteger(readInput.lineStart, 1, "Starting line");
        const requestedLineEnd = focusedRange?.lineEnd ?? parsePositiveInteger(
          readInput.lineEnd,
          totalLines,
          "Ending line",
        );

        if (lineStart > totalLines || requestedLineEnd < lineStart) {
          invalidInput("The requested line range is outside the file.");
        }

        const lineEnd = Math.min(requestedLineEnd, totalLines);
        const content = lines.slice(lineStart - 1, lineEnd).join("\n");
        const visibleBytes = Buffer.byteLength(content, "utf8");

        if (
          input.budgetState.usage.visibleBytes + visibleBytes >
          githubRepositoryExplorationLimits.maxVisibleBytes
        ) {
          throw new GitHubRepositoryExplorationError(
            "budget_exhausted",
            "The repository model-visible content budget is exhausted.",
          );
        }

        input.budgetState.usage.visibleBytes += visibleBytes;
        const citation: GitHubFileCitation = {
          type: "github_file",
          sourceId: input.snapshot.sourceId,
          repositoryFullName: input.snapshot.repository.fullName,
          commitSha: input.snapshot.revision.commitSha,
          blobSha: entry.blobSha,
          path,
          lineStart,
          lineEnd,
          url: immutableFileUrl({
            owner: input.owner,
            repo: input.repo,
            commitSha: input.snapshot.revision.commitSha,
            path,
            lineStart,
            lineEnd,
          }),
        };

        return {
          path,
          content,
          lineStart,
          lineEnd,
          totalLines,
          truncated: lineStart > 1 || lineEnd < totalLines,
          redacted: redaction.categories.length > 0,
          redactionCategories: redaction.categories,
          contentSafety: "untrusted_repository_content" as const,
          citation,
          usage: usageSnapshot(),
        };
      });
    },
  };
}

export const githubRepositoryExplorationService = {
  createBudget: createExplorationBudget,

  async start(rawInput: {
    userId: string;
    workItemId: string;
    sourceId: string;
    ref?: string;
    budget?: GitHubRepositoryExplorationBudget;
  }): Promise<GitHubRepositoryExplorationSession> {
    const parsedInput = startInputSchema.safeParse(rawInput);

    if (!parsedInput.success) {
      throw new GitHubRepositoryExplorationError(
        "invalid_input",
        "The repository exploration request is invalid.",
      );
    }

    const budget = rawInput.budget ?? createExplorationBudget();
    const budgetState = getExplorationBudgetState(budget);

    const source = await prisma.source.findFirst({
      where: {
        id: parsedInput.data.sourceId,
        workItemId: parsedInput.data.workItemId,
        type: "github_repo",
        workItem: {
          userId: parsedInput.data.userId,
        },
      },
      select: {
        id: true,
        workItemId: true,
        externalId: true,
        metadata: true,
      },
    });

    if (!source) {
      throw new GitHubRepositoryExplorationError(
        "attached_repository_not_found",
        "No attached GitHub repository is available for this Work Item.",
      );
    }

    const metadataResult = attachedRepositoryMetadataSchema.safeParse(source.metadata);

    if (!metadataResult.success) {
      throw new GitHubRepositoryExplorationError(
        "invalid_repository_metadata",
        "The attached GitHub source does not contain valid repository metadata.",
      );
    }

    const repository = metadataResult.data.repository;
    const expectedFullName = `${repository.owner}/${repository.name}`;

    if (
      repository.fullName.toLowerCase() !== expectedFullName.toLowerCase() ||
      source.externalId !== repository.id ||
      !repositoryPartPattern.test(repository.owner) ||
      !repositoryPartPattern.test(repository.name)
    ) {
      throw new GitHubRepositoryExplorationError(
        "invalid_repository_metadata",
        "The attached GitHub source has inconsistent repository identity metadata.",
      );
    }

    const token = await getGitHubAccessTokenForUser(parsedInput.data.userId);

    if (!token) {
      throw new GitHubRepositoryExplorationError(
        "github_not_connected",
        "GitHub is not connected for this user.",
      );
    }

    const requestedRef = parsedInput.data.ref ?? repository.defaultBranch;
    const commit = await resolveGitHubCommit({
      token,
      owner: repository.owner,
      repo: repository.name,
      ref: requestedRef,
      signal: AbortSignal.timeout(githubRepositoryExplorationLimits.timeoutMs),
    });

    if (
      !hexObjectIdPattern.test(commit.sha) ||
      !hexObjectIdPattern.test(commit.commit.tree.sha)
    ) {
      throw new GitHubRepositoryExplorationError(
        "invalid_revision",
        "GitHub did not resolve the repository to valid immutable object IDs.",
      );
    }

    const repositorySnapshot = Object.freeze({ ...repository });
    const revision = Object.freeze({
      requestedRef,
      commitSha: commit.sha,
      treeSha: commit.commit.tree.sha,
      commitUrl: `https://github.com/${encodeURIComponent(
        repository.owner,
      )}/${encodeURIComponent(repository.name)}/commit/${commit.sha}`,
      committedAt: commit.commit.committer?.date ?? null,
    });
    const snapshot: GitHubRepositoryExplorationSnapshot = Object.freeze({
      sourceId: source.id,
      workItemId: source.workItemId,
      repository: repositorySnapshot,
      revision,
      limits: githubRepositoryExplorationLimits,
      expiresAt: budget.expiresAt,
    });

    return createSession({
      token,
      owner: repository.owner,
      repo: repository.name,
      snapshot,
      budgetState,
    });
  },
};
