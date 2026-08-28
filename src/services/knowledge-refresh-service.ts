import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import {
  resolveActiveTextModelIdentity,
  resolveWorkbaseLlmProvider,
} from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  analyzeRepositoryFilesHierarchically,
  analyzeRepositoryFiles,
  analyzeRepositoryFile,
  BASE_COVERAGE_TARGETS,
  buildCoverageMatrix,
  inferSubsystemsFromPath,
  isProjectDomainCapabilityKey,
  mergeRepositoryFileAnalysis,
  MAX_REPOSITORY_STATIC_ANALYSIS_BATCH_SIZE,
  REPOSITORY_COVERAGE_POLICY_VERSION,
  selectRequiredSemanticCoverageAreas,
  type RepositoryFileAnalysis,
} from "@/src/services/repository-coverage-service";
import {
  REPOSITORY_SEMANTIC_ANALYZER_VERSION,
  REPOSITORY_STATIC_ANALYZER_VERSION,
  repositoryKnowledgeSyncService,
  type RepositoryInventoryEntry,
  type RepositoryTargetHead,
} from "@/src/services/repository-knowledge-sync-service";
import {
  REPOSITORY_ORCHESTRATION_POLICY_VERSION,
  repositorySemanticOrchestratorService,
} from "@/src/services/repository-semantic-orchestrator-service";
import {
  isNewerKnowledgeRefreshGeneration,
  KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
  lockKnowledgeRefreshWorkItem,
} from "@/src/services/knowledge-reconciliation-service";

export const REPOSITORY_SYNTHESIS_POLICY_VERSION = "repository-synthesis-v32";
export const DEGRADED_CHAT_REFRESH_RETRY_COOLDOWN_MS = 15 * 60 * 1_000;
const ACTIVE_KNOWLEDGE_REFRESH_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;

const targetHeadSchema = z.object({
  sourceId: z.string(),
  repository: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  treeSha: z.string(),
  committedAt: z.string().nullable(),
  resolvedAt: z.string(),
});

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function currentKnowledgeRefreshPolicyHash() {
  return hash(JSON.stringify(currentKnowledgeRefreshPolicyMetadata())).slice(0, 16);
}

function currentKnowledgeRefreshPolicyMetadata() {
  return {
    analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
    semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
    coveragePolicyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
    orchestrationPolicyVersion: REPOSITORY_ORCHESTRATION_POLICY_VERSION,
    synthesisPolicyVersion: REPOSITORY_SYNTHESIS_POLICY_VERSION,
    lifecyclePolicyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
  };
}

export function policyScopedKnowledgeRefreshIdempotencyKey(baseKey: string) {
  return `${baseKey}:policy:${currentKnowledgeRefreshPolicyHash()}`;
}

export function knowledgeRefreshBaseIdempotencyKey(input: {
  trigger: "repository_attach" | "webhook_push" | "scheduled" | "manual" | "chat_freshness" | "backfill";
  requestedKey?: string;
  targets: Array<Pick<RepositoryTargetHead, "sourceId" | "commitSha">>;
}) {
  const headsHash = hash(
    input.targets
      .map((target) => `${target.sourceId}:${target.commitSha}`)
      .sort()
      .join("|"),
  );
  // Attach, webhook, scheduled, manual, and chat triggers are all ordinary
  // requests for the same immutable repository state. Sharing a base key lets
  // the caller coalesce their active work regardless of which surface won the
  // race.
  // Backfills remain explicitly scoped because a knowledge edit may require a
  // forced revalidation even while an ordinary refresh is running.
  if (input.trigger !== "backfill") return `repository_heads:${headsHash}`;
  return input.requestedKey ?? `${input.trigger}:${headsHash}`;
}

function assertKnowledgeRefreshCanExecute(runId: string, status: string) {
  if (status === "failed" || status === "cancelled") {
    throw new Error(`Repository refresh ${runId} is ${status} and cannot continue.`);
  }
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function coverageRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

export function isKnowledgeRefreshPartial(input: { qualityStatus: unknown; coverage: unknown }) {
  if (input.qualityStatus !== "verified") return true;
  const coverage = coverageRecords(input.coverage);
  if (!coverage.length) return true;
  return coverage.some((entry) => {
    const semanticStatus = entry.semanticCoverageStatus;
    const capabilityStatus = entry.capabilityCoverageStatus;
    return entry.coverageStatus !== "complete" ||
      (semanticStatus !== undefined && semanticStatus !== "complete" && semanticStatus !== "not_required") ||
      (capabilityStatus !== undefined && capabilityStatus !== "verified") ||
      (Array.isArray(entry.coverageGaps) && entry.coverageGaps.length > 0);
  });
}

export function repositoryCapabilityPriority(input: {
  capabilityKey: string;
  observationCount: number;
  requiredForSemanticCoverage?: boolean;
}) {
  if (BASE_COVERAGE_TARGETS.some((target) => target.key === input.capabilityKey)) return 5;
  if (input.requiredForSemanticCoverage && isProjectDomainCapabilityKey(input.capabilityKey)) return 4;
  return input.observationCount >= 20 ? 3 : 1;
}

export function repositoryOrchestrationCoverageGaps(input: {
  repository: string;
  repositories: string[];
  filePaths: string[];
  remainingGaps: string[];
}) {
  return input.remainingGaps.filter((gap) => {
    const explicitlyScopedRepositories = input.repositories.filter((repository) => gap.includes(repository));
    if (explicitlyScopedRepositories.length) return explicitlyScopedRepositories.includes(input.repository);
    if (input.filePaths.some((path) => gap.startsWith(`${path}:`))) return true;
    // Package-level provider failures, missing assigned IDs, and missing
    // capability findings cannot always be attributed to one repository from
    // the sanitized audit string. Keep them as conservative global gaps so a
    // bounded orchestration failure can never be finalized as verified.
    return true;
  });
}

function parseTargets(value: unknown): RepositoryTargetHead[] {
  return z.array(targetHeadSchema).parse(value);
}

function safeParseTargets(value: unknown) {
  const parsed = z.array(targetHeadSchema).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isReusableKnowledgeRefresh(input: {
  warnings: unknown;
  qualityStatus: unknown;
  completedTargets: RepositoryTargetHead[];
  targets: RepositoryTargetHead[];
}) {
  return currentKnowledgeRefreshPolicyMatches(input.warnings) &&
    input.qualityStatus === "verified" &&
    sameKnowledgeRefreshTargets(input.completedTargets, input.targets);
}

function sameKnowledgeRefreshTargets(
  completedTargets: RepositoryTargetHead[],
  targets: RepositoryTargetHead[],
) {
  return completedTargets.length === targets.length && targets.every((target) =>
    completedTargets.some((completed) =>
      completed.sourceId === target.sourceId && completed.commitSha === target.commitSha
    )
  );
}

type ActiveKnowledgeRefreshSummary = {
  id: string;
  trigger: string;
  status: string;
  targetHeads: unknown;
  createdAt: Date;
};

async function cancelSupersededActiveRefreshes(input: {
  workItemId: string;
  currentRunId: string;
  currentTrigger: string;
  currentTargets: RepositoryTargetHead[];
  currentCreatedAt: Date;
  activeRuns: ActiveKnowledgeRefreshSummary[];
}, client: Pick<Prisma.TransactionClient, "knowledgeRefreshRun">) {
  const supersededIds = input.activeRuns.flatMap((candidate) => {
    if (candidate.id === input.currentRunId) return [];
    const candidateTargets = safeParseTargets(candidate.targetHeads);
    if (!candidateTargets) return [];
    const duplicateOrdinaryGeneration = input.currentTrigger !== "backfill" &&
      candidate.trigger !== "backfill" &&
      sameKnowledgeRefreshTargets(candidateTargets, input.currentTargets) &&
      candidate.createdAt.getTime() <= input.currentCreatedAt.getTime();
    const replacedByNewerHead = isNewerKnowledgeRefreshGeneration({
      currentTargets: candidateTargets,
      candidateTargets: input.currentTargets,
      currentCreatedAt: candidate.createdAt,
      candidateCreatedAt: input.currentCreatedAt,
    });
    return duplicateOrdinaryGeneration || replacedByNewerHead ? [candidate.id] : [];
  });
  if (!supersededIds.length) return [];
  await client.knowledgeRefreshRun.updateMany({
    where: {
      id: { in: supersededIds },
      workItemId: input.workItemId,
      status: { in: [...ACTIVE_KNOWLEDGE_REFRESH_STATUSES] },
    },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
      error: toInputJson({
        message: `Superseded by newer repository refresh ${input.currentRunId}.`,
      }),
    },
  });
  return supersededIds;
}

async function withKnowledgeRefreshWorkItemLock<T>(
  workItemId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await lockKnowledgeRefreshWorkItem(tx, workItemId);
    return operation(tx);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10_000,
  });
}

