import { createHash, randomUUID } from "node:crypto";
import {
  mergeRepositoryCapabilityFunnelTraces,
  reconcileRepositoryCapabilityFunnelMaterialization,
} from "@/src/domain/repository-capability-funnel";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import type { HighlightTagValue } from "@/src/lib/highlight-taxonomy";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  buildRepositoryKnowledgeMetadata,
  parseRepositoryKnowledgeMetadata,
  type RepositoryKnowledgeMetadata,
} from "@/src/domain/repository-knowledge";
import {
  recordAutoResolvedKnowledgeChanges,
  recordAutoResolvedKnowledgeChangesInTransaction,
  upsertReviewableKnowledgeChange,
  upsertReviewableKnowledgeChangeInTransaction,
  upsertReviewableKnowledgeChangesInTransaction,
  type AutoResolvedKnowledgeChangeInput,
  type ReviewableKnowledgeChangeInput,
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
  repositoryKnowledgeRole,
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

function repositoryClaimMetadata(input: {
  runId: string;
  subsystem: Pick<SynthesizedKnowledge, "subsystemKey" | "synthesisKey">;
  sourceEntries: readonly SynthesisNotebookEntry[];
}): RepositoryKnowledgeMetadata {
  return buildRepositoryKnowledgeMetadata({
    refreshRunId: input.runId,
    subsystemKey: input.subsystem.subsystemKey,
    synthesisKey: input.subsystem.synthesisKey ?? null,
    sources: input.sourceEntries.map((entry) => ({
      sourceId: entry.sourceId,
      knowledgeRole: repositoryKnowledgeRole(entry),
      implementationState: entry.implementationState,
      operationKey: entry.operationKey,
      operationFacet: entry.operationFacet,
    })),
  });
}

function mergeRepositoryClaimMetadata(
  current: unknown,
  repositoryMetadata: RepositoryKnowledgeMetadata,
) {
  const currentRecord = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return toInputJson({ ...currentRecord, ...repositoryMetadata });
}

function repositoryClaimMetadataDigest(metadata: RepositoryKnowledgeMetadata) {
  return hash(JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    managedBy: metadata.managedBy,
    sourceIds: metadata.sourceIds,
    subsystemKey: metadata.subsystemKey,
    synthesisKey: metadata.synthesisKey,
    knowledgeRoles: metadata.knowledgeRoles,
    implementationStates: metadata.implementationStates,
    operationKeys: metadata.operationKeys,
    operationFacets: metadata.operationFacets,
  })).slice(0, 16);
}

