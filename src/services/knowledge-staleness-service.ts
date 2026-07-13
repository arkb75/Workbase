import { prisma } from "@/src/lib/prisma";
import { invalidateEvidenceDependents } from "@/src/services/knowledge-dependency-service";
import { knowledgeSimilarity, recordChange } from "@/src/services/knowledge-reconciliation-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";
import { REPOSITORY_KNOWLEDGE_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

type CurrentObservation = {
  statement: string;
  path: string;
  subsystemKeys: string[];
  commitSha: string;
  sourceId: string;
};

function parseAnalysis(value: unknown): RepositoryFileAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as RepositoryFileAnalysis;
  return Array.isArray(analysis.facts) && Array.isArray(analysis.subsystemKeys) ? analysis : null;
}

export function currentObservations(run: Awaited<ReturnType<typeof loadRun>>) {
  const observations: CurrentObservation[] = [];
  for (const snapshot of run.snapshots) {
    for (const file of snapshot.files) {
      const analysis = file.semanticRefreshRunId === run.id && file.semanticAnalyzerVersion === REPOSITORY_KNOWLEDGE_ANALYZER_VERSION && (file.semanticStatus === "succeeded" || file.semanticStatus === "degraded")
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
      snapshots: { include: { files: { where: { disposition: "analyzed" } } } },
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

async function validateAssertion(input: {
  assertion: string;
  priorReferences: string[];
  currentReferences: Set<string>;
  observations: CurrentObservation[];
}) {
  const strongest = input.observations
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
    reason: "The complete current snapshot did not decisively support or contradict this repository-derived assertion; it requires review rather than automatic retirement.",
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
    sourceId: string;
    type: string;
    lifecycleStatus: string;
    metadata: unknown;
  };
};

/** Returns only heads backed by an active, immutable file excerpt relation. */
export function currentImmutableProvenanceHeads(
  evidence: ImmutableEvidence[],
  targetShaBySource: Map<string, string>,
) {
  const heads = new Map<string, string>();
  for (const entry of evidence) {
    const item = entry.evidenceItem;
    if (item.type !== "github_file_excerpt" || item.lifecycleStatus !== "active") continue;
    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? item.metadata as Record<string, unknown>
      : null;
    const commitSha = typeof metadata?.commitSha === "string" ? metadata.commitSha : null;
    const immutable = Boolean(
      commitSha &&
      typeof metadata?.blobSha === "string" && metadata.blobSha &&
      typeof metadata?.path === "string" && metadata.path &&
      typeof metadata?.startLine === "number" &&
      typeof metadata?.endLine === "number" &&
      typeof metadata?.excerptHash === "string" && metadata.excerptHash,
    );
    if (immutable && targetShaBySource.get(item.sourceId) === commitSha) {
      heads.set(item.sourceId, commitSha!);
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
  const targetBySource = new Map(targets.map((target) => [target.sourceId, target.repository]));
  const currentReferences = new Set(run.snapshots.flatMap((snapshot) => snapshot.files.flatMap((file) => [
    `${snapshot.sourceId}:${file.path}`,
    `${targetBySource.get(snapshot.sourceId) ?? snapshot.sourceId}:${file.path}`,
  ])));
  const activeFacts = await prisma.projectFact.findMany({
    where: {
      workItemId: run.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
      id: { notIn: input.appliedFactIds.length ? input.appliedFactIds : [""] },
    },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const activeHighlights = await prisma.highlight.findMany({
    where: {
      workItemId: run.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
      id: { notIn: input.appliedHighlightIds.length ? input.appliedHighlightIds : [""] },
    },
    include: { evidence: { include: { evidenceItem: true } } },
  });
  const retiredFactIds: string[] = [];
  const retiredHighlightIds: string[] = [];
  const appliedFactSubsystems = new Set((await prisma.projectFact.findMany({
    where: { id: { in: input.appliedFactIds.length ? input.appliedFactIds : [""] } },
    select: { subsystemKey: true },
  })).flatMap((fact) => fact.subsystemKey ? [fact.subsystemKey] : []));
  const appliedHighlightSubsystems = new Set((await prisma.highlight.findMany({
    where: { id: { in: input.appliedHighlightIds.length ? input.appliedHighlightIds : [""] } },
    select: { metadata: true },
  })).flatMap((highlight) => {
    const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
      ? highlight.metadata as Record<string, unknown>
      : null;
    return typeof metadata?.subsystemKey === "string" ? [metadata.subsystemKey] : [];
  }));

  for (const fact of activeFacts) {
    if (!isRepositoryDerived(fact.evidence)) continue;
    if (fact.approvalSource === "automation" && fact.reviewState === "pending_review" && fact.subsystemKey && appliedFactSubsystems.has(fact.subsystemKey)) {
      const reason = "A newer current-head synthesis replaced this unreviewed automated Project Fact in the same capability area.";
      await prisma.projectFact.update({ where: { id: fact.id }, data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: reason } });
      retiredFactIds.push(fact.id);
      await recordChange({ workItemId: run.workItemId, refreshRunId: run.id, entityKind: "project_fact", action: "retired", entityId: fact.id, beforeSnapshot: { statement: fact.statement, lifecycleStatus: fact.lifecycleStatus }, afterSnapshot: { statement: fact.statement, lifecycleStatus: "retired" }, reason, suffix: `${fact.id}:canonical-replacement:${run.id}` });
      continue;
    }
    const references = priorReferences(fact.evidence);
    const relevant = relevantObservations(fact.statement, fact.subsystemKey, observations);
    const validation = await validateAssertion({ assertion: fact.statement, priorReferences: references, currentReferences, observations: relevant });
    const immutableHeads = currentImmutableProvenanceHeads(fact.evidence, targetShaBySource);
    const currentSha = immutableHeads.values().next().value ?? null;
    const validationHeads = Object.fromEntries(immutableHeads);
    if (validation.verdict === "supported" && currentSha) {
      await prisma.projectFact.update({
        where: { id: fact.id },
        data: {
          lifecycleStatus: "active",
          status: "approved",
          reviewState: "pending_review",
          validatedThroughSha: currentSha,
          validationHeads,
          lastValidatedAt: new Date(),
          autoAppliedAt: new Date(),
        },
      });
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
          autoAppliedAt: new Date(),
          evidenceItemIds: fact.evidence.map((entry) => entry.evidenceItemId),
        },
        reason: validation.reason,
        provenance: { observationIndexes: validation.observationIndexes, commitSha: currentSha },
        suffix: `${fact.id}:${currentSha}`,
      });
    } else if (validation.verdict === "removed") {
      await prisma.projectFact.update({
        where: { id: fact.id },
        data: { lifecycleStatus: "retired", status: "rejected", rejectionReason: validation.reason },
      });
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
    } else {
      await prisma.projectFact.update({ where: { id: fact.id }, data: { lifecycleStatus: "needs_validation" } });
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

  for (const highlight of activeHighlights) {
    if (!isRepositoryDerived(highlight.evidence)) continue;
    const references = priorReferences(highlight.evidence);
    const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
      ? highlight.metadata as Record<string, unknown>
      : null;
    const subsystemKey = typeof metadata?.subsystemKey === "string" ? metadata.subsystemKey : null;
    if (highlight.approvalSource === "automation" && highlight.reviewState === "pending_review" && subsystemKey && appliedHighlightSubsystems.has(subsystemKey)) {
      const reason = "A newer current-head synthesis replaced this unreviewed automated Highlight in the same capability area.";
      await prisma.highlight.update({ where: { id: highlight.id }, data: { lifecycleStatus: "retired", rejectionReason: reason } });
      retiredHighlightIds.push(highlight.id);
      await recordChange({ workItemId: run.workItemId, refreshRunId: run.id, entityKind: "highlight", action: "retired", entityId: highlight.id, beforeSnapshot: { text: highlight.text, lifecycleStatus: highlight.lifecycleStatus }, afterSnapshot: { text: highlight.text, lifecycleStatus: "retired" }, reason, suffix: `${highlight.id}:canonical-replacement:${run.id}` });
      continue;
    }
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
      await prisma.highlight.update({
        where: { id: highlight.id },
        data: {
          lifecycleStatus: "active",
          reviewState: "pending_review",
          validatedThroughSha: currentSha,
          validationHeads: Object.fromEntries(immutableHeads),
          lastValidatedAt: new Date(),
          autoAppliedAt: new Date(),
        },
      });
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
          autoAppliedAt: new Date(),
          evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
        },
        reason: validation.reason,
        provenance: { observationIndexes: validation.observationIndexes, commitSha: currentSha },
        suffix: `${highlight.id}:${currentSha}`,
      });
    } else if (validation.verdict === "removed") {
      await prisma.highlight.update({
        where: { id: highlight.id },
        data: { lifecycleStatus: "retired", rejectionReason: validation.reason },
      });
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
    } else {
      await prisma.highlight.update({ where: { id: highlight.id }, data: { lifecycleStatus: "needs_validation" } });
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

  const repositoryEvidence = await prisma.evidenceItem.findMany({
    where: { workItemId: run.workItemId, type: "github_file_excerpt", lifecycleStatus: "active" },
  });
  for (const evidence of repositoryEvidence) {
    const metadata = evidence.metadata && typeof evidence.metadata === "object" && !Array.isArray(evidence.metadata)
      ? evidence.metadata as Record<string, unknown>
      : null;
    const commitSha = typeof metadata?.commitSha === "string" ? metadata.commitSha : null;
    if (commitSha && targetShaBySource.get(evidence.sourceId) !== commitSha) {
      const reason = "This immutable repository excerpt is pinned to an older repository head and requires review.";
      await prisma.evidenceItem.update({
        where: { id: evidence.id },
        data: { lifecycleStatus: "stale", purgeEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
      });
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "evidence",
        action: "updated",
        entityId: evidence.id,
        beforeSnapshot: { id: evidence.id, title: evidence.title, lifecycleStatus: evidence.lifecycleStatus, validatedThroughSha: evidence.validatedThroughSha },
        afterSnapshot: { id: evidence.id, title: evidence.title, lifecycleStatus: "stale", validatedThroughSha: evidence.validatedThroughSha },
        reason,
        provenance: { priorCommitSha: commitSha, currentCommitSha: targetShaBySource.get(evidence.sourceId) ?? null },
        suffix: `${evidence.id}:stale:${run.id}`,
      });
      await invalidateEvidenceDependents({
        workItemId: run.workItemId,
        evidenceItemId: evidence.id,
        reason,
        idempotencyScope: `refresh:${run.id}:evidence-stale:${evidence.id}`,
        refreshRunId: run.id,
      });
    }
  }

  const artifacts = await prisma.artifact.findMany({
    where: { workItemId: run.workItemId, lifecycleStatus: "active" },
    include: { highlightProvenance: { include: { highlight: true } }, evidenceProvenance: { include: { evidenceItem: true } } },
  });
  const staleArtifactIds: string[] = [];
  for (const artifact of artifacts) {
    const invalidHighlights = artifact.highlightProvenance.filter((entry) => entry.highlight && entry.highlight.lifecycleStatus !== "active");
    const invalidEvidence = artifact.evidenceProvenance.filter((entry) => entry.evidenceItem && entry.evidenceItem.lifecycleStatus !== "active");
    if (!invalidHighlights.length && !invalidEvidence.length) continue;
    const reason = `Upstream knowledge changed: ${invalidHighlights.length} Highlight and ${invalidEvidence.length} Evidence reference${invalidHighlights.length + invalidEvidence.length === 1 ? "" : "s"} are no longer canonical.`;
    await prisma.artifact.update({ where: { id: artifact.id }, data: { lifecycleStatus: "stale", staleReason: reason } });
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

  return { retiredFactIds, retiredHighlightIds, staleArtifactIds };
}

export const knowledgeStalenessService = { reconcile: reconcileStaleKnowledge };