function activeKnowledgeRefreshes(
  client: Pick<Prisma.TransactionClient, "knowledgeRefreshRun">,
  workItemId: string,
) {
  return client.knowledgeRefreshRun.findMany({
    where: {
      workItemId,
      status: { in: [...ACTIVE_KNOWLEDGE_REFRESH_STATUSES] },
    },
    select: {
      id: true,
      trigger: true,
      status: true,
      targetHeads: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

function currentKnowledgeRefreshPolicyMatches(warningsValue: unknown) {
  const warnings = record(warningsValue);
  const policy = currentKnowledgeRefreshPolicyMetadata();
  return warnings.analyzerVersion === policy.analyzerVersion &&
    warnings.semanticAnalyzerVersion === policy.semanticAnalyzerVersion &&
    warnings.coveragePolicyVersion === policy.coveragePolicyVersion &&
    warnings.orchestrationPolicyVersion === policy.orchestrationPolicyVersion &&
    warnings.synthesisPolicyVersion === policy.synthesisPolicyVersion &&
    warnings.lifecyclePolicyVersion === policy.lifecyclePolicyVersion;
}

/**
 * A partial same-head refresh is still useful durable work. Ordinary chat may
 * reuse it briefly, with its explicit coverage gaps intact, instead of paying
 * for the same failed provider call on every turn. Manual/backfill/attach and
 * scheduled refreshes deliberately bypass this cooldown.
 */
export function isReusableDegradedChatRefresh(input: {
  warnings: unknown;
  qualityStatus: unknown;
  completedTargets: RepositoryTargetHead[];
  targets: RepositoryTargetHead[];
  finishedAt: Date | null;
  now?: Date;
  cooldownMs?: number;
}) {
  const cooldownMs = input.cooldownMs ?? DEGRADED_CHAT_REFRESH_RETRY_COOLDOWN_MS;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0 || !input.finishedAt) return false;
  const ageMs = (input.now ?? new Date()).getTime() - input.finishedAt.getTime();
  return input.qualityStatus !== "verified" &&
    ageMs >= 0 &&
    ageMs < cooldownMs &&
    currentKnowledgeRefreshPolicyMatches(input.warnings) &&
    sameKnowledgeRefreshTargets(input.completedTargets, input.targets);
}

function languageForPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const languages: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript React",
    js: "JavaScript",
    jsx: "JavaScript React",
    json: "JSON",
    md: "Markdown",
    prisma: "Prisma",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
    css: "CSS",
    py: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    sh: "Shell",
  };
  return languages[extension] ?? (extension ? extension.toUpperCase() : null);
}

async function createFileRows(
  snapshotId: string,
  entries: RepositoryInventoryEntry[],
  changeTypeByPath: Map<string, "unchanged" | "added" | "modified" | "renamed">,
) {
  const batchSize = 500;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    await prisma.repositoryFileSnapshot.createMany({
      data: batch.map((entry) => ({
        snapshotId,
        path: entry.path,
        blobSha: entry.blobSha,
        sizeBytes: entry.sizeBytes,
        language: languageForPath(entry.path),
        disposition: entry.disposition,
        changeType: changeTypeByPath.get(entry.path) ?? "added",
        exclusionReason: entry.exclusionReason,
      })),
      skipDuplicates: true,
    });
  }
}

