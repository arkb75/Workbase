import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import { resolveBedrockConfig, resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  analyzeRepositoryFilesHierarchically,
  analyzeRepositoryFiles,
  analyzeRepositoryFile,
  BASE_COVERAGE_TARGETS,
  buildCoverageMatrix,
  mergeRepositoryFileAnalysis,
  REPOSITORY_COVERAGE_POLICY_VERSION,
  type RepositoryFileAnalysis,
} from "@/src/services/repository-coverage-service";
import {
  REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
  repositoryKnowledgeSyncService,
  type RepositoryInventoryEntry,
  type RepositoryTargetHead,
} from "@/src/services/repository-knowledge-sync-service";
import { repositorySemanticOrchestratorService } from "@/src/services/repository-semantic-orchestrator-service";

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

function blockingSemanticGaps(questions: string[]) {
  return questions.filter((question) =>
    /(?:failed|could not|insufficient|missing decisive|no supported|unreadable|coverage blocker)/i.test(question),
  );
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
  const forceRevalidation = input.trigger === "backfill" && input.idempotencyKey?.startsWith("knowledge-edit:");
  if (
    !forceRevalidation &&
    completedWarnings?.analyzerVersion === REPOSITORY_KNOWLEDGE_ANALYZER_VERSION &&
    completedWarnings?.synthesisPolicyVersion === "repository-synthesis-v15" &&
    latestCompleted?.qualityStatus === "verified" &&
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
    const analyses = await analyzeRepositoryFilesHierarchically(pending.map((entry) => ({
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
          semanticAnalyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
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
          semanticAnalyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
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
  try {
    return await repositorySemanticOrchestratorService.orchestrate(runId);
  } catch (error) {
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
  const semanticWorkers = await prisma.agentRun.findMany({
    where: { knowledgeRefreshRunId: runId, kind: "semantic_worker" },
    select: { id: true, request: true },
  });
  for (const snapshot of run.snapshots) {
    const analyzed = snapshot.files.flatMap((file) => {
      const cachedAnalysis = rebaseCachedAnalysis(file.analysis, file.path);
      const staticAnalysis = cachedAnalysis ? { ...cachedAnalysis, analysisMode: "static" as const, tokenUsage: [] } : null;
      const semanticAnalysis = file.semanticRefreshRunId === runId &&
        file.semanticAnalyzerVersion === REPOSITORY_KNOWLEDGE_ANALYZER_VERSION &&
        file.semanticStatus === "succeeded"
        ? rebaseCachedAnalysis(file.semanticAnalysis, file.path)
        : null;
      const analysis = staticAnalysis && semanticAnalysis
        ? mergeRepositoryFileAnalysis(staticAnalysis, semanticAnalysis)
        : staticAnalysis;
      return analysis ? [{ path: file.path, analysis }] : [];
    });
    const matrix = buildCoverageMatrix(analyzed);
    const baseKeys = new Set<string>(BASE_COVERAGE_TARGETS.map((target) => target.key));
    const requiredAreas = matrix.filter((area) => baseKeys.has(area.key) && area.staticPathCount > 0);
    const semanticDegradations = snapshot.files.flatMap((file) =>
      file.semanticRefreshRunId === runId &&
      file.semanticAnalyzerVersion === REPOSITORY_KNOWLEDGE_ANALYZER_VERSION &&
      (file.semanticStatus === "degraded" || file.semanticStatus === "failed" || file.semanticStatus === "pending")
        ? [`Semantic analysis ${file.semanticStatus} for ${file.path}.`]
        : [],
    );
    const coverageGaps = Array.from(new Set([...requiredAreas.flatMap((area) => [
      ...(area.semanticPathCount === 0 ? [`${area.label} has static coverage but no successful semantic analysis.`] : []),
      ...blockingSemanticGaps(area.unresolvedQuestions).map((question) => `${area.label}: ${question}`),
    ]), ...semanticDegradations]));
    const semanticPaths = analyzed.filter((entry) => entry.analysis.analysisMode === "semantic").length;
    const semanticCoverageStatus = requiredAreas.length === 0 && semanticDegradations.length === 0
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
      repository: parseTargets(run.targetHeads).find((target) => target.sourceId === snapshot.sourceId)?.repository ?? snapshot.sourceId,
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
    for (const area of matrix) {
      const representativeFileIds = snapshot.files
        .filter((file) => area.paths.includes(file.path))
        .slice(0, 12)
        .map((file) => file.id);
      const priority = area.key === "product_surface" || area.key.includes("lifecycle") || area.observationCount >= 20
        ? 5
        : area.observationCount >= 8
          ? 3
          : 1;
      const blockingGaps = blockingSemanticGaps(area.unresolvedQuestions);
      const status = area.status === "not_applicable"
        ? "not_applicable"
        : area.semanticPathCount > 0 && !blockingGaps.length
          ? "semantic_verified"
          : area.semanticPathCount > 0
            ? "partial"
            : "static_only";
      const workerRunIds = semanticWorkers.flatMap((worker) => {
        const request = record(worker.request);
        return Array.isArray(request?.capabilityKeys) && request.capabilityKeys.includes(area.key) ? [worker.id] : [];
      });
      await prisma.repositoryCapabilityLedger.upsert({
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
            ...(area.semanticPathCount === 0 && area.staticPathCount > 0 ? ["No successful semantic analysis."] : []),
            ...blockingGaps,
          ]),
          workerRunIds: toInputJson(workerRunIds),
          analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
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
            ...(area.semanticPathCount === 0 && area.staticPathCount > 0 ? ["No successful semantic analysis."] : []),
            ...blockingGaps,
          ]),
          workerRunIds: toInputJson(workerRunIds),
          analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
          policyVersion: REPOSITORY_COVERAGE_POLICY_VERSION,
        },
      });
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
        modelId: resolveBedrockConfig().modelId,
        analyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
        synthesisPolicyVersion: "repository-synthesis-v15",
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
      qualityStatus: "failed",
      finishedAt: new Date(),
      error: toInputJson({ message: error instanceof Error ? error.message : "Unknown repository refresh error." }),
    },
  });
}

export const knowledgeRefreshService = {
  start: startKnowledgeRefresh,
  inventory: inventoryKnowledgeRefresh,
  analyzeBatch: analyzeKnowledgeRefreshBatch,
  repairCoverage: repairKnowledgeCoverageGaps,
  finalizeCoverage: finalizeKnowledgeCoverage,
  complete: completeKnowledgeRefresh,
  fail: failKnowledgeRefresh,
};
