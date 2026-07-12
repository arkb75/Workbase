import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
import { resolveBedrockConfig } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  buildProjectFactEmbeddingText,
  upsertProjectFactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import { publicKnowledgeVerificationService } from "@/src/services/public-knowledge-verification-service";
import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";
import {
  materializeSynthesisCitations,
  synthesizeRepositoryKnowledge,
  type SynthesizedKnowledge,
  type SynthesisNotebookEntry,
} from "@/src/services/repository-knowledge-synthesis-service";
import type { RepositoryTargetHead } from "@/src/services/repository-knowledge-sync-service";

export const KNOWLEDGE_LIFECYCLE_POLICY_VERSION = "knowledge-lifecycle-v1";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

function referenceKey(entry: SynthesisNotebookEntry) {
  return `${entry.sourceId}:${entry.blobSha}:${entry.lineStart}:${entry.lineEnd}`;
}

function evidenceIdsForIndexes(input: {
  subsystem: SynthesizedKnowledge;
  citationIndexes: number[];
  promotedIdByReference: Map<string, string>;
}) {
  return Array.from(new Set(input.citationIndexes.flatMap((index) => {
    const notebook = input.subsystem.notebook[index - 1];
    if (!notebook) return [];
    const evidenceId = input.promotedIdByReference.get(referenceKey(notebook));
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
    const citation = input.materialized.get(referenceKey(notebook));
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
  const relation = input.entityKind === "evidence"
    ? { evidenceItemId: input.entityId }
    : input.entityKind === "highlight"
      ? { highlightId: input.entityId }
      : input.entityKind === "project_fact"
        ? { projectFactId: input.entityId }
        : { artifactId: input.entityId };
  return prisma.knowledgeChange.upsert({
    where: {
      workItemId_idempotencyKey: {
        workItemId: input.workItemId,
        idempotencyKey: `${input.refreshRunId ?? "direct"}:${input.entityKind}:${input.action}:${input.suffix}`,
      },
    },
    create: {
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
      entityKind: input.entityKind,
      action: input.action,
      ...relation,
      beforeSnapshot: input.beforeSnapshot === undefined ? undefined : toInputJson(input.beforeSnapshot),
      afterSnapshot: input.afterSnapshot === undefined ? undefined : toInputJson(input.afterSnapshot),
      reason: input.reason,
      provenance: input.provenance === undefined ? undefined : toInputJson(input.provenance),
      downstreamImpact: input.downstreamImpact === undefined ? undefined : toInputJson(input.downstreamImpact),
      policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
      modelId: resolveBedrockConfig().modelId,
      idempotencyKey: `${input.refreshRunId ?? "direct"}:${input.entityKind}:${input.action}:${input.suffix}`,
    },
    update: {},
  });
}

async function preparePromotedEvidence(input: {
  runId: string;
  workItemId: string;
  targets: RepositoryTargetHead[];
  synthesis: SynthesizedKnowledge[];
  userId: string;
}) {
  const materialized = await materializeSynthesisCitations({
    userId: input.userId,
    workItemId: input.workItemId,
    targets: input.targets,
    synthesis: input.synthesis,
  });
  const entries = Array.from(materialized.entries());
  const promoted = await promoteRepositoryCitations({
    workItemId: input.workItemId,
    citations: entries.map(([, citation]) => citation),
  });
  const promotedIdByReference = new Map<string, string>();
  for (const [index, [key]] of entries.entries()) {
    const evidenceId = promoted.evidenceIdByCitationIndex.get(index);
    if (evidenceId) promotedIdByReference.set(key, evidenceId);
  }
  const snapshots = await prisma.repositorySnapshot.findMany({
    where: { refreshRunId: input.runId },
    select: { id: true, sourceId: true, commitSha: true },
  });
  for (const [reference, evidenceId] of promotedIdByReference) {
    const notebook = input.synthesis.flatMap((subsystem) => subsystem.notebook).find((entry) => referenceKey(entry) === reference);
    const snapshot = notebook
      ? snapshots.find((entry) => entry.sourceId === notebook.sourceId && entry.commitSha === notebook.commitSha)
      : null;
    await prisma.evidenceItem.update({
      where: { id: evidenceId },
      data: {
        logicalKey: notebook ? `github_file:${notebook.path}:${notebook.lineStart}:${notebook.lineEnd}` : undefined,
        repositorySnapshotId: snapshot?.id,
        lifecycleStatus: "active",
        reviewState: "pending_review",
        approvalSource: "automation",
        validatedThroughSha: notebook?.commitSha,
        lastValidatedAt: new Date(),
        autoAppliedAt: new Date(),
      },
    });
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
  const unsafe = input.candidate.sensitivityFlag || input.candidate.confidence === "low";
  const exact = closest && closest.score >= 0.9 && normalizeWhitespace(closest.fact.statement).toLowerCase() === normalizeWhitespace(input.candidate.statement).toLowerCase();

  if (exact && !unsafe) {
    await prisma.$transaction([
      prisma.projectFact.update({
        where: { id: closest.fact.id },
        data: {
          status: "approved",
          lifecycleStatus: "active",
          validatedThroughSha: input.commitSha,
          lastValidatedAt: new Date(),
          rejectionReason: null,
          productImportance: input.candidate.productImportance,
          implementationBreadth: input.candidate.implementationBreadth,
          technicalDifficulty: input.candidate.technicalDifficulty,
          distinctiveness: input.candidate.distinctiveness,
          evidence: { createMany: { data: input.evidenceIds.map((evidenceItemId) => ({ evidenceItemId })), skipDuplicates: true } },
        },
      }),
      prisma.evidenceItem.updateMany({ where: { id: { in: input.evidenceIds } }, data: { included: true } }),
    ]);
    await recordChange({
      workItemId: input.workItemId,
      refreshRunId: input.runId,
      entityKind: "project_fact",
      action: "revalidated",
      entityId: closest.fact.id,
      beforeSnapshot: { statement: closest.fact.statement, validatedThroughSha: closest.fact.validatedThroughSha },
      afterSnapshot: { statement: closest.fact.statement, validatedThroughSha: input.commitSha },
      reason: "Current repository evidence revalidated this Project Fact.",
      provenance: { evidenceIds: input.evidenceIds, commitSha: input.commitSha },
      suffix: `${closest.fact.id}:${input.commitSha}`,
    });
    return closest.fact.id;
  }

  const supersedes = !unsafe && closest && closest.score >= 0.55
    ? closest.fact
    : null;
  const fact = await prisma.$transaction(async (tx) => {
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
  await upsertProjectFactEmbedding({
    projectFactId: fact.id,
    inputText: buildProjectFactEmbeddingText(fact),
  });
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
}) {
  if (!input.evidenceIds.length) return null;
  const unsafe = input.candidate.sensitivityFlag || input.candidate.confidence === "low";
  const publicVerification = unsafe
    ? { eligible: false, correctedText: null, reasons: ["The Highlight failed the automatic safety gate."], claimChecks: [], tokenUsage: null }
    : await publicKnowledgeVerificationService.verify({
        text: input.candidate.text,
        summary: input.candidate.summary,
        confidence: input.candidate.confidence,
        ownershipClarity: "unclear",
        sensitivityFlag: input.candidate.sensitivityFlag,
        evidence: input.evidence,
      });
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
  const supersedes = !unsafe && closest && closest.score >= 0.55 ? closest.highlight : null;
  const tags = inferHighlightTags({
    text,
    summary: input.candidate.summary,
    verificationNotes: publicVerification.reasons.join(" ") || "Verified from complete repository coverage.",
  });
  const highlight = await prisma.$transaction(async (tx) => {
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
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: runId },
    include: { workItem: { select: { userId: true } } },
  });
  if (run.status !== "reconciling") throw new Error("Repository coverage must complete before reconciliation.");
  const targets = run.targetHeads as unknown as RepositoryTargetHead[];
  const partialChanges = await prisma.knowledgeChange.count({ where: { refreshRunId: runId } });
  const synthesis = await synthesizeRepositoryKnowledge(runId, { fallbackOnly: partialChanges > 0 });
  const { materialized, promotedIdByReference } = await preparePromotedEvidence({
    runId,
    workItemId: run.workItemId,
    targets,
    synthesis,
    userId: run.workItem.userId,
  });
  const appliedFactIds: string[] = [];
  const appliedHighlightIds: string[] = [];
  for (const subsystem of synthesis) {
    for (const candidate of subsystem.facts) {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const factId = await applyFact({
        runId,
        workItemId: run.workItemId,
        subsystem,
        candidate,
        evidenceIds,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
      });
      if (factId) appliedFactIds.push(factId);
    }
    for (const candidate of subsystem.highlights) {
      const evidenceIds = evidenceIdsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, promotedIdByReference });
      const evidence = citationsForIndexes({ subsystem, citationIndexes: candidate.citationIndexes, materialized }).map((entry) => ({
        title: entry.label,
        excerpt: entry.excerpt,
        commitSha: entry.commitSha,
      }));
      const citedEntries = candidate.citationIndexes.flatMap((index) => subsystem.notebook[index - 1] ? [subsystem.notebook[index - 1]!] : []);
      const highlightId = await applyHighlight({
        runId,
        workItemId: run.workItemId,
        subsystem,
        candidate,
        evidenceIds,
        evidence,
        commitSha: citedEntries[0]?.commitSha ?? targets[0]?.commitSha ?? "",
      });
      if (highlightId) appliedHighlightIds.push(highlightId);
    }
  }
  return {
    synthesis,
    appliedFactIds: Array.from(new Set(appliedFactIds)),
    appliedHighlightIds: Array.from(new Set(appliedHighlightIds)),
    promotedEvidenceIds: Array.from(new Set(promotedIdByReference.values())),
  };
}

export { recordChange };

export const knowledgeReconciliationService = { reconcile: reconcileRepositoryKnowledge };