export async function startKnowledgeRefresh(input: {
  userId: string;
  workItemId: string;
  trigger: "repository_attach" | "webhook_push" | "scheduled" | "manual" | "chat_freshness" | "backfill";
  idempotencyKey?: string;
}) {
  const workItem = await prisma.workItem.findFirst({
    where: { id: input.workItemId, userId: input.userId },
    select: { id: true },
  });
  if (!workItem) throw new Error("The project is not authorized for this user.");
  const targets = await repositoryKnowledgeSyncService.resolveTargetHeads(input);
  if (!targets.length) throw new Error("No attached GitHub repository is available for a current knowledge refresh.");
  const forceRevalidation = input.trigger === "backfill" && input.idempotencyKey?.startsWith("knowledge-edit:");
  const ordinaryTrigger = input.trigger !== "backfill";
  const currentPolicySuffix = `:policy:${currentKnowledgeRefreshPolicyHash()}`;
  return withKnowledgeRefreshWorkItemLock(input.workItemId, async (tx) => {
    const [policyRuns, activeRuns] = await Promise.all([
      ordinaryTrigger
        ? tx.knowledgeRefreshRun.findMany({
            where: {
              workItemId: input.workItemId,
              idempotencyKey: { endsWith: currentPolicySuffix },
              trigger: { not: "backfill" },
            },
            select: {
              id: true,
              status: true,
              targetHeads: true,
              completedHeads: true,
              qualityStatus: true,
              warnings: true,
              finishedAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          })
        : Promise.resolve([]),
      activeKnowledgeRefreshes(tx, input.workItemId),
    ]);
    const matchingRuns = policyRuns.filter((run) => {
      const runTargets = safeParseTargets(run.targetHeads);
      return runTargets ? sameKnowledgeRefreshTargets(runTargets, targets) : false;
    });
    const activeRun = matchingRuns.find((run) =>
      ACTIVE_KNOWLEDGE_REFRESH_STATUSES.includes(
        run.status as (typeof ACTIVE_KNOWLEDGE_REFRESH_STATUSES)[number],
      )
    );
    if (activeRun) {
      await cancelSupersededActiveRefreshes({
        workItemId: input.workItemId,
        currentRunId: activeRun.id,
        currentTrigger: input.trigger,
        currentTargets: targets,
        currentCreatedAt: activeRun.createdAt,
        activeRuns,
      }, tx);
      return { runId: activeRun.id, status: activeRun.status, targets, coalesced: true };
    }
    const latestCompleted = ordinaryTrigger
      ? matchingRuns.find((run) => run.status === "completed") ?? null
      : await tx.knowledgeRefreshRun.findFirst({
          where: { workItemId: input.workItemId, status: "completed" },
          orderBy: { finishedAt: "desc" },
        });
    const completedTargets = latestCompleted?.completedHeads && Array.isArray(latestCompleted.completedHeads)
      ? parseTargets(latestCompleted.completedHeads)
      : [];
    if (
      !forceRevalidation &&
      isReusableKnowledgeRefresh({
        warnings: latestCompleted?.warnings,
        qualityStatus: latestCompleted?.qualityStatus,
        completedTargets,
        targets,
      })
    ) {
      await cancelSupersededActiveRefreshes({
        workItemId: input.workItemId,
        currentRunId: latestCompleted!.id,
        currentTrigger: input.trigger,
        currentTargets: targets,
        currentCreatedAt: latestCompleted!.createdAt,
        activeRuns,
      }, tx);
      return { runId: latestCompleted!.id, status: latestCompleted!.status, targets };
    }
    if (
      !forceRevalidation &&
      input.trigger === "chat_freshness" &&
      latestCompleted &&
      isReusableDegradedChatRefresh({
        warnings: latestCompleted.warnings,
        qualityStatus: latestCompleted.qualityStatus,
        completedTargets,
        targets,
        finishedAt: latestCompleted.finishedAt,
      })
    ) {
      await cancelSupersededActiveRefreshes({
        workItemId: input.workItemId,
        currentRunId: latestCompleted.id,
        currentTrigger: input.trigger,
        currentTargets: targets,
        currentCreatedAt: latestCompleted.createdAt,
        activeRuns,
      }, tx);
      return {
        runId: latestCompleted.id,
        status: latestCompleted.status,
        targets,
        degradedCooldown: true,
      };
    }
    const baseIdempotencyKey = knowledgeRefreshBaseIdempotencyKey({
      trigger: input.trigger,
      requestedKey: input.idempotencyKey,
      targets,
    });
    const attemptIdempotencyKey = ordinaryTrigger
      ? `${baseIdempotencyKey}:after:${matchingRuns[0]?.id ?? "initial"}`
      : baseIdempotencyKey;
    const idempotencyKey = policyScopedKnowledgeRefreshIdempotencyKey(
      attemptIdempotencyKey,
    );
    const run = await tx.knowledgeRefreshRun.upsert({
      where: { workItemId_idempotencyKey: { workItemId: input.workItemId, idempotencyKey } },
      create: {
        workItemId: input.workItemId,
        idempotencyKey,
        trigger: input.trigger,
        targetHeads: toInputJson(targets),
        progress: toInputJson({ repositories: targets.length, inventoried: 0, analyzedFiles: 0 }),
      },
      update: {},
    });
    await cancelSupersededActiveRefreshes({
      workItemId: input.workItemId,
      currentRunId: run.id,
      currentTrigger: input.trigger,
      currentTargets: targets,
      currentCreatedAt: run.createdAt,
      activeRuns: await activeKnowledgeRefreshes(tx, input.workItemId),
    }, tx);
    return { runId: run.id, status: run.status, targets };
  });
}

export async function claimInlineKnowledgeRefreshExecution(input: {
  runId: string;
  ownerToken: string;
}, client: Pick<Prisma.TransactionClient, "knowledgeRefreshRun"> = prisma) {
  const freshClaim = await client.knowledgeRefreshRun.updateMany({
    where: {
      id: input.runId,
      status: "queued",
      workflowId: null,
      startedAt: null,
    },
    data: {
      status: "inventorying",
      workflowId: input.ownerToken,
      startedAt: new Date(),
      finishedAt: null,
    },
  });
  if (freshClaim.count) return true;
  const resumedClaim = await client.knowledgeRefreshRun.updateMany({
    where: {
      id: input.runId,
      status: "queued",
      workflowId: null,
      startedAt: { not: null },
    },
    data: {
      status: "inventorying",
      workflowId: input.ownerToken,
      finishedAt: null,
    },
  });
  if (resumedClaim.count) return true;
  const orphanedActiveClaim = await client.knowledgeRefreshRun.updateMany({
    where: {
      id: input.runId,
      status: {
        in: ACTIVE_KNOWLEDGE_REFRESH_STATUSES.filter((status) => status !== "queued"),
      },
      workflowId: null,
    },
    data: {
      workflowId: input.ownerToken,
      finishedAt: null,
    },
  });
  if (orphanedActiveClaim.count) return true;
  const current = await client.knowledgeRefreshRun.findUnique({
    where: { id: input.runId },
    select: { status: true, workflowId: true, startedAt: true },
  });
  if (
    !current ||
    !ACTIVE_KNOWLEDGE_REFRESH_STATUSES.includes(
      current.status as (typeof ACTIVE_KNOWLEDGE_REFRESH_STATUSES)[number],
    )
  ) {
    return false;
  }
  if (current.workflowId === input.ownerToken) return true;
  // Ownership changes only through an explicit release after Workflow
  // cancellation has been confirmed. AgentRun terminal state alone is not a
  // safe fencing signal because a cancellation RPC can fail while the durable
  // workflow continues executing.
  return false;
}

export async function releaseInlineKnowledgeRefreshExecution(input: {
  runId: string;
  ownerToken: string;
}) {
  const released = await prisma.knowledgeRefreshRun.updateMany({
    where: {
      id: input.runId,
      workflowId: input.ownerToken,
      status: { in: [...ACTIVE_KNOWLEDGE_REFRESH_STATUSES] },
    },
    data: {
      status: "queued",
      workflowId: null,
      finishedAt: null,
    },
  });
  return released.count > 0;
}

export async function inventoryKnowledgeRefresh(runId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status === "completed") return { runId, completed: true };
  assertKnowledgeRefreshCanExecute(runId, run.status);
  const targets = parseTargets(run.targetHeads);
  await prisma.knowledgeRefreshRun.update({
    where: { id: runId },
    data: { status: "inventorying", startedAt: run.startedAt ?? new Date() },
  });

  for (const [index, target] of targets.entries()) {
    const existing = await prisma.repositorySnapshot.findUnique({
      where: { sourceId_commitSha: { sourceId: target.sourceId, commitSha: target.commitSha } },
    });
    if (existing?.inventoryComplete) {
      const outdatedAnalyses = await prisma.repositoryFileSnapshot.count({
        where: {
          snapshotId: existing.id,
          disposition: "analyzed",
          analyzerVersion: { not: REPOSITORY_STATIC_ANALYZER_VERSION },
        },
      });
      await prisma.repositorySnapshot.update({
        where: { id: existing.id },
        data: {
          refreshRunId: runId,
          ...(outdatedAnalyses ? { analysisComplete: false, coverageComplete: false } : {}),
        },
      });
      await rebaseSnapshotCapabilityMappings(existing.id);
    } else {
      const inventory = await repositoryKnowledgeSyncService.inventory({
        userId: (await prisma.workItem.findUniqueOrThrow({ where: { id: run.workItemId }, select: { userId: true } })).userId,
        workItemId: run.workItemId,
        target,
      });
      const previousSnapshot = await prisma.repositorySnapshot.findFirst({
        where: {
          sourceId: target.sourceId,
          commitSha: { not: target.commitSha },
          coverageComplete: true,
        },
        include: { files: { select: { path: true, blobSha: true } } },
        orderBy: { resolvedAt: "desc" },
      });
      const previousByPath = new Map(previousSnapshot?.files.map((file) => [file.path, file.blobSha]) ?? []);
      const currentByPath = new Map(inventory.entries.map((entry) => [entry.path, entry.blobSha]));
      const removedPaths = Array.from(previousByPath.keys()).filter((path) => !currentByPath.has(path));
      const addedPaths = inventory.entries.filter((entry) => !previousByPath.has(entry.path)).map((entry) => entry.path);
      const removedByBlob = new Map(removedPaths.flatMap((path) => {
        const blobSha = previousByPath.get(path);
        return blobSha ? [[blobSha, path] as const] : [];
      }));
      const renamed = addedPaths.flatMap((path) => {
        const blobSha = currentByPath.get(path);
        const previousPath = blobSha ? removedByBlob.get(blobSha) : null;
        return previousPath ? [{ from: previousPath, to: path, blobSha }] : [];
      });
      const renamedTargets = new Set(renamed.map((entry) => entry.to));
      const renamedSources = new Set(renamed.map((entry) => entry.from));
      const changeTypeByPath = new Map<string, "unchanged" | "added" | "modified" | "renamed">(
        inventory.entries.map((entry) => {
          if (renamedTargets.has(entry.path)) return [entry.path, "renamed"];
          if (!previousByPath.has(entry.path)) return [entry.path, "added"];
          return [entry.path, previousByPath.get(entry.path) === entry.blobSha ? "unchanged" : "modified"];
        }),
      );
      const delta = {
        baseCommitSha: previousSnapshot?.commitSha ?? null,
        added: addedPaths.filter((path) => !renamedTargets.has(path)),
        modified: inventory.entries.filter((entry) => changeTypeByPath.get(entry.path) === "modified").map((entry) => entry.path),
        removed: removedPaths.filter((path) => !renamedSources.has(path)),
        renamed,
        unchanged: inventory.entries.filter((entry) => changeTypeByPath.get(entry.path) === "unchanged").length,
      };
      const snapshot = await prisma.repositorySnapshot.upsert({
        where: { sourceId_commitSha: { sourceId: target.sourceId, commitSha: target.commitSha } },
        create: {
          workItemId: run.workItemId,
          sourceId: target.sourceId,
          refreshRunId: runId,
          branch: target.branch,
          commitSha: target.commitSha,
          treeSha: target.treeSha,
          committedAt: target.committedAt ? new Date(target.committedAt) : null,
          resolvedAt: new Date(target.resolvedAt),
          inventoryComplete: true,
          manifestHash: inventory.manifestHash,
          warnings: toInputJson({ treeLookups: inventory.treeLookups }),
          delta: toInputJson(delta),
        },
        update: {
          refreshRunId: runId,
          treeSha: target.treeSha,
          resolvedAt: new Date(target.resolvedAt),
          inventoryComplete: true,
          manifestHash: inventory.manifestHash,
          delta: toInputJson(delta),
        },
      });
      await prisma.repositoryFileSnapshot.deleteMany({ where: { snapshotId: snapshot.id } });
      await createFileRows(snapshot.id, inventory.entries, changeTypeByPath);
    }
    await prisma.knowledgeRefreshRun.update({
      where: { id: runId },
      data: { progress: toInputJson({ repositories: targets.length, inventoried: index + 1 }) },
    });
  }
  await prisma.knowledgeRefreshRun.update({ where: { id: runId }, data: { status: "analyzing" } });
  return { runId, completed: false, targets };
}

