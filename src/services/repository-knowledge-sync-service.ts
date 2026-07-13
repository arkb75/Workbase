import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@/src/domain/types";
import { prisma } from "@/src/lib/prisma";
import {
  fetchGitHubBlob,
  fetchGitHubTree,
  getGitHubAccessTokenForUser,
  resolveGitHubCommit,
} from "@/src/services/github-client";
import {
  classifyRepositoryPathForKnowledgeSync,
  decodeRepositoryBlob,
  isRepositoryBinaryContent,
  redactRepositorySecrets,
} from "@/src/services/github-repository-exploration-service";

export const REPOSITORY_KNOWLEDGE_ANALYZER_VERSION = "repository-coverage-v9";
export const REPOSITORY_SYNC_MAX_FILE_BYTES = 256 * 1024;
const GITHUB_TIMEOUT_MS = 30_000;

const metadataSchema = z.object({
  repository: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    fullName: z.string().min(3).max(200),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    defaultBranch: z.string().min(1).max(200),
    private: z.boolean(),
  }),
});

export interface RepositoryTargetHead {
  sourceId: string;
  repository: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  committedAt: string | null;
  resolvedAt: string;
}

export interface RepositoryInventoryEntry {
  path: string;
  blobSha: string | null;
  sizeBytes: number | null;
  mode: string;
  objectType: "blob" | "commit";
  disposition: "eligible" | "excluded";
  exclusionReason: string | null;
}

type AttachedRepository = {
  sourceId: string;
  workItemId: string;
  repository: z.infer<typeof metadataSchema>["repository"];
  token: string;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableUrl(target: RepositoryTargetHead, path: string, startLine?: number, endLine?: number) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const lineFragment = startLine
    ? `#L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ""}`
    : "";
  return `https://github.com/${target.repository}/blob/${target.commitSha}/${encodedPath}${lineFragment}`;
}

async function authorizeAttachedRepository(input: {
  userId: string;
  workItemId: string;
  sourceId: string;
}): Promise<AttachedRepository> {
  const source = await prisma.source.findFirst({
    where: {
      id: input.sourceId,
      workItemId: input.workItemId,
      type: "github_repo",
      workItem: { userId: input.userId },
    },
    select: { id: true, workItemId: true, externalId: true, metadata: true },
  });
  if (!source) throw new Error("The attached repository is not authorized for this project.");
  const parsed = metadataSchema.safeParse(source.metadata);
  if (!parsed.success || source.externalId !== parsed.data.repository.id) {
    throw new Error("The attached repository metadata is invalid.");
  }
  const token = await getGitHubAccessTokenForUser(input.userId);
  if (!token) throw new Error("GitHub is not connected for this user.");
  return {
    sourceId: source.id,
    workItemId: source.workItemId,
    repository: parsed.data.repository,
    token,
  };
}

