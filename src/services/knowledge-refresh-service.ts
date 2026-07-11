import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import { resolveBedrockConfig } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  analyzeRepositoryFiles,
  buildCoverageMatrix,
  REPOSITORY_COVERAGE_POLICY_VERSION,
  type RepositoryFileAnalysis,
} from "@/src/services/repository-coverage-service";
import {
  REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
  repositoryKnowledgeSyncService,
  type RepositoryInventoryEntry,
  type RepositoryTargetHead,
} from "@/src/services/repository-knowledge-sync-service";

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

function parseTargets(value: unknown): RepositoryTargetHead[] {
  return z.array(targetHeadSchema).parse(value);
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
  trigger: "repository_attach" | "scheduled" | "manual" | "chat_freshness" | "backfill";
  idempotencyKey?: string;
}) {
  const workItem = await prisma.workItem.findFirst({
    where: { id: input.workItemId, userId: input.userId },
    select: { id: true },
  });
  if (!workItem) throw new Error("The project is not authorized for this user.");
  const targets = await repositoryKnowledgeSyncService.resolveTargetHeads(input);
  if (!targets.length) throw new Error("No attached GitHub repository is available for a current knowledge refresh.");
  const latestCompleted = await prisma.knowledgeRefreshRun.findFirst({
    where: { workItemId: input.workItemId, status: "completed" },
    orderBy: { finishedAt: "desc" },
  });
  const completedTargets = latestCompleted?.completedHeads && Array.isArray(latestCompleted.completedHeads)
    ? parseTargets(latestCompleted.completedHeads)
    : [];
  const completedWarnings = latestCompleted?.warnings && typeof latestCompleted.warnings === "object" && !Array.isArray(latestCompleted.warnings)
    ? latestCompleted.warnings as Record<string, unknown>
    : null;
  if (
    completedWarnings?.analyzerVersion === REPOSITORY_KNOWLEDGE_ANALYZER_VERSION &&
    completedWarnings?.synthesisPolicyVersion === "repository-synthesis-v6" &&
    completedTargets.length === targets.length &&
    targets.every((target) => completedTargets.some((completed) => completed.sourceId === target.sourceId && completed.commitSha === target.commitSha))
  ) {
    return { runId: latestCompleted!.id, status: latestCompleted!.status, targets };
  }
  const headsHash = hash(targets.map((target) => `${target.sourceId}:${target.commitSha}`).join("|"));
  const idempotencyKey = input.idempotencyKey ?? `${input.trigger}:${headsHash}`;
  const run = await prisma.knowledgeRefreshRun.upsert({
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
  return { runId: run.id, status: run.status, targets };
}

export async function inventoryKnowledgeRefresh(runId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status === "completed") return { runId, completed: true };
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
          analyzerVersion: { not: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION },
        },
      });
      await prisma.repositorySnapshot.update({
        where: { id: existing.id },
        data: {
          refreshRunId: runId,
          ...(outdatedAnalyses ? { analysisComplete: false, coverageComplete: false } : {}),
        },
      });
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
  return { ...analysis, path, facts: analysis.facts.map((fact) => ({ ...fact, path })) };
}