function rebaseCachedAnalysis(value: unknown, path: string): RepositoryFileAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as RepositoryFileAnalysis;
  if (!Array.isArray(analysis.facts) || !Array.isArray(analysis.subsystemKeys)) return null;
  const inferredSubsystemKeys = inferSubsystemsFromPath(path);
  return {
    ...analysis,
    path,
    subsystemKeys: Array.from(new Set([
      ...analysis.subsystemKeys,
      ...inferredSubsystemKeys,
    ])).slice(0, 16),
    facts: analysis.facts.map((fact) => ({
      ...fact,
      path,
      subsystemKeys: Array.from(new Set([
        ...(fact.subsystemKeys ?? []),
        ...(analysis.analysisMode === "static" || fact.evidenceMode === "static"
          ? inferredSubsystemKeys
          : []),
      ])).slice(0, 16),
    })),
  };
}

async function rebaseSnapshotCapabilityMappings(snapshotId: string) {
  const files = await prisma.repositoryFileSnapshot.findMany({
    where: {
      snapshotId,
      disposition: "analyzed",
      analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
      analysis: { not: Prisma.DbNull },
    },
    select: { id: true, path: true, analysis: true },
  });
  const updates = files.flatMap((file) => {
    const rebased = rebaseCachedAnalysis(file.analysis, file.path);
    if (!rebased || JSON.stringify(rebased) === JSON.stringify(file.analysis)) return [];
    return [prisma.repositoryFileSnapshot.update({
      where: { id: file.id },
      data: { analysis: toInputJson(rebased) },
    })];
  });
  for (let offset = 0; offset < updates.length; offset += 50) {
    await prisma.$transaction(updates.slice(offset, offset + 50));
  }
  return updates.length;
}

