import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import type { HighlightTagValue } from "@/src/lib/highlight-taxonomy";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  recordAutoResolvedKnowledgeChanges,
  recordAutoResolvedKnowledgeChangesInTransaction,
  upsertReviewableKnowledgeChange,
  upsertReviewableKnowledgeChangeInTransaction,
  type AutoResolvedKnowledgeChangeInput,
} from "@/src/services/knowledge-change-service";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  buildProjectFactEmbeddingText,
  upsertProjectFactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";
import {
  isRepositoryExecutableSourcePath,
} from "@/src/services/repository-coverage-service";
import {
  materializeSynthesisCitations,
  synthesisNotebookReferenceKey,
  synthesizeRepositoryKnowledge,
  type SynthesizedKnowledge,
  type SynthesisNotebookEntry,
} from "@/src/services/repository-knowledge-synthesis-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";

export const KNOWLEDGE_LIFECYCLE_POLICY_VERSION = "knowledge-lifecycle-v3";
export const STRONG_KNOWLEDGE_IDENTITY_THRESHOLD = 0.72;
const KNOWLEDGE_EMBEDDING_CONCURRENCY = 4;

type KnowledgeEmbeddingTarget = {
  entityKind: "project_fact" | "highlight";
  entityId: string;
};

type KnowledgeEmbeddingTask = KnowledgeEmbeddingTarget & {
  execute: () => Promise<unknown>;
};

export type KnowledgeEmbeddingTelemetry = {
  attempted: number;
  attempts: number;
  retried: number;
  recovered: number;
  failed: number;
  failedTargets: KnowledgeEmbeddingTarget[];
};

/**
 * Repository reconciliation must serialize versioned knowledge mutations, but
 * embedding requests are independent and do not participate in that write
 * fence. Run them in small waves after the durable records exist so a cold
 * refresh does not pay one network round trip per Fact and Highlight.
 *
 * Embeddings are a ranking optimization; lexical retrieval remains available.
 * A failed vector write therefore stays observable in the returned telemetry
 * without rolling back already-reconciled, citation-valid project memory.
 */
export async function runBoundedKnowledgeEmbeddingTasks(
  tasks: readonly KnowledgeEmbeddingTask[],
  concurrency = KNOWLEDGE_EMBEDDING_CONCURRENCY,
): Promise<KnowledgeEmbeddingTelemetry> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Knowledge embedding concurrency must be a positive integer.");
  }
  const runPass = async (passTasks: readonly KnowledgeEmbeddingTask[]) => {
    const failedTasks: KnowledgeEmbeddingTask[] = [];
    for (let offset = 0; offset < passTasks.length; offset += concurrency) {
      const wave = passTasks.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(
        wave.map((task) => task.execute()),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected" && wave[index]) {
          failedTasks.push(wave[index]!);
        }
      });
    }
    return failedTasks;
  };
  const firstFailures = await runPass(tasks);
  // One bounded retry absorbs transient provider/network failures without
  // rolling back citation-valid memory or forcing an entire repository refresh.
  // Persistent failures remain explicit targets for a later cheap backfill.
  const finalFailures = firstFailures.length
    ? await runPass(firstFailures)
    : [];
  return {
    attempted: tasks.length,
    attempts: tasks.length + firstFailures.length,
    retried: firstFailures.length,
    recovered: firstFailures.length - finalFailures.length,
    failed: finalFailures.length,
    failedTargets: finalFailures.map(({ entityKind, entityId }) => ({
      entityKind,
      entityId,
    })),
  };
}

type KnowledgeRefreshFenceClient = Pick<
  Prisma.TransactionClient,
  "knowledgeRefreshRun" | "$queryRaw"
>;

export async function lockKnowledgeRefreshWorkItem(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  workItemId: string,
) {
  // Generation starts and generation-owned mutations share this transaction
  // lock. Whichever side acquires it first commits before the other can decide
  // whether the refresh is still current, preventing an older generation from
  // legally serializing a write after a newer run has begun.
  await lockKnowledgeWorkItemMutation(client, workItemId);
}

function targetSignature(targets: Array<Pick<RepositoryTargetHead, "sourceId" | "commitSha">>) {
  return targets
    .map((target) => `${target.sourceId}:${target.commitSha}`)
    .sort()
    .join("|");
}

function latestResolvedAt(targets: Array<Pick<RepositoryTargetHead, "resolvedAt">>) {
  return targets.reduce((latest, target) => {
    const resolvedAt = Date.parse(target.resolvedAt);
    return Number.isFinite(resolvedAt) ? Math.max(latest, resolvedAt) : latest;
  }, Number.NEGATIVE_INFINITY);
}

export function isNewerKnowledgeRefreshGeneration(input: {
  currentTargets: Array<Pick<RepositoryTargetHead, "sourceId" | "commitSha" | "resolvedAt">>;
  candidateTargets: Array<Pick<RepositoryTargetHead, "sourceId" | "commitSha" | "resolvedAt">>;
  currentCreatedAt: Date;
  candidateCreatedAt: Date;
}) {
  if (targetSignature(input.currentTargets) === targetSignature(input.candidateTargets)) {
    return false;
  }
  const currentResolvedAt = latestResolvedAt(input.currentTargets);
  const candidateResolvedAt = latestResolvedAt(input.candidateTargets);
  if (candidateResolvedAt !== currentResolvedAt) {
    return candidateResolvedAt > currentResolvedAt;
  }
  return input.candidateCreatedAt.getTime() > input.currentCreatedAt.getTime();
}

function repositoryTargets(value: unknown): RepositoryTargetHead[] {
  if (!Array.isArray(value)) return [];
  return value.filter((target): target is RepositoryTargetHead => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const record = target as Record<string, unknown>;
    return typeof record.sourceId === "string" &&
      typeof record.commitSha === "string" &&
      typeof record.resolvedAt === "string";
  });
}

export class KnowledgeRefreshGenerationSupersededError extends Error {
  constructor(runId: string, newerRunId?: string) {
    super(
      newerRunId
        ? `Repository refresh ${runId} was superseded by newer refresh ${newerRunId}.`
        : `Repository refresh ${runId} no longer owns the current knowledge generation.`,
    );
    this.name = "KnowledgeRefreshGenerationSupersededError";
  }
}

export async function assertKnowledgeRefreshGenerationCurrent(
  runId: string,
  client: KnowledgeRefreshFenceClient = prisma as unknown as KnowledgeRefreshFenceClient,
) {
  const current = await client.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      workItemId: true,
      status: true,
      targetHeads: true,
      createdAt: true,
    },
  });
  if (current.status !== "reconciling") {
    throw new KnowledgeRefreshGenerationSupersededError(runId);
  }
  const currentTargets = repositoryTargets(current.targetHeads);
  const candidates = await client.knowledgeRefreshRun.findMany({
    where: {
      workItemId: current.workItemId,
      id: { not: current.id },
      status: { not: "cancelled" },
      createdAt: { gte: current.createdAt },
    },
    select: {
      id: true,
      targetHeads: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  const superseding = candidates.find((candidate) =>
    isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: repositoryTargets(candidate.targetHeads),
      currentCreatedAt: current.createdAt,
      candidateCreatedAt: candidate.createdAt,
    })
  );
  if (superseding) {
    throw new KnowledgeRefreshGenerationSupersededError(runId, superseding.id);
  }
  return current;
}

export async function withKnowledgeRefreshGenerationFence<T>(
  runId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
) {
  const maximumAttempts = 5;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const generation = await tx.knowledgeRefreshRun.findUniqueOrThrow({
          where: { id: runId },
          select: { workItemId: true },
        });
        await lockKnowledgeRefreshWorkItem(tx, generation.workItemId);
        await assertKnowledgeRefreshGenerationCurrent(runId, tx);
        return operation(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: options.timeoutMs ?? 15_000,
      });
    } catch (error) {
      if (
        isRetryableKnowledgeRefreshTransactionError(error) &&
        attempt < maximumAttempts - 1
      ) {
        const baseDelayMs = Math.min(500, 25 * (2 ** attempt));
        const jitterMs = Math.floor(Math.random() * Math.max(1, baseDelayMs / 2));
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error("The repository knowledge generation transaction could not be completed.");
}

export function isRetryableKnowledgeRefreshTransactionError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === "P2034") return true;
  const message = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);
  return message.includes("TransactionWriteConflict");
}