export async function resolveRepositoryTargetHeads(input: {
  userId: string;
  workItemId: string;
}) {
  const sources = await prisma.source.findMany({
    where: {
      workItemId: input.workItemId,
      type: "github_repo",
      workItem: { userId: input.userId },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const targets: RepositoryTargetHead[] = [];
  for (const source of sources) {
    const attached = await authorizeAttachedRepository({ ...input, sourceId: source.id });
    const commit = await resolveGitHubCommit({
      token: attached.token,
      owner: attached.repository.owner,
      repo: attached.repository.name,
      ref: attached.repository.defaultBranch,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const resolvedAt = new Date().toISOString();
    targets.push({
      sourceId: attached.sourceId,
      repository: attached.repository.fullName,
      branch: attached.repository.defaultBranch,
      commitSha: commit.sha,
      treeSha: commit.commit.tree.sha,
      committedAt: commit.commit.committer?.date ?? null,
      resolvedAt,
    });
  }
  return targets;
}

function normalizeNestedPath(prefix: string, path: string) {
  return prefix ? `${prefix}/${path}` : path;
}

function dispositionForEntry(input: {
  path: string;
  sizeBytes: number | null;
  mode: string;
  objectType: "blob" | "commit";
}) {
  if (input.objectType === "commit") return "submodule";
  if (input.mode === "120000") return "symlink";
  const classified = classifyRepositoryPathForKnowledgeSync(input.path, input.sizeBytes);
  if (!classified.normalizedPath) return "invalid_path";
  return classified.exclusionReason;
}

export async function inventoryRepositoryAtTarget(input: {
  userId: string;
  workItemId: string;
  target: RepositoryTargetHead;
}) {
  const attached = await authorizeAttachedRepository({
    userId: input.userId,
    workItemId: input.workItemId,
    sourceId: input.target.sourceId,
  });
  if (
    attached.repository.fullName.toLowerCase() !== input.target.repository.toLowerCase() ||
    attached.repository.defaultBranch !== input.target.branch
  ) {
    throw new Error("The repository target no longer matches the attached source.");
  }

  const recursive = await fetchGitHubTree({
    token: attached.token,
    owner: attached.repository.owner,
    repo: attached.repository.name,
    treeSha: input.target.treeSha,
    recursive: true,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (recursive.sha.toLowerCase() !== input.target.treeSha.toLowerCase()) {
    throw new Error("GitHub returned a tree that did not match the freshness barrier.");
  }

  const rawEntries: Array<{
    path: string;
    sha: string;
    size: number | null;
    mode: string;
    type: "blob" | "commit";
  }> = [];
  let treeLookups = 1;

  if (!recursive.truncated) {
    for (const entry of recursive.tree) {
      if (entry.type === "tree") continue;
      rawEntries.push({
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? null,
        mode: entry.mode,
        type: entry.type,
      });
    }
  } else {
    const queue: Array<{ prefix: string; treeSha: string }> = [{ prefix: "", treeSha: input.target.treeSha }];
    while (queue.length) {
      const current = queue.shift()!;
      const tree = await fetchGitHubTree({
        token: attached.token,
        owner: attached.repository.owner,
        repo: attached.repository.name,
        treeSha: current.treeSha,
        recursive: false,
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      treeLookups += 1;
      if (tree.truncated) throw new Error(`GitHub truncated the non-recursive tree at ${current.prefix || "/"}.`);
      for (const entry of tree.tree) {
        const path = normalizeNestedPath(current.prefix, entry.path);
        if (entry.type === "tree") {
          queue.push({ prefix: path, treeSha: entry.sha });
        } else {
          rawEntries.push({
            path,
            sha: entry.sha,
            size: entry.size ?? null,
            mode: entry.mode,
            type: entry.type,
          });
        }
      }
    }
  }

  const entries: RepositoryInventoryEntry[] = rawEntries
    .map((entry) => {
      const exclusionReason = dispositionForEntry({
        path: entry.path,
        sizeBytes: entry.size,
        mode: entry.mode,
        objectType: entry.type,
      });
      return {
        path: entry.path,
        blobSha: entry.type === "blob" ? entry.sha : null,
        sizeBytes: entry.size,
        mode: entry.mode,
        objectType: entry.type,
        disposition: exclusionReason ? ("excluded" as const) : ("eligible" as const),
        exclusionReason: exclusionReason ?? null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    target: input.target,
    entries,
    treeLookups,
    manifestHash: hash(entries.map((entry) => [entry.path, entry.blobSha, entry.disposition, entry.exclusionReason].join(":")).join("\n")),
  };
}

export async function readRepositoryFileAtTarget(input: {
  userId: string;
  workItemId: string;
  target: RepositoryTargetHead;
  entry: RepositoryInventoryEntry;
}) {
  if (input.entry.disposition !== "eligible" || !input.entry.blobSha) {
    throw new Error("Only eligible repository blobs may be analyzed.");
  }
  const attached = await authorizeAttachedRepository({
    userId: input.userId,
    workItemId: input.workItemId,
    sourceId: input.target.sourceId,
  });
  const blob = await fetchGitHubBlob({
    token: attached.token,
    owner: attached.repository.owner,
    repo: attached.repository.name,
    blobSha: input.entry.blobSha,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (blob.sha.toLowerCase() !== input.entry.blobSha.toLowerCase()) {
    throw new Error("GitHub returned content for a different immutable blob.");
  }
  if (blob.size > REPOSITORY_SYNC_MAX_FILE_BYTES) throw new Error("file_too_large");
  const decoded = decodeRepositoryBlob(blob);
  if (decoded.byteLength !== blob.size) throw new Error("incomplete_blob");
  if (isRepositoryBinaryContent(decoded)) throw new Error("binary_file");
  const normalized = decoded.toString("utf8").replace(/\r\n?/g, "\n");
  const redacted = redactRepositorySecrets(normalized);
  return {
    path: input.entry.path,
    blobSha: input.entry.blobSha,
    content: redacted.content,
    contentHash: hash(redacted.content),
    redacted: redacted.categories.length > 0,
    redactionCategories: redacted.categories,
    immutableUrl: immutableUrl(input.target, input.entry.path),
    metadata: {
      repository: input.target.repository,
      commitSha: input.target.commitSha,
      blobSha: input.entry.blobSha,
      path: input.entry.path,
    } satisfies JsonValue,
  };
}

export const repositoryKnowledgeSyncService = {
  resolveTargetHeads: resolveRepositoryTargetHeads,
  inventory: inventoryRepositoryAtTarget,
  readFile: readRepositoryFileAtTarget,
};