export async function analyzeKnowledgeRefreshBatch(input: { runId: string; batchSize?: number }) {
  const startedAt = Date.now();
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: input.runId },
    include: { snapshots: true, workItem: { select: { userId: true } } },
  });
  if (run.status === "completed") {
    return {
      remaining: 0,
      analyzed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  assertKnowledgeRefreshCanExecute(input.runId, run.status);
  const targets = new Map(parseTargets(run.targetHeads).map((target) => [target.sourceId, target]));
  const snapshots = run.snapshots.filter((snapshot) => snapshot.inventoryComplete && !snapshot.analysisComplete);
  const batch = await prisma.repositoryFileSnapshot.findMany({
    where: {
      snapshotId: { in: snapshots.map((snapshot) => snapshot.id) },
      OR: [
        { disposition: "eligible", analysis: { equals: Prisma.DbNull } },
        { disposition: "analyzed", analyzerVersion: { not: REPOSITORY_STATIC_ANALYZER_VERSION } },
      ],
    },
    include: { snapshot: true },
    orderBy: [{ snapshotId: "asc" }, { path: "asc" }],
    take: Math.max(1, Math.min(input.batchSize ?? 16, 128)),
  });

  const cachedCandidates = batch.length
    ? await prisma.repositoryFileSnapshot.findMany({
        where: {
          id: { notIn: batch.map((file) => file.id) },
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          disposition: "analyzed",
          analysis: { not: Prisma.DbNull },
          OR: batch.flatMap((file) => file.blobSha
            ? [{
                path: file.path,
                blobSha: file.blobSha,
                snapshot: { sourceId: file.snapshot.sourceId },
              }]
            : []),
        },
        include: { snapshot: { select: { sourceId: true } } },
        orderBy: { analyzedAt: "desc" },
      })
    : [];
  const cacheByIdentity = selectLatestStaticAnalysisCacheCandidates(cachedCandidates);

  const cached: Array<{
    file: (typeof batch)[number];
    analysis: RepositoryFileAnalysis;
    contentHash: string | null;
  }> = [];
  const pendingFiles: Array<{
    file: (typeof batch)[number];
    target: RepositoryTargetHead;
  }> = [];
  for (const file of batch) {
    const target = targets.get(file.snapshot.sourceId);
    if (!target || !file.blobSha) throw new Error(`The target for ${file.path} is unavailable.`);
    const cachedCandidate = cacheByIdentity.get(
      `${file.snapshot.sourceId}:${file.path}:${file.blobSha}`,
    );
    const cachedAnalysis = rebaseCachedAnalysis(cachedCandidate?.analysis, file.path);
    if (cachedAnalysis) {
      cached.push({
        file,
        analysis: cachedAnalysis,
        contentHash: cachedCandidate?.contentHash ?? null,
      });
    } else {
      pendingFiles.push({ file, target });
    }
  }

  const analyzedAt = new Date();
  // Cache promotion is independently idempotent per snapshot row. Keep the
  // writes bounded and parallel instead of placing dozens of distinct JSON
  // updates in one transaction, which PostgreSQL must execute serially.
  for (let offset = 0; offset < cached.length; offset += 32) {
    await Promise.all(cached.slice(offset, offset + 32).map((entry) =>
      prisma.repositoryFileSnapshot.update({
        where: { id: entry.file.id },
        data: {
          disposition: "analyzed",
          contentHash: entry.contentHash,
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          analysis: toInputJson(entry.analysis),
          analyzedAt,
        },
      })
    ));
  }

  for (
    let offset = 0;
    offset < pendingFiles.length;
    offset += MAX_REPOSITORY_STATIC_ANALYSIS_BATCH_SIZE
  ) {
    const wave = pendingFiles.slice(offset, offset + MAX_REPOSITORY_STATIC_ANALYSIS_BATCH_SIZE);
    const readResults = await Promise.all(wave.map(async ({ file, target }) => {
      try {
        return {
          file,
          target,
          read: await repositoryKnowledgeSyncService.readFile({
            userId: run.workItem.userId,
            workItemId: run.workItemId,
            target,
            entry: {
              path: file.path,
              blobSha: file.blobSha!,
              sizeBytes: file.sizeBytes,
              mode: "100644",
              objectType: "blob",
              disposition: "eligible",
              exclusionReason: null,
            },
          }),
        };
      } catch (error) {
        const exclusionReason = repositoryReadExclusionReason(error);
        if (!exclusionReason) throw error;
        await prisma.repositoryFileSnapshot.update({
          where: { id: file.id },
          data: { disposition: "excluded", exclusionReason },
        });
        return null;
      }
    }));
    const pending = readResults.filter((entry) => entry !== null);
    if (!pending.length) continue;
    const analyses = await analyzeRepositoryFilesHierarchically(pending.map((entry) => ({
      repository: entry.target.repository,
      commitSha: entry.target.commitSha,
      path: entry.file.path,
      content: entry.read.content,
    })));
    const paired = pairRepositoryAnalysesByInputOrder({ pending, analyses });
    await Promise.all(paired.map(({ entry, analysis }) =>
      prisma.repositoryFileSnapshot.update({
        where: { id: entry.file.id },
        data: {
          disposition: "analyzed",
          contentHash: entry.read.contentHash,
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          analysis: toInputJson({ ...analysis, redacted: entry.read.redacted, redactionCategories: entry.read.redactionCategories }),
          analyzedAt: new Date(),
        },
      })
    ));
  }
  const analyzed = batch.length;

  const remaining = await prisma.repositoryFileSnapshot.count({
    where: {
      snapshotId: { in: snapshots.map((snapshot) => snapshot.id) },
      OR: [
        { disposition: "eligible", analysis: { equals: Prisma.DbNull } },
        { disposition: "analyzed", analyzerVersion: { not: REPOSITORY_STATIC_ANALYZER_VERSION } },
      ],
    },
  });
  const analyzedFiles = await prisma.repositoryFileSnapshot.count({
    where: { snapshotId: { in: run.snapshots.map((snapshot) => snapshot.id) }, disposition: "analyzed" },
  });
  await prisma.knowledgeRefreshRun.update({
    where: { id: input.runId },
    data: { progress: toInputJson({ repositories: run.snapshots.length, analyzedFiles, remainingFiles: remaining }) },
  });
  return {
    remaining,
    analyzed,
    cacheHits: cached.length,
    cacheMisses: pendingFiles.length,
    durationMs: Date.now() - startedAt,
  };
}

export function selectLatestStaticAnalysisCacheCandidates<T extends {
  path: string;
  blobSha: string | null;
  snapshot: { sourceId: string };
}>(candidates: readonly T[]) {
  const cacheByIdentity = new Map<string, T>();
  for (const candidate of candidates) {
    const key = `${candidate.snapshot.sourceId}:${candidate.path}:${candidate.blobSha ?? ""}`;
    if (!cacheByIdentity.has(key)) cacheByIdentity.set(key, candidate);
  }
  return cacheByIdentity;
}

export function pairRepositoryAnalysesByInputOrder<T extends {
  file: { path: string };
  target: { repository: string };
}>(input: {
  pending: T[];
  analyses: RepositoryFileAnalysis[];
}) {
  if (input.pending.length !== input.analyses.length) {
    throw new Error("Repository analysis returned a different number of files than requested.");
  }
  return input.pending.map((entry, index) => {
    const analysis = input.analyses[index];
    if (!analysis || analysis.path !== entry.file.path) {
      throw new Error(`Repository analysis omitted or reordered ${entry.target.repository}:${entry.file.path}.`);
    }
    return { entry, analysis };
  });
}

export function repositoryReadExclusionReason(error: unknown) {
  const message = error instanceof Error ? error.message : null;
  if (message === "binary_file") return "binary";
  if (message === "file_too_large") return "oversized";
  return null;
}

export async function analyzeKnowledgeRefreshChunk(input: {
  runId: string;
  batchSize?: number;
  maxBatches?: number;
}) {
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 128, 128));
  const maxBatches = Math.max(1, Math.min(input.maxBatches ?? 8, 16));
  let remaining = 1;
  let analyzed = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let batches = 0;
  const startedAt = Date.now();
  while (remaining > 0 && batches < maxBatches) {
    const result = await analyzeKnowledgeRefreshBatch({ runId: input.runId, batchSize });
    remaining = result.remaining;
    analyzed += result.analyzed;
    cacheHits += result.cacheHits;
    cacheMisses += result.cacheMisses;
    batches += 1;
  }
  return {
    remaining,
    analyzed,
    batches,
    cacheHits,
    cacheMisses,
    durationMs: Date.now() - startedAt,
  };
}