export function allowsCanonicalKnowledgeReplacement(qualityStatus: unknown) {
  return qualityStatus === "verified";
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function knowledgeEmbeddingTargets(value: unknown): KnowledgeEmbeddingTarget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const record = objectRecord(entry);
    const entityKind = record.entityKind;
    const entityId = record.entityId;
    if (
      (entityKind !== "project_fact" && entityKind !== "highlight") ||
      typeof entityId !== "string"
    ) {
      return [];
    }
    const key = `${entityKind}:${entityId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ entityKind, entityId }];
  });
}

export function knowledgeRefreshStateForEmbeddingTelemetry(input: {
  warnings: unknown;
  qualityStatus: "pending" | "verified" | "degraded" | "failed";
  telemetry: KnowledgeEmbeddingTelemetry;
  now?: Date;
}) {
  const warnings = objectRecord(input.warnings);
  const recordedBaseQuality = warnings.embeddingBaseQuality;
  const baseQuality =
    recordedBaseQuality === "pending" ||
      recordedBaseQuality === "verified" ||
      recordedBaseQuality === "degraded" ||
      recordedBaseQuality === "failed"
      ? recordedBaseQuality
      : input.qualityStatus;
  const hasFailures =
    input.telemetry.failed > 0 ||
    input.telemetry.failedTargets.length > 0;
  return {
    qualityStatus: hasFailures ? "degraded" as const : baseQuality,
    warnings: {
      ...warnings,
      embeddingBaseQuality: baseQuality,
      embeddingTelemetry: {
        ...input.telemetry,
        updatedAt: (input.now ?? new Date()).toISOString(),
      },
    },
  };
}

export function applySynthesisCoverageGapsToRefreshState(input: {
  coverage: unknown;
  warnings: unknown;
  coverageGaps: string[];
}) {
  const coverageGaps = Array.from(new Set(input.coverageGaps));
  const coverage = Array.isArray(input.coverage)
    ? input.coverage.map((entry) => {
        const current = objectRecord(entry);
        const repository = typeof current.repository === "string" ? current.repository : null;
        const repositoryGaps = repository
          ? coverageGaps.filter((gap) => gap.startsWith(`Repository ${repository} `))
          : [];
        if (!repositoryGaps.length) return current;
        return {
          ...current,
          coverageStatus: "partial",
          capabilityCoverageStatus: "partial",
          coverageGaps: Array.from(new Set([
            ...stringArray(current.coverageGaps),
            ...repositoryGaps,
          ])),
        };
      })
    : [];
  const warnings = objectRecord(input.warnings);
  return {
    coverage,
    warnings: {
      ...warnings,
      synthesisCoverageGaps: Array.from(new Set([
        ...stringArray(warnings.synthesisCoverageGaps),
        ...coverageGaps,
      ])),
    },
  };
}

async function persistSynthesisCoverageGaps(
  runId: string,
  synthesis: SynthesizedKnowledge[],
) {
  const gapsBySubsystem = new Map<string, string[]>();
  for (const subsystem of synthesis) {
    if (!subsystem.coverageGaps.length) continue;
    gapsBySubsystem.set(subsystem.subsystemKey, Array.from(new Set([
      ...(gapsBySubsystem.get(subsystem.subsystemKey) ?? []),
      ...subsystem.coverageGaps,
    ])));
  }
  if (!gapsBySubsystem.size) return [];
  const allGaps = Array.from(new Set(Array.from(gapsBySubsystem.values()).flat()));
  await withKnowledgeRefreshGenerationFence(runId, async (tx) => {
    const [run, ledgers] = await Promise.all([
      tx.knowledgeRefreshRun.findUniqueOrThrow({
        where: { id: runId },
        select: { coverage: true, warnings: true },
      }),
      tx.repositoryCapabilityLedger.findMany({
        where: {
          refreshRunId: runId,
          capabilityKey: { in: Array.from(gapsBySubsystem.keys()) },
        },
        select: { id: true, capabilityKey: true, gaps: true },
      }),
    ]);
    for (const ledger of ledgers) {
      const subsystemGaps = gapsBySubsystem.get(ledger.capabilityKey) ?? [];
      await tx.repositoryCapabilityLedger.update({
        where: { id: ledger.id },
        data: {
          status: "partial",
          gaps: toInputJson(Array.from(new Set([
            ...stringArray(ledger.gaps),
            ...subsystemGaps,
          ]))),
        },
      });
    }
    const state = applySynthesisCoverageGapsToRefreshState({
      coverage: run.coverage,
      warnings: run.warnings,
      coverageGaps: allGaps,
    });
    await tx.knowledgeRefreshRun.update({
      where: { id: runId },
      data: {
        qualityStatus: "degraded",
        coverage: toInputJson(state.coverage),
        warnings: toInputJson(state.warnings),
      },
    });
  });
  return allGaps;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type SynthesizedCandidateSource = Pick<SynthesisNotebookEntry, "path" | "statement"> &
  Partial<Pick<
    SynthesisNotebookEntry,
    "confidence" | "evidenceMode" | "semanticStatus" | "sensitivityFlag"
  >>;

type SynthesizedCandidate = {
  sensitivityFlag: boolean;
  confidence: string;
  statement?: string;
  text?: string;
  summary?: string;
};

export function shouldQuarantineSynthesizedCandidate(
  candidate: SynthesizedCandidate,
  sources: SynthesizedCandidateSource[] = [],
) {
  if (candidate.sensitivityFlag || candidate.confidence === "low") return true;
  if (sources.some((source) => source.semanticStatus === "degraded")) return true;
  const claim = normalizeWhitespace([
    candidate.statement ?? "",
    candidate.text ?? "",
    candidate.summary ?? "",
  ].join(" "));
  // These phrases imply guarantees that ordinary source code or prose cannot
  // establish by themselves. They require a narrower claim rather than silent
  // auto-approval.
  if (/\b(?:tamper[- ]evident|production[- ]grade|always produces?|guarantees?)\b/i.test(claim)) return true;
  const modalTerms = [
    ...claim.matchAll(/\b(?:mandatory|always|never|exclusively|every|all)\b/gi),
    // Product descriptors such as "invite-only" and "read-only" are not
    // standalone universal qualifiers. Treating their suffix as an absolute
    // would quarantine an otherwise evidence-backed capability statement.
    ...claim.matchAll(/(?<![-\u2010-\u2015])\bonly\b/gi),
  ].map((match) => match[0]!.toLowerCase());
  if (!modalTerms.length) return false;
  // An unrelated executable file is not evidence for an absolute qualifier.
  // At least one executable exact-line observation must itself state every
  // qualifier used by the synthesized claim.
  const hasClauseLevelCorroboration = sources.some((source) =>
    isRepositoryExecutableSourcePath(source.path) &&
    modalTerms.every((term) => normalizeWhitespace(source.statement).toLowerCase().includes(term))
  );
  return !hasClauseLevelCorroboration;
}

export function isSynthesizedCandidateUnsafe(input: {
  approvalEligible: boolean;
  candidate: SynthesizedCandidate;
  sources?: SynthesizedCandidateSource[];
}) {
  return !input.approvalEligible ||
    shouldQuarantineSynthesizedCandidate(input.candidate, input.sources);
}

export function repositoryHighlightPublicDisposition(unsafe: boolean) {
  return {
    eligible: false,
    correctedText: null,
    reasons: [unsafe
      ? "The Highlight failed the automatic safety gate."
      : "Repository evidence verifies implementation, but public use requires reviewed ownership context."],
    claimChecks: [],
    tokenUsage: null,
  };
}

function tokens(value: string) {
  return new Set(normalizeWhitespace(value.toLowerCase()).split(/[^a-z0-9_./-]+/).filter((token) => token.length > 2));
}

export function knowledgeSimilarity(left: string, right: string) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function evidenceIdsForIndexes(input: {
  subsystem: SynthesizedKnowledge;
  citationIndexes: number[];
  promotedIdByReference: Map<string, string>;
}) {
  return Array.from(new Set(input.citationIndexes.flatMap((index) => {
    const notebook = input.subsystem.notebook[index - 1];
    if (!notebook) return [];
    const evidenceId = input.promotedIdByReference.get(synthesisNotebookReferenceKey(notebook));
    return evidenceId ? [evidenceId] : [];
  })));
}

function citationsForIndexes(input: {
  subsystem: SynthesizedKnowledge;
  citationIndexes: number[];
  materialized: Map<string, { label: string; excerpt: string; commitSha?: string }>;
}) {
  return input.citationIndexes.flatMap((index) => {
    const notebook = input.subsystem.notebook[index - 1];
    if (!notebook) return [];
    const citation = input.materialized.get(synthesisNotebookReferenceKey(notebook));
    return citation ? [citation] : [];
  });
}

async function recordChange(input: {
  workItemId: string;
  refreshRunId?: string;
  entityKind: "evidence" | "highlight" | "project_fact" | "artifact";
  action: "created" | "updated" | "revalidated" | "retired" | "quarantined";
  entityId: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  reason: string;
  provenance?: unknown;
  downstreamImpact?: unknown;
  suffix: string;
}, client?: Prisma.TransactionClient) {
  const idempotencyKey = `${input.refreshRunId ?? "direct"}:${input.entityKind}:${input.action}:${input.suffix}`;
  const change = {
    ...input,
    refreshRunId: input.refreshRunId ?? null,
    policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
    modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
    idempotencyKey,
  };
  return client
    ? upsertReviewableKnowledgeChangeInTransaction(change, client)
    : upsertReviewableKnowledgeChange(change);
}

export function recordContentAddressedRevalidations(
  inputs: ReadonlyArray<Omit<AutoResolvedKnowledgeChangeInput, "policyVersion" | "modelId" | "idempotencyKey"> & {
    contentIdentity: string;
  }>,
) {
  const modelId = resolveActiveTextModelIdentity("deep_synthesis").modelId;
  return recordAutoResolvedKnowledgeChanges(inputs.map(({ contentIdentity, ...input }) => ({
    ...input,
    policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
    modelId,
    // Deliberately independent of refresh-run identity. Replaying a workflow
    // or starting another refresh at the same repository head should not add a
    // second audit row for identical content.
    idempotencyKey: `${input.entityKind}:content-addressed:${input.entityId}:${contentIdentity}`,
  })));
}

async function preparePromotedEvidence(input: {
  runId: string;
  workItemId: string;
  targets: RepositoryTargetHead[];
  synthesis: SynthesizedKnowledge[];
  userId: string;
}) {
  const [materialized, snapshots] = await Promise.all([
    materializeSynthesisCitations({
      userId: input.userId,
      workItemId: input.workItemId,
      targets: input.targets,
      synthesis: input.synthesis,
    }),
    prisma.repositorySnapshot.findMany({
      where: { refreshRunId: input.runId },
      select: { id: true, sourceId: true, commitSha: true },
    }),
  ]);
  const entries = Array.from(materialized.entries());
  const snapshotByHead = new Map(
    snapshots.map((snapshot) => [`${snapshot.sourceId}:${snapshot.commitSha}`, snapshot.id] as const),
  );
  const promoted = await promoteRepositoryCitations({
    workItemId: input.workItemId,
    citations: entries.map(([, citation]) => citation),
    reviewScope: `knowledge-refresh:${input.runId}`,
    refreshRunId: input.runId,
    repositorySnapshotIdByHead: snapshotByHead,
    mutationFence: (operation) =>
      withKnowledgeRefreshGenerationFence(input.runId, operation, {
        // The bounded phase can promote several dozen exact excerpts on a cold
        // multi-repository refresh. It performs no network or model work while
        // holding the lock, but Neon may need more than the ordinary 15s CAS
        // window for all Evidence, tag, and review-card writes.
        timeoutMs: 45_000,
      }),
  });
  const promotedIdByReference = new Map<string, string>();
  for (const [index, [key]] of entries.entries()) {
    const evidenceId = promoted.evidenceIdByCitationIndex.get(index);
    if (evidenceId) promotedIdByReference.set(key, evidenceId);
  }
  return { materialized, promotedIdByReference };
}

type ProjectFactReconciliationSnapshot = {
  id: string;
  workItemId: string;
  statement: string;
  status: string;
  lifecycleStatus: string;
  reviewState: string;
  approvalSource: string;
  supersedesProjectFactId?: string | null;
  updatedAt?: Date;
};

type HighlightReconciliationSnapshot = {
  id: string;
  workItemId: string;
  text: string;
  summary: string;
  verificationStatus: string;
  lifecycleStatus: string;
  reviewState: string;
  approvalSource: string;
  metadata?: unknown;
  supersedesHighlightId?: string | null;
  updatedAt?: Date;
};

export function repositoryMayReconcileHighlight(
  highlight: Pick<HighlightReconciliationSnapshot, "metadata">,
) {
  const metadata = highlight.metadata &&
    typeof highlight.metadata === "object" &&
    !Array.isArray(highlight.metadata)
    ? highlight.metadata as Record<string, unknown>
    : null;
  // Manual-Evidence output is owned by its originating AgentRun and may be
  // supplemented only through a reviewable suggestion. Repository refreshes
  // must never revalidate, supersede, or replace it as canonical repo memory.
  return metadata?.managedBy !== "manual_evidence_highlight_workflow";
}

export function repositoryHighlightOwnershipDecision(input: {
  highlight: Pick<HighlightReconciliationSnapshot, "metadata">;
  similarityScore: number;
  unsafe: boolean;
  allowCanonicalReplacement: boolean;
}) {
  if (repositoryMayReconcileHighlight(input.highlight)) {
    return "repository_reconcile" as const;
  }
  if (input.similarityScore < STRONG_KNOWLEDGE_IDENTITY_THRESHOLD) {
    return "unrelated_manual" as const;
  }
  return !input.unsafe && input.allowCanonicalReplacement
    ? "supersede_manual" as const
    : "preserve_manual" as const;
}

type ExistingProjectFactForReconciliation = Prisma.ProjectFactGetPayload<{
  include: { evidence: { include: { evidenceItem: true } } };
}>;

type ExistingHighlightForReconciliation = Prisma.HighlightGetPayload<{
  include: { evidence: { include: { evidenceItem: true } } };
}>;

export function hasPromotedReconciliationEvidence(evidenceIds: string[]) {
  return evidenceIds.length > 0;
}

function closestProjectFact(input: {
  candidate: SynthesizedKnowledge["facts"][number];
  subsystemKey: string;
  existing: ExistingProjectFactForReconciliation[];
}) {
  return input.existing
    .map((fact) => ({
      fact,
      score: knowledgeSimilarity(input.candidate.statement, fact.statement),
    }))
    .sort((left, right) => right.score - left.score)
    .find((entry) => entry.fact.subsystemKey === input.subsystemKey) ?? null;
}

function closestHighlight(input: {
  text: string;
  subsystemKey: string;
  existing: ExistingHighlightForReconciliation[];
}) {
  return input.existing
    .filter((highlight) => {
      const metadata = highlight.metadata &&
        typeof highlight.metadata === "object" &&
        !Array.isArray(highlight.metadata)
        ? highlight.metadata as Record<string, unknown>
        : null;
      return repositoryMayReconcileHighlight(highlight)
        ? metadata?.subsystemKey === input.subsystemKey
        : true;
    })
    .map((highlight) => ({
      highlight,
      score: knowledgeSimilarity(input.text, highlight.text),
    }))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

/**
 * A synthesis candidate is selected before the short mutation transaction.
 * These compare-and-swap predicates make that selection expire as soon as a
 * user review (or any other writer) changes the row. In particular, an old
 * refresh can never reactivate or supersede a user-edited row by ID alone.
 */
export function projectFactReconciliationCasWhere(
  fact: ProjectFactReconciliationSnapshot,
): Prisma.ProjectFactWhereInput {
  return {
    id: fact.id,
    workItemId: fact.workItemId,
    statement: fact.statement,
    status: fact.status as Prisma.EnumProjectFactStatusFilter,
    lifecycleStatus: fact.lifecycleStatus as Prisma.EnumKnowledgeLifecycleStatusFilter,
    reviewState: fact.reviewState as Prisma.EnumKnowledgeReviewStateFilter,
    approvalSource: fact.approvalSource as Prisma.EnumKnowledgeApprovalSourceFilter,
    supersedesProjectFactId: fact.supersedesProjectFactId ?? null,
    ...(fact.updatedAt ? { updatedAt: fact.updatedAt } : {}),
  };
}

export function highlightReconciliationCasWhere(
  highlight: HighlightReconciliationSnapshot,
): Prisma.HighlightWhereInput {
  return {
    id: highlight.id,
    workItemId: highlight.workItemId,
    text: highlight.text,
    summary: highlight.summary,
    verificationStatus: highlight.verificationStatus as Prisma.EnumVerificationStatusFilter,
    lifecycleStatus: highlight.lifecycleStatus as Prisma.EnumKnowledgeLifecycleStatusFilter,
    reviewState: highlight.reviewState as Prisma.EnumKnowledgeReviewStateFilter,
    approvalSource: highlight.approvalSource as Prisma.EnumKnowledgeApprovalSourceFilter,
    ...(highlight.metadata !== undefined
      ? {
          metadata: {
            equals: highlight.metadata === null
              ? Prisma.DbNull
              : highlight.metadata as Prisma.InputJsonValue,
          },
        }
      : {}),
    supersedesHighlightId: highlight.supersedesHighlightId ?? null,
    ...(highlight.updatedAt ? { updatedAt: highlight.updatedAt } : {}),
  };
}

async function applyFact(input: {
  runId: string;
  workItemId: string;
  subsystem: SynthesizedKnowledge;
  candidate: SynthesizedKnowledge["facts"][number];
  evidenceIds: string[];
  commitSha: string;
  validationHeads: Record<string, string>;
  sourceEntries: SynthesisNotebookEntry[];
  allowCanonicalReplacement: boolean;
  enqueueEmbedding?: (task: KnowledgeEmbeddingTask) => void;
}) {
  if (!hasPromotedReconciliationEvidence(input.evidenceIds)) return null;
  const existing = await prisma.projectFact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
    },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const closest = closestProjectFact({
    candidate: input.candidate,
    subsystemKey: input.subsystem.subsystemKey,
    existing,
  });
  const unsafe = isSynthesizedCandidateUnsafe({
    approvalEligible: input.subsystem.approvalEligible,
    candidate: input.candidate,
    sources: input.sourceEntries,
  });
  const exact = closest && closest.score >= 0.9 && normalizeWhitespace(closest.fact.statement).toLowerCase() === normalizeWhitespace(input.candidate.statement).toLowerCase();
  const validatesUserEdit = Boolean(
    closest &&
    closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD &&
    closest.fact.approvalSource === "user" &&
    closest.fact.lifecycleStatus === "needs_validation" &&
    !shouldQuarantineSynthesizedCandidate({
      confidence: closest.fact.confidence,
      sensitivityFlag: closest.fact.sensitivityFlag,
      statement: closest.fact.statement,
    }, input.sourceEntries),
  );

  if ((exact || validatesUserEdit) && !unsafe && closest) {
    const applied = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      const validatedAt = new Date();
      const claimed = await tx.projectFact.updateMany({
        where: projectFactReconciliationCasWhere(closest.fact),
        data: {
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: input.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          productImportance: input.candidate.productImportance,
          implementationBreadth: input.candidate.implementationBreadth,
          technicalDifficulty: input.candidate.technicalDifficulty,
          distinctiveness: input.candidate.distinctiveness,
        },
      });
      if (claimed.count !== 1) return false;
      await tx.projectFactEvidence.deleteMany({ where: { projectFactId: closest.fact.id } });
      await tx.projectFactEvidence.createMany({
        data: input.evidenceIds.map((evidenceItemId) => ({
          projectFactId: closest.fact.id,
          evidenceItemId,
        })),
        skipDuplicates: true,
      });
      await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
      await recordChange({
        workItemId: input.workItemId,
        refreshRunId: input.runId,
        entityKind: "project_fact",
        action: "revalidated",
        entityId: closest.fact.id,
        beforeSnapshot: {
          id: closest.fact.id,
          statement: closest.fact.statement,
          status: closest.fact.status,
          lifecycleStatus: closest.fact.lifecycleStatus,
          reviewState: closest.fact.reviewState,
          approvalSource: closest.fact.approvalSource,
          publicSafetyStatus: closest.fact.publicSafetyStatus,
          validatedThroughSha: closest.fact.validatedThroughSha,
          validationHeads: closest.fact.validationHeads,
          lastValidatedAt: closest.fact.lastValidatedAt,
          autoAppliedAt: closest.fact.autoAppliedAt,
          evidenceItemIds: closest.fact.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot: {
          id: closest.fact.id,
          statement: closest.fact.statement,
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: closest.fact.approvalSource,
          publicSafetyStatus: closest.fact.publicSafetyStatus,
          validatedThroughSha: input.commitSha,
          validationHeads: input.validationHeads,
          lastValidatedAt: validatedAt,
          autoAppliedAt: validatedAt,
          evidenceItemIds: input.evidenceIds,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Project Fact without replacing its wording."
          : "Current repository evidence revalidated this Project Fact.",
        provenance: {
          evidenceIds: input.evidenceIds,
          commitSha: input.commitSha,
          preservedUserEdit: validatesUserEdit,
        },
        suffix: `${closest.fact.id}:${input.commitSha}`,
      }, tx);
      return true;
    });
    return applied ? closest.fact.id : null;
  }

  const supersedes = input.allowCanonicalReplacement && !unsafe && closest && closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
    ? closest.fact
    : null;
  const fact = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
    if (closest) {
      if (supersedes) {
        const claimed = await tx.projectFact.updateMany({
          where: projectFactReconciliationCasWhere(closest.fact),
          data: { status: "superseded", lifecycleStatus: "superseded" },
        });
        if (claimed.count !== 1) return null;
      } else {
        const current = await tx.projectFact.findFirst({
          where: projectFactReconciliationCasWhere(closest.fact),
          select: { id: true },
        });
        if (!current) return null;
      }
    }
    const created = await tx.projectFact.create({
      data: {
        workItemId: input.workItemId,
        statement: input.candidate.statement,
        category: input.candidate.category,
        confidence: input.candidate.confidence,
        status: unsafe ? "draft" : "approved",
        lifecycleStatus: unsafe ? "quarantined" : "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: "not_eligible",
        sensitivityFlag: input.candidate.sensitivityFlag,
        reviewNotes: input.candidate.reviewNotes,
        searchText: normalizeWhitespace([input.candidate.statement, input.candidate.category, input.candidate.reviewNotes ?? ""].join(" ")),
        supersedesProjectFactId: supersedes?.id,
        subsystemKey: input.subsystem.subsystemKey,
        validatedThroughSha: input.commitSha,
        lastValidatedAt: new Date(),
        validationHeads: toInputJson(input.validationHeads),
        autoAppliedAt: unsafe ? null : new Date(),
        productImportance: input.candidate.productImportance,
        implementationBreadth: input.candidate.implementationBreadth,
        technicalDifficulty: input.candidate.technicalDifficulty,
        distinctiveness: input.candidate.distinctiveness,
        evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
      },
    });
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    await recordChange({
      workItemId: input.workItemId,
      refreshRunId: input.runId,
      entityKind: "project_fact",
      action: unsafe ? "quarantined" : supersedes ? "updated" : "created",
      entityId: created.id,
      beforeSnapshot: supersedes ? { id: supersedes.id, statement: supersedes.statement } : undefined,
      afterSnapshot: { id: created.id, statement: created.statement, category: created.category, confidence: created.confidence, lifecycleStatus: created.lifecycleStatus },
      reason: unsafe ? "The generated Project Fact failed an automatic safety gate." : supersedes ? "Current repository evidence produced a verified successor." : "Current repository evidence supported a new Project Fact.",
      provenance: { evidenceIds: input.evidenceIds, commitSha: input.commitSha, subsystemKey: input.subsystem.subsystemKey },
      suffix: `${hash(created.statement).slice(0, 16)}:${input.commitSha}`,
    }, tx);
    return created;
  });
  if (!fact) return null;
  // Quarantined facts are deliberately excluded from retrieval. Avoid paying
  // for an embedding that cannot be used; the review service creates one if a
  // user later edits and activates the candidate.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    const embeddingTask: KnowledgeEmbeddingTask = {
      entityKind: "project_fact",
      entityId: fact.id,
      // This ID was created in the transaction immediately above, so an
      // embedding freshness read is guaranteed to miss.
      execute: () => upsertProjectFactEmbedding({
        projectFactId: fact.id,
        inputText: buildProjectFactEmbeddingText(fact),
        skipFreshnessCheck: true,
      }),
    };
    if (input.enqueueEmbedding) input.enqueueEmbedding(embeddingTask);
    else await embeddingTask.execute();
  }
  return unsafe ? null : fact.id;
}

async function applyHighlight(input: {
  runId: string;
  workItemId: string;
  subsystem: SynthesizedKnowledge;
  candidate: SynthesizedKnowledge["highlights"][number];
  evidenceIds: string[];
  evidence: Array<{ title: string; excerpt: string; commitSha?: string }>;
  commitSha: string;
  validationHeads: Record<string, string>;
  sourceEntries: SynthesisNotebookEntry[];
  allowCanonicalReplacement: boolean;
  enqueueEmbedding?: (task: KnowledgeEmbeddingTask) => void;
}) {
  if (!hasPromotedReconciliationEvidence(input.evidenceIds)) return null;
  const unsafe = isSynthesizedCandidateUnsafe({
    approvalEligible: input.subsystem.approvalEligible,
    candidate: input.candidate,
    sources: input.sourceEntries,
  });
  // Repository contents can verify implementation but cannot establish who
  // personally performed the work. Running a public-claim verifier for every
  // repository-derived Highlight is both expensive and guaranteed to fail the
  // ownership gate in the normal case. Auto-apply it as private memory and let
  // later reviewed ownership context drive a separate public verification.
  const publicVerification = repositoryHighlightPublicDisposition(unsafe);
  const text = publicVerification.eligible && publicVerification.correctedText
    ? publicVerification.correctedText
    : input.candidate.text;
  const existing = await prisma.highlight.findMany({
    where: { workItemId: input.workItemId, lifecycleStatus: { in: ["active", "needs_validation"] } },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const closest = closestHighlight({
    text,
    subsystemKey: input.subsystem.subsystemKey,
    existing,
  });
  const exact = Boolean(
    closest &&
    closest.score >= 0.9 &&
    normalizeWhitespace(closest.highlight.text).toLowerCase() === normalizeWhitespace(text).toLowerCase(),
  );
  const validatesUserEdit = Boolean(
    closest &&
    closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD &&
    closest.highlight.approvalSource === "user" &&
    closest.highlight.lifecycleStatus === "needs_validation" &&
    !shouldQuarantineSynthesizedCandidate({
      confidence: closest.highlight.confidence,
      sensitivityFlag: closest.highlight.sensitivityFlag,
      text: closest.highlight.text,
      summary: closest.highlight.summary,
    }, input.sourceEntries),
  );
  const ownershipDecision = closest
    ? repositoryHighlightOwnershipDecision({
        highlight: closest.highlight,
        similarityScore: closest.score,
        unsafe,
        allowCanonicalReplacement: input.allowCanonicalReplacement,
      })
    : null;
  if (
    (exact || validatesUserEdit) &&
    !unsafe &&
    closest &&
    ownershipDecision === "repository_reconcile"
  ) {
    const applied = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      const validatedAt = new Date();
      const claimed = await tx.highlight.updateMany({
        where: highlightReconciliationCasWhere(closest.highlight),
        data: {
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: input.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
        },
      });
      if (claimed.count !== 1) return false;
      await tx.highlightEvidence.deleteMany({ where: { highlightId: closest.highlight.id } });
      await tx.highlightEvidence.createMany({
        data: input.evidenceIds.map((evidenceItemId) => ({
          highlightId: closest.highlight.id,
          evidenceItemId,
        })),
        skipDuplicates: true,
      });
      await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
      await recordChange({
        workItemId: input.workItemId,
        refreshRunId: input.runId,
        entityKind: "highlight",
        action: "revalidated",
        entityId: closest.highlight.id,
        beforeSnapshot: {
          id: closest.highlight.id,
          text: closest.highlight.text,
          verificationStatus: closest.highlight.verificationStatus,
          lifecycleStatus: closest.highlight.lifecycleStatus,
          reviewState: closest.highlight.reviewState,
          approvalSource: closest.highlight.approvalSource,
          publicSafetyStatus: closest.highlight.publicSafetyStatus,
          validatedThroughSha: closest.highlight.validatedThroughSha,
          validationHeads: closest.highlight.validationHeads,
          lastValidatedAt: closest.highlight.lastValidatedAt,
          autoAppliedAt: closest.highlight.autoAppliedAt,
          evidenceItemIds: closest.highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot: {
          id: closest.highlight.id,
          text: closest.highlight.text,
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: closest.highlight.approvalSource,
          publicSafetyStatus: closest.highlight.publicSafetyStatus,
          validatedThroughSha: input.commitSha,
          validationHeads: input.validationHeads,
          lastValidatedAt: validatedAt,
          autoAppliedAt: validatedAt,
          evidenceItemIds: input.evidenceIds,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Highlight without replacing its wording."
          : "Current repository evidence revalidated this Highlight.",
        provenance: {
          evidenceIds: input.evidenceIds,
          commitSha: input.commitSha,
          preservedUserEdit: validatesUserEdit,
        },
        suffix: `${closest.highlight.id}:${input.commitSha}`,
      }, tx);
      return true;
    });
    return applied ? closest.highlight.id : null;
  }
  const supersedes = input.allowCanonicalReplacement && !unsafe && closest &&
      closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
    ? closest.highlight
    : null;
  if (ownershipDecision === "preserve_manual") {
    // Incomplete or unsafe repository evidence cannot rewrite manual
    // provenance, and creating a second active near-duplicate would make
    // retrieval nondeterministic. Preserve the manual canonical row.
    return null;
  }
  const tags = inferHighlightTags({
    text,
    summary: input.candidate.summary,
    verificationNotes: publicVerification.reasons.join(" ") || "Verified from complete repository coverage.",
  });
  const highlight = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
    if (closest) {
      if (supersedes) {
        const claimed = await tx.highlight.updateMany({
          where: highlightReconciliationCasWhere(closest.highlight),
          data: { lifecycleStatus: "superseded" },
        });
        if (claimed.count !== 1) return null;
      } else {
        const current = await tx.highlight.findFirst({
          where: highlightReconciliationCasWhere(closest.highlight),
          select: { id: true },
        });
        if (!current) return null;
      }
    }
    const created = await tx.highlight.create({
      data: {
        workItemId: input.workItemId,
        text,
        summary: input.candidate.summary,
        searchText: normalizeWhitespace([text, input.candidate.summary, input.subsystem.subsystemKey].join(" ")),
        confidence: input.candidate.confidence,
        ownershipClarity: "unclear",
        sensitivityFlag: input.candidate.sensitivityFlag,
        verificationStatus: unsafe ? "flagged" : "approved",
        lifecycleStatus: unsafe ? "quarantined" : "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: publicVerification.eligible ? "verified" : publicVerification.reasons.length ? "failed" : "pending",
        visibility: publicVerification.eligible ? input.candidate.visibility : "private",
        risksSummary: publicVerification.reasons.join(" ").slice(0, 1_000) || null,
        verificationNotes: "Auto-applied from complete, commit-pinned repository coverage.",
        metadata: toInputJson({
          managedBy: "repository_knowledge_sync",
          refreshRunId: input.runId,
          subsystemKey: input.subsystem.subsystemKey,
          scores: {
            productImportance: input.candidate.productImportance,
            implementationBreadth: input.candidate.implementationBreadth,
            technicalDifficulty: input.candidate.technicalDifficulty,
            distinctiveness: input.candidate.distinctiveness,
          },
          publicVerification,
        }),
        validatedThroughSha: input.commitSha,
        lastValidatedAt: new Date(),
        validationHeads: toInputJson(input.validationHeads),
        autoAppliedAt: unsafe ? null : new Date(),
        supersedesHighlightId: supersedes?.id,
        evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
        tags: { create: tags.map((tag) => ({ dimension: tag.dimension, tag: tag.tag, score: tag.score ?? null })) },
      },
    });
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    await recordChange({
      workItemId: input.workItemId,
      refreshRunId: input.runId,
      entityKind: "highlight",
      action: unsafe ? "quarantined" : supersedes ? "updated" : "created",
      entityId: created.id,
      beforeSnapshot: supersedes ? { id: supersedes.id, text: supersedes.text } : undefined,
      afterSnapshot: { id: created.id, text: created.text, summary: created.summary, lifecycleStatus: created.lifecycleStatus, publicSafetyStatus: created.publicSafetyStatus },
      reason: unsafe ? "The generated Highlight failed an automatic safety gate." : supersedes ? "Current repository evidence produced a verified Highlight successor." : "Current repository evidence supported a new Highlight.",
      provenance: { evidenceIds: input.evidenceIds, commitSha: input.commitSha, subsystemKey: input.subsystem.subsystemKey },
      suffix: `${hash(created.text).slice(0, 16)}:${input.commitSha}`,
    }, tx);
    return created;
  });
  if (!highlight) return null;
  // Quarantined Highlights likewise cannot enter retrieval until review, so
  // defer their embedding instead of creating an immediately unused vector.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    const embeddingTask: KnowledgeEmbeddingTask = {
      entityKind: "highlight",
      entityId: highlight.id,
      // This ID was created in the transaction immediately above, so an
      // embedding freshness read is guaranteed to miss.
      execute: () => upsertHighlightEmbedding({
        highlightId: highlight.id,
        inputText: buildHighlightEmbeddingText({
          text: highlight.text,
          summary: highlight.summary,
          verificationNotes: highlight.verificationNotes,
          tags,
          evidence: { summary: input.candidate.summary, sourceRefs: input.evidence.map((entry, index) => ({ evidenceItemId: input.evidenceIds[index] ?? "", sourceId: "repository-sync", sourceType: "github_repo" as const, title: entry.title, sourceLabel: "GitHub", excerpt: entry.excerpt })) },
        }),
        skipFreshnessCheck: true,
      }),
    };
    if (input.enqueueEmbedding) input.enqueueEmbedding(embeddingTask);
    else await embeddingTask.execute();
  }
  return unsafe ? null : highlight.id;
}

type PreparedFactReconciliation = {
  key: string;
  subsystem: SynthesizedKnowledge;
  candidate: SynthesizedKnowledge["facts"][number];
  evidenceIds: string[];
  commitSha: string;
  validationHeads: Record<string, string>;
  sourceEntries: SynthesisNotebookEntry[];
};

type PreparedHighlightReconciliation = {
  key: string;
  subsystem: SynthesizedKnowledge;
  candidate: SynthesizedKnowledge["highlights"][number];
  evidenceIds: string[];
  evidence: Array<{ title: string; excerpt: string; commitSha?: string }>;
  commitSha: string;
  validationHeads: Record<string, string>;
  sourceEntries: SynthesisNotebookEntry[];
};

/**
 * Revalidating unchanged knowledge is lifecycle maintenance, not a new review
 * decision. Apply all exact/user-edit-preserving matches under one generation
 * fence and record their audit rows already resolved. This replaces one
 * serializable transaction per Fact/Highlight with one transaction per cold
 * refresh while keeping every row-level CAS and immutable provenance link.
 */
async function revalidateExistingKnowledge(input: {
  runId: string;
  workItemId: string;
  facts: PreparedFactReconciliation[];
  highlights: PreparedHighlightReconciliation[];
  existingFacts: ExistingProjectFactForReconciliation[];
  existingHighlights: ExistingHighlightForReconciliation[];
}) {
  const claimedFactIds = new Set<string>();
  const claimedHighlightIds = new Set<string>();
  const factMatches = input.facts.flatMap((entry) => {
    if (!hasPromotedReconciliationEvidence(entry.evidenceIds)) return [];
    const closest = closestProjectFact({
      candidate: entry.candidate,
      subsystemKey: entry.subsystem.subsystemKey,
      existing: input.existingFacts,
    });
    const unsafe = isSynthesizedCandidateUnsafe({
      approvalEligible: entry.subsystem.approvalEligible,
      candidate: entry.candidate,
      sources: entry.sourceEntries,
    });
    const exact = Boolean(
      closest &&
      closest.score >= 0.9 &&
      normalizeWhitespace(closest.fact.statement).toLowerCase() ===
        normalizeWhitespace(entry.candidate.statement).toLowerCase(),
    );
    const validatesUserEdit = Boolean(
      closest &&
      closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD &&
      closest.fact.approvalSource === "user" &&
      closest.fact.lifecycleStatus === "needs_validation" &&
      !shouldQuarantineSynthesizedCandidate({
        confidence: closest.fact.confidence,
        sensitivityFlag: closest.fact.sensitivityFlag,
        statement: closest.fact.statement,
      }, entry.sourceEntries),
    );
    if (
      unsafe ||
      !closest ||
      (!exact && !validatesUserEdit) ||
      claimedFactIds.has(closest.fact.id)
    ) return [];
    claimedFactIds.add(closest.fact.id);
    return [{ entry, closest, validatesUserEdit }];
  });
  const highlightMatches = input.highlights.flatMap((entry) => {
    if (!hasPromotedReconciliationEvidence(entry.evidenceIds)) return [];
    const unsafe = isSynthesizedCandidateUnsafe({
      approvalEligible: entry.subsystem.approvalEligible,
      candidate: entry.candidate,
      sources: entry.sourceEntries,
    });
    const publicVerification = repositoryHighlightPublicDisposition(unsafe);
    const text = publicVerification.eligible && publicVerification.correctedText
      ? publicVerification.correctedText
      : entry.candidate.text;
    const closest = closestHighlight({
      text,
      subsystemKey: entry.subsystem.subsystemKey,
      existing: input.existingHighlights,
    });
    const exact = Boolean(
      closest &&
      closest.score >= 0.9 &&
      normalizeWhitespace(closest.highlight.text).toLowerCase() ===
        normalizeWhitespace(text).toLowerCase(),
    );
    const validatesUserEdit = Boolean(
      closest &&
      closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD &&
      closest.highlight.approvalSource === "user" &&
      closest.highlight.lifecycleStatus === "needs_validation" &&
      !shouldQuarantineSynthesizedCandidate({
        confidence: closest.highlight.confidence,
        sensitivityFlag: closest.highlight.sensitivityFlag,
        text: closest.highlight.text,
        summary: closest.highlight.summary,
      }, entry.sourceEntries),
    );
    if (
      unsafe ||
      !closest ||
      !repositoryMayReconcileHighlight(closest.highlight) ||
      (!exact && !validatesUserEdit) ||
      claimedHighlightIds.has(closest.highlight.id)
    ) return [];
    claimedHighlightIds.add(closest.highlight.id);
    return [{ entry, closest, validatesUserEdit }];
  });
  const matchedKeys = new Set([
    ...factMatches.map(({ entry }) => entry.key),
    ...highlightMatches.map(({ entry }) => entry.key),
  ]);
  if (!matchedKeys.size) {
    return {
      matchedKeys,
      appliedFactIdsByKey: new Map<string, string>(),
      appliedHighlightIdsByKey: new Map<string, string>(),
    };
  }

  const appliedFactIdsByKey = new Map<string, string>();
  const appliedHighlightIdsByKey = new Map<string, string>();
  await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
    const validatedAt = new Date();
    const changeInputs: AutoResolvedKnowledgeChangeInput[] = [];
    const evidenceIds = new Set<string>();
    const factEvidenceRows: Array<{ projectFactId: string; evidenceItemId: string }> = [];
    const highlightEvidenceRows: Array<{ highlightId: string; evidenceItemId: string }> = [];

    for (const { entry, closest, validatesUserEdit } of factMatches) {
      const claimed = await tx.projectFact.updateMany({
        where: projectFactReconciliationCasWhere(closest.fact),
        data: {
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: entry.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(entry.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          productImportance: entry.candidate.productImportance,
          implementationBreadth: entry.candidate.implementationBreadth,
          technicalDifficulty: entry.candidate.technicalDifficulty,
          distinctiveness: entry.candidate.distinctiveness,
        },
      });
      if (claimed.count !== 1) continue;
      appliedFactIdsByKey.set(entry.key, closest.fact.id);
      for (const evidenceItemId of entry.evidenceIds) {
        evidenceIds.add(evidenceItemId);
        factEvidenceRows.push({ projectFactId: closest.fact.id, evidenceItemId });
      }
      changeInputs.push({
        workItemId: input.workItemId,
        refreshRunId: input.runId,
        entityKind: "project_fact",
        action: "revalidated",
        entityId: closest.fact.id,
        beforeSnapshot: {
          id: closest.fact.id,
          statement: closest.fact.statement,
          status: closest.fact.status,
          lifecycleStatus: closest.fact.lifecycleStatus,
          validatedThroughSha: closest.fact.validatedThroughSha,
        },
        afterSnapshot: {
          id: closest.fact.id,
          statement: closest.fact.statement,
          status: "approved",
          lifecycleStatus: "active",
          validatedThroughSha: entry.commitSha,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Project Fact without replacing its wording."
          : "Current repository evidence revalidated this Project Fact.",
        provenance: {
          evidenceIds: entry.evidenceIds,
          commitSha: entry.commitSha,
          preservedUserEdit: validatesUserEdit,
        },
        policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
        modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
        idempotencyKey: `project_fact:content-addressed:${closest.fact.id}:${hash([
          closest.fact.statement,
          entry.commitSha,
          ...entry.evidenceIds.slice().sort(),
        ].join("|")).slice(0, 24)}`,
      });
    }

    for (const { entry, closest, validatesUserEdit } of highlightMatches) {
      const claimed = await tx.highlight.updateMany({
        where: highlightReconciliationCasWhere(closest.highlight),
        data: {
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: entry.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(entry.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
        },
      });
      if (claimed.count !== 1) continue;
      appliedHighlightIdsByKey.set(entry.key, closest.highlight.id);
      for (const evidenceItemId of entry.evidenceIds) {
        evidenceIds.add(evidenceItemId);
        highlightEvidenceRows.push({ highlightId: closest.highlight.id, evidenceItemId });
      }
      changeInputs.push({
        workItemId: input.workItemId,
        refreshRunId: input.runId,
        entityKind: "highlight",
        action: "revalidated",
        entityId: closest.highlight.id,
        beforeSnapshot: {
          id: closest.highlight.id,
          text: closest.highlight.text,
          verificationStatus: closest.highlight.verificationStatus,
          lifecycleStatus: closest.highlight.lifecycleStatus,
          validatedThroughSha: closest.highlight.validatedThroughSha,
        },
        afterSnapshot: {
          id: closest.highlight.id,
          text: closest.highlight.text,
          verificationStatus: "approved",
          lifecycleStatus: "active",
          validatedThroughSha: entry.commitSha,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Highlight without replacing its wording."
          : "Current repository evidence revalidated this Highlight.",
        provenance: {
          evidenceIds: entry.evidenceIds,
          commitSha: entry.commitSha,
          preservedUserEdit: validatesUserEdit,
        },
        policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
        modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
        idempotencyKey: `highlight:content-addressed:${closest.highlight.id}:${hash([
          closest.highlight.text,
          entry.commitSha,
          ...entry.evidenceIds.slice().sort(),
        ].join("|")).slice(0, 24)}`,
      });
    }

    const appliedFactIds = Array.from(appliedFactIdsByKey.values());
    const appliedHighlightIds = Array.from(appliedHighlightIdsByKey.values());
    await Promise.all([
      appliedFactIds.length
        ? tx.projectFactEvidence.deleteMany({ where: { projectFactId: { in: appliedFactIds } } })
        : Promise.resolve(),
      appliedHighlightIds.length
        ? tx.highlightEvidence.deleteMany({ where: { highlightId: { in: appliedHighlightIds } } })
        : Promise.resolve(),
    ]);
    await Promise.all([
      factEvidenceRows.length
        ? tx.projectFactEvidence.createMany({ data: factEvidenceRows, skipDuplicates: true })
        : Promise.resolve(),
      highlightEvidenceRows.length
        ? tx.highlightEvidence.createMany({ data: highlightEvidenceRows, skipDuplicates: true })
        : Promise.resolve(),
      evidenceIds.size
        ? tx.evidenceItem.updateMany({
            where: { id: { in: Array.from(evidenceIds) } },
            data: { included: true },
          })
        : Promise.resolve(),
    ]);
    if (changeInputs.length) {
      await recordAutoResolvedKnowledgeChangesInTransaction(changeInputs, tx);
    }
  }, { timeoutMs: 45_000 });

  return { matchedKeys, appliedFactIdsByKey, appliedHighlightIdsByKey };
}

export async function reconcileRepositoryKnowledge(runId: string) {
  const reconciliationStartedAt = Date.now();
  const stageTimingsMs: Record<string, number> = {};
  let stageStartedAt = reconciliationStartedAt;
  const finishStage = (stage: string) => {
    const now = Date.now();
    stageTimingsMs[stage] = now - stageStartedAt;
    stageStartedAt = now;
  };
  await assertKnowledgeRefreshGenerationCurrent(runId);
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { workItem: { select: { userId: true } } },
  });
  if (run.status !== "reconciling") throw new Error("Repository coverage must complete before reconciliation.");
  const targets = run.targetHeads as unknown as RepositoryTargetHead[];
  // A retried reconciliation must replay the audited model synthesis. Existing
  // partial changes are idempotent checkpoints, not permission to switch the
  // primary path to deterministic synthesis.
  const synthesis = await synthesizeRepositoryKnowledge(runId);
  const synthesisCoverageGaps = await persistSynthesisCoverageGaps(runId, synthesis);
  finishStage("synthesis");
  const allowCanonicalReplacement =
    allowsCanonicalKnowledgeReplacement(run.qualityStatus) &&
    synthesisCoverageGaps.length === 0;
  await assertKnowledgeRefreshGenerationCurrent(runId);
  const { materialized, promotedIdByReference } = await preparePromotedEvidence({
    runId,
    workItemId: run.workItemId,
    targets,
    synthesis,
    userId: run.workItem.userId,
  });
  finishStage("evidencePromotion");
  await assertKnowledgeRefreshGenerationCurrent(runId);
  const embeddingTasks: KnowledgeEmbeddingTask[] = [];
  const enqueueEmbedding = (task: KnowledgeEmbeddingTask) => {
    embeddingTasks.push(task);
  };
  const preparedFacts: PreparedFactReconciliation[] = synthesis.flatMap((subsystem) =>
    subsystem.facts.map((candidate, index) => {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const validationHeads = Object.fromEntries(citedEntries.map((entry) => [entry.sourceId, entry.commitSha]));
      return {
        key: `fact:${subsystem.subsystemKey}:${index}`,
        subsystem,
        candidate,
        evidenceIds,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
        validationHeads,
        sourceEntries: citedEntries,
      };
    })
  );
  const preparedHighlights: PreparedHighlightReconciliation[] = synthesis.flatMap((subsystem) =>
    subsystem.highlights.map((candidate, index) => {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const evidence = citationsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, materialized }).map((entry) => ({
        title: entry.label,
        excerpt: entry.excerpt,
        commitSha: entry.commitSha,
      }));
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const validationHeads = Object.fromEntries(citedEntries.map((entry) => [entry.sourceId, entry.commitSha]));
      return {
        key: `highlight:${subsystem.subsystemKey}:${index}`,
        subsystem,
        candidate,
        evidenceIds,
        evidence,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
        validationHeads,
        sourceEntries: citedEntries,
      };
    })
  );
  const [existingFacts, existingHighlights] = await Promise.all([
    prisma.projectFact.findMany({
      where: {
        workItemId: run.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
      },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
    prisma.highlight.findMany({
      where: {
        workItemId: run.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation"] },
      },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
  ]);
  const batchedRevalidations = await revalidateExistingKnowledge({
    runId,
    workItemId: run.workItemId,
    facts: preparedFacts,
    highlights: preparedHighlights,
    existingFacts,
    existingHighlights,
  });
  finishStage("batchedRevalidation");
  const producedBySubsystem = new Map(synthesis.map((subsystem) => [
    subsystem.subsystemKey,
    { projectFactIds: [] as string[], highlightIds: [] as string[] },
  ]));
  for (const entry of preparedFacts) {
    const batchedId = batchedRevalidations.appliedFactIdsByKey.get(entry.key);
    if (batchedId) {
      producedBySubsystem.get(entry.subsystem.subsystemKey)?.projectFactIds.push(batchedId);
      continue;
    }
    // A lost row-level CAS means a user or newer writer changed the matched
    // entity after planning. Do not reinterpret that race as permission to
    // manufacture a successor from stale state.
    if (batchedRevalidations.matchedKeys.has(entry.key)) continue;
    const factId = await applyFact({
      runId,
      workItemId: run.workItemId,
      ...entry,
      allowCanonicalReplacement,
      enqueueEmbedding,
    });
    if (factId) {
      producedBySubsystem.get(entry.subsystem.subsystemKey)?.projectFactIds.push(factId);
    }
  }
  for (const entry of preparedHighlights) {
    const batchedId = batchedRevalidations.appliedHighlightIdsByKey.get(entry.key);
    if (batchedId) {
      producedBySubsystem.get(entry.subsystem.subsystemKey)?.highlightIds.push(batchedId);
      continue;
    }
    if (batchedRevalidations.matchedKeys.has(entry.key)) continue;
    const highlightId = await applyHighlight({
      runId,
      workItemId: run.workItemId,
      ...entry,
      allowCanonicalReplacement,
      enqueueEmbedding,
    });
    if (highlightId) {
      producedBySubsystem.get(entry.subsystem.subsystemKey)?.highlightIds.push(highlightId);
    }
  }
  finishStage("knowledgeApplication");
  const results = synthesis.map((subsystem) => ({
    subsystemKey: subsystem.subsystemKey,
    produced: producedBySubsystem.get(subsystem.subsystemKey) ?? {
      projectFactIds: [],
      highlightIds: [],
    },
  }));
  await withKnowledgeRefreshGenerationFence(runId, async (tx) => {
    for (const { subsystemKey, produced } of results) {
      await tx.repositoryCapabilityLedger.updateMany({
        where: { refreshRunId: runId, capabilityKey: subsystemKey },
        data: { producedEntityRefs: toInputJson(produced) },
      });
    }
  });
  finishStage("ledgerPersistence");
  const embeddingTelemetry = await runBoundedKnowledgeEmbeddingTasks(
    embeddingTasks,
  );
  finishStage("embeddings");
  await withKnowledgeRefreshGenerationFence(runId, async (tx) => {
    // Synthesis-gap reconciliation may have degraded the run and extended its
    // warnings after the initial snapshot was loaded. Merge into the current
    // fenced row so embedding telemetry cannot erase those newer diagnostics.
    const current = await tx.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: runId },
      select: { warnings: true, qualityStatus: true, budgetUsage: true },
    });
    const embeddingRefreshState = knowledgeRefreshStateForEmbeddingTelemetry({
      warnings: current.warnings,
      qualityStatus: current.qualityStatus,
      telemetry: embeddingTelemetry,
    });
    await tx.knowledgeRefreshRun.update({
      where: { id: runId },
      data: {
        qualityStatus: embeddingRefreshState.qualityStatus,
        warnings: toInputJson(embeddingRefreshState.warnings),
        budgetUsage: toInputJson({
          ...objectRecord(current.budgetUsage),
          repositorySynthesis: {
            maxTokens: 80_000,
            usage: synthesis[0]?.tokenUsage ?? null,
          },
          reconciliation: {
            stageTimingsMs,
            totalMs: Date.now() - reconciliationStartedAt,
            promotedEvidenceCount: promotedIdByReference.size,
            preparedFactCount: preparedFacts.length,
            preparedHighlightCount: preparedHighlights.length,
            batchedFactRevalidationCount: batchedRevalidations.appliedFactIdsByKey.size,
            batchedHighlightRevalidationCount: batchedRevalidations.appliedHighlightIdsByKey.size,
          },
        }),
      },
    });
  });
  const appliedFactIds = results.flatMap((entry) => entry.produced.projectFactIds);
  const appliedHighlightIds = results.flatMap((entry) => entry.produced.highlightIds);
  return {
    synthesis,
    appliedFactIds: Array.from(new Set(appliedFactIds)),
    appliedHighlightIds: Array.from(new Set(appliedHighlightIds)),
    promotedEvidenceIds: Array.from(new Set(promotedIdByReference.values())),
    coverageGaps: synthesisCoverageGaps,
    embeddingTelemetry,
    reconciliationTelemetry: {
      stageTimingsMs,
      totalMs: Date.now() - reconciliationStartedAt,
    },
  };
}

export async function retryKnowledgeRefreshEmbeddingBackfill(runId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      workItemId: true,
      status: true,
      qualityStatus: true,
      warnings: true,
    },
  });
  const embeddingTelemetry = objectRecord(objectRecord(run.warnings).embeddingTelemetry);
  const failedTargets = knowledgeEmbeddingTargets(embeddingTelemetry.failedTargets);
  if (!failedTargets.length || run.status !== "completed") {
    return {
      attempted: 0,
      attempts: 0,
      retried: 0,
      recovered: 0,
      failed: failedTargets.length,
      failedTargets,
      qualityStatus: run.qualityStatus,
    };
  }

  const factIds = failedTargets.flatMap((target) =>
    target.entityKind === "project_fact" ? [target.entityId] : []
  );
  const highlightIds = failedTargets.flatMap((target) =>
    target.entityKind === "highlight" ? [target.entityId] : []
  );
  const [facts, highlights] = await Promise.all([
    factIds.length
      ? prisma.projectFact.findMany({
          where: {
            id: { in: factIds },
            workItemId: run.workItemId,
            lifecycleStatus: "active",
            status: "approved",
          },
          select: {
            id: true,
            statement: true,
            category: true,
            reviewNotes: true,
          },
        })
      : Promise.resolve([]),
    highlightIds.length
      ? prisma.highlight.findMany({
          where: {
            id: { in: highlightIds },
            workItemId: run.workItemId,
            lifecycleStatus: "active",
            verificationStatus: "approved",
          },
          select: {
            id: true,
            text: true,
            summary: true,
            verificationNotes: true,
            tags: {
              select: {
                dimension: true,
                tag: true,
                score: true,
              },
            },
            evidence: {
              select: {
                evidenceItemId: true,
                evidenceItem: {
                  select: {
                    sourceId: true,
                    title: true,
                    content: true,
                    source: {
                      select: {
                        label: true,
                        type: true,
                      },
                    },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  const tasks: KnowledgeEmbeddingTask[] = [
    ...facts.map((fact): KnowledgeEmbeddingTask => ({
      entityKind: "project_fact",
      entityId: fact.id,
      execute: () => upsertProjectFactEmbedding({
        projectFactId: fact.id,
        inputText: buildProjectFactEmbeddingText(fact),
      }),
    })),
    ...highlights.map((highlight): KnowledgeEmbeddingTask => ({
      entityKind: "highlight",
      entityId: highlight.id,
      execute: () => upsertHighlightEmbedding({
        highlightId: highlight.id,
        inputText: buildHighlightEmbeddingText({
          text: highlight.text,
          summary: highlight.summary,
          verificationNotes: highlight.verificationNotes,
          tags: highlight.tags.map((tag) => ({
            ...tag,
            tag: tag.tag as HighlightTagValue,
          })),
          evidence: {
            summary: highlight.summary,
            verificationNotes: highlight.verificationNotes,
            sourceRefs: highlight.evidence.map((entry) => ({
              evidenceItemId: entry.evidenceItemId,
              sourceId: entry.evidenceItem.sourceId,
              sourceLabel: entry.evidenceItem.source.label,
              sourceType: entry.evidenceItem.source.type,
              title: entry.evidenceItem.title,
              excerpt: entry.evidenceItem.content,
            })),
          },
        }),
      }),
    })),
  ];
  const telemetry = await runBoundedKnowledgeEmbeddingTasks(tasks);
  const refreshState = knowledgeRefreshStateForEmbeddingTelemetry({
    warnings: run.warnings,
    qualityStatus: run.qualityStatus,
    telemetry,
  });
  await prisma.knowledgeRefreshRun.updateMany({
    where: { id: runId, status: "completed" },
    data: {
      qualityStatus: refreshState.qualityStatus,
      warnings: toInputJson(refreshState.warnings),
    },
  });
  return {
    ...telemetry,
    qualityStatus: refreshState.qualityStatus,
  };
}

export { recordChange };

export const knowledgeReconciliationService = {
  reconcile: reconcileRepositoryKnowledge,
  retryEmbeddingBackfill: retryKnowledgeRefreshEmbeddingBackfill,
};
