import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  reviewSnapshotMatchesEntity,
  upsertReviewableKnowledgeChangesInTransaction,
} from "@/src/services/knowledge-change-service";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
import { invalidateStaleEvidenceDependentsInTransaction } from "@/src/services/knowledge-dependency-service";
import {
  knowledgeSimilarity,
  recordContentAddressedRevalidations,
  recordChange,
  STRONG_KNOWLEDGE_IDENTITY_THRESHOLD,
  KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
  withKnowledgeRefreshGenerationFence,
} from "@/src/services/knowledge-reconciliation-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";
import { REPOSITORY_SEMANTIC_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

type CurrentObservation = {
  statement: string;
  path: string;
  subsystemKeys: string[];
  commitSha: string;
  sourceId: string;
};

const executableRepositoryPathPattern = /\.(?:[cm]?[jt]sx?|prisma|sql|py|go|rs|java)$/i;

type ProjectFactCasSnapshot = Pick<
  Prisma.ProjectFactModel,
  | "id"
  | "statement"
  | "status"
  | "lifecycleStatus"
  | "reviewState"
  | "approvalSource"
  | "rejectionReason"
  | "validatedThroughSha"
  | "lastValidatedAt"
  | "updatedAt"
>;

type HighlightCasSnapshot = Pick<
  Prisma.HighlightModel,
  | "id"
  | "text"
  | "summary"
  | "verificationStatus"
  | "lifecycleStatus"
  | "reviewState"
  | "approvalSource"
  | "rejectionReason"
  | "validatedThroughSha"
  | "lastValidatedAt"
  | "updatedAt"
>;

type EvidenceCasSnapshot = Pick<
  Prisma.EvidenceItemModel,
  | "id"
  | "title"
  | "content"
  | "included"
  | "lifecycleStatus"
  | "reviewState"
  | "approvalSource"
  | "validatedThroughSha"
  | "lastValidatedAt"
  | "repositorySnapshotId"
  | "purgeEligibleAt"
  | "updatedAt"
>;

type ArtifactCasSnapshot = Pick<
  Prisma.ArtifactModel,
  | "id"
  | "content"
  | "lifecycleStatus"
  | "reviewState"
  | "approvalSource"
  | "validatedThroughSha"
  | "lastValidatedAt"
  | "staleReason"
  | "updatedAt"
>;

function projectFactCasWhere(fact: ProjectFactCasSnapshot): Prisma.ProjectFactWhereInput {
  return {
    id: fact.id,
    statement: fact.statement,
    status: fact.status,
    lifecycleStatus: fact.lifecycleStatus,
    reviewState: fact.reviewState,
    approvalSource: fact.approvalSource,
    rejectionReason: fact.rejectionReason,
    validatedThroughSha: fact.validatedThroughSha,
    lastValidatedAt: fact.lastValidatedAt,
    ...(fact.updatedAt ? { updatedAt: fact.updatedAt } : {}),
  };
}

function highlightCasWhere(highlight: HighlightCasSnapshot): Prisma.HighlightWhereInput {
  return {
    id: highlight.id,
    text: highlight.text,
    summary: highlight.summary,
    verificationStatus: highlight.verificationStatus,
    lifecycleStatus: highlight.lifecycleStatus,
    reviewState: highlight.reviewState,
    approvalSource: highlight.approvalSource,
    rejectionReason: highlight.rejectionReason,
    validatedThroughSha: highlight.validatedThroughSha,
    lastValidatedAt: highlight.lastValidatedAt,
    ...(highlight.updatedAt ? { updatedAt: highlight.updatedAt } : {}),
  };
}

function evidenceCasWhere(evidence: EvidenceCasSnapshot): Prisma.EvidenceItemWhereInput {
  return {
    id: evidence.id,
    title: evidence.title,
    content: evidence.content,
    included: evidence.included,
    lifecycleStatus: evidence.lifecycleStatus,
    reviewState: evidence.reviewState,
    approvalSource: evidence.approvalSource,
    validatedThroughSha: evidence.validatedThroughSha,
    lastValidatedAt: evidence.lastValidatedAt,
    repositorySnapshotId: evidence.repositorySnapshotId,
    purgeEligibleAt: evidence.purgeEligibleAt,
    ...(evidence.updatedAt ? { updatedAt: evidence.updatedAt } : {}),
  };
}

function artifactCasWhere(artifact: ArtifactCasSnapshot): Prisma.ArtifactWhereInput {
  return {
    id: artifact.id,
    content: artifact.content,
    lifecycleStatus: artifact.lifecycleStatus,
    reviewState: artifact.reviewState,
    approvalSource: artifact.approvalSource,
    validatedThroughSha: artifact.validatedThroughSha,
    lastValidatedAt: artifact.lastValidatedAt,
    staleReason: artifact.staleReason,
    ...(artifact.updatedAt ? { updatedAt: artifact.updatedAt } : {}),
  };
}

export function isStrongCanonicalReplacement(input: {
  priorId: string;
  priorText: string;
  priorSubsystemKey: string | null;
  candidateText: string;
  candidateSubsystemKey: string | null;
  candidateSupersedesId: string | null;
}) {
  if (input.candidateSupersedesId === input.priorId) return true;
  if (
    !input.priorSubsystemKey ||
    input.priorSubsystemKey !== input.candidateSubsystemKey
  ) return false;
  return knowledgeSimilarity(input.priorText, input.candidateText) >= STRONG_KNOWLEDGE_IDENTITY_THRESHOLD;
}

function parseAnalysis(value: unknown): RepositoryFileAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as RepositoryFileAnalysis;
  return Array.isArray(analysis.facts) && Array.isArray(analysis.subsystemKeys) ? analysis : null;
}

export function currentObservations(run: Awaited<ReturnType<typeof loadRun>>) {
  const observations: CurrentObservation[] = [];
  for (const snapshot of run.snapshots) {
    for (const file of snapshot.files) {
      const analysis = file.semanticRefreshRunId === run.id && file.semanticAnalyzerVersion === REPOSITORY_SEMANTIC_ANALYZER_VERSION && (file.semanticStatus === "succeeded" || file.semanticStatus === "degraded")
        ? parseAnalysis(file.semanticAnalysis)
        : null;
      if (!analysis) continue;
      for (const fact of analysis.facts) {
        observations.push({
          statement: fact.statement,
          path: file.path,
          subsystemKeys: fact.subsystemKeys?.length ? fact.subsystemKeys : analysis.subsystemKeys,
          commitSha: snapshot.commitSha,
          sourceId: snapshot.sourceId,
        });
      }
    }
  }
  return observations;
}