async function repairKnowledgeCoverageGapsLegacy(runId: string) {
  if (resolveWorkbaseLlmProvider() === "mock") return { repaired: 0, remainingGaps: [] as string[] };
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { snapshots: { include: { files: { where: { disposition: "analyzed" }, orderBy: { path: "asc" } } } }, workItem: { select: { userId: true } } },
  });
  const targets = new Map(parseTargets(run.targetHeads).map((target) => [target.sourceId, target]));
  const candidates: Array<{ snapshot: (typeof run.snapshots)[number]; file: (typeof run.snapshots)[number]["files"][number]; analysis: RepositoryFileAnalysis }> = [];
  const remainingGaps = new Set<string>();
  for (const snapshot of run.snapshots) {
    const analyzed = snapshot.files.flatMap((file) => {
      const analysis = rebaseCachedAnalysis(file.analysis, file.path);
      return analysis ? [{ path: file.path, analysis, file }] : [];
    });
    const matrix = buildCoverageMatrix(analyzed);
    const baseOrder = new Map<string, number>(BASE_COVERAGE_TARGETS.map((target, index) => [target.key, index]));
    const orderedAreas = [...matrix].sort((left, right) =>
      (baseOrder.get(left.key) ?? 1_000) - (baseOrder.get(right.key) ?? 1_000) ||
      right.observationCount - left.observationCount,
    );
    for (const area of orderedAreas) {
      if (area.semanticPathCount === 0 || area.unresolvedQuestions.length) {
        remainingGaps.add(area.key);
        const entry = analyzed
          .filter((item) => item.analysis.subsystemKeys.includes(area.key) && item.analysis.analysisMode !== "semantic")
          .filter((item) => !candidates.some((candidate) => candidate.file.id === item.file.id))
          .sort((left, right) => {
            const score = (item: typeof left) =>
              item.analysis.facts.reduce((total, fact) => total + fact.productImportance + fact.implementationBreadth + fact.technicalDifficulty, 0) +
              item.analysis.architectureSignals.length * 4 +
              item.analysis.dependencies.length +
              (/readme|schema|workflow|agent|artifact|chat|retriev|github/i.test(item.path) ? 20 : 0);
            return score(right) - score(left) || left.path.localeCompare(right.path);
          })[0];
        if (entry) candidates.push({ snapshot, file: entry.file, analysis: entry.analysis });
      }
      if (candidates.length >= 8) break;
    }
    if (candidates.length >= 8) break;
  }
  await prisma.knowledgeRefreshRun.update({ where: { id: runId }, data: { status: "semantic_analysis" } });
  const repairResults: Array<{ path: string; repaired: boolean; status: string; error: string | null }> = [];
  for (let offset = 0; offset < candidates.length; offset += 3) {
    const wave = candidates.slice(offset, offset + 3);
    const waveResults = await Promise.all(wave.map(async (candidate) => {
    const target = targets.get(candidate.snapshot.sourceId);
    if (!target || !candidate.file.blobSha) return { path: candidate.file.path, repaired: false, status: "failed", error: "missing_target" };
    try {
      const read = await repositoryKnowledgeSyncService.readFile({
        userId: run.workItem.userId,
        workItemId: run.workItemId,
        target,
        entry: {
          path: candidate.file.path,
          blobSha: candidate.file.blobSha,
          sizeBytes: candidate.file.sizeBytes,
          mode: "100644",
          objectType: "blob",
          disposition: "eligible",
          exclusionReason: null,
        },
      });
      await prisma.repositoryFileSnapshot.update({ where: { id: candidate.file.id }, data: { semanticStatus: "pending" } });
      const semantic = await analyzeRepositoryFile({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        repository: target.repository,
        commitSha: target.commitSha,
        path: candidate.file.path,
        content: read.content,
      });
      const [freshStaticAnalysis] = await analyzeRepositoryFiles([{
        repository: target.repository,
        commitSha: target.commitSha,
        path: candidate.file.path,
        content: read.content,
      }]);
      const semanticStatus = semantic.semanticStatus ?? (semantic.facts.length ? "succeeded" : "degraded");
      await prisma.repositoryFileSnapshot.update({
        where: { id: candidate.file.id },
        data: {
          analysis: toInputJson({ ...(freshStaticAnalysis ?? candidate.analysis), redacted: read.redacted, redactionCategories: read.redactionCategories }),
          semanticStatus,
          semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
          semanticRefreshRunId: run.id,
          semanticAnalysis: toInputJson(semantic),
          semanticDiagnostics: toInputJson(semantic.semanticDiagnostics ?? []),
          semanticAnalyzedAt: new Date(),
          analyzedAt: new Date(),
        },
      });
      return {
        path: candidate.file.path,
        repaired: semanticStatus === "succeeded",
        status: semanticStatus,
        error: semanticStatus === "succeeded" ? null : semantic.unresolvedQuestions.join("; ").slice(0, 300) || "semantic_extraction_degraded",
      };
    } catch (error) {
      await prisma.repositoryFileSnapshot.update({
        where: { id: candidate.file.id },
        data: {
          semanticStatus: "failed",
          semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
          semanticRefreshRunId: run.id,
          semanticDiagnostics: toInputJson({ message: error instanceof Error ? error.message.slice(0, 500) : "unknown_semantic_repair_error" }),
          semanticAnalyzedAt: new Date(),
        },
      }).catch(() => null);
      return { path: candidate.file.path, repaired: false, status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "unknown_semantic_repair_error" };
    }
    }));
    repairResults.push(...waveResults);
  }
  const failures = repairResults.filter((result) => !result.repaired);
  if (failures.length) {
    await prisma.knowledgeRefreshRun.update({
      where: { id: runId },
      data: { warnings: toInputJson({ ...record(run.warnings), semanticRepairFailures: failures }) },
    });
  }
  return {
    repaired: repairResults.filter((result) => result.repaired).length,
    remainingGaps: [...Array.from(remainingGaps), ...failures.map((failure) => `Semantic repair retained static coverage for ${failure.path}: ${failure.error ?? failure.status}.`)],
  };
}