function stringSetsOverlap(left: readonly string[], right: readonly string[]) {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

export type RepositoryKnowledgeIdentityRelation =
  | "same_operation"
  | "compatible_legacy"
  | "different";

/**
 * Compare stable repository semantics before using lexical similarity.
 * Evidence-derived source IDs let early v1 rows (which omitted sourceIds)
 * recover safely without allowing two attached repositories that use the same
 * subsystem or operation label to overwrite one another.
 */
export function repositoryKnowledgeIdentityRelation(input: {
  priorMetadata: unknown;
  candidateMetadata: RepositoryKnowledgeMetadata;
  priorEvidenceSourceIds?: readonly string[];
}): RepositoryKnowledgeIdentityRelation {
  const prior = parseRepositoryKnowledgeMetadata(input.priorMetadata);
  const priorSourceIds = prior?.sourceIds.length
    ? prior.sourceIds
    : Array.from(new Set(input.priorEvidenceSourceIds ?? []));
  const candidateSourceIds = input.candidateMetadata.sourceIds;
  if (
    priorSourceIds.length &&
    candidateSourceIds.length &&
    !stringSetsOverlap(priorSourceIds, candidateSourceIds)
  ) return "different";

  if (!prior) return "compatible_legacy";

  if (prior.operationKeys.length && input.candidateMetadata.operationKeys.length) {
    return stringSetsOverlap(
      prior.operationKeys,
      input.candidateMetadata.operationKeys,
    )
      ? "same_operation"
      : "different";
  }
  if (
    prior.synthesisKey &&
    input.candidateMetadata.synthesisKey &&
    prior.synthesisKey === input.candidateMetadata.synthesisKey
  ) return "same_operation";
  return "compatible_legacy";
}

/** Unknown legacy state may be upgraded, but an explicit state/role change is
 * a new semantic revision and must not be revalidated in place. */
export function repositoryKnowledgeStateMatches(input: {
  priorMetadata: unknown;
  candidateMetadata: RepositoryKnowledgeMetadata;
}) {
  const prior = parseRepositoryKnowledgeMetadata(input.priorMetadata);
  if (!prior) return true;
  if (
    prior.implementationStates.length &&
    input.candidateMetadata.implementationStates.length
  ) {
    if (
      JSON.stringify(prior.implementationStates) !==
        JSON.stringify(input.candidateMetadata.implementationStates)
    ) return false;
  }
  if (prior.knowledgeRoles.length && input.candidateMetadata.knowledgeRoles.length) {
    if (
      JSON.stringify(prior.knowledgeRoles) !==
        JSON.stringify(input.candidateMetadata.knowledgeRoles)
    ) return false;
  }
  return true;
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

export function synthesisCoverageLedgerGapUpdates(input: {
  synthesis: Array<Pick<
    SynthesizedKnowledge,
    "sourceId" | "repository" | "subsystemKey" | "coverageGaps" | "notebook"
  >>;
  ledgers: Array<{
    id: string;
    capabilityKey: string;
    gaps: unknown;
    sourceId: string;
  }>;
}) {
  const gapsBySourceCapability = new Map<string, string[]>();
  for (const subsystem of input.synthesis) {
    if (!subsystem.coverageGaps.length) continue;
    const key = JSON.stringify([subsystem.sourceId, subsystem.subsystemKey]);
    gapsBySourceCapability.set(key, Array.from(new Set([
      ...(gapsBySourceCapability.get(key) ?? []),
      ...subsystem.coverageGaps,
    ])));
  }
  return input.ledgers.flatMap((ledger) => {
    const coverageGaps = gapsBySourceCapability.get(
      JSON.stringify([ledger.sourceId, ledger.capabilityKey]),
    );
    if (!coverageGaps?.length) return [];
    return [{
      id: ledger.id,
      gaps: Array.from(new Set([
        ...stringArray(ledger.gaps),
        ...coverageGaps,
      ])),
    }];
  });
}

export function synthesisReconciliationScopeKey(
  subsystem: Pick<SynthesizedKnowledge, "sourceId" | "subsystemKey">,
) {
  return JSON.stringify([
    subsystem.sourceId,
    subsystem.subsystemKey,
  ]);
}

export function synthesisCandidateReconciliationKey(
  kind: "fact" | "highlight",
  subsystem: Pick<SynthesizedKnowledge, "sourceId" | "subsystemKey" | "synthesisKey">,
  index: number,
) {
  return JSON.stringify([
    subsystem.sourceId,
    subsystem.subsystemKey,
    subsystem.synthesisKey ?? null,
    kind,
    index,
  ]);
}

export function synthesisProducedEntityLedgerWhere(
  runId: string,
  subsystem: Pick<SynthesizedKnowledge, "sourceId" | "subsystemKey">,
): Prisma.RepositoryCapabilityLedgerWhereInput {
  return {
    refreshRunId: runId,
    capabilityKey: subsystem.subsystemKey,
    snapshot: { sourceId: subsystem.sourceId },
  };
}

export function synthesisProducedEntityBuckets(
  synthesis: Array<Pick<SynthesizedKnowledge, "sourceId" | "subsystemKey" | "capabilityFunnel">>,
) {
  const buckets = new Map<string, {
    projectFactIds: string[];
    highlightIds: string[];
    capabilityFunnel?: SynthesizedKnowledge["capabilityFunnel"];
  }>();
  for (const subsystem of synthesis) {
    const key = synthesisReconciliationScopeKey(subsystem);
    const current = buckets.get(key) ?? {
      projectFactIds: [],
      highlightIds: [],
    };
    const capabilityFunnel = mergeRepositoryCapabilityFunnelTraces([
      current.capabilityFunnel,
      subsystem.capabilityFunnel,
    ]);
    buckets.set(key, {
      ...current,
      ...(capabilityFunnel ? { capabilityFunnel } : {}),
    });
  }
  return buckets;
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
        select: {
          id: true,
          capabilityKey: true,
          gaps: true,
          snapshot: { select: { sourceId: true } },
        },
      }),
    ]);
    const ledgerUpdates = synthesisCoverageLedgerGapUpdates({
      synthesis,
      ledgers: ledgers.map((ledger) => ({
        id: ledger.id,
        capabilityKey: ledger.capabilityKey,
        gaps: ledger.gaps,
        sourceId: ledger.snapshot.sourceId,
      })),
    });
    for (const ledger of ledgerUpdates) {
      await tx.repositoryCapabilityLedger.update({
        where: { id: ledger.id },
        data: {
          status: "partial",
          gaps: toInputJson(ledger.gaps),
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
  // Sensitivity is monotonic across synthesis. A later model may narrow a
  // claim, but it cannot clear the protection attached to any cited source.
  if (sources.some((source) => source.sensitivityFlag === true)) return true;
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

type ReconciliationKnowledgeChangeInput = {
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
};

function reconciliationKnowledgeChangeInput(
  input: ReconciliationKnowledgeChangeInput,
): ReviewableKnowledgeChangeInput {
  const idempotencyKey = `${input.refreshRunId ?? "direct"}:${input.entityKind}:${input.action}:${input.suffix}`;
  return {
    workItemId: input.workItemId,
    refreshRunId: input.refreshRunId ?? null,
    entityKind: input.entityKind,
    action: input.action,
    entityId: input.entityId,
    beforeSnapshot: input.beforeSnapshot,
    afterSnapshot: input.afterSnapshot,
    reason: input.reason,
    provenance: input.provenance,
    downstreamImpact: input.downstreamImpact,
    policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
    modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
    idempotencyKey,
  };
}

async function recordChange(
  input: ReconciliationKnowledgeChangeInput,
  client?: Prisma.TransactionClient,
) {
  const change = reconciliationKnowledgeChangeInput(input);
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
  metadata?: unknown;
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
  candidateMetadata: RepositoryKnowledgeMetadata;
  subsystemKey: string;
  existing: ExistingProjectFactForReconciliation[];
}) {
  return input.existing
    .filter((fact) => {
      const identity = repositoryKnowledgeIdentityRelation({
        priorMetadata: fact.metadata,
        candidateMetadata: input.candidateMetadata,
        priorEvidenceSourceIds: fact.evidence.map((entry) =>
          entry.evidenceItem.sourceId
        ),
      });
      return identity === "same_operation" ||
        (identity === "compatible_legacy" &&
          fact.subsystemKey === input.subsystemKey);
    })
    .map((fact) => ({
      fact,
      score: knowledgeSimilarity(input.candidate.statement, fact.statement),
    }))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function closestHighlight(input: {
  text: string;
  candidateMetadata: RepositoryKnowledgeMetadata;
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
      if (!repositoryMayReconcileHighlight(highlight)) return true;
      const identity = repositoryKnowledgeIdentityRelation({
        priorMetadata: highlight.metadata,
        candidateMetadata: input.candidateMetadata,
        priorEvidenceSourceIds: highlight.evidence.map((entry) =>
          entry.evidenceItem.sourceId
        ),
      });
      return identity === "same_operation" ||
        (identity === "compatible_legacy" &&
          metadata?.subsystemKey === input.subsystemKey);
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
    ...(fact.metadata !== undefined
      ? {
          metadata: {
            equals: fact.metadata === null
              ? Prisma.DbNull
              : fact.metadata as Prisma.InputJsonValue,
          },
        }
      : {}),
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

export async function applyFact(input: {
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
  const metadata = repositoryClaimMetadata(input);
  const existing = await prisma.projectFact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
    },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const closest = closestProjectFact({
    candidate: input.candidate,
    candidateMetadata: metadata,
    subsystemKey: input.subsystem.subsystemKey,
    existing,
  });
  const unsafe = isSynthesizedCandidateUnsafe({
    approvalEligible: input.subsystem.approvalEligible,
    candidate: input.candidate,
    sources: input.sourceEntries,
  });
  const stateMatches = closest
    ? repositoryKnowledgeStateMatches({
        priorMetadata: closest.fact.metadata,
        candidateMetadata: metadata,
      })
    : false;
  const exact = closest && stateMatches && closest.score >= 0.9 && normalizeWhitespace(closest.fact.statement).toLowerCase() === normalizeWhitespace(input.candidate.statement).toLowerCase();
  const validatesUserEdit = Boolean(
    closest &&
    stateMatches &&
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
          reviewState: closest.fact.reviewState,
          validatedThroughSha: input.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          metadata: toInputJson(metadata),
          subsystemKey: input.subsystem.subsystemKey,
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
      await recordAutoResolvedKnowledgeChangesInTransaction([
        reconciliationKnowledgeChangeInput({
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
            metadata: closest.fact.metadata,
            subsystemKey: closest.fact.subsystemKey,
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
            reviewState: closest.fact.reviewState,
            approvalSource: closest.fact.approvalSource,
            metadata,
            subsystemKey: input.subsystem.subsystemKey,
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
            repositoryKnowledge: metadata,
          },
          suffix: `${closest.fact.id}:${input.commitSha}:${repositoryClaimMetadataDigest(metadata)}`,
        }),
      ], tx);
      return true;
    });
    return applied ? closest.fact.id : null;
  }

  const supersedes = input.allowCanonicalReplacement && !unsafe && closest && closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
    ? closest.fact
    : null;
  const creationPlan = newProjectFactPlan({
    ...input,
    key: "single-project-fact",
  }, { unsafe, supersedes });
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
        ...creationPlan.data,
        evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
      },
    });
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    await upsertReviewableKnowledgeChangeInTransaction(creationPlan.change, tx);
    return created;
  });
  if (!fact) return null;
  // Quarantined facts are deliberately excluded from retrieval. Avoid paying
  // for an embedding that cannot be used; the review service creates one if a
  // user later edits and activates the candidate.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    if (input.enqueueEmbedding) input.enqueueEmbedding(creationPlan.embeddingTask);
    else await creationPlan.embeddingTask.execute();
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
  const repositoryMetadata = repositoryClaimMetadata(input);
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
  const presentation = newHighlightPresentation(input, unsafe);
  const { text } = presentation;
  const existing = await prisma.highlight.findMany({
    where: { workItemId: input.workItemId, lifecycleStatus: { in: ["active", "needs_validation"] } },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const closest = closestHighlight({
    text,
    candidateMetadata: repositoryMetadata,
    subsystemKey: input.subsystem.subsystemKey,
    existing,
  });
  const stateMatches = closest
    ? repositoryKnowledgeStateMatches({
        priorMetadata: closest.highlight.metadata,
        candidateMetadata: repositoryMetadata,
      })
    : false;
  const exact = Boolean(
    closest &&
    stateMatches &&
    closest.score >= 0.9 &&
    normalizeWhitespace(closest.highlight.text).toLowerCase() === normalizeWhitespace(text).toLowerCase(),
  );
  const validatesUserEdit = Boolean(
    closest &&
    stateMatches &&
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
    const metadata = mergeRepositoryClaimMetadata(
      closest.highlight.metadata,
      repositoryMetadata,
    );
    const applied = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      const validatedAt = new Date();
      const claimed = await tx.highlight.updateMany({
        where: highlightReconciliationCasWhere(closest.highlight),
        data: {
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: closest.highlight.reviewState,
          validatedThroughSha: input.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          metadata,
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
      await recordAutoResolvedKnowledgeChangesInTransaction([
        reconciliationKnowledgeChangeInput({
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
            metadata: closest.highlight.metadata,
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
            reviewState: closest.highlight.reviewState,
            approvalSource: closest.highlight.approvalSource,
            metadata,
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
            repositoryKnowledge: repositoryMetadata,
          },
          suffix: `${closest.highlight.id}:${input.commitSha}:${repositoryClaimMetadataDigest(repositoryMetadata)}`,
        }),
      ], tx);
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
  const creationPlan = newHighlightPlan({
    ...input,
    key: "single-highlight",
  }, { unsafe, supersedes, presentation });
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
        ...creationPlan.data,
        evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
        tags: {
          create: creationPlan.tags.map((tag) => ({
            dimension: tag.dimension,
            tag: tag.tag,
            score: tag.score ?? null,
          })),
        },
      },
    });
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    await upsertReviewableKnowledgeChangeInTransaction(creationPlan.change, tx);
    return created;
  });
  if (!highlight) return null;
  // Quarantined Highlights likewise cannot enter retrieval until review, so
  // defer their embedding instead of creating an immediately unused vector.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    if (input.enqueueEmbedding) input.enqueueEmbedding(creationPlan.embeddingTask);
    else await creationPlan.embeddingTask.execute();
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
  funnelCandidateRef?: string;
};