function loadRun(runId: string) {
  return prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      // Staleness needs the complete manifest, not only semantically analyzed
      // files: unchanged blobs can revalidate old provenance without another
      // model pass, and only a complete manifest can prove path removal.
      snapshots: { include: { files: true } },
    },
  });
}

function relevantObservations(assertion: string, subsystemKey: string | null, observations: CurrentObservation[]) {
  return observations
    .map((observation) => ({
      observation,
      score: knowledgeSimilarity(assertion, observation.statement) + (subsystemKey && observation.subsystemKeys.includes(subsystemKey) ? 1 : 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 60)
    .map((entry) => entry.observation);
}

export async function validateAssertion(input: {
  assertion: string;
  priorReferences: string[];
  currentReferences: Set<string>;
  observations: CurrentObservation[];
}) {
  // Documentation is useful project context, but it cannot by itself prove an
  // absolute implementation invariant. Otherwise an unchanged stale README can
  // continually revalidate a behavior that current executable code no longer
  // implements.
  const modalTerms = Array.from(
    input.assertion.matchAll(/\b(?:mandatory|always|never|exclusively|every|all|only|guarantee[sd]?|production[- ]grade|tamper[- ]evident)\b/gi),
  ).map((match) => match[0]!.toLowerCase());
  const requiresExecutableEvidence = modalTerms.length > 0;
  const eligibleObservations = requiresExecutableEvidence
    ? input.observations.filter((observation) => {
        if (!executableRepositoryPathPattern.test(observation.path)) return false;
        const statement = observation.statement.toLowerCase();
        return modalTerms.every((term) => statement.includes(term));
      })
    : input.observations;
  const strongest = eligibleObservations
    .map((observation) => ({ observation, score: knowledgeSimilarity(input.assertion, observation.statement) }))
    .sort((left, right) => right.score - left.score)[0];
  if (strongest && strongest.score >= 0.35) {
    return {
      verdict: "supported" as const,
      reason: "A content-derived observation in the complete current snapshot supports the assertion.",
      observationIndexes: [input.observations.indexOf(strongest.observation) + 1],
    };
  }
  if (input.priorReferences.length && input.priorReferences.every((reference) => !input.currentReferences.has(reference))) {
    return {
      verdict: "removed" as const,
      reason: "Every previously cited repository path is absent from the complete current snapshot.",
      observationIndexes: [],
    };
  }
  return {
    verdict: "unknown" as const,
    reason: requiresExecutableEvidence
      ? "The modal implementation assertion was not supported by current executable repository evidence; documentation alone cannot revalidate it."
      : "The complete current snapshot did not decisively support or contradict this repository-derived assertion; it requires review rather than automatic retirement.",
    observationIndexes: [],
  };
}

function isRepositoryDerived(evidence: Array<{ evidenceItem: { type: string } }>) {
  return evidence.length > 0 && evidence.every((entry) => entry.evidenceItem.type.startsWith("github_"));
}

function priorReferences(evidence: Array<{ evidenceItem: { metadata: unknown } }>) {
  return Array.from(new Set(evidence.flatMap((entry) => {
    const metadata = entry.evidenceItem.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
    const path = (metadata as Record<string, unknown>).path;
    const sourceId = (metadata as Record<string, unknown>).sourceId;
    const repository = (metadata as Record<string, unknown>).repository;
    const owner = typeof sourceId === "string" ? sourceId : typeof repository === "string" ? repository : null;
    return typeof path === "string" && owner ? [`${owner}:${path}`] : [];
  })));
}

type ImmutableEvidence = {
  evidenceItem: {
    id?: string;
    sourceId: string;
    type: string;
    lifecycleStatus: string;
    metadata: unknown;
  };
};

type CurrentRepositoryFile = {
  sourceId: string;
  commitSha: string;
  snapshotId: string;
  path: string;
  blobSha: string;
};

type RefreshCompletenessInput = {
  qualityStatus: unknown;
  coverage: unknown;
  snapshots: Array<{
    inventoryComplete: boolean;
    analysisComplete: boolean;
    coverageComplete: boolean;
  }>;
};

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<unknown>,
) {
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value !== undefined) await task(value);
      }
    },
  ));
}

function contentIdentity(
  matches: ReturnType<typeof contentAddressedProvenance>["matches"],
) {
  return matches
    .map(({ current }) => `${current.sourceId}:${current.commitSha}:${current.path}:${current.blobSha}`)
    .sort()
    .join("|");
}

/**
 * Destructive staleness decisions require a complete repository barrier. A
 * degraded run is still useful for adding supported knowledge, but absence in
 * a partial scan is not evidence that previously verified knowledge vanished.
 */
export function refreshSupportsDestructiveStaleness(input: RefreshCompletenessInput) {
  if (input.qualityStatus !== "verified" || !input.snapshots.length) return false;
  if (input.snapshots.some((snapshot) =>
    !snapshot.inventoryComplete || !snapshot.analysisComplete || !snapshot.coverageComplete
  )) return false;
  if (!Array.isArray(input.coverage) || !input.coverage.length) return false;
  return input.coverage.every((value) => {
    const entry = objectRecord(value);
    if (!entry || entry.coverageStatus !== "complete") return false;
    const semanticStatus = entry.semanticCoverageStatus;
    const capabilityStatus = entry.capabilityCoverageStatus;
    return (semanticStatus === undefined || semanticStatus === "complete" || semanticStatus === "not_required") &&
      (capabilityStatus === undefined || capabilityStatus === "verified") &&
      (!Array.isArray(entry.coverageGaps) || entry.coverageGaps.length === 0);
  });
}