export async function repairKnowledgeCoverageGaps(runId: string) {
  const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
  });
  assertKnowledgeRefreshCanExecute(runId, current.status);
  try {
    const result = await repositorySemanticOrchestratorService.orchestrate(runId);
    const after = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    assertKnowledgeRefreshCanExecute(runId, after.status);
    return result;
  } catch (error) {
    const after = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    assertKnowledgeRefreshCanExecute(runId, after.status);
    const legacy = await repairKnowledgeCoverageGapsLegacy(runId);
    return {
      ...legacy,
      remainingGaps: [
        `Hybrid semantic orchestration degraded: ${error instanceof Error ? error.message.slice(0, 300) : "unknown orchestration failure"}.`,
        ...legacy.remainingGaps,
      ],
    };
  }
}

export async function finalizeKnowledgeCoverage(runId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { snapshots: { include: { files: { orderBy: { path: "asc" } } } } },
  });
  assertKnowledgeRefreshCanExecute(runId, run.status);
  const incompleteFiles = run.snapshots.flatMap((snapshot) =>
    snapshot.files.filter((file) =>
      file.disposition === "eligible" ||
      file.disposition === "unreadable" ||
      (file.disposition === "analyzed" && file.analyzerVersion !== REPOSITORY_STATIC_ANALYZER_VERSION),
    ),
  );
  if (incompleteFiles.length) {
    throw new Error(`Repository analysis is incomplete for ${incompleteFiles.length} eligible file${incompleteFiles.length === 1 ? "" : "s"}.`);
  }
  const coverageByRepository = [];
  const repositories = parseTargets(run.targetHeads).map((target) => target.repository);
  const orchestrationGaps = Array.isArray(record(run.orchestration).remainingGaps)
    ? (record(run.orchestration).remainingGaps as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const semanticWorkers = await prisma.agentRun.findMany({
    where: { knowledgeRefreshRunId: runId, kind: "semantic_worker" },
    select: { id: true, request: true },
  });
  for (const snapshot of run.snapshots) {
    const repository = parseTargets(run.targetHeads).find((target) => target.sourceId === snapshot.sourceId)?.repository ?? snapshot.sourceId;
    const analyzed = snapshot.files.flatMap((file) => {
      const cachedAnalysis = rebaseCachedAnalysis(file.analysis, file.path);
      const staticAnalysis = cachedAnalysis ? { ...cachedAnalysis, analysisMode: "static" as const, tokenUsage: [] } : null;
      const semanticAnalysis = file.semanticRefreshRunId === runId &&
        file.semanticAnalyzerVersion === REPOSITORY_SEMANTIC_ANALYZER_VERSION &&
        file.semanticStatus === "succeeded"
        ? rebaseCachedAnalysis(file.semanticAnalysis, file.path)
        : null;
      const analysis = staticAnalysis && semanticAnalysis
        ? mergeRepositoryFileAnalysis(staticAnalysis, semanticAnalysis)
        : staticAnalysis;
      return analysis ? [{ path: file.path, analysis }] : [];
    });
    const matrix = buildCoverageMatrix(analyzed);
    const requiredAreas = selectRequiredSemanticCoverageAreas(matrix);
    const requiredAreaKeys = new Set(requiredAreas.map((area) => area.key));
    const semanticDegradations = snapshot.files.flatMap((file) =>
      file.semanticRefreshRunId === runId &&
      file.semanticAnalyzerVersion === REPOSITORY_SEMANTIC_ANALYZER_VERSION &&
      (file.semanticStatus === "degraded" || file.semanticStatus === "failed" || file.semanticStatus === "pending")
        ? [{ path: file.path, message: `Semantic analysis ${file.semanticStatus} for ${file.path}.` }]
        : [],
    );
    const scopedOrchestrationGaps = repositoryOrchestrationCoverageGaps({
      repository,
      repositories,
      filePaths: snapshot.files.map((file) => file.path),
      remainingGaps: orchestrationGaps,
    });
    const coverageGaps = Array.from(new Set([...requiredAreas.flatMap((area) => [
      ...(area.semanticPathCount < area.requiredSemanticPathCount
        ? [`${area.label} has ${area.semanticPathCount} of ${area.requiredSemanticPathCount} required successful semantic analyses.`]
        : []),
    ]), ...semanticDegradations.map((entry) => entry.message), ...scopedOrchestrationGaps]));
    const semanticPaths = analyzed.filter((entry) => entry.analysis.analysisMode === "semantic").length;
    const semanticCoverageStatus = requiredAreas.length === 0 && semanticDegradations.length === 0 && scopedOrchestrationGaps.length === 0
      ? "not_required"
      : coverageGaps.length === 0
        ? "complete"
        : semanticPaths > 0
          ? "partial"
          : "failed";
    const coverageStatus = semanticCoverageStatus === "complete" || semanticCoverageStatus === "not_required"
      ? "complete"
      : semanticCoverageStatus === "failed"
        ? "failed"
        : "partial";
    const capabilityCoverageStatus = coverageStatus === "complete"
      ? "verified"
      : coverageStatus === "failed"
        ? "failed"
        : "partial";
    const coverage = {
      repository,
      commitSha: snapshot.commitSha,
      totalPaths: snapshot.files.length,
      analyzedPaths: snapshot.files.filter((file) => file.disposition === "analyzed").length,
      excludedPaths: snapshot.files.filter((file) => file.disposition === "excluded").length,
      semanticPaths,
      coverageStatus,
      semanticCoverageStatus,
      capabilityCoverageStatus,
      dimensions: {
        inventory: "complete",
        staticAnalysis: "complete",
        semanticAnalysis: semanticCoverageStatus,
        capabilityCoverage: capabilityCoverageStatus,
      },
      coverageGaps,
      targets: matrix,
      policyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
    };
    coverageByRepository.push(coverage);
    const ledgerUpserts: Array<() => Promise<unknown>> = [];
    for (const area of matrix) {
      const areaFileIds = new Set(snapshot.files
        .filter((file) => area.paths.includes(file.path))
        .map((file) => file.id));
      const sampledWorkers = semanticWorkers.flatMap((worker) => {
        const request = record(worker.request);
        const capabilityKeys = Array.isArray(request.capabilityKeys)
          ? request.capabilityKeys.filter((key): key is string => typeof key === "string")
          : [];
        const fileSnapshotIds = Array.isArray(request.fileSnapshotIds)
          ? request.fileSnapshotIds.filter((id): id is string => typeof id === "string" && areaFileIds.has(id))
          : [];
        return capabilityKeys.includes(area.key) && fileSnapshotIds.length
          ? [{ workerId: worker.id, fileSnapshotIds }]
          : [];
      });
      const representativeFileIds = Array.from(new Set(sampledWorkers.flatMap((worker) => worker.fileSnapshotIds))).slice(0, 12);
      const priority = repositoryCapabilityPriority({
        capabilityKey: area.key,
        observationCount: area.observationCount,
        requiredForSemanticCoverage: requiredAreaKeys.has(area.key),
      });
      // Model-authored unresolved questions are useful diagnostics, but they
      // are not a trustworthy quality signal. Coverage is blocked only by a
      // structural absence of supported semantic evidence or by an explicit
      // semantic execution failure recorded on a representative file.
      const blockingGaps = semanticDegradations
        .filter((entry) => area.paths.includes(entry.path))
        .map((entry) => entry.message);
      const status = area.status === "not_applicable"
        ? "not_applicable"
        : area.semanticPathCount >= area.requiredSemanticPathCount && area.requiredSemanticPathCount > 0 && !blockingGaps.length
          ? "semantic_verified"
          : area.semanticPathCount > 0
            ? "partial"
            : "static_only";
      const workerRunIds = sampledWorkers.map((worker) => worker.workerId);
      const quotaGaps = area.semanticPathCount < area.requiredSemanticPathCount && area.requiredSemanticPathCount > 0
        ? [`Only ${area.semanticPathCount} of ${area.requiredSemanticPathCount} required representative files produced successful semantic evidence.`]
        : [];
      ledgerUpserts.push(() => prisma.repositoryCapabilityLedger.upsert({
        where: { snapshotId_capabilityKey: { snapshotId: snapshot.id, capabilityKey: area.key } },
        create: {
          workItemId: run.workItemId,
          snapshotId: snapshot.id,
          refreshRunId: run.id,
          capabilityKey: area.key,
          label: area.label,
          status,
          priority,
          representativeFileIds: toInputJson(representativeFileIds),
          staticObservationCount: area.observationCount,
          semanticObservationCount: area.semanticPathCount,
          gaps: toInputJson([
            ...quotaGaps,
            ...blockingGaps,
          ]),
          workerRunIds: toInputJson(workerRunIds),
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          policyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
        },
        update: {
          refreshRunId: run.id,
          label: area.label,
          status,
          priority,
          representativeFileIds: toInputJson(representativeFileIds),
          staticObservationCount: area.observationCount,
          semanticObservationCount: area.semanticPathCount,
          gaps: toInputJson([
            ...quotaGaps,
            ...blockingGaps,
          ]),
          workerRunIds: toInputJson(workerRunIds),
          analyzerVersion: REPOSITORY_STATIC_ANALYZER_VERSION,
          policyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
        },
      }));
    }
    // Capability rows are independent. A small bounded batch removes dozens
    // of network round trips from large repositories without overwhelming the
    // database connection pool.
    for (let offset = 0; offset < ledgerUpserts.length; offset += 8) {
      await Promise.all(ledgerUpserts.slice(offset, offset + 8).map((upsert) => upsert()));
    }
    await prisma.repositorySnapshot.update({
      where: { id: snapshot.id },
      data: {
        analysisComplete: true,
        coverageComplete: coverageStatus === "complete",
        coverage: toInputJson(coverage),
      },
    });
  }
  await prisma.knowledgeRefreshRun.update({
    where: { id: runId },
    data: {
      status: "reconciling",
      qualityStatus: coverageByRepository.some((entry) => entry.coverageStatus !== "complete") ? "degraded" : "verified",
      coverage: toInputJson(coverageByRepository),
      completedHeads: toInputJson(run.targetHeads),
      warnings: toInputJson({
        ...record(run.warnings),
        modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
        semanticOrchestrationGaps: orchestrationGaps,
        ...currentKnowledgeRefreshPolicyMetadata(),
      }),
    },
  });
  return { runId, coverage: coverageByRepository };
}