export async function analyzeKnowledgeRefreshBatch(input: { runId: string; batchSize?: number }) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: input.runId },
    include: { snapshots: true, workItem: { select: { userId: true } } },
  });
  if (run.status === "completed") return { remaining: 0, analyzed: 0 };
  const targets = new Map(parseTargets(run.targetHeads).map((target) => [target.sourceId, target]));
  const snapshots = run.snapshots.filter((snapshot) => snapshot.inventoryComplete && !snapshot.analysisComplete);
  const batch = await prisma.repositoryFileSnapshot.findMany({
    where: {
      snapshotId: { in: snapshots.map((snapshot) => snapshot.id) },
      OR: [
        { disposition: "eligible", analysis: { equals: Prisma.DbNull } },
        { disposition: "analyzed", analyzerVersion: { not: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION } },
      ],
    },
    include: { snapshot: true },
    orderBy: [{ snapshotId: "asc" }, { path: "asc" }],
    take: Math.max(1, Math.min(input.batchSize ?? 4, 8)),
  });

  const prepared = await Promise.all(batch.map(async (file) => {
    const target = targets.get(file.snapshot.sourceId);
    if (!target || !file.blobSha) throw new Error(`The target for ${file.path} is unavailable.`);
    const cached = await prisma.repositoryFileSnapshot.findFirst({
      where: {
        id: { not: file.id },
        path: file.path,
        blobSha: file.blobSha,
        analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
        disposition: "analyzed",
        analysis: { not: Prisma.DbNull },
        snapshot: { sourceId: file.snapshot.sourceId },
      },
      orderBy: { analyzedAt: "desc" },
    });
    const cachedAnalysis = rebaseCachedAnalysis(cached?.analysis, file.path);
    if (cachedAnalysis) {
      await prisma.repositoryFileSnapshot.update({
        where: { id: file.id },
        data: {
          disposition: "analyzed",
          contentHash: cached?.contentHash,
          analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
          analysis: toInputJson(cachedAnalysis),
          analyzedAt: new Date(),
        },
      });
      return { kind: "cached" as const };
    }

    const read = await repositoryKnowledgeSyncService.readFile({
      userId: run.workItem.userId,
      workItemId: run.workItemId,
      target,
      entry: {
        path: file.path,
        blobSha: file.blobSha,
        sizeBytes: file.sizeBytes,
        mode: "100644",
        objectType: "blob",
        disposition: "eligible",
        exclusionReason: null,
      },
    });
    return { kind: "pending" as const, file, target, read };
  }));
  const pending = prepared.filter((entry): entry is Extract<(typeof prepared)[number], { kind: "pending" }> => entry.kind === "pending");
  if (pending.length) {
    const analyses = await analyzeRepositoryFiles(pending.map((entry) => ({
      repository: entry.target.repository,
      commitSha: entry.target.commitSha,
      path: entry.file.path,
      content: entry.read.content,
    })));
    const analysisByPath = new Map(analyses.map((analysis) => [analysis.path, analysis]));
    await Promise.all(pending.map(async (entry) => {
      const analysis = analysisByPath.get(entry.file.path);
      if (!analysis) throw new Error(`Repository analysis omitted ${entry.file.path}.`);
      await prisma.repositoryFileSnapshot.update({
        where: { id: entry.file.id },
        data: {
          disposition: "analyzed",
          contentHash: entry.read.contentHash,
          analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
          analysis: toInputJson({ ...analysis, redacted: entry.read.redacted, redactionCategories: entry.read.redactionCategories }),
          analyzedAt: new Date(),
        },
      });
    }));
  }
  const analyzed = prepared.length;

  const remaining = await prisma.repositoryFileSnapshot.count({
    where: {
      snapshotId: { in: snapshots.map((snapshot) => snapshot.id) },
      OR: [
        { disposition: "eligible", analysis: { equals: Prisma.DbNull } },
        { disposition: "analyzed", analyzerVersion: { not: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION } },
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
  return { remaining, analyzed };
}

export async function finalizeKnowledgeCoverage(runId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { snapshots: { include: { files: { orderBy: { path: "asc" } } } } },
  });
  const incompleteFiles = run.snapshots.flatMap((snapshot) =>
    snapshot.files.filter((file) =>
      file.disposition === "eligible" ||
      file.disposition === "unreadable" ||
      (file.disposition === "analyzed" && file.analyzerVersion !== REPOSITORY_KNOWLEDGE_ANALYZER_VERSION),
    ),
  );
  if (incompleteFiles.length) {
    throw new Error(`Repository analysis is incomplete for ${incompleteFiles.length} eligible file${incompleteFiles.length === 1 ? "" : "s"}.`);
  }
  const coverageByRepository = [];
  for (const snapshot of run.snapshots) {
    const analyzed = snapshot.files.flatMap((file) => {
      const analysis = rebaseCachedAnalysis(file.analysis, file.path);
      return analysis ? [{ path: file.path, analysis }] : [];
    });
    const matrix = buildCoverageMatrix(analyzed);
    const coverage = {
      repository: parseTargets(run.targetHeads).find((target) => target.sourceId === snapshot.sourceId)?.repository ?? snapshot.sourceId,
      commitSha: snapshot.commitSha,
      totalPaths: snapshot.files.length,
      analyzedPaths: snapshot.files.filter((file) => file.disposition === "analyzed").length,
      excludedPaths: snapshot.files.filter((file) => file.disposition === "excluded").length,
      targets: matrix,
      policyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
    };
    coverageByRepository.push(coverage);
    await prisma.repositorySnapshot.update({
      where: { id: snapshot.id },
      data: {
        analysisComplete: true,
        coverageComplete: true,
        coverage: toInputJson(coverage),
      },
    });
  }
  await prisma.knowledgeRefreshRun.update({
    where: { id: runId },
    data: {
      status: "reconciling",
      coverage: toInputJson(coverageByRepository),
      completedHeads: toInputJson(run.targetHeads),
      warnings: toInputJson({
        modelId: resolveBedrockConfig().modelId,
        analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
        synthesisPolicyVersion: "repository-synthesis-v6",
      }),
    },
  });
  return { runId, coverage: coverageByRepository };
}

export async function completeKnowledgeRefresh(runId: string) {
  return prisma.knowledgeRefreshRun.update({
    where: { id: runId },
    data: { status: "completed", finishedAt: new Date() },
  });
}

export async function failKnowledgeRefresh(runId: string, error: unknown) {
  return prisma.knowledgeRefreshRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      finishedAt: new Date(),
      error: toInputJson({ message: error instanceof Error ? error.message : "Unknown repository refresh error." }),
    },
  });
}

export const knowledgeRefreshService = {
  start: startKnowledgeRefresh,
  inventory: inventoryKnowledgeRefresh,
  analyzeBatch: analyzeKnowledgeRefreshBatch,
  finalizeCoverage: finalizeKnowledgeCoverage,
  complete: completeKnowledgeRefresh,
  fail: failKnowledgeRefresh,
};