function immutableEvidenceCoordinates(entry: ImmutableEvidence) {
  const item = entry.evidenceItem;
  if (item.type !== "github_file_excerpt") return null;
  const metadata = objectRecord(item.metadata);
  const commitSha = typeof metadata?.commitSha === "string" ? metadata.commitSha : null;
  const blobSha = typeof metadata?.blobSha === "string" ? metadata.blobSha : null;
  const path = typeof metadata?.path === "string" ? metadata.path : null;
  const immutable = Boolean(
    commitSha && blobSha && path &&
    typeof metadata?.startLine === "number" &&
    typeof metadata?.endLine === "number" &&
    typeof metadata?.excerptHash === "string" && metadata.excerptHash,
  );
  return immutable ? { sourceId: item.sourceId, commitSha: commitSha!, blobSha: blobSha!, path: path! } : null;
}

export function currentRepositoryFiles(snapshots: Array<{
  id: string;
  sourceId: string;
  commitSha: string;
  files: Array<{ path: string; blobSha: string | null }>;
}>) {
  const files = new Map<string, CurrentRepositoryFile>();
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      if (!file.blobSha) continue;
      files.set(`${snapshot.sourceId}:${file.path}`, {
        sourceId: snapshot.sourceId,
        commitSha: snapshot.commitSha,
        snapshotId: snapshot.id,
        path: file.path,
        blobSha: file.blobSha,
      });
    }
  }
  return files;
}

/**
 * Revalidates immutable excerpts by Git blob identity rather than commit SHA.
 * An unchanged source/path/blob has identical content at the new head, so the
 * old immutable URL remains valid provenance and no semantic model call is
 * needed. Lifecycle state is deliberately ignored to repair rows that an
 * earlier partial refresh incorrectly marked stale.
 */
export function contentAddressedProvenance(input: {
  evidence: ImmutableEvidence[];
  currentFiles: Map<string, CurrentRepositoryFile>;
}) {
  const excerptEntries = input.evidence.flatMap((entry) => {
    const coordinates = immutableEvidenceCoordinates(entry);
    return coordinates ? [{ entry, coordinates }] : [];
  });
  const matches = excerptEntries.flatMap(({ entry, coordinates }) => {
    const current = input.currentFiles.get(`${coordinates.sourceId}:${coordinates.path}`);
    return current && current.blobSha === coordinates.blobSha ? [{ entry, current }] : [];
  });
  return {
    allCurrent: excerptEntries.length > 0 && matches.length === excerptEntries.length,
    heads: new Map(matches.map(({ current }) => [current.sourceId, current.commitSha])),
    matches,
  };
}

/** Returns only heads backed by an active, immutable file excerpt relation. */
export function currentImmutableProvenanceHeads(
  evidence: ImmutableEvidence[],
  targetShaBySource: Map<string, string>,
) {
  const heads = new Map<string, string>();
  for (const entry of evidence) {
    const item = entry.evidenceItem;
    if (item.type !== "github_file_excerpt" || item.lifecycleStatus !== "active") continue;
    const coordinates = immutableEvidenceCoordinates(entry);
    if (coordinates && targetShaBySource.get(item.sourceId) === coordinates.commitSha) {
      heads.set(item.sourceId, coordinates.commitSha);
    }
  }
  return heads;
}

