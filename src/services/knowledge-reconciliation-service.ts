import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import { resolveBedrockConfig } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  recordAutoResolvedKnowledgeChanges,
  upsertReviewableKnowledgeChange,
  type AutoResolvedKnowledgeChangeInput,
} from "@/src/services/knowledge-change-service";
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
  materializeSynthesisCitations,
  synthesisNotebookReferenceKey,
  synthesizeRepositoryKnowledge,
  type SynthesizedKnowledge,
  type SynthesisNotebookEntry,
} from "@/src/services/repository-knowledge-synthesis-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";

export const KNOWLEDGE_LIFECYCLE_POLICY_VERSION = "knowledge-lifecycle-v3";
export const STRONG_KNOWLEDGE_IDENTITY_THRESHOLD = 0.72;

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
  await client.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(
      hashtextextended(${"workbase:knowledge-refresh:" + workItemId}, 0)
    )
  `;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("The repository knowledge generation transaction could not be completed.");
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
  const gapsBySubsystem = new Map(
    synthesis
      .filter((subsystem) => subsystem.coverageGaps.length)
      .map((subsystem) => [subsystem.subsystemKey, subsystem.coverageGaps] as const),
  );
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

export function shouldQuarantineSynthesizedCandidate(candidate: {
  sensitivityFlag: boolean;
  confidence: string;
  statement?: string;
  text?: string;
  summary?: string;
}, sources: Array<Pick<SynthesisNotebookEntry, "path" | "statement" | "semanticStatus">> = []) {
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
  const modalTerms = Array.from(claim.matchAll(/\b(?:mandatory|always|never|exclusively|every|all|only)\b/gi))
    .map((match) => match[0]!.toLowerCase());
  if (!modalTerms.length) return false;
  // An unrelated executable file is not evidence for an absolute qualifier.
  // At least one executable exact-line observation must itself state every
  // qualifier used by the synthesized claim.
  const hasClauseLevelCorroboration = sources.some((source) =>
    /\.(?:[cm]?[jt]sx?|prisma|sql|py|go|rs|java)$/i.test(source.path) &&
    modalTerms.every((term) => normalizeWhitespace(source.statement).toLowerCase().includes(term))
  );
  return !hasClauseLevelCorroboration;
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
}) {
  const idempotencyKey = `${input.refreshRunId ?? "direct"}:${input.entityKind}:${input.action}:${input.suffix}`;
  return upsertReviewableKnowledgeChange({
    ...input,
    refreshRunId: input.refreshRunId ?? null,
    policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
    modelId: resolveBedrockConfig().modelId,
    idempotencyKey,
  });
}

export function recordContentAddressedRevalidations(
  inputs: ReadonlyArray<Omit<AutoResolvedKnowledgeChangeInput, "policyVersion" | "modelId" | "idempotencyKey"> & {
    contentIdentity: string;
  }>,
) {
  const modelId = resolveBedrockConfig().modelId;
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
}) {
  if (!input.evidenceIds.length) return null;
  const existing = await prisma.projectFact.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
    },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const ranked = existing
    .map((fact) => ({ fact, score: knowledgeSimilarity(input.candidate.statement, fact.statement) }))
    .sort((left, right) => right.score - left.score);
  const closest = ranked.find((entry) => entry.fact.subsystemKey === input.subsystem.subsystemKey) ?? null;
  const unsafe = !input.subsystem.approvalEligible || shouldQuarantineSynthesizedCandidate(input.candidate, input.sourceEntries);
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
    await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      await tx.projectFactEvidence.deleteMany({ where: { projectFactId: closest.fact.id } });
      await tx.projectFact.update({
        where: { id: closest.fact.id },
        data: {
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: input.commitSha,
          lastValidatedAt: new Date(),
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: new Date(),
          rejectionReason: null,
          productImportance: input.candidate.productImportance,
          implementationBreadth: input.candidate.implementationBreadth,
          technicalDifficulty: input.candidate.technicalDifficulty,
          distinctiveness: input.candidate.distinctiveness,
          evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
        },
      });
      await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    });
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
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
        autoAppliedAt: new Date(),
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
    });
    return closest.fact.id;
  }

  const supersedes = input.allowCanonicalReplacement && !unsafe && closest && closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
    ? closest.fact
    : null;
  const fact = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
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
    if (supersedes) {
      await tx.projectFact.update({ where: { id: supersedes.id }, data: { status: "superseded", lifecycleStatus: "superseded" } });
    }
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    return created;
  });
  // Quarantined facts are deliberately excluded from retrieval. Avoid paying
  // for an embedding that cannot be used; the review service creates one if a
  // user later edits and activates the candidate.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    await upsertProjectFactEmbedding({
      projectFactId: fact.id,
      inputText: buildProjectFactEmbeddingText(fact),
    });
  }
  await assertKnowledgeRefreshGenerationCurrent(input.runId);
  await recordChange({
    workItemId: input.workItemId,
    refreshRunId: input.runId,
    entityKind: "project_fact",
    action: unsafe ? "quarantined" : supersedes ? "updated" : "created",
    entityId: fact.id,
    beforeSnapshot: supersedes ? { id: supersedes.id, statement: supersedes.statement } : undefined,
    afterSnapshot: { id: fact.id, statement: fact.statement, category: fact.category, confidence: fact.confidence, lifecycleStatus: fact.lifecycleStatus },
    reason: unsafe ? "The generated Project Fact failed an automatic safety gate." : supersedes ? "Current repository evidence produced a verified successor." : "Current repository evidence supported a new Project Fact.",
    provenance: { evidenceIds: input.evidenceIds, commitSha: input.commitSha, subsystemKey: input.subsystem.subsystemKey },
    suffix: `${hash(fact.statement).slice(0, 16)}:${input.commitSha}`,
  });
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
}) {
  if (!input.evidenceIds.length) return null;
  const unsafe = !input.subsystem.approvalEligible || shouldQuarantineSynthesizedCandidate(input.candidate, input.sourceEntries);
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
  const closest = existing
    .filter((highlight) => {
      const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
        ? highlight.metadata as Record<string, unknown>
        : null;
      return metadata?.subsystemKey === input.subsystem.subsystemKey;
    })
    .map((highlight) => ({ highlight, score: knowledgeSimilarity(text, highlight.text) }))
    .sort((left, right) => right.score - left.score)[0] ?? null;
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
  if ((exact || validatesUserEdit) && !unsafe && closest) {
    await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      await tx.highlightEvidence.deleteMany({ where: { highlightId: closest.highlight.id } });
      await tx.highlight.update({
        where: { id: closest.highlight.id },
        data: {
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: input.commitSha,
          lastValidatedAt: new Date(),
          validationHeads: toInputJson(input.validationHeads),
          autoAppliedAt: new Date(),
          rejectionReason: null,
          evidence: { create: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })) },
        },
      });
      await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    });
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
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
        autoAppliedAt: new Date(),
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
    });
    return closest.highlight.id;
  }
  const supersedes = input.allowCanonicalReplacement && !unsafe && closest && closest.score >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD
    ? closest.highlight
    : null;
  const tags = inferHighlightTags({
    text,
    summary: input.candidate.summary,
    verificationNotes: publicVerification.reasons.join(" ") || "Verified from complete repository coverage.",
  });
  const highlight = await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
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
    if (supersedes) await tx.highlight.update({ where: { id: supersedes.id }, data: { lifecycleStatus: "superseded" } });
    if (!unsafe) await tx.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } });
    return created;
  });
  // Quarantined Highlights likewise cannot enter retrieval until review, so
  // defer their embedding instead of creating an immediately unused vector.
  if (!unsafe) {
    await assertKnowledgeRefreshGenerationCurrent(input.runId);
    await upsertHighlightEmbedding({
      highlightId: highlight.id,
      inputText: buildHighlightEmbeddingText({
        text: highlight.text,
        summary: highlight.summary,
        verificationNotes: highlight.verificationNotes,
        tags,
        evidence: { summary: input.candidate.summary, sourceRefs: input.evidence.map((entry, index) => ({ evidenceItemId: input.evidenceIds[index] ?? "", sourceId: "repository-sync", sourceType: "github_repo" as const, title: entry.title, sourceLabel: "GitHub", excerpt: entry.excerpt })) },
      }),
    });
  }
  await assertKnowledgeRefreshGenerationCurrent(input.runId);
  await recordChange({
    workItemId: input.workItemId,
    refreshRunId: input.runId,
    entityKind: "highlight",
    action: unsafe ? "quarantined" : supersedes ? "updated" : "created",
    entityId: highlight.id,
    beforeSnapshot: supersedes ? { id: supersedes.id, text: supersedes.text } : undefined,
    afterSnapshot: { id: highlight.id, text: highlight.text, summary: highlight.summary, lifecycleStatus: highlight.lifecycleStatus, publicSafetyStatus: highlight.publicSafetyStatus },
    reason: unsafe ? "The generated Highlight failed an automatic safety gate." : supersedes ? "Current repository evidence produced a verified Highlight successor." : "Current repository evidence supported a new Highlight.",
    provenance: { evidenceIds: input.evidenceIds, commitSha: input.commitSha, subsystemKey: input.subsystem.subsystemKey },
    suffix: `${hash(highlight.text).slice(0, 16)}:${input.commitSha}`,
  });
  return unsafe ? null : highlight.id;
}

export async function reconcileRepositoryKnowledge(runId: string) {
  await assertKnowledgeRefreshGenerationCurrent(runId);
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { workItem: { select: { userId: true } } },
  });
  if (run.status !== "reconciling") throw new Error("Repository coverage must complete before reconciliation.");
  const targets = run.targetHeads as unknown as RepositoryTargetHead[];
  const partialChanges = await prisma.knowledgeChange.count({ where: { refreshRunId: runId } });
  const synthesis = await synthesizeRepositoryKnowledge(runId, { fallbackOnly: partialChanges > 0 });
  const synthesisCoverageGaps = await persistSynthesisCoverageGaps(runId, synthesis);
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
  await assertKnowledgeRefreshGenerationCurrent(runId);
  const processSubsystem = async (subsystem: SynthesizedKnowledge) => {
    const produced = { projectFactIds: [] as string[], highlightIds: [] as string[] };
    for (const candidate of subsystem.facts) {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const validationHeads = Object.fromEntries(citedEntries.map((entry) => [entry.sourceId, entry.commitSha]));
      const factId = await applyFact({
        runId,
        workItemId: run.workItemId,
        subsystem,
        candidate,
        evidenceIds,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
        validationHeads,
        sourceEntries: citedEntries,
        allowCanonicalReplacement,
      });
      if (factId) {
        produced.projectFactIds.push(factId);
      }
    }
    for (const candidate of subsystem.highlights) {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const evidence = citationsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, materialized }).map((entry) => ({
        title: entry.label,
        excerpt: entry.excerpt,
        commitSha: entry.commitSha,
      }));
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const validationHeads = Object.fromEntries(citedEntries.map((entry) => [entry.sourceId, entry.commitSha]));
      const highlightId = await applyHighlight({
        runId,
        workItemId: run.workItemId,
        subsystem,
        candidate,
        evidenceIds,
        evidence,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
        validationHeads,
        sourceEntries: citedEntries,
        allowCanonicalReplacement,
      });
      if (highlightId) {
        produced.highlightIds.push(highlightId);
      }
    }
    return { subsystemKey: subsystem.subsystemKey, produced };
  };
  const results: Array<Awaited<ReturnType<typeof processSubsystem>>> = [];
  for (let start = 0; start < synthesis.length; start += 4) {
    results.push(...await Promise.all(synthesis.slice(start, start + 4).map(processSubsystem)));
  }
  for (const { subsystemKey, produced } of results) {
    await withKnowledgeRefreshGenerationFence(runId, (tx) =>
      tx.repositoryCapabilityLedger.updateMany({
        where: { refreshRunId: runId, capabilityKey: subsystemKey },
        data: { producedEntityRefs: toInputJson(produced) },
      })
    );
  }
  const appliedFactIds = results.flatMap((entry) => entry.produced.projectFactIds);
  const appliedHighlightIds = results.flatMap((entry) => entry.produced.highlightIds);
  return {
    synthesis,
    appliedFactIds: Array.from(new Set(appliedFactIds)),
    appliedHighlightIds: Array.from(new Set(appliedHighlightIds)),
    promotedEvidenceIds: Array.from(new Set(promotedIdByReference.values())),
    coverageGaps: synthesisCoverageGaps,
  };
}

export { recordChange };

export const knowledgeReconciliationService = { reconcile: reconcileRepositoryKnowledge };