function repositoryHighlightFunnelCandidateRef(
  subsystem: SynthesizedKnowledge,
  highlight: SynthesizedKnowledge["highlights"][number],
) {
  const factIndex = subsystem.facts.findIndex((fact) =>
    normalizeWhitespace(fact.statement).toLowerCase() ===
      normalizeWhitespace(highlight.summary).toLowerCase() &&
    JSON.stringify(fact.citationIndexes) === JSON.stringify(highlight.citationIndexes)
  );
  if (factIndex < 0) return undefined;
  return subsystem.capabilityFunnel?.highlights.decisions.find((decision) =>
    decision.factIndex === factIndex && decision.outcome === "selected"
  )?.candidateRef;
}

type NewProjectFactInput = PreparedFactReconciliation & {
  runId: string;
  workItemId: string;
};

function repositoryKnowledgeChangeScopeDigest(
  subsystem: Pick<SynthesizedKnowledge, "sourceId" | "subsystemKey">,
  text: string,
) {
  return hash(JSON.stringify({
    sourceId: subsystem.sourceId,
    subsystemKey: subsystem.subsystemKey,
    text: normalizeWhitespace(text),
  })).slice(0, 16);
}

function newProjectFactPlan(
  input: NewProjectFactInput,
  options: {
    unsafe: boolean;
    supersedes?: Pick<ExistingProjectFactForReconciliation, "id" | "statement"> | null;
  },
) {
  const id = randomUUID();
  const validatedAt = new Date();
  const metadata = repositoryClaimMetadata(input);
  const data = {
    id,
    workItemId: input.workItemId,
    statement: input.candidate.statement,
    category: input.candidate.category,
    confidence: input.candidate.confidence,
    status: options.unsafe ? "draft" as const : "approved" as const,
    lifecycleStatus: options.unsafe ? "quarantined" as const : "active" as const,
    reviewState: "pending_review" as const,
    approvalSource: "automation" as const,
    publicSafetyStatus: "not_eligible" as const,
    sensitivityFlag: input.candidate.sensitivityFlag,
    reviewNotes: input.candidate.reviewNotes,
    metadata: toInputJson(metadata),
    searchText: normalizeWhitespace([
      input.candidate.statement,
      input.candidate.category,
      input.candidate.reviewNotes ?? "",
    ].join(" ")),
    supersedesProjectFactId: options.supersedes?.id,
    subsystemKey: input.subsystem.subsystemKey,
    validatedThroughSha: input.commitSha,
    lastValidatedAt: validatedAt,
    validationHeads: toInputJson(input.validationHeads),
    autoAppliedAt: options.unsafe ? null : validatedAt,
    productImportance: input.candidate.productImportance,
    implementationBreadth: input.candidate.implementationBreadth,
    technicalDifficulty: input.candidate.technicalDifficulty,
    distinctiveness: input.candidate.distinctiveness,
  } satisfies Prisma.ProjectFactCreateManyInput;
  const change = reconciliationKnowledgeChangeInput({
    workItemId: input.workItemId,
    refreshRunId: input.runId,
    entityKind: "project_fact",
    action: options.unsafe ? "quarantined" : options.supersedes ? "updated" : "created",
    entityId: id,
    beforeSnapshot: options.supersedes
      ? { id: options.supersedes.id, statement: options.supersedes.statement }
      : undefined,
    afterSnapshot: {
      id,
      statement: data.statement,
      category: data.category,
      confidence: data.confidence,
      metadata,
      lifecycleStatus: data.lifecycleStatus,
    },
    reason: options.unsafe
      ? "The generated Project Fact failed an automatic safety gate."
      : options.supersedes
        ? "Current repository evidence produced a verified successor."
        : "Current repository evidence supported a new Project Fact.",
    provenance: {
      evidenceIds: input.evidenceIds,
      commitSha: input.commitSha,
      subsystemKey: input.subsystem.subsystemKey,
      repositoryKnowledge: metadata,
    },
    suffix: `${repositoryKnowledgeChangeScopeDigest(
      input.subsystem,
      data.statement,
    )}:${input.commitSha}:${repositoryClaimMetadataDigest(metadata)}`,
  });
  const embeddingTask: KnowledgeEmbeddingTask = {
    entityKind: "project_fact",
    entityId: id,
    execute: () => upsertProjectFactEmbedding({
      projectFactId: id,
      inputText: buildProjectFactEmbeddingText(data),
      skipFreshnessCheck: true,
    }),
  };
  return { entry: input, id, data, change, embeddingTask };
}

