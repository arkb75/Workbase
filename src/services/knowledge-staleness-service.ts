import { prisma } from "@/src/lib/prisma";
import { knowledgeSimilarity, recordChange } from "@/src/services/knowledge-reconciliation-service";
import type { RepositoryFileAnalysis } from "@/src/services/repository-coverage-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";

type CurrentObservation = {
  statement: string;
  path: string;
  subsystemKeys: string[];
  commitSha: string;
};

function parseAnalysis(value: unknown): RepositoryFileAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as RepositoryFileAnalysis;
  return Array.isArray(analysis.facts) && Array.isArray(analysis.subsystemKeys) ? analysis : null;
}

function currentObservations(run: Awaited<ReturnType<typeof loadRun>>) {
  const observations: CurrentObservation[] = [];
  for (const snapshot of run.snapshots) {
    for (const file of snapshot.files) {
      const analysis = parseAnalysis(file.analysis);
      if (!analysis) continue;
      for (const fact of analysis.facts) {
        observations.push({
          statement: fact.statement,
          path: file.path,
          subsystemKeys: analysis.subsystemKeys,
          commitSha: snapshot.commitSha,
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
  priorPaths: string[];
  currentPaths: Set<string>;
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
  if (input.priorPaths.length && input.priorPaths.every((path) => !input.currentPaths.has(path))) {
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

function priorPaths(evidence: Array<{ evidenceItem: { metadata: unknown } }>) {
  return Array.from(new Set(evidence.flatMap((entry) => {
    const metadata = entry.evidenceItem.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
    const path = (metadata as Record<string, unknown>).path;
    return typeof path === "string" ? [path] : [];
  })));
}

export async function reconcileStaleKnowledge(input: {
  runId: string;
  appliedFactIds: string[];
  appliedHighlightIds: string[];
}) {
  const run = await loadRun(input.runId);
  const targets = run.targetHeads as unknown as RepositoryTargetHead[];
  const targetShas = new Set(targets.map((target) => target.commitSha));
  const observations = currentObservations(run);
  const currentPaths = new Set(run.snapshots.flatMap((snapshot) => snapshot.files.map((file) => file.path)));
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

  for (const fact of activeFacts) {
    if (!isRepositoryDerived(fact.evidence)) continue;
    const paths = priorPaths(fact.evidence);
    const relevant = relevantObservations(fact.statement, fact.subsystemKey, observations);
    const validation = await validateAssertion({ assertion: fact.statement, priorPaths: paths, currentPaths, observations: relevant });
    const currentSha = relevant[0]?.commitSha ?? targets[0]?.commitSha ?? null;
    if (validation.verdict === "supported") {
      await prisma.projectFact.update({
        where: { id: fact.id },
        data: { lifecycleStatus: "active", status: "approved", validatedThroughSha: currentSha, lastValidatedAt: new Date() },
      });
      await recordChange({
        workItemId: run.workItemId,
        refreshRunId: run.id,
        entityKind: "project_fact",
        action: "revalidated",
        entityId: fact.id,
        beforeSnapshot: { statement: fact.statement, validatedThroughSha: fact.validatedThroughSha },
        afterSnapshot: { statement: fact.statement, validatedThroughSha: currentSha },
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
        provenance: { priorPaths: paths, targetShas: Array.from(targetShas) },
        suffix: `${fact.id}:${targets.map((target) => target.commitSha).join(":")}`,
      });
    } else {
      await prisma.projectFact.update({ where: { id: fact.id }, data: { lifecycleStatus: "needs_validation" } });
    }
  }

  for (const highlight of activeHighlights) {
    if (!isRepositoryDerived(highlight.evidence)) continue;
    const paths = priorPaths(highlight.evidence);
    const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
      ? highlight.metadata as Record<string, unknown>
      : null;
    const subsystemKey = typeof metadata?.subsystemKey === "string" ? metadata.subsystemKey : null;
    const validation = await validateAssertion({
      assertion: `${highlight.text}. ${highlight.summary}`,
      priorPaths: paths,
      currentPaths,
      observations: relevantObservations(`${highlight.text} ${highlight.summary}`, subsystemKey, observations),
    });
    if (validation.verdict === "supported") {
      await prisma.highlight.update({
        where: { id: highlight.id },
        data: { lifecycleStatus: "active", validatedThroughSha: targets[0]?.commitSha, lastValidatedAt: new Date() },
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
        provenance: { priorPaths: paths, targetShas: Array.from(targetShas) },
        suffix: `${highlight.id}:${targets.map((target) => target.commitSha).join(":")}`,
      });
    } else {
      await prisma.highlight.update({ where: { id: highlight.id }, data: { lifecycleStatus: "needs_validation" } });
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
    if (commitSha && !targetShas.has(commitSha)) {
      await prisma.evidenceItem.update({
        where: { id: evidence.id },
        data: { lifecycleStatus: "stale", purgeEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
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
    const invalidEvidence = artifact.evidenceProvenance.filter((entry) => entry.evidenceItem && !["active", "stale"].includes(entry.evidenceItem.lifecycleStatus));
    if (!invalidHighlights.length && !invalidEvidence.length) continue;
    const reason = `Upstream knowledge changed: ${invalidHighlights.length} Highlight and ${invalidEvidence.length} Evidence reference${invalidHighlights.length + invalidEvidence.length === 1 ? "" : "s"} are no longer canonical.`;
    await prisma.artifact.update({ where: { id: artifact.id }, data: { lifecycleStatus: "stale", staleReason: reason } });
    staleArtifactIds.push(artifact.id);
    await recordChange({
      workItemId: run.workItemId,
      refreshRunId: run.id,
      entityKind: "artifact",
      action: "retired",
      entityId: artifact.id,
      beforeSnapshot: { content: artifact.content, lifecycleStatus: artifact.lifecycleStatus },
      afterSnapshot: { content: artifact.content, lifecycleStatus: "stale", staleReason: reason },
      reason,
      downstreamImpact: { invalidHighlightIds: invalidHighlights.flatMap((entry) => entry.highlightId ? [entry.highlightId] : []), invalidEvidenceIds: invalidEvidence.flatMap((entry) => entry.evidenceItemId ? [entry.evidenceItemId] : []) },
      suffix: `${artifact.id}:${targets.map((target) => target.commitSha).join(":")}`,
    });
  }

  return { retiredFactIds, retiredHighlightIds, staleArtifactIds };
}

export const knowledgeStalenessService = { reconcile: reconcileStaleKnowledge };