export async function reconcileStaleKnowledge(input: {
  runId: string;
  appliedFactIds: string[];
  appliedHighlightIds: string[];
}) {
  const run = await loadRun(input.runId);
  const targets = run.targetHeads as unknown as RepositoryTargetHead[];
  const targetShas = new Set(targets.map((target) => target.commitSha));
  const targetShaBySource = new Map(targets.map((target) => [target.sourceId, target.commitSha]));
  const observations = currentObservations(run);
  const currentFiles = currentRepositoryFiles(run.snapshots);
  const destructiveStalenessAllowed = refreshSupportsDestructiveStaleness(run);
  const targetBySource = new Map(targets.map((target) => [target.sourceId, target.repository]));
  const currentReferences = new Set(run.snapshots.flatMap((snapshot) => snapshot.files.flatMap((file) => [
    `${snapshot.sourceId}:${file.path}`,
    `${targetBySource.get(snapshot.sourceId) ?? snapshot.sourceId}:${file.path}`,
  ])));
  const retiredFactIds: string[] = [];
  const retiredHighlightIds: string[] = [];
  let recoveredDependency = false;
  const [
    activeFacts,
    activeHighlights,
    appliedFacts,
    appliedHighlights,
    pendingReviewChanges,
  ] = await Promise.all([
    prisma.projectFact.findMany({
      where: {
        workItemId: run.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
        id: { notIn: input.appliedFactIds.length ? input.appliedFactIds : [""] },
      },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
    prisma.highlight.findMany({
      where: {
        workItemId: run.workItemId,
        lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
        id: { notIn: input.appliedHighlightIds.length ? input.appliedHighlightIds : [""] },
      },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
    prisma.projectFact.findMany({
      where: { id: { in: input.appliedFactIds.length ? input.appliedFactIds : [""] } },
      select: {
        id: true,
        statement: true,
        subsystemKey: true,
        supersedesProjectFactId: true,
      },
    }),
    prisma.highlight.findMany({
      where: { id: { in: input.appliedHighlightIds.length ? input.appliedHighlightIds : [""] } },
      select: {
        id: true,
        text: true,
        summary: true,
        metadata: true,
        supersedesHighlightId: true,
      },
    }),
    prisma.knowledgeChange.findMany({
      where: {
        workItemId: run.workItemId,
        decision: "pending",
        OR: [
          { projectFactId: { not: null } },
          { highlightId: { not: null } },
        ],
      },
      select: {
        projectFactId: true,
        highlightId: true,
        action: true,
        afterSnapshot: true,
      },
    }),
  ]);
  const activeFactById = new Map(activeFacts.map((fact) => [fact.id, fact]));
  const activeHighlightById = new Map(activeHighlights.map((highlight) => [highlight.id, highlight]));
  const isNeedsValidationWarning = (change: (typeof pendingReviewChanges)[number]) => {
    const after = change.afterSnapshot && typeof change.afterSnapshot === "object" && !Array.isArray(change.afterSnapshot)
      ? change.afterSnapshot as Record<string, unknown>
      : null;
    const entityId = change.projectFactId ?? change.highlightId;
    const entity = change.projectFactId
      ? activeFactById.get(change.projectFactId)
      : change.highlightId
        ? activeHighlightById.get(change.highlightId)
        : null;
    return Boolean(
      entityId &&
      entity &&
      change.action === "updated" &&
      after?.lifecycleStatus === "needs_validation" &&
      reviewSnapshotMatchesEntity({
        entityId,
        afterSnapshot: change.afterSnapshot,
        entity: entity as unknown as Record<string, unknown>,
      })
    );
  };
  const pendingFactReviewIds = new Set(
    pendingReviewChanges.flatMap((change) =>
      change.projectFactId && isNeedsValidationWarning(change) ? [change.projectFactId] : []
    ),
  );
  const pendingHighlightReviewIds = new Set(
    pendingReviewChanges.flatMap((change) =>
      change.highlightId && isNeedsValidationWarning(change) ? [change.highlightId] : []
    ),
  );
  type AutomaticRevalidation = Parameters<typeof recordContentAddressedRevalidations>[0][number];
  const automaticRevalidations: AutomaticRevalidation[] = [];
  // Use one timestamp for grouped state writes and their audit snapshots so
  // the recorded after-state exactly matches the persisted revalidation.
  const contentRevalidatedAt = new Date();
  const factRevalidationGroups = new Map<string, {
    entries: Array<{
      id: string;
      where: Prisma.ProjectFactWhereInput;
      audit: AutomaticRevalidation;
      wasInactive: boolean;
    }>;
    currentSha: string;
    validationHeads: Record<string, string>;
  }>();

  for (const fact of activeFacts) {
    if (!isRepositoryDerived(fact.evidence)) continue;
    const canonicalReplacement = appliedFacts.find((candidate) => isStrongCanonicalReplacement({
      priorId: fact.id,
      priorText: fact.statement,
      priorSubsystemKey: fact.subsystemKey,
      candidateText: candidate.statement,
      candidateSubsystemKey: candidate.subsystemKey,
      candidateSupersedesId: candidate.supersedesProjectFactId,
    }));
    if (destructiveStalenessAllowed && fact.approvalSource === "automation" && fact.reviewState === "pending_review" && canonicalReplacement) {
      const reason = "A newer current-head synthesis replaced this unreviewed automated Project Fact in the same capability area.";
      const retired = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.projectFact.updateMany({
          where: projectFactCasWhere(fact),
          data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: reason },
        })
      );
      if (retired.count !== 1) continue;
      retiredFactIds.push(fact.id);
      await recordChange({ workItemId: run.workItemId, refreshRunId: run.id, entityKind: "project_fact", action: "retired", entityId: fact.id, beforeSnapshot: { statement: fact.statement, lifecycleStatus: fact.lifecycleStatus }, afterSnapshot: { statement: fact.statement, lifecycleStatus: "retired" }, reason, provenance: { replacementProjectFactId: canonicalReplacement.id }, suffix: `${fact.id}:canonical-replacement:${run.id}` });
      continue;
    }
    const references = priorReferences(fact.evidence);
    const contentAddressed = contentAddressedProvenance({ evidence: fact.evidence, currentFiles });
    if (contentAddressed.allCurrent) {
      const currentSha = contentAddressed.heads.values().next().value ?? null;
      if (!currentSha) continue;
      const validationHeads = Object.fromEntries(contentAddressed.heads);
      const validatedAt = contentRevalidatedAt;
      const afterSnapshot = {
        id: fact.id,
        statement: fact.statement,
        status: "approved",
        lifecycleStatus: "active",
        reviewState: fact.reviewState,
        approvalSource: fact.approvalSource,
        publicSafetyStatus: fact.publicSafetyStatus,
        validatedThroughSha: currentSha,
        validationHeads,
        lastValidatedAt: validatedAt,
        autoAppliedAt: fact.autoAppliedAt,
        evidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
      };
      const audit: AutomaticRevalidation = {
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "project_fact",
        action: "revalidated",
        entityId: fact.id,
        beforeSnapshot: {
          id: fact.id,
          statement: fact.statement,
          status: fact.status,
          lifecycleStatus: fact.lifecycleStatus,
          reviewState: fact.reviewState,
          approvalSource: fact.approvalSource,
          publicSafetyStatus: fact.publicSafetyStatus,
          validatedThroughSha: fact.validatedThroughSha,
          validationHeads: fact.validationHeads,
          lastValidatedAt: fact.lastValidatedAt,
          autoAppliedAt: fact.autoAppliedAt,
          evidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot,
        reason: "Every immutable repository excerpt still resolves to the same source/path/blob at the current head.",
        provenance: { commitSha: currentSha, automatic: true, contentAddressed: true },
        contentIdentity: contentIdentity(contentAddressed.matches),
      };
      const needsUpdate = fact.lifecycleStatus !== "active" ||
        fact.status !== "approved" ||
        fact.rejectionReason !== null ||
        fact.validatedThroughSha !== currentSha ||
        !sameJson(fact.validationHeads, validationHeads);
      if (needsUpdate) {
        const key = `${currentSha}:${JSON.stringify(validationHeads)}`;
        const group = factRevalidationGroups.get(key) ?? {
          entries: [],
          currentSha,
          validationHeads,
        };
        group.entries.push({
          id: fact.id,
          where: projectFactCasWhere(fact),
          audit,
          wasInactive: fact.lifecycleStatus !== "active",
        });
        factRevalidationGroups.set(key, group);
      } else {
        automaticRevalidations.push(audit);
      }
      continue;
    }
    if (!contentAddressed.allCurrent && !destructiveStalenessAllowed) continue;
    const relevant = relevantObservations(fact.statement, fact.subsystemKey, observations);
    const validation = await validateAssertion({ assertion: fact.statement, priorReferences: references, currentReferences, observations: relevant });
    const immutableHeads = currentImmutableProvenanceHeads(fact.evidence, targetShaBySource);
    const currentSha = immutableHeads.values().next().value ?? null;
    const validationHeads = Object.fromEntries(immutableHeads);
    if (validation.verdict === "supported" && currentSha) {
      const revalidatedAt = new Date();
      const revalidated = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.projectFact.updateMany({
          where: projectFactCasWhere(fact),
          data: {
            lifecycleStatus: "active",
            status: "approved",
            reviewState: "pending_review",
            rejectionReason: null,
            validatedThroughSha: currentSha,
            validationHeads,
            lastValidatedAt: revalidatedAt,
            autoAppliedAt: revalidatedAt,
          },
        })
      );
      if (revalidated.count !== 1) continue;
      recoveredDependency ||= fact.lifecycleStatus !== "active";
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "project_fact",
        action: "revalidated",
        entityId: fact.id,
        beforeSnapshot: {
          id: fact.id,
          statement: fact.statement,
          status: fact.status,
          lifecycleStatus: fact.lifecycleStatus,
          reviewState: fact.reviewState,
          approvalSource: fact.approvalSource,
          publicSafetyStatus: fact.publicSafetyStatus,
          validatedThroughSha: fact.validatedThroughSha,
          validationHeads: fact.validationHeads,
          lastValidatedAt: fact.lastValidatedAt,
          autoAppliedAt: fact.autoAppliedAt,
          evidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot: {
          id: fact.id,
          statement: fact.statement,
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: fact.approvalSource,
          publicSafetyStatus: fact.publicSafetyStatus,
          validatedThroughSha: currentSha,
          validationHeads,
          lastValidatedAt: revalidatedAt,
          autoAppliedAt: revalidatedAt,
          evidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
        },
        reason: validation.reason,
        provenance: { observationIndexes: validation.observationIndexes, commitSha: currentSha },
        suffix: `${fact.id}:${currentSha}`,
      });
    } else if (destructiveStalenessAllowed && validation.verdict === "removed") {
      const retired = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.projectFact.updateMany({
          where: projectFactCasWhere(fact),
          data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: validation.reason },
        })
      );
      if (retired.count !== 1) continue;
      retiredFactIds.push(fact.id);
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "project_fact",
        action: "retired",
        entityId: fact.id,
        beforeSnapshot: { statement: fact.statement, lifecycleStatus: fact.lifecycleStatus },
        afterSnapshot: { statement: fact.statement, lifecycleStatus: "retired" },
        reason: validation.reason,
        provenance: { priorReferences: references, targetShas: Array.from(targetShas) },
        suffix: `${fact.id}:${targets.map((target) => target.commitSha).join(":")}`,
      });
    } else if (
      destructiveStalenessAllowed &&
      (
        fact.lifecycleStatus !== "needs_validation" ||
        !pendingFactReviewIds.has(fact.id)
      )
    ) {
      const marked = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.projectFact.updateMany({
          where: projectFactCasWhere(fact),
          data: { lifecycleStatus: "needs_validation" },
        })
      );
      if (marked.count !== 1) continue;
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "project_fact",
        action: "updated",
        entityId: fact.id,
        beforeSnapshot: { id: fact.id, statement: fact.statement, lifecycleStatus: fact.lifecycleStatus, validatedThroughSha: fact.validatedThroughSha },
        afterSnapshot: { id: fact.id, statement: fact.statement, lifecycleStatus: "needs_validation", validatedThroughSha: fact.validatedThroughSha },
        reason: validation.verdict === "supported"
          ? "The assertion was semantically supported, but no current-head immutable excerpt is attached; validation was not advanced."
          : validation.reason,
        provenance: { immutableEvidenceRequired: true, targetShas: Array.from(targetShas) },
        suffix: `${fact.id}:needs-validation:${run.id}`,
      });
    }
  }

  await runBounded(Array.from(factRevalidationGroups.values()), 8, async (group) => {
    const updated = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
      tx.projectFact.updateManyAndReturn({
        where: { OR: group.entries.map((entry) => entry.where) },
        data: {
          lifecycleStatus: "active",
          status: "approved",
          rejectionReason: null,
          validatedThroughSha: group.currentSha,
          validationHeads: group.validationHeads,
          lastValidatedAt: contentRevalidatedAt,
        },
        select: { id: true },
      })
    );
    const winnerIds = new Set(updated.map((fact) => fact.id));
    for (const entry of group.entries) {
      if (!winnerIds.has(entry.id)) continue;
      automaticRevalidations.push(entry.audit);
      recoveredDependency ||= entry.wasInactive;
    }
  });

  const highlightRevalidationGroups = new Map<string, {
    entries: Array<{
      id: string;
      where: Prisma.HighlightWhereInput;
      audit: AutomaticRevalidation;
      wasInactive: boolean;
    }>;
    currentSha: string;
    validationHeads: Record<string, string>;
  }>();
  for (const highlight of activeHighlights) {
    if (!isRepositoryDerived(highlight.evidence)) continue;
    const references = priorReferences(highlight.evidence);
    const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
      ? highlight.metadata as Record<string, unknown>
      : null;
    const subsystemKey = typeof metadata?.subsystemKey === "string" ? metadata.subsystemKey : null;
    const canonicalReplacement = appliedHighlights.find((candidate) => {
      const candidateMetadata = candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? candidate.metadata as Record<string, unknown>
        : null;
      const candidateSubsystemKey = typeof candidateMetadata?.subsystemKey === "string"
        ? candidateMetadata.subsystemKey
        : null;
      return isStrongCanonicalReplacement({
        priorId: highlight.id,
        priorText: `${highlight.text} ${highlight.summary}`,
        priorSubsystemKey: subsystemKey,
        candidateText: `${candidate.text} ${candidate.summary}`,
        candidateSubsystemKey,
        candidateSupersedesId: candidate.supersedesHighlightId,
      });
    });
    if (destructiveStalenessAllowed && highlight.approvalSource === "automation" && highlight.reviewState === "pending_review" && canonicalReplacement) {
      const reason = "A newer current-head synthesis replaced this unreviewed automated Highlight in the same capability area.";
      const retired = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.highlight.updateMany({
          where: highlightCasWhere(highlight),
          data: { lifecycleStatus: "retired", rejectionReason: reason },
        })
      );
      if (retired.count !== 1) continue;
      retiredHighlightIds.push(highlight.id);
      await recordChange({ workItemId: run.workItemId, refreshRunId: run.id, entityKind: "highlight", action: "retired", entityId: highlight.id, beforeSnapshot: { text: highlight.text, lifecycleStatus: highlight.lifecycleStatus }, afterSnapshot: { text: highlight.text, lifecycleStatus: "retired" }, reason, provenance: { replacementHighlightId: canonicalReplacement.id }, suffix: `${highlight.id}:canonical-replacement:${run.id}` });
      continue;
    }
    const contentAddressed = contentAddressedProvenance({ evidence: highlight.evidence, currentFiles });
    if (contentAddressed.allCurrent) {
      const currentSha = contentAddressed.heads.values().next().value ?? null;
      if (!currentSha) continue;
      const validationHeads = Object.fromEntries(contentAddressed.heads);
      const validatedAt = contentRevalidatedAt;
      const audit: AutomaticRevalidation = {
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "highlight",
        action: "revalidated",
        entityId: highlight.id,
        beforeSnapshot: {
          id: highlight.id,
          text: highlight.text,
          lifecycleStatus: highlight.lifecycleStatus,
          reviewState: highlight.reviewState,
          approvalSource: highlight.approvalSource,
          publicSafetyStatus: highlight.publicSafetyStatus,
          validatedThroughSha: highlight.validatedThroughSha,
          validationHeads: highlight.validationHeads,
          lastValidatedAt: highlight.lastValidatedAt,
          autoAppliedAt: highlight.autoAppliedAt,
          evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot: {
          id: highlight.id,
          text: highlight.text,
          lifecycleStatus: "active",
          reviewState: highlight.reviewState,
          approvalSource: highlight.approvalSource,
          publicSafetyStatus: highlight.publicSafetyStatus,
          validatedThroughSha: currentSha,
          validationHeads,
          lastValidatedAt: validatedAt,
          autoAppliedAt: highlight.autoAppliedAt,
          evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        reason: "Every immutable repository excerpt still resolves to the same source/path/blob at the current head.",
        provenance: { commitSha: currentSha, automatic: true, contentAddressed: true },
        contentIdentity: contentIdentity(contentAddressed.matches),
      };
      const needsUpdate = highlight.lifecycleStatus !== "active" ||
        highlight.rejectionReason !== null ||
        highlight.validatedThroughSha !== currentSha ||
        !sameJson(highlight.validationHeads, validationHeads);
      if (needsUpdate) {
        const key = `${currentSha}:${JSON.stringify(validationHeads)}`;
        const group = highlightRevalidationGroups.get(key) ?? {
          entries: [],
          currentSha,
          validationHeads,
        };
        group.entries.push({
          id: highlight.id,
          where: highlightCasWhere(highlight),
          audit,
          wasInactive: highlight.lifecycleStatus !== "active",
        });
        highlightRevalidationGroups.set(key, group);
      } else {
        automaticRevalidations.push(audit);
      }
      continue;
    }
    if (!contentAddressed.allCurrent && !destructiveStalenessAllowed) continue;
    const supportingObservations = relevantObservations(`${highlight.text} ${highlight.summary}`, subsystemKey, observations);
    const validation = await validateAssertion({
      assertion: `${highlight.text}. ${highlight.summary}`,
      priorReferences: references,
      currentReferences,
      observations: supportingObservations,
    });
    const immutableHeads = currentImmutableProvenanceHeads(highlight.evidence, targetShaBySource);
    const currentSha = immutableHeads.values().next().value ?? null;
    if (validation.verdict === "supported" && currentSha) {
      const revalidatedAt = new Date();
      const revalidated = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.highlight.updateMany({
          where: highlightCasWhere(highlight),
          data: {
            lifecycleStatus: "active",
            reviewState: "pending_review",
            rejectionReason: null,
            validatedThroughSha: currentSha,
            validationHeads: Object.fromEntries(immutableHeads),
            lastValidatedAt: revalidatedAt,
            autoAppliedAt: revalidatedAt,
          },
        })
      );
      if (revalidated.count !== 1) continue;
      recoveredDependency ||= highlight.lifecycleStatus !== "active";
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "highlight",
        action: "revalidated",
        entityId: highlight.id,
        beforeSnapshot: {
          id: highlight.id,
          text: highlight.text,
          lifecycleStatus: highlight.lifecycleStatus,
          reviewState: highlight.reviewState,
          approvalSource: highlight.approvalSource,
          publicSafetyStatus: highlight.publicSafetyStatus,
          validatedThroughSha: highlight.validatedThroughSha,
          validationHeads: highlight.validationHeads,
          lastValidatedAt: highlight.lastValidatedAt,
          autoAppliedAt: highlight.autoAppliedAt,
          evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        afterSnapshot: {
          id: highlight.id,
          text: highlight.text,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: highlight.approvalSource,
          publicSafetyStatus: highlight.publicSafetyStatus,
          validatedThroughSha: currentSha,
          validationHeads: Object.fromEntries(immutableHeads),
          lastValidatedAt: revalidatedAt,
          autoAppliedAt: revalidatedAt,
          evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        reason: validation.reason,
        provenance: { observationIndexes: validation.observationIndexes, commitSha: currentSha },
        suffix: `${highlight.id}:${currentSha}`,
      });
    } else if (destructiveStalenessAllowed && validation.verdict === "removed") {
      const retired = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.highlight.updateMany({
          where: highlightCasWhere(highlight),
          data: { lifecycleStatus: "retired", rejectionReason: validation.reason },
        })
      );
      if (retired.count !== 1) continue;
      retiredHighlightIds.push(highlight.id);
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "highlight",
        action: "retired",
        entityId: highlight.id,
        beforeSnapshot: { text: highlight.text, lifecycleStatus: highlight.lifecycleStatus },
        afterSnapshot: { text: highlight.text, lifecycleStatus: "retired" },
        reason: validation.reason,
        provenance: { priorReferences: references, targetShas: Array.from(targetShas) },
        suffix: `${highlight.id}:${targets.map((target) => target.commitSha).join(":")}`,
      });
    } else if (
      destructiveStalenessAllowed &&
      (
        highlight.lifecycleStatus !== "needs_validation" ||
        !pendingHighlightReviewIds.has(highlight.id)
      )
    ) {
      const marked = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
        tx.highlight.updateMany({
          where: highlightCasWhere(highlight),
          data: { lifecycleStatus: "needs_validation" },
        })
      );
      if (marked.count !== 1) continue;
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "highlight",
        action: "updated",
        entityId: highlight.id,
        beforeSnapshot: { id: highlight.id, text: highlight.text, lifecycleStatus: highlight.lifecycleStatus, validatedThroughSha: highlight.validatedThroughSha },
        afterSnapshot: { id: highlight.id, text: highlight.text, lifecycleStatus: "needs_validation", validatedThroughSha: highlight.validatedThroughSha },
        reason: validation.verdict === "supported"
          ? "The Highlight was semantically supported, but no current-head immutable excerpt is attached; validation was not advanced."
          : validation.reason,
        provenance: { immutableEvidenceRequired: true, targetShas: Array.from(targetShas) },
        suffix: `${highlight.id}:needs-validation:${run.id}`,
      });
    }
  }

  await runBounded(Array.from(highlightRevalidationGroups.values()), 8, async (group) => {
    const updated = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
      tx.highlight.updateManyAndReturn({
        where: { OR: group.entries.map((entry) => entry.where) },
        data: {
          lifecycleStatus: "active",
          rejectionReason: null,
          validatedThroughSha: group.currentSha,
          validationHeads: group.validationHeads,
          lastValidatedAt: contentRevalidatedAt,
        },
        select: { id: true },
      })
    );
    const winnerIds = new Set(updated.map((highlight) => highlight.id));
    for (const entry of group.entries) {
      if (!winnerIds.has(entry.id)) continue;
      automaticRevalidations.push(entry.audit);
      recoveredDependency ||= entry.wasInactive;
    }
  });

  const repositoryEvidence = await prisma.evidenceItem.findMany({
    where: {
      workItemId: run.workItemId,
      type: "github_file_excerpt",
      lifecycleStatus: { in: ["active", "needs_validation", "stale"] },
    },
  });
  const evidenceRevalidationGroups = new Map<string, {
    entries: Array<{
      id: string;
      where: Prisma.EvidenceItemWhereInput;
      audit: AutomaticRevalidation;
      wasInactive: boolean;
    }>;
    commitSha: string;
    snapshotId: string;
  }>();
  const staleEvidencePlans: Array<{
    evidence: EvidenceCasSnapshot & {
      sourceId: string;
      title: string;
    };
    commitSha: string;
    currentCommitSha: string | null;
    reason: string;
  }> = [];
  for (const evidence of repositoryEvidence) {
    const contentAddressed = contentAddressedProvenance({
      evidence: [{ evidenceItem: evidence }],
      currentFiles,
    });
    if (contentAddressed.allCurrent) {
      const current = contentAddressed.matches[0]!.current;
      const audit: AutomaticRevalidation = {
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "evidence",
        action: "revalidated",
        entityId: evidence.id,
        beforeSnapshot: {
          id: evidence.id,
          title: evidence.title,
          lifecycleStatus: evidence.lifecycleStatus,
          validatedThroughSha: evidence.validatedThroughSha,
          repositorySnapshotId: evidence.repositorySnapshotId,
        },
        afterSnapshot: {
          id: evidence.id,
          title: evidence.title,
          lifecycleStatus: "active",
          validatedThroughSha: current.commitSha,
          repositorySnapshotId: current.snapshotId,
        },
        reason: "The cited source/path still resolves to the same immutable Git blob at the current repository head.",
        provenance: {
          priorCommitSha: objectRecord(evidence.metadata)?.commitSha ?? null,
          currentCommitSha: current.commitSha,
          blobSha: current.blobSha,
          path: current.path,
          automatic: true,
          contentAddressed: true,
        },
        contentIdentity: `${current.sourceId}:${current.commitSha}:${current.path}:${current.blobSha}`,
      };
      if (
        evidence.lifecycleStatus !== "active" ||
        evidence.validatedThroughSha !== current.commitSha ||
        evidence.repositorySnapshotId !== current.snapshotId ||
        evidence.purgeEligibleAt
      ) {
        const key = `${current.commitSha}:${current.snapshotId}`;
        const group = evidenceRevalidationGroups.get(key) ?? {
          entries: [],
          commitSha: current.commitSha,
          snapshotId: current.snapshotId,
        };
        group.entries.push({
          id: evidence.id,
          where: evidenceCasWhere(evidence),
          audit,
          wasInactive: evidence.lifecycleStatus !== "active",
        });
        evidenceRevalidationGroups.set(key, group);
      } else {
        automaticRevalidations.push(audit);
      }
      continue;
    }
    if (!destructiveStalenessAllowed || evidence.lifecycleStatus === "stale") continue;
    const metadata = evidence.metadata && typeof evidence.metadata === "object" && !Array.isArray(evidence.metadata)
      ? evidence.metadata as Record<string, unknown>
      : null;
    const commitSha = typeof metadata?.commitSha === "string" ? metadata.commitSha : null;
    if (commitSha && targetShaBySource.get(evidence.sourceId) !== commitSha) {
      staleEvidencePlans.push({
        evidence,
        commitSha,
        currentCommitSha: targetShaBySource.get(evidence.sourceId) ?? null,
        reason: "This immutable repository excerpt is pinned to an older repository head and requires review.",
      });
    }
  }

  if (staleEvidencePlans.length) {
    const purgeEligibleAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await withKnowledgeRefreshGenerationFence(input.runId, async (tx) => {
      const updated = await tx.evidenceItem.updateManyAndReturn({
        where: { OR: staleEvidencePlans.map((plan) => evidenceCasWhere(plan.evidence)) },
        data: { lifecycleStatus: "stale", purgeEligibleAt },
        select: { id: true },
      });
      const winnerIds = new Set(updated.map((evidence) => evidence.id));
      const winners = staleEvidencePlans.filter((plan) => winnerIds.has(plan.evidence.id));
      const modelId = resolveActiveTextModelIdentity("verification").modelId;
      await upsertReviewableKnowledgeChangesInTransaction(winners.map((plan) => ({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "evidence" as const,
        action: "updated" as const,
        entityId: plan.evidence.id,
        beforeSnapshot: {
          id: plan.evidence.id,
          title: plan.evidence.title,
          lifecycleStatus: plan.evidence.lifecycleStatus,
          validatedThroughSha: plan.evidence.validatedThroughSha,
        },
        afterSnapshot: {
          id: plan.evidence.id,
          title: plan.evidence.title,
          lifecycleStatus: "stale",
          validatedThroughSha: plan.evidence.validatedThroughSha,
        },
        reason: plan.reason,
        provenance: {
          priorCommitSha: plan.commitSha,
          currentCommitSha: plan.currentCommitSha,
        },
        policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
        modelId,
        idempotencyKey: `${run.id}:evidence:updated:${plan.evidence.id}:stale:${run.id}`,
      })), tx);
      await invalidateStaleEvidenceDependentsInTransaction({
        workItemId: run.workItemId,
        evidenceItemIds: winners.map((plan) => plan.evidence.id),
        reason: "One or more immutable repository excerpts are pinned to an older repository head and require review.",
        idempotencyScope: `refresh:${run.id}:stale-evidence-batch`,
        refreshRunId: run.id,
      }, tx);
      return winners.map((plan) => plan.evidence.id);
    }, { timeoutMs: 30_000 });
  }

  await runBounded(Array.from(evidenceRevalidationGroups.values()), 8, async (group) => {
    const updated = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
      tx.evidenceItem.updateManyAndReturn({
        where: { OR: group.entries.map((entry) => entry.where) },
        data: {
          lifecycleStatus: "active",
          validatedThroughSha: group.commitSha,
          lastValidatedAt: contentRevalidatedAt,
          repositorySnapshotId: group.snapshotId,
          purgeEligibleAt: null,
        },
        select: { id: true },
      })
    );
    const winnerIds = new Set(updated.map((evidence) => evidence.id));
    for (const entry of group.entries) {
      if (!winnerIds.has(entry.id)) continue;
      automaticRevalidations.push(entry.audit);
      recoveredDependency ||= entry.wasInactive;
    }
  });

  const staleArtifactIds: string[] = [];
  if (!destructiveStalenessAllowed && !recoveredDependency) {
    await recordContentAddressedRevalidations(automaticRevalidations);
    return { retiredFactIds, retiredHighlightIds, staleArtifactIds };
  }
  const artifacts = await prisma.artifact.findMany({
    where: {
      workItemId: run.workItemId,
      lifecycleStatus: destructiveStalenessAllowed ? { in: ["active", "stale"] } : "stale",
    },
    include: { highlightProvenance: { include: { highlight: true } }, evidenceProvenance: { include: { evidenceItem: true } } },
  });
  const recoverableArtifacts: Array<{
    id: string;
    where: Prisma.ArtifactWhereInput;
    audit: AutomaticRevalidation;
  }> = [];
  for (const artifact of artifacts) {
    const invalidHighlights = artifact.highlightProvenance.filter((entry) => entry.highlight && entry.highlight.lifecycleStatus !== "active");
    const invalidEvidence = artifact.evidenceProvenance.filter((entry) => entry.evidenceItem && entry.evidenceItem.lifecycleStatus !== "active");
    const hasKnowledgeProvenance = artifact.highlightProvenance.length > 0 || artifact.evidenceProvenance.length > 0;
    if (!invalidHighlights.length && !invalidEvidence.length) {
      if (!hasKnowledgeProvenance) continue;
      const reason = "All immutable repository dependencies are active again after content-addressed revalidation.";
      const audit: AutomaticRevalidation = {
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "artifact",
        action: "revalidated",
        entityId: artifact.id,
        beforeSnapshot: { id: artifact.id, content: artifact.content, lifecycleStatus: artifact.lifecycleStatus, staleReason: artifact.staleReason },
        afterSnapshot: { id: artifact.id, content: artifact.content, lifecycleStatus: "active", staleReason: null },
        reason,
        downstreamImpact: {
          restoredHighlightIds: artifact.highlightProvenance.flatMap((entry) => entry.highlightId ? [entry.highlightId] : []),
          restoredEvidenceIds: artifact.evidenceProvenance.flatMap((entry) => entry.evidenceItemId ? [entry.evidenceItemId] : []),
        },
        contentIdentity: [
          ...targets.map((target) => `${target.sourceId}:${target.commitSha}`),
          ...artifact.highlightProvenance.flatMap((entry) => entry.highlightId ? [`highlight:${entry.highlightId}`] : []),
          ...artifact.evidenceProvenance.flatMap((entry) => entry.evidenceItemId ? [`evidence:${entry.evidenceItemId}`] : []),
        ].sort().join("|"),
      };
      if (artifact.lifecycleStatus === "stale") {
        recoverableArtifacts.push({
          id: artifact.id,
          where: artifactCasWhere(artifact),
          audit,
        });
      } else {
        automaticRevalidations.push(audit);
      }
      continue;
    }
    if (!destructiveStalenessAllowed || artifact.lifecycleStatus !== "active") continue;
    const reason = `Upstream knowledge changed: ${invalidHighlights.length} Highlight and ${invalidEvidence.length} Evidence reference${invalidHighlights.length + invalidEvidence.length === 1 ? "" : "s"} are no longer canonical.`;
    const marked = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
      tx.artifact.updateMany({
        where: artifactCasWhere(artifact),
        data: { lifecycleStatus: "stale", staleReason: reason },
      })
    );
    if (marked.count !== 1) continue;
    staleArtifactIds.push(artifact.id);
    await recordChange({
      workItemId: run.workItemId,
      refreshRunId: run.id,
      entityKind: "artifact",
      action: "updated",
      entityId: artifact.id,
      beforeSnapshot: { id: artifact.id, content: artifact.content, lifecycleStatus: artifact.lifecycleStatus, staleReason: artifact.staleReason },
      afterSnapshot: { id: artifact.id, content: artifact.content, lifecycleStatus: "stale", staleReason: reason },
      reason,
      downstreamImpact: { invalidHighlightIds: invalidHighlights.flatMap((entry) => entry.highlightId ? [entry.highlightId] : []), invalidEvidenceIds: invalidEvidence.flatMap((entry) => entry.evidenceItemId ? [entry.evidenceItemId] : []) },
      suffix: `${artifact.id}:${targets.map((target) => target.commitSha).join(":")}`,
    });
  }

  if (recoverableArtifacts.length) {
    const recovered = await withKnowledgeRefreshGenerationFence(input.runId, (tx) =>
      tx.artifact.updateManyAndReturn({
        where: { OR: recoverableArtifacts.map((artifact) => artifact.where) },
        data: { lifecycleStatus: "active", staleReason: null },
        select: { id: true },
      })
    );
    const winnerIds = new Set(recovered.map((artifact) => artifact.id));
    for (const artifact of recoverableArtifacts) {
      if (winnerIds.has(artifact.id)) automaticRevalidations.push(artifact.audit);
    }
  }
  await recordContentAddressedRevalidations(automaticRevalidations);

  return { retiredFactIds, retiredHighlightIds, staleArtifactIds };
}

export const knowledgeStalenessService = { reconcile: reconcileStaleKnowledge };