type NewHighlightInput = PreparedHighlightReconciliation & {
  runId: string;
  workItemId: string;
};

function newHighlightPresentation(
  input: Pick<NewHighlightInput, "candidate">,
  unsafe: boolean,
) {
  const publicVerification = repositoryHighlightPublicDisposition(unsafe);
  const text = publicVerification.eligible && publicVerification.correctedText
    ? publicVerification.correctedText
    : input.candidate.text;
  const verificationNotes = "Auto-applied from complete, commit-pinned repository coverage.";
  const tags = inferHighlightTags({
    text,
    summary: input.candidate.summary,
    verificationNotes: publicVerification.reasons.join(" ") || "Verified from complete repository coverage.",
  });
  return { publicVerification, text, verificationNotes, tags };
}

function newHighlightPlan(
  input: NewHighlightInput,
  options: {
    unsafe: boolean;
    supersedes?: Pick<ExistingHighlightForReconciliation, "id" | "text"> | null;
    presentation?: ReturnType<typeof newHighlightPresentation>;
  },
) {
  const id = randomUUID();
  const validatedAt = new Date();
  const presentation = options.presentation ?? newHighlightPresentation(input, options.unsafe);
  const repositoryMetadata = repositoryClaimMetadata(input);
  const data = {
    id,
    workItemId: input.workItemId,
    text: presentation.text,
    summary: input.candidate.summary,
    searchText: normalizeWhitespace([
      presentation.text,
      input.candidate.summary,
      input.subsystem.subsystemKey,
    ].join(" ")),
    confidence: input.candidate.confidence,
    ownershipClarity: "unclear" as const,
    sensitivityFlag: input.candidate.sensitivityFlag,
    verificationStatus: options.unsafe ? "flagged" as const : "approved" as const,
    lifecycleStatus: options.unsafe ? "quarantined" as const : "active" as const,
    reviewState: "pending_review" as const,
    approvalSource: "automation" as const,
    publicSafetyStatus: presentation.publicVerification.eligible
      ? "verified" as const
      : presentation.publicVerification.reasons.length
        ? "failed" as const
        : "pending" as const,
    visibility: presentation.publicVerification.eligible
      ? input.candidate.visibility
      : "private" as const,
    risksSummary: presentation.publicVerification.reasons.join(" ").slice(0, 1_000) || null,
    verificationNotes: presentation.verificationNotes,
    metadata: toInputJson({
      ...repositoryMetadata,
      scores: {
        productImportance: input.candidate.productImportance,
        implementationBreadth: input.candidate.implementationBreadth,
        technicalDifficulty: input.candidate.technicalDifficulty,
        distinctiveness: input.candidate.distinctiveness,
      },
      publicVerification: presentation.publicVerification,
    }),
    validatedThroughSha: input.commitSha,
    lastValidatedAt: validatedAt,
    validationHeads: toInputJson(input.validationHeads),
    autoAppliedAt: options.unsafe ? null : validatedAt,
    supersedesHighlightId: options.supersedes?.id,
  } satisfies Prisma.HighlightCreateManyInput;
  const change = reconciliationKnowledgeChangeInput({
    workItemId: input.workItemId,
    refreshRunId: input.runId,
    entityKind: "highlight",
    action: options.unsafe ? "quarantined" : options.supersedes ? "updated" : "created",
    entityId: id,
    beforeSnapshot: options.supersedes
      ? { id: options.supersedes.id, text: options.supersedes.text }
      : undefined,
    afterSnapshot: {
      id,
      text: data.text,
      summary: data.summary,
      metadata: data.metadata,
      lifecycleStatus: data.lifecycleStatus,
      publicSafetyStatus: data.publicSafetyStatus,
    },
    reason: options.unsafe
      ? "The generated Highlight failed an automatic safety gate."
      : options.supersedes
        ? "Current repository evidence produced a verified Highlight successor."
        : "Current repository evidence supported a new Highlight.",
    provenance: {
      evidenceIds: input.evidenceIds,
      commitSha: input.commitSha,
      subsystemKey: input.subsystem.subsystemKey,
      repositoryKnowledge: repositoryMetadata,
    },
    suffix: `${repositoryKnowledgeChangeScopeDigest(
      input.subsystem,
      data.text,
    )}:${input.commitSha}:${repositoryClaimMetadataDigest(repositoryMetadata)}`,
  });
  const embeddingTask: KnowledgeEmbeddingTask = {
    entityKind: "highlight",
    entityId: id,
    execute: () => upsertHighlightEmbedding({
      highlightId: id,
      inputText: buildHighlightEmbeddingText({
        text: data.text,
        summary: data.summary,
        verificationNotes: data.verificationNotes,
        tags: presentation.tags,
        evidence: {
          summary: input.candidate.summary,
          sourceRefs: input.evidence.map((entry, index) => ({
            evidenceItemId: input.evidenceIds[index] ?? "",
            sourceId: "repository-sync",
            sourceType: "github_repo" as const,
            title: entry.title,
            sourceLabel: "GitHub",
            excerpt: entry.excerpt,
          })),
        },
      }),
      skipFreshnessCheck: true,
    }),
  };
  return {
    entry: input,
    id,
    data,
    change,
    embeddingTask,
    tags: presentation.tags,
    presentation,
  };
}