export async function completeKnowledgeRefresh(
  runId: string,
  result?: {
    appliedFactCount: number;
    appliedHighlightCount: number;
    promotedEvidenceCount: number;
  },
) {
  const beforeCompletion = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    select: { progress: true },
  });
  const finishedAt = new Date();
  const completed = await prisma.knowledgeRefreshRun.updateMany({
    where: { id: runId, status: "reconciling" },
    data: {
      status: "completed",
      finishedAt,
      ...(result
        ? {
            progress: toInputJson({
              ...record(beforeCompletion.progress),
              terminalOutcome: {
                status: result.appliedHighlightCount > 0
                  ? "ready"
                  : "no_safe_candidates",
                appliedFactCount: result.appliedFactCount,
                appliedHighlightCount: result.appliedHighlightCount,
                promotedEvidenceCount: result.promotedEvidenceCount,
                completedAt: finishedAt.toISOString(),
              },
            }),
          }
        : {}),
    },
  });
  const current = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: runId } });
  if (!completed.count && current.status !== "completed") {
    throw new Error(`Repository refresh ${runId} lost its generation fence before completion.`);
  }
  return current;
}

export async function failKnowledgeRefresh(runId: string, error: unknown) {
  await prisma.knowledgeRefreshRun.updateMany({
    where: {
      id: runId,
      status: { in: [...ACTIVE_KNOWLEDGE_REFRESH_STATUSES] },
    },
    data: {
      status: "failed",
      qualityStatus: "failed",
      finishedAt: new Date(),
      error: toInputJson({ message: error instanceof Error ? error.message : "Unknown repository refresh error." }),
    },
  });
  return prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: runId } });
}

export const knowledgeRefreshService = {
  start: startKnowledgeRefresh,
  claimInline: claimInlineKnowledgeRefreshExecution,
  releaseInline: releaseInlineKnowledgeRefreshExecution,
  inventory: inventoryKnowledgeRefresh,
  analyzeBatch: analyzeKnowledgeRefreshBatch,
  analyzeChunk: analyzeKnowledgeRefreshChunk,
  repairCoverage: repairKnowledgeCoverageGaps,
  finalizeCoverage: finalizeKnowledgeCoverage,
  complete: completeKnowledgeRefresh,
  fail: failKnowledgeRefresh,
};