function collidingColdCandidateKeys<T extends {
  key: string;
  subsystem: Pick<SynthesizedKnowledge, "subsystemKey">;
}>(
  entries: readonly T[],
  text: (entry: T) => string,
) {
  const collisions = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    for (const other of entries.slice(index + 1)) {
      if (
        entry.subsystem.subsystemKey === other.subsystem.subsystemKey &&
        knowledgeSimilarity(text(entry), text(other)) >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
      ) {
        collisions.add(entry.key);
        collisions.add(other.key);
      }
    }
  }
  return collisions;
}

/**
 * A genuinely cold Work Item has no active repository knowledge to compare,
 * revalidate, or supersede. Create its independent safe candidates in one
 * generation-fenced transaction, while leaving every ownership-sensitive,
 * unsafe, uncited, or identity-colliding candidate on the established CAS
 * path. The under-lock emptiness check closes the race with a user mutation
 * that may have committed after the caller loaded its reconciliation snapshot.
 */
export async function createColdKnowledgeBatch(input: {
  runId: string;
  workItemId: string;
  facts: PreparedFactReconciliation[];
  highlights: PreparedHighlightReconciliation[];
  enqueueEmbedding?: (task: KnowledgeEmbeddingTask) => void;
}) {
  const safeFacts = input.facts.filter((entry) =>
    hasPromotedReconciliationEvidence(entry.evidenceIds) &&
    !isSynthesizedCandidateUnsafe({
      approvalEligible: entry.subsystem.approvalEligible,
      candidate: entry.candidate,
      sources: entry.sourceEntries,
    })
  );
  const collidingFactKeys = collidingColdCandidateKeys(
    safeFacts,
    (entry) => entry.candidate.statement,
  );
  const factPlans = safeFacts
    .filter((entry) => !collidingFactKeys.has(entry.key))
    .map((entry) => newProjectFactPlan({
      ...entry,
      runId: input.runId,
      workItemId: input.workItemId,
    }, { unsafe: false }));

  const safeHighlights = input.highlights.filter((entry) =>
    hasPromotedReconciliationEvidence(entry.evidenceIds) &&
    !isSynthesizedCandidateUnsafe({
      approvalEligible: entry.subsystem.approvalEligible,
      candidate: entry.candidate,
      sources: entry.sourceEntries,
    })
  );
  const collidingHighlightKeys = collidingColdCandidateKeys(
    safeHighlights,
    (entry) => entry.candidate.text,
  );
  const highlightPlans = safeHighlights
    .filter((entry) => !collidingHighlightKeys.has(entry.key))
    .map((entry) => newHighlightPlan({
      ...entry,
      runId: input.runId,
      workItemId: input.workItemId,
    }, { unsafe: false }));

  const createdFactIdsByKey = new Map<string, string>();
  const createdHighlightIdsByKey = new Map<string, string>();
  if (!factPlans.length && !highlightPlans.length) {
    return { createdFactIdsByKey, createdHighlightIdsByKey };
  }

  const createdPlans = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
    const [currentFact, currentHighlight] = await Promise.all([
      factPlans.length
        ? tx.projectFact.findFirst({
            where: {
              workItemId: input.workItemId,
              lifecycleStatus: { in: ["active", "needs_validation"] },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      highlightPlans.length
        ? tx.highlight.findFirst({
            where: {
              workItemId: input.workItemId,
              lifecycleStatus: { in: ["active", "needs_validation"] },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const factsToCreate = currentFact ? [] : factPlans;
    const highlightsToCreate = currentHighlight ? [] : highlightPlans;
    if (!factsToCreate.length && !highlightsToCreate.length) {
      return { facts: [], highlights: [] };
    }

    if (factsToCreate.length) {
      const created = await tx.projectFact.createMany({
        data: factsToCreate.map((plan) => plan.data),
      });
      if (created.count !== factsToCreate.length) {
        throw new Error("Cold Project Fact batch did not create every planned row.");
      }
    }
    if (highlightsToCreate.length) {
      const created = await tx.highlight.createMany({
        data: highlightsToCreate.map((plan) => plan.data),
      });
      if (created.count !== highlightsToCreate.length) {
        throw new Error("Cold Highlight batch did not create every planned row.");
      }
    }

    const factEvidenceRows = factsToCreate.flatMap(({ entry, id }) =>
      entry.evidenceIds.map((evidenceItemId) => ({
        projectFactId: id,
        evidenceItemId,
      }))
    );
    const highlightEvidenceRows = highlightsToCreate.flatMap(({ entry, id }) =>
      entry.evidenceIds.map((evidenceItemId) => ({
        highlightId: id,
        evidenceItemId,
      }))
    );
    const highlightTagRows = highlightsToCreate.flatMap(({ id, tags }) =>
      tags.map((tag) => ({
        highlightId: id,
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score ?? null,
      }))
    );
    await Promise.all([
      factEvidenceRows.length
        ? tx.projectFactEvidence.createMany({ data: factEvidenceRows, skipDuplicates: true })
        : Promise.resolve(),
      highlightEvidenceRows.length
        ? tx.highlightEvidence.createMany({ data: highlightEvidenceRows, skipDuplicates: true })
        : Promise.resolve(),
      highlightTagRows.length
        ? tx.highlightTag.createMany({ data: highlightTagRows, skipDuplicates: true })
        : Promise.resolve(),
    ]);
    const includedEvidenceIds = Array.from(new Set([
      ...factsToCreate.flatMap(({ entry }) => entry.evidenceIds),
      ...highlightsToCreate.flatMap(({ entry }) => entry.evidenceIds),
    ]));
    if (includedEvidenceIds.length) {
      await tx.evidenceItem.updateMany({
        where: { id: { in: includedEvidenceIds } },
        data: { included: true },
      });
    }

    await upsertReviewableKnowledgeChangesInTransaction([
      ...factsToCreate.map((plan) => plan.change),
      ...highlightsToCreate.map((plan) => plan.change),
    ], tx);
    return { facts: factsToCreate, highlights: highlightsToCreate };
  }, { timeoutMs: 45_000 });

  for (const plan of createdPlans.facts) {
    createdFactIdsByKey.set(plan.entry.key, plan.id);
  }
  for (const plan of createdPlans.highlights) {
    createdHighlightIdsByKey.set(plan.entry.key, plan.id);
  }

  if (createdFactIdsByKey.size || createdHighlightIdsByKey.size) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
  }
  for (const plan of factPlans) {
    if (!createdFactIdsByKey.has(plan.entry.key)) continue;
    if (input.enqueueEmbedding) input.enqueueEmbedding(plan.embeddingTask);
    else await plan.embeddingTask.execute();
  }
  for (const plan of highlightPlans) {
    if (!createdHighlightIdsByKey.has(plan.entry.key)) continue;
    if (input.enqueueEmbedding) input.enqueueEmbedding(plan.embeddingTask);
    else await plan.embeddingTask.execute();
  }
  return { createdFactIdsByKey, createdHighlightIdsByKey };
}

/**
 * Revalidating unchanged knowledge is lifecycle maintenance, not a new review
 * decision. Apply all exact/user-edit-preserving matches under one generation
 * fence and record their audit rows already resolved. This replaces one
 * serializable transaction per Fact/Highlight with one transaction per cold
 * refresh while keeping every row-level CAS and immutable provenance link.
 */
export async function revalidateExistingKnowledge(input: {
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
    const candidateMetadata = repositoryClaimMetadata({
      runId: input.runId,
      subsystem: entry.subsystem,
      sourceEntries: entry.sourceEntries,
    });
    const closest = closestProjectFact({
      candidate: entry.candidate,
      candidateMetadata,
      subsystemKey: entry.subsystem.subsystemKey,
      existing: input.existingFacts,
    });
    const stateMatches = closest
      ? repositoryKnowledgeStateMatches({
          priorMetadata: closest.fact.metadata,
          candidateMetadata,
        })
      : false;
    const unsafe = isSynthesizedCandidateUnsafe({
      approvalEligible: entry.subsystem.approvalEligible,
      candidate: entry.candidate,
      sources: entry.sourceEntries,
    });
    const exact = Boolean(
      closest &&
      stateMatches &&
      closest.score >= 0.9 &&
      normalizeWhitespace(closest.fact.statement).toLowerCase() ===
        normalizeWhitespace(entry.candidate.statement).toLowerCase(),
    );
    const validatesUserEdit = Boolean(
      closest &&
      stateMatches &&
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
    const candidateMetadata = repositoryClaimMetadata({
      runId: input.runId,
      subsystem: entry.subsystem,
      sourceEntries: entry.sourceEntries,
    });
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
      candidateMetadata,
      subsystemKey: entry.subsystem.subsystemKey,
      existing: input.existingHighlights,
    });
    const stateMatches = closest
      ? repositoryKnowledgeStateMatches({
          priorMetadata: closest.highlight.metadata,
          candidateMetadata,
        })
      : false;
    const exact = Boolean(
      closest &&
      stateMatches &&
      closest.score >= 0.9 &&
      normalizeWhitespace(closest.highlight.text).toLowerCase() ===
        normalizeWhitespace(text).toLowerCase(),
    );
    const validatesUserEdit = Boolean(
      closest &&
      stateMatches &&
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

  const applied = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
    const appliedFactIdsByKey = new Map<string, string>();
    const appliedHighlightIdsByKey = new Map<string, string>();
    const validatedAt = new Date();
    const changeInputs: AutoResolvedKnowledgeChangeInput[] = [];
    const evidenceIds = new Set<string>();
    const factEvidenceRows: Array<{ projectFactId: string; evidenceItemId: string }> = [];
    const highlightEvidenceRows: Array<{ highlightId: string; evidenceItemId: string }> = [];

    for (const { entry, closest, validatesUserEdit } of factMatches) {
      const metadata = repositoryClaimMetadata({
        runId: input.runId,
        subsystem: entry.subsystem,
        sourceEntries: entry.sourceEntries,
      });
      const claimed = await tx.projectFact.updateMany({
        where: projectFactReconciliationCasWhere(closest.fact),
        data: {
          status: "approved",
          lifecycleStatus: "active",
          reviewState: closest.fact.reviewState,
          validatedThroughSha: entry.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(entry.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          metadata: toInputJson(metadata),
          subsystemKey: entry.subsystem.subsystemKey,
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
          reviewState: closest.fact.reviewState,
          approvalSource: closest.fact.approvalSource,
          metadata: closest.fact.metadata,
          subsystemKey: closest.fact.subsystemKey,
          validatedThroughSha: closest.fact.validatedThroughSha,
        },
        afterSnapshot: {
          id: closest.fact.id,
          statement: closest.fact.statement,
          status: "approved",
          lifecycleStatus: "active",
          reviewState: closest.fact.reviewState,
          approvalSource: closest.fact.approvalSource,
          metadata,
          subsystemKey: entry.subsystem.subsystemKey,
          validatedThroughSha: entry.commitSha,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Project Fact without replacing its wording."
          : "Current repository evidence revalidated this Project Fact.",
        provenance: {
          evidenceIds: entry.evidenceIds,
          commitSha: entry.commitSha,
          preservedUserEdit: validatesUserEdit,
          repositoryKnowledge: metadata,
        },
        policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
        modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
        idempotencyKey: `project_fact:content-addressed:${closest.fact.id}:${hash([
          closest.fact.statement,
          entry.commitSha,
          repositoryClaimMetadataDigest(metadata),
          ...entry.evidenceIds.slice().sort(),
        ].join("|")).slice(0, 24)}`,
      });
    }

    for (const { entry, closest, validatesUserEdit } of highlightMatches) {
      const repositoryMetadata = repositoryClaimMetadata({
        runId: input.runId,
        subsystem: entry.subsystem,
        sourceEntries: entry.sourceEntries,
      });
      const metadata = mergeRepositoryClaimMetadata(
        closest.highlight.metadata,
        repositoryMetadata,
      );
      const claimed = await tx.highlight.updateMany({
        where: highlightReconciliationCasWhere(closest.highlight),
        data: {
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: closest.highlight.reviewState,
          validatedThroughSha: entry.commitSha,
          lastValidatedAt: validatedAt,
          validationHeads: toInputJson(entry.validationHeads),
          autoAppliedAt: validatedAt,
          rejectionReason: null,
          metadata,
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
          reviewState: closest.highlight.reviewState,
          approvalSource: closest.highlight.approvalSource,
          metadata: closest.highlight.metadata,
          validatedThroughSha: closest.highlight.validatedThroughSha,
        },
        afterSnapshot: {
          id: closest.highlight.id,
          text: closest.highlight.text,
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: closest.highlight.reviewState,
          approvalSource: closest.highlight.approvalSource,
          metadata,
          validatedThroughSha: entry.commitSha,
        },
        reason: validatesUserEdit
          ? "Current repository evidence revalidated the user-edited Highlight without replacing its wording."
          : "Current repository evidence revalidated this Highlight.",
        provenance: {
          evidenceIds: entry.evidenceIds,
          commitSha: entry.commitSha,
          preservedUserEdit: validatesUserEdit,
          repositoryKnowledge: repositoryMetadata,
        },
        policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
        modelId: resolveActiveTextModelIdentity("deep_synthesis").modelId,
        idempotencyKey: `highlight:content-addressed:${closest.highlight.id}:${hash([
          closest.highlight.text,
          entry.commitSha,
          repositoryClaimMetadataDigest(repositoryMetadata),
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
    return { appliedFactIdsByKey, appliedHighlightIdsByKey };
  }, { timeoutMs: 45_000 });

  return { matchedKeys, ...applied };
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
        key: synthesisCandidateReconciliationKey("fact", subsystem, index),
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
        key: synthesisCandidateReconciliationKey("highlight", subsystem, index),
        subsystem,
        candidate,
        evidenceIds,
        evidence,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
        validationHeads,
        sourceEntries: citedEntries,
        funnelCandidateRef: repositoryHighlightFunnelCandidateRef(subsystem, candidate),
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
  const batchedColdCreates = await createColdKnowledgeBatch({
    runId,
    workItemId: run.workItemId,
    facts: existingFacts.length ? [] : preparedFacts,
    highlights: existingHighlights.length ? [] : preparedHighlights,
    enqueueEmbedding,
  });
  const producedByScope = synthesisProducedEntityBuckets(synthesis);
  const materializedHighlightIdByCandidateRef = new Map<string, string>();
  const recordMaterializedHighlight = (
    entry: PreparedHighlightReconciliation,
    highlightId: string,
  ) => {
    if (entry.funnelCandidateRef) {
      materializedHighlightIdByCandidateRef.set(entry.funnelCandidateRef, highlightId);
    }
  };
  for (const entry of preparedFacts) {
    const batchedId = batchedRevalidations.appliedFactIdsByKey.get(entry.key);
    if (batchedId) {
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.projectFactIds.push(batchedId);
      continue;
    }
    const coldCreatedId = batchedColdCreates.createdFactIdsByKey.get(entry.key);
    if (coldCreatedId) {
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.projectFactIds.push(coldCreatedId);
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
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.projectFactIds.push(factId);
    }
  }
  for (const entry of preparedHighlights) {
    const batchedId = batchedRevalidations.appliedHighlightIdsByKey.get(entry.key);
    if (batchedId) {
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.highlightIds.push(batchedId);
      recordMaterializedHighlight(entry, batchedId);
      continue;
    }
    const coldCreatedId = batchedColdCreates.createdHighlightIdsByKey.get(entry.key);
    if (coldCreatedId) {
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.highlightIds.push(coldCreatedId);
      recordMaterializedHighlight(entry, coldCreatedId);
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
      producedByScope.get(synthesisReconciliationScopeKey(entry.subsystem))?.highlightIds.push(highlightId);
      recordMaterializedHighlight(entry, highlightId);
    }
  }
  finishStage("knowledgeApplication");
  const results = synthesis.map((subsystem) => {
    const produced = producedByScope.get(synthesisReconciliationScopeKey(subsystem)) ?? {
      projectFactIds: [],
      highlightIds: [],
    };
    const capabilityFunnel = reconcileRepositoryCapabilityFunnelMaterialization(
      produced.capabilityFunnel,
      materializedHighlightIdByCandidateRef,
    );
    return {
      subsystem,
      produced: {
        ...produced,
        ...(capabilityFunnel ? { capabilityFunnel } : {}),
      },
    };
  });
  await withKnowledgeRefreshGenerationFence(runId, async (tx) => {
    for (const { subsystem, produced } of results) {
      await tx.repositoryCapabilityLedger.updateMany({
        where: synthesisProducedEntityLedgerWhere(runId, subsystem),
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
            batchedFactCreateCount: batchedColdCreates.createdFactIdsByKey.size,
            batchedHighlightCreateCount: batchedColdCreates.createdHighlightIdsByKey.size,
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
