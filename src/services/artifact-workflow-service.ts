import { Prisma } from "@/src/generated/prisma/client";
import type {
  ClaimSnapshot,
  EvidenceItemSnapshot,
  JsonValue,
  NormalizedEvidenceItem,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { filterDuplicateClaimDrafts } from "@/src/domain/claim-regeneration";
import { createHighlightWithRelations } from "@/src/lib/evidence-persistence";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { artifactGenerationService } from "@/src/services/artifact-generation-service";
import { normalizeArtifactBrief } from "@/src/services/artifact-brief-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import { highlightRetrievalService } from "@/src/services/highlight-retrieval-service";
import {
  buildArtifactEmbeddingText,
  upsertArtifactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import { appendAgentRunEvent, completeAgentRun, failAgentRun } from "@/src/services/project-chat-store";
import { projectKnowledgeRetrievalService } from "@/src/services/project-knowledge-retrieval-service";
import { projectResearchService } from "@/src/services/project-research-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import { buildArtifactFromApprovedClaims } from "@/src/domain/workbase-workflows";
import { publicArtifactVisibilityRules } from "@/src/lib/options";
import { persistResearchAgentEvent } from "@/src/services/research-event-persistence-service";
import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";
import { publicKnowledgeVerificationService } from "@/src/services/public-knowledge-verification-service";
import { recordChange } from "@/src/services/knowledge-reconciliation-service";
import {
  buildPublicArtifactCitations,
  buildPublicArtifactVerificationSources,
} from "@/src/services/artifact-publication-policy";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function lockArtifactResearchEvidence(
  tx: Prisma.TransactionClient,
  workItemId: string,
  evidenceIds: readonly string[],
) {
  const ids = Array.from(new Set(evidenceIds));
  if (!ids.length) return [];
  return tx.$queryRaw<Array<{
    id: string;
    included: boolean;
    lifecycleStatus: string;
    reviewState: string;
    approvalSource: string;
  }>>(Prisma.sql`
    SELECT
      "id",
      "included",
      "lifecycleStatus"::text AS "lifecycleStatus",
      "reviewState"::text AS "reviewState",
      "approvalSource"::text AS "approvalSource"
    FROM "EvidenceItem"
    WHERE "workItemId" = ${workItemId}
      AND "id" IN (${Prisma.join(ids)})
    FOR UPDATE
  `);
}

export function artifactBriefRequiresMeasuredImpact(brief: string) {
  return /\b(?:quantif(?:y|ied|iable)|measur(?:e|ed|able)|metric|latency (?:improvement|reduction)|throughput (?:improvement|increase)|performance (?:improvement|gain)|\d+(?:\.\d+)?\s*(?:%|x|ms|seconds?|minutes?|hours?|users?|requests?))\b/i.test(brief);
}

export function hasMeasuredImpactEvidence(hits: Awaited<ReturnType<typeof projectKnowledgeRetrievalService.retrieve>>["hits"]) {
  return hits.some((hit) =>
    ["included_evidence", "verified_highlight", "verified_project_fact"].includes(hit.authority) &&
    /\b\d+(?:\.\d+)?\s*(?:%|x|ms|s|sec(?:onds?)?|minutes?|hours?|users?|requests?|records?)\b/i.test(hit.content) &&
    /\b(?:reduc|improv|increas|decreas|faster|slower|latency|throughput|saved|grew)\w*/i.test(hit.content)
  );
}

function mapWorkItem(workItem: {
  id: string;
  userId: string;
  title: string;
  type: "project" | "experience";
  description: string;
  startDate: Date | null;
  endDate: Date | null;
}): WorkItemSnapshot {
  return {
    id: workItem.id,
    userId: workItem.userId,
    title: workItem.title,
    type: workItem.type,
    description: workItem.description,
    startDate: workItem.startDate,
    endDate: workItem.endDate,
  };
}

function mapSource(source: {
  id: string;
  workItemId: string;
  type: "manual_note" | "github_repo" | "chat_context";
  label: string;
  externalId: string | null;
  rawContent: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SourceSnapshot {
  return {
    ...source,
    metadata: (source.metadata as JsonValue | null) ?? null,
  };
}

function mapEvidence(item: {
  id: string;
  workItemId: string;
  sourceId: string;
  externalId: string;
  type: EvidenceItemSnapshot["type"];
  title: string;
  content: string;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  included: boolean;
  lifecycleStatus: EvidenceItemSnapshot["lifecycleStatus"];
  reviewState: EvidenceItemSnapshot["reviewState"];
  approvalSource: EvidenceItemSnapshot["approvalSource"];
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    label: string;
    type: EvidenceItemSnapshot["source"]["type"];
    externalId: string | null;
  };
  tags: Array<{ dimension: string; tag: string; score: number | null }>;
}): EvidenceItemSnapshot {
  return {
    id: item.id,
    workItemId: item.workItemId,
    sourceId: item.sourceId,
    externalId: item.externalId,
    type: item.type,
    title: item.title,
    content: item.content,
    searchText: item.searchText,
    parentKind: item.parentKind,
    parentKey: item.parentKey,
    included: item.included,
    lifecycleStatus: item.lifecycleStatus,
    reviewState: item.reviewState,
    approvalSource: item.approvalSource,
    metadata: (item.metadata as JsonValue | null) ?? null,
    source: item.source,
    tags: item.tags.map((tag) => ({
      dimension: tag.dimension as never,
      tag: tag.tag as never,
      score: tag.score,
    })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function mapHighlight(highlight: Awaited<ReturnType<typeof loadArtifactContext>>["highlights"][number]): ClaimSnapshot {
  return {
    id: highlight.id,
    workItemId: highlight.workItemId,
    text: highlight.text,
    summary: highlight.summary,
    confidence: highlight.confidence,
    ownershipClarity: highlight.ownershipClarity,
    sensitivityFlag: highlight.sensitivityFlag,
    verificationStatus: highlight.verificationStatus,
    lifecycleStatus: highlight.lifecycleStatus,
    reviewState: highlight.reviewState,
    approvalSource: highlight.approvalSource,
    publicSafetyStatus: highlight.publicSafetyStatus,
    validatedThroughSha: highlight.validatedThroughSha,
    visibility: highlight.visibility,
    risksSummary: highlight.risksSummary,
    missingInfo: highlight.missingInfo,
    rejectionReason: highlight.rejectionReason,
    verificationNotes: highlight.verificationNotes,
    metadata: (highlight.metadata as JsonValue | null) ?? null,
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
    tags: highlight.tags.map((tag) => ({
      dimension: tag.dimension,
      tag: tag.tag as never,
      score: tag.score,
    })),
    createdAt: highlight.createdAt,
    updatedAt: highlight.updatedAt,
  };
}

function loadArtifactContext(userId: string, workItemId: string) {
  return prisma.workItem.findFirstOrThrow({
    where: { id: workItemId, userId },
    include: {
      sources: true,
      evidenceItems: {
        where: { lifecycleStatus: "active" },
        include: { source: true, tags: true },
        orderBy: { updatedAt: "desc" },
      },
      highlights: {
        where: { lifecycleStatus: "active" },
        include: {
          evidence: {
            include: { evidenceItem: { include: { source: true } } },
          },
          tags: true,
        },
      },
    },
  });
}

async function persistArtifact(input: {
  runId: string;
  userId: string;
  workItemId: string;
  normalized: {
    type: "resume_bullets" | "linkedin_experience" | "project_summary";
    targetAngle: "general" | "ai_ml" | "data_engineering" | "backend" | "full_stack";
    tone: "concise" | "technical" | "recruiter_friendly";
    brief: string;
  };
  draft: {
    content: string;
    usedHighlightIds: string[];
    supportingEvidenceItemIds: string[];
  };
  supersedesArtifactId?: string | null;
}) {
  const [highlights, evidence] = await Promise.all([
    prisma.highlight.findMany({
      where: {
        id: { in: input.draft.usedHighlightIds },
        workItemId: input.workItemId,
        verificationStatus: "approved",
        lifecycleStatus: "active",
        publicSafetyStatus: "verified",
        sensitivityFlag: false,
        visibility: { in: publicArtifactVisibilityRules[input.normalized.type] },
      },
      include: {
        evidence: { select: { evidenceItemId: true } },
      },
    }),
    prisma.evidenceItem.findMany({
      where: {
        id: { in: input.draft.supportingEvidenceItemIds },
        workItemId: input.workItemId,
        included: true,
        lifecycleStatus: "active",
        // Do not trust generator-returned Evidence IDs. Every persisted
        // provenance item must be directly related to a used Highlight.
        highlightEvidence: {
          some: { highlightId: { in: input.draft.usedHighlightIds } },
        },
      },
    }),
  ]);
  const expectedHighlightCount = new Set(input.draft.usedHighlightIds).size;
  const expectedEvidenceCount = new Set(input.draft.supportingEvidenceItemIds).size;
  if (highlights.length !== expectedHighlightCount || evidence.length !== expectedEvidenceCount) {
    throw new Error(
      "Artifact context changed during generation; approval, visibility, sensitivity, and evidence inclusion must be rechecked.",
    );
  }
  const activeRun = await prisma.agentRun.findFirst({
    where: { id: input.runId, status: "running" },
    select: { id: true },
  });
  if (!activeRun) throw new Error("The artifact run is no longer active.");
  const publicVerification = await publicKnowledgeVerificationService.verifyArtifact({
    content: input.draft.content,
    // Public output is authorized and verified only against approved,
    // visibility-compatible Highlights. Exact Evidence remains immutable
    // provenance beneath those Highlights and never expands what the Artifact
    // is allowed to claim.
    sources: buildPublicArtifactVerificationSources(highlights),
  });
  const persistedContent = publicVerification.eligible && publicVerification.correctedContent
    ? publicVerification.correctedContent
    : input.draft.content;
  const artifact = await prisma.$transaction(async (tx) => {
    const activeRuns = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
        AND "userId" = ${input.userId}
        AND "workItemId" = ${input.workItemId}
        AND "status" = 'running'
      FOR UPDATE
    `;
    if (!activeRuns[0]) {
      throw new Error("The artifact run is no longer active.");
    }
    return tx.artifact.upsert({
      where: { originatingAgentRunId: input.runId },
      create: {
        userId: input.userId,
        workItemId: input.workItemId,
        originatingAgentRunId: input.runId,
        type: input.normalized.type,
        targetAngle: input.normalized.targetAngle,
        tone: input.normalized.tone,
        requestBrief: input.normalized.brief,
        content: persistedContent,
        searchText: normalizeWhitespace(
          [input.normalized.brief, persistedContent].join(" "),
        ),
        // A verified Artifact remains non-active until completeAgentRun
        // atomically activates it and terminalizes the owning run. This makes
        // cancellation during public verification or embedding fail closed.
        lifecycleStatus: "quarantined",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: publicVerification.eligible ? "verified" : "failed",
        staleReason: publicVerification.eligible
          ? "Awaiting durable run finalization."
          : publicVerification.reasons.join(" ").slice(0, 1_000),
        supersedesArtifactId: input.supersedesArtifactId ?? null,
        highlightProvenance: {
          create: highlights.map((highlight, index) => ({
            highlightId: highlight.id,
            rank: index + 1,
            highlightSnapshot: toInputJson({
              id: highlight.id,
              text: highlight.text,
              summary: highlight.summary,
              confidence: highlight.confidence,
              ownershipClarity: highlight.ownershipClarity,
              sensitivityFlag: highlight.sensitivityFlag,
              visibility: highlight.visibility,
              verificationStatus: highlight.verificationStatus,
              risksSummary: highlight.risksSummary,
              missingInfo: highlight.missingInfo,
              evidenceItemIds: highlight.evidence.map((entry) => entry.evidenceItemId),
            }),
          })),
        },
        evidenceProvenance: {
          create: evidence.map((item, index) => ({
            evidenceItemId: item.id,
            rank: index + 1,
            evidenceSnapshot: toInputJson({
              id: item.id,
              title: item.title,
              content: item.content,
              type: item.type,
              sourceId: item.sourceId,
              metadata: item.metadata,
            }),
          })),
        },
      },
      update: {},
    });
  });
  await upsertArtifactEmbedding({
    artifactId: artifact.id,
    inputText: buildArtifactEmbeddingText(artifact),
  });
  if (!publicVerification.eligible) await recordChange({
    workItemId: input.workItemId,
    entityKind: "artifact",
    action: "quarantined",
    entityId: artifact.id,
    afterSnapshot: {
      id: artifact.id,
      content: artifact.content,
      lifecycleStatus: artifact.lifecycleStatus,
      publicSafetyStatus: artifact.publicSafetyStatus,
    },
    reason: publicVerification.reasons.join(" ") || "The generated Artifact failed final public verification.",
    provenance: { highlightIds: highlights.map((highlight) => highlight.id), evidenceIds: evidence.map((item) => item.id) },
    suffix: `${artifact.id}:public-verification`,
  }).catch(() => null);
  return { artifact, publicVerification };
}

async function generateCandidateBatch(input: {
  runId: string;
  userId: string;
  workItemId: string;
  brief: string;
  batchNumber: number;
  feedback: string[];
}) {
  await appendAgentRunEvent({
    runId: input.runId,
    type: "progress",
    message: `Researching project context for candidate batch ${input.batchNumber}.`,
  });
  const research = await projectResearchService.research({
    runId: input.runId,
    userId: input.userId,
    workItemId: input.workItemId,
    question: input.brief,
    purpose: "discover_highlights",
    hints: input.feedback,
    onAgentEvent: (event) => persistResearchAgentEvent(input.runId, event),
  });
  const transientResearchEvidence = research.citations.flatMap((citation, index) => {
    if (
      citation.kind !== "github_file" ||
      !citation.sourceId ||
      !citation.repository ||
      !citation.commitSha ||
      !citation.blobSha ||
      !citation.path
    ) return [];
    const temporaryId = [
      "artifact-research",
      input.runId,
      input.batchNumber,
      index,
    ].join(":");
    const excerpt = normalizeWhitespace(citation.excerpt);
    const normalized: NormalizedEvidenceItem = {
      id: temporaryId,
      sourceId: citation.sourceId,
      label: `${citation.path}:${citation.startLine ?? 1}-${citation.endLine ?? 1}`,
      type: "github_repo",
      evidenceType: "github_file_excerpt",
      searchText: normalizeWhitespace([citation.path, excerpt].join(" ")),
      parentKind: "github_file",
      parentKey: `${citation.commitSha}:${citation.path}`,
      body: excerpt,
      excerpts: [excerpt],
      metadata: {
        repository: citation.repository,
        commitSha: citation.commitSha,
        blobSha: citation.blobSha,
        path: citation.path,
        startLine: citation.startLine ?? null,
        endLine: citation.endLine ?? null,
        url: citation.url ?? null,
        contentSafety: "untrusted_repository_content",
        redacted: citation.redacted ?? false,
        redactionCategories: citation.redactionCategories ?? [],
      },
      tags: [],
    };
    return [{ temporaryId, citation, normalized }];
  });
  const knowledge = await projectKnowledgeRetrievalService.retrieve({
    userId: input.userId,
    workItemId: input.workItemId,
    query: input.brief,
    purpose: "project_research",
    limits: { evidence: 12, highlights: 8, artifacts: 3 },
  });
  const researchEstablishedMeasuredImpact = transientResearchEvidence.some(({ normalized }) =>
    /\b\d+(?:\.\d+)?\s*(?:%|x|ms|s|sec(?:onds?)?|minutes?|hours?|users?|requests?|records?)\b/i.test(normalized.body) &&
    /\b(?:reduc|improv|increas|decreas|faster|slower|latency|throughput|saved|grew)\w*/i.test(normalized.body)
  );
  if (
    artifactBriefRequiresMeasuredImpact(input.brief) &&
    !hasMeasuredImpactEvidence(knowledge.hits) &&
    !researchEstablishedMeasuredImpact
  ) {
    await appendAgentRunEvent({
      runId: input.runId,
      type: "warning",
      message: "Repository research did not establish a measured impact value; skipping speculative Highlight generation.",
      payload: { coverageGap: "Add a measured or explicitly self-reported impact statement before requesting a quantified artifact." },
      isUserVisible: false,
    });
    return [];
  }
  const context = await loadArtifactContext(input.userId, input.workItemId);
  const pendingHighlightIds = new Set(
    knowledge.hits.flatMap((hit) =>
      hit.kind === "highlight" &&
      hit.authority === "candidate_highlight" &&
      (hit.status === "draft" || hit.status === "flagged")
        ? [hit.id]
        : [],
    ),
  );
  const pendingHighlights = context.highlights.filter((highlight) =>
    pendingHighlightIds.has(highlight.id),
  );
  const selectedEvidenceIds = new Set(knowledge.selectedEvidenceItemIds);
  const durableEvidenceItems = context.evidenceItems
    .filter(
      (item) =>
        selectedEvidenceIds.has(item.id) &&
        item.included,
    )
    .slice(0, Math.max(0, 16 - transientResearchEvidence.length))
    .map(mapEvidence);

  const normalizedBrief = normalizeArtifactBrief(input.brief);
  const workItem = mapWorkItem(context);
  const existingHighlights = context.highlights.map(mapHighlight);
  const normalizedDurableEvidence = durableEvidenceItems.length
    ? await sourceIngestionService.normalize({
        workItem,
        sources: context.sources.map(mapSource),
        evidenceItems: durableEvidenceItems,
      })
    : [];
  const normalizedEvidence = [
    ...transientResearchEvidence.slice(0, 16).map((entry) => entry.normalized),
    ...normalizedDurableEvidence,
  ].slice(0, 16);
  const generated = normalizedEvidence.length && normalizedBrief.status === "ok"
    ? await claimResearchService.generate({
        workItem,
        evidenceItems: normalizedEvidence,
        existingHighlights,
        artifactRequest: {
          userId: input.userId,
          workItemId: input.workItemId,
          ...normalizedBrief.request,
        },
      })
    : { highlights: [], generationRunIds: { generation: [], verification: null } };
  const verified = generated.highlights.length
    ? await claimVerificationService.verify({
        workItem,
        evidenceItems: normalizedEvidence,
        highlights: generated.highlights,
      })
    : [];
  const drafts = [] as Array<(typeof verified)[number] & { autoSafe: boolean; publicVerified: boolean }>;
  for (const draft of filterDuplicateClaimDrafts(verified, existingHighlights).slice(0, 4)) {
    const autoSafe = draft.verificationStatus === "approved" && !draft.sensitivityFlag && draft.confidence !== "low";
    const publicVerification = autoSafe
      ? await publicKnowledgeVerificationService.verify({
          text: draft.text,
          summary: draft.summary,
          confidence: draft.confidence,
          ownershipClarity: draft.ownershipClarity,
          sensitivityFlag: draft.sensitivityFlag,
          evidence: draft.evidence.sourceRefs.map((reference) => ({
            title: reference.title ?? reference.sourceLabel,
            excerpt: reference.excerpt,
          })),
        })
      : { eligible: false, correctedText: null, reasons: ["The candidate failed the automatic safety gate."], claimChecks: [], tokenUsage: null };
    drafts.push({
      ...draft,
      text: publicVerification.eligible && publicVerification.correctedText ? publicVerification.correctedText : draft.text,
      verificationStatus: autoSafe ? "approved" : "flagged",
      visibility: publicVerification.eligible ? draft.visibility : "private",
      risksSummary: publicVerification.reasons.join(" ").slice(0, 1_000) || draft.risksSummary,
      metadata: {
        ...(draft.metadata && typeof draft.metadata === "object" && !Array.isArray(draft.metadata) ? draft.metadata : {}),
        managedBy: "artifact_auto_research",
        publicVerification,
      },
      autoSafe,
      publicVerified: publicVerification.eligible,
    });
  }

  const transientEvidenceById = new Map(
    transientResearchEvidence.map((entry) => [entry.temporaryId, entry]),
  );
  const usedTransientEvidence = transientResearchEvidence.filter((entry) =>
    drafts.some((draft) => draft.evidence.sourceRefs.some(
      (reference) => reference.evidenceItemId === entry.temporaryId,
    ))
  );
  const materialized = await prisma.$transaction(async (tx) => {
    const activeRuns = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
        AND "userId" = ${input.userId}
        AND "workItemId" = ${input.workItemId}
        AND "status" = 'running'
      FOR UPDATE
    `;
    if (!activeRuns[0]) {
      throw new Error("The artifact run is no longer active.");
    }
    const existingBatch = await tx.agentRunCandidate.findMany({
      where: {
        agentRunId: input.runId,
        batchNumber: input.batchNumber,
        kind: { in: ["new_highlight", "highlight_revision"] },
      },
      select: { id: true, highlightId: true },
      orderBy: { ordinal: "asc" },
    });
    if (existingBatch.length) {
      return {
        surfaced: existingBatch.flatMap((candidate) =>
          candidate.highlightId
            ? [{ id: candidate.id, highlightId: candidate.highlightId }]
            : []
        ),
        created: [] as Array<{
          id: string;
          highlightId: string;
          draft: (typeof drafts)[number];
        }>,
      };
    }

    const promoted = usedTransientEvidence.length
      ? await promoteRepositoryCitations({
          workItemId: input.workItemId,
          citations: usedTransientEvidence.map((entry) => entry.citation),
          reviewScope: `artifact-research:${input.runId}:batch:${input.batchNumber}`,
          mutationFence: (operation) => operation(tx),
        })
      : {
          promotedIds: [] as string[],
          newIds: [] as string[],
          evidenceIdByCitationIndex: new Map<number, string>(),
        };
    const promotedIdByTemporaryId = new Map(
      usedTransientEvidence.flatMap((entry, index) => {
        const evidenceId = promoted.evidenceIdByCitationIndex.get(index);
        return evidenceId ? [[entry.temporaryId, evidenceId] as const] : [];
      }),
    );
    const lockedPromotedEvidence = await lockArtifactResearchEvidence(
      tx,
      input.workItemId,
      promoted.promotedIds,
    );
    const automationPendingExcludedIds = lockedPromotedEvidence.flatMap((evidence) =>
      !evidence.included &&
      evidence.lifecycleStatus === "active" &&
      evidence.reviewState === "pending_review" &&
      evidence.approvalSource === "automation"
        ? [evidence.id]
        : []
    );
    const automationPendingExcludedIdSet = new Set(automationPendingExcludedIds);
    const usablePromotedIds = new Set(
      lockedPromotedEvidence.flatMap((evidence) =>
        evidence.lifecycleStatus === "active" &&
        evidence.reviewState !== "reverted" &&
        (
          evidence.included ||
          automationPendingExcludedIdSet.has(evidence.id)
        )
          ? [evidence.id]
          : []
      ),
    );
    for (const [temporaryId, evidenceId] of promotedIdByTemporaryId) {
      if (!usablePromotedIds.has(evidenceId)) promotedIdByTemporaryId.delete(temporaryId);
    }

    const remappedDrafts = drafts.flatMap((draft) => {
      const referencedTemporaryIds = draft.evidence.sourceRefs.flatMap((reference) =>
        reference.evidenceItemId && transientEvidenceById.has(reference.evidenceItemId)
          ? [reference.evidenceItemId]
          : []
      );
      // Repository-backed verification applies to the complete cited set.
      // Dropping a failed promotion and keeping the remaining refs would turn
      // that verification into a stronger claim than the persisted evidence
      // supports. Fail this draft closed unless every temporary ref maps.
      if (referencedTemporaryIds.some((id) => !promotedIdByTemporaryId.has(id))) {
        return [];
      }
      const sourceRefs = draft.evidence.sourceRefs.flatMap((reference) => {
        if (!reference.evidenceItemId) return [];
        if (!transientEvidenceById.has(reference.evidenceItemId)) return [reference];
        const evidenceItemId = promotedIdByTemporaryId.get(reference.evidenceItemId);
        return evidenceItemId ? [{ ...reference, evidenceItemId }] : [];
      });
      return sourceRefs.length
        ? [{
            ...draft,
            evidence: {
              ...draft.evidence,
              sourceRefs,
            },
          }]
        : [];
    });
    const remappedEvidenceIds = Array.from(new Set(remappedDrafts.flatMap((draft) =>
      draft.evidence.sourceRefs.flatMap((reference) =>
        reference.evidenceItemId ? [reference.evidenceItemId] : []
      )
    )));
    const automationEvidenceToInclude = remappedEvidenceIds.filter((evidenceId) =>
      automationPendingExcludedIdSet.has(evidenceId)
    );
    if (automationEvidenceToInclude.length) {
      const included = await tx.evidenceItem.updateMany({
        where: {
          id: { in: automationEvidenceToInclude },
          workItemId: input.workItemId,
          included: false,
          lifecycleStatus: "active",
          reviewState: "pending_review",
          approvalSource: "automation",
        },
        data: { included: true },
      });
      if (included.count !== automationEvidenceToInclude.length) {
        throw new Error(
          "Artifact research Evidence changed while its inclusion state was being finalized.",
        );
      }
    }
    const lockedRemappedEvidence = await lockArtifactResearchEvidence(
      tx,
      input.workItemId,
      remappedEvidenceIds,
    );
    const finalUsableEvidenceIds = new Set(
      lockedRemappedEvidence.flatMap((evidence) =>
        evidence.included &&
        evidence.lifecycleStatus === "active" &&
        evidence.reviewState !== "reverted"
          ? [evidence.id]
          : []
      ),
    );
    // A draft is atomic with respect to its cited support. If any durable or
    // newly promoted Evidence is missing, inactive, excluded, or reverted,
    // omit only that draft while preserving independently grounded drafts.
    const materializedDrafts = remappedDrafts.filter((draft) =>
      draft.evidence.sourceRefs.every((reference) =>
        Boolean(reference.evidenceItemId) &&
        finalUsableEvidenceIds.has(reference.evidenceItemId!)
      )
    );

    const surfaced: Array<{ id: string; highlightId: string }> = [];
    for (const [index, highlight] of pendingHighlights.entries()) {
      const candidate = await tx.agentRunCandidate.create({
        data: {
          agentRunId: input.runId,
          highlightId: highlight.id,
          kind: "new_highlight",
          batchNumber: input.batchNumber,
          ordinal: index + 1,
          snapshot: toInputJson(mapHighlight(highlight)),
        },
      });
      surfaced.push({ id: candidate.id, highlightId: highlight.id });
    }

    const entries: Array<{
      id: string;
      highlightId: string;
      draft: (typeof materializedDrafts)[number];
    }> = [];

    for (const [index, draft] of materializedDrafts.entries()) {
      const highlight = await createHighlightWithRelations({
        tx,
        workItemId: input.workItemId,
        draft,
      });
      const candidate = await tx.agentRunCandidate.create({
        data: {
          agentRunId: input.runId,
          highlightId: highlight.id,
          kind: "new_highlight",
          status: draft.autoSafe ? "approved" : "pending",
          batchNumber: input.batchNumber,
          ordinal: surfaced.length + index + 1,
          snapshot: toInputJson(draft),
          reviewedAt: draft.autoSafe ? new Date() : null,
        },
      });
      await tx.highlight.update({
        where: { id: highlight.id },
        data: {
          lifecycleStatus: draft.autoSafe ? "active" : "quarantined",
          reviewState: "pending_review",
          approvalSource: "automation",
          publicSafetyStatus: draft.publicVerified ? "verified" : draft.autoSafe ? "failed" : "not_eligible",
          autoAppliedAt: draft.autoSafe ? new Date() : null,
        },
      });
      entries.push({ id: candidate.id, highlightId: highlight.id, draft });
    }

    return { surfaced, created: entries };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30_000,
  });
  const { surfaced, created } = materialized;
  await Promise.all(
    created.map((entry) =>
      upsertHighlightEmbedding({
        highlightId: entry.highlightId,
        inputText: buildHighlightEmbeddingText(entry.draft),
      }),
    ),
  );
  await Promise.allSettled(created.map((entry) => recordChange({
    workItemId: input.workItemId,
    entityKind: "highlight",
    action: entry.draft.autoSafe ? "created" : "quarantined",
    entityId: entry.highlightId,
    afterSnapshot: {
      text: entry.draft.text,
      summary: entry.draft.summary,
      verificationStatus: entry.draft.verificationStatus,
      publicSafetyStatus: entry.draft.publicVerified ? "verified" : "failed",
    },
    reason: entry.draft.autoSafe
      ? "Artifact research auto-applied a verified Highlight for later review."
      : "Artifact research quarantined a Highlight that failed the automatic safety gate.",
    provenance: { agentRunId: input.runId, batchNumber: input.batchNumber },
    suffix: `${input.runId}:${entry.highlightId}`,
  })));
  const verificationRun = readGenerationRunMetadata(verified);
  await Promise.allSettled(
    [
      ...generated.generationRunIds.generation,
      verificationRun?.id ?? generated.generationRunIds.verification,
    ]
      .filter((id): id is string => Boolean(id))
      .map((id) =>
        updateGenerationRunResultRefs(id, {
          agentRunId: input.runId,
          candidateHighlightIds: created.map((entry) => entry.highlightId),
          artifactResearchBatch: input.batchNumber,
        }),
      ),
  );

  return [...surfaced, ...created];
}

export type ArtifactAttemptResult =
  | { status: "completed"; artifactId?: string; replayed?: true }
  | { status: "awaiting_review"; candidateIds: string[]; batchNumber: number }
  | { status: "retry_research"; batchNumber: number }
  | { status: "clarification_required"; message: string }
  | { status: "insufficient_context"; message: string; replayed?: true }
  | { status: "failed" | "cancelled"; message: string; replayed: true };

type AgentRunCompletion = Awaited<ReturnType<typeof completeAgentRun>>;

export function artifactAttemptResultAfterCompletion(
  completion: AgentRunCompletion,
  intended:
    | { status: "completed"; artifactId?: string }
    | { status: "clarification_required"; message: string },
): ArtifactAttemptResult {
  if (completion.persisted && completion.status === "completed") return intended;
  if (completion.status === "insufficient_context") {
    return {
      status: "insufficient_context",
      message: "message" in completion && typeof completion.message === "string"
        ? completion.message
        : "The artifact run finished without sufficient current source context.",
      ...(!completion.persisted ? { replayed: true as const } : {}),
    };
  }
  if (completion.persisted) {
    throw new Error("The artifact result finalized with an unexpected persisted status.");
  }
  if (completion.status === "completed") {
    return { status: "completed", artifactId: intended.status === "completed" ? intended.artifactId : undefined, replayed: true };
  }
  if (completion.status === "cancelled") {
    return { status: "cancelled", message: "The artifact run was cancelled.", replayed: true };
  }
  if (completion.status === "failed") {
    return { status: "failed", message: "The artifact run already failed.", replayed: true };
  }
  throw new Error("The artifact result could not be persisted to an active run.");
}

async function recordFinalizedArtifact(input: {
  runId: string;
  workItemId: string;
  artifact: {
    id: string;
    content: string;
    publicSafetyStatus: string;
  };
  highlightIds: string[];
  evidenceIds: string[];
}) {
  await recordChange({
    workItemId: input.workItemId,
    entityKind: "artifact",
    action: "created",
    entityId: input.artifact.id,
    afterSnapshot: {
      id: input.artifact.id,
      content: input.artifact.content,
      lifecycleStatus: "active",
      publicSafetyStatus: input.artifact.publicSafetyStatus,
    },
    reason: "The generated Artifact passed final claim-level public verification and its owning run completed.",
    provenance: {
      agentRunId: input.runId,
      highlightIds: input.highlightIds,
      evidenceIds: input.evidenceIds,
    },
    suffix: `${input.artifact.id}:public-verification`,
  }).catch(() => null);
}

export async function executeArtifactAttempt(input: {
  runId: string;
  batchNumber: number;
}): Promise<ArtifactAttemptResult> {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: input.runId },
    include: {
      candidates: true,
      artifact: true,
    },
  });
  if (run.status === "cancelled") {
    throw new Error("The artifact run was cancelled.");
  }
  if (run.artifact) {
    if (
      run.artifact.lifecycleStatus === "quarantined" &&
      run.artifact.publicSafetyStatus !== "verified"
    ) {
      const message = run.artifact.staleReason ?? "The generated Artifact did not pass public verification.";
      await failAgentRun({ runId: run.id, message, insufficient: true });
      return { status: "insufficient_context", message };
    }
    const completion = await completeAgentRun({
      runId: run.id,
      content: run.artifact.content,
      result: { status: "completed", artifactId: run.artifact.id, replayed: true },
      citationPolicy: "none",
      artifactFinalization: {
        artifactId: run.artifact.id,
        supersedesArtifactId: run.artifact.supersedesArtifactId,
      },
    });
    const result = artifactAttemptResultAfterCompletion(completion, {
      status: "completed",
      artifactId: run.artifact.id,
    });
    if (result.status === "completed") {
      await recordFinalizedArtifact({
        runId: run.id,
        workItemId: run.workItemId,
        artifact: run.artifact,
        highlightIds: [],
        evidenceIds: [],
      });
    }
    return result;
  }
  if (run.status === "insufficient_context" || run.status === "failed") {
    const storedError = run.error as { message?: unknown } | null;
    return {
      status: "insufficient_context",
      message:
        typeof storedError?.message === "string"
          ? storedError.message
          : "The artifact run is already terminal.",
    };
  }
  const request = run.request as Record<string, unknown>;
  const brief = typeof request.brief === "string"
    ? request.brief
    : typeof request.message === "string"
      ? request.message
      : "";
  const normalized = normalizeArtifactBrief(brief);

  if (normalized.status !== "ok") {
    const completion = await completeAgentRun({
      runId: run.id,
      content: normalized.message,
      result: { status: "clarification_required" },
      citationPolicy: "none",
    });
    return artifactAttemptResultAfterCompletion(completion, {
      status: "clarification_required",
      message: normalized.message,
    });
  }

  const context = await loadArtifactContext(run.userId, run.workItemId);
  const artifactResult = await buildArtifactFromApprovedClaims({
    request: {
      userId: run.userId,
      workItemId: run.workItemId,
      ...normalized.request,
    },
    workItem: mapWorkItem(context),
    highlights: context.highlights.map(mapHighlight),
    evidenceItems: context.evidenceItems.map(mapEvidence),
    highlightRetrievalService,
    artifactGenerationService,
    sourceIngestionService,
    claimResearchService,
    claimVerificationService,
  });

  if (artifactResult.artifactDraft) {
    const persisted = await persistArtifact({
      runId: run.id,
      userId: run.userId,
      workItemId: run.workItemId,
      normalized: normalized.request,
      draft: artifactResult.artifactDraft,
      supersedesArtifactId: typeof request.supersedesArtifactId === "string" ? request.supersedesArtifactId : null,
    });
    const artifact = persisted.artifact;
    if (!persisted.publicVerification.eligible) {
      const message = persisted.publicVerification.reasons.join(" ") || "The generated Artifact did not pass public verification.";
      await failAgentRun({ runId: run.id, message, insufficient: true });
      return { status: "insufficient_context", message };
    }
    if (artifactResult.generationRunId) {
      await updateGenerationRunResultRefs(artifactResult.generationRunId, {
        artifactId: artifact.id,
        agentRunId: run.id,
        usedHighlightIds: artifactResult.artifactDraft.usedHighlightIds,
        supportingEvidenceItemIds:
          artifactResult.artifactDraft.supportingEvidenceItemIds,
        fallbackUsed: false,
      });
    }
    if (artifactResult.retrieval.generationRunId) {
      await updateGenerationRunResultRefs(artifactResult.retrieval.generationRunId, {
        artifactId: artifact.id,
        agentRunId: run.id,
        usedHighlightIds: artifactResult.artifactDraft.usedHighlightIds,
        supportingEvidenceItemIds:
          artifactResult.artifactDraft.supportingEvidenceItemIds,
        fallbackUsed: false,
      });
    }
    const usedHighlightIds = new Set(artifactResult.artifactDraft.usedHighlightIds);
    const usedEvidenceIds = new Set(
      artifactResult.artifactDraft.supportingEvidenceItemIds,
    );
    const citations = buildPublicArtifactCitations({
      highlights: artifactResult.retrieval.highlights,
      usedHighlightIds: [...usedHighlightIds],
      supportingEvidence: artifactResult.retrieval.supportingEvidence.filter((item) =>
        usedEvidenceIds.has(item.id),
      ),
    });
    const completion = await completeAgentRun({
      runId: run.id,
      content: artifact.content,
      result: { status: "completed", artifactId: artifact.id },
      citations,
      citationPolicy: "attached",
      artifactFinalization: {
        artifactId: artifact.id,
        supersedesArtifactId:
          typeof request.supersedesArtifactId === "string"
            ? request.supersedesArtifactId
            : null,
      },
    });
    const result = artifactAttemptResultAfterCompletion(completion, {
      status: "completed",
      artifactId: artifact.id,
    });
    if (result.status === "completed") {
      await recordFinalizedArtifact({
        runId: run.id,
        workItemId: run.workItemId,
        artifact,
        highlightIds: [...usedHighlightIds],
        evidenceIds: [...usedEvidenceIds],
      });
    }
    return result;
  }

  if (input.batchNumber > 2) {
    const message =
      "I could not find enough approved, visibility-safe project context to support that artifact after two research passes.";
    await failAgentRun({ runId: run.id, message, insufficient: true });
    return { status: "insufficient_context", message };
  }

  const existingBatch = run.candidates.filter(
    (candidate) => candidate.batchNumber === input.batchNumber,
  );
  if (existingBatch.length) {
    const pending = existingBatch.filter((candidate) => candidate.status === "pending");
    if (pending.length) {
      const restored = await prisma.agentRun.updateMany({
        where: { id: run.id, status: { in: ["running", "awaiting_review"] } },
        data: { status: "awaiting_review", attemptNumber: input.batchNumber },
      });
      if (!restored.count) throw new Error("The artifact run is no longer active.");
      return {
        status: "awaiting_review",
        candidateIds: pending.map((candidate) => candidate.id),
        batchNumber: input.batchNumber,
      };
    }

    return { status: "retry_research", batchNumber: input.batchNumber + 1 };
  }

  const feedback = run.candidates.flatMap((candidate) =>
    candidate.feedback ? [candidate.feedback] : [],
  );
  const candidates = await generateCandidateBatch({
    runId: run.id,
    userId: run.userId,
    workItemId: run.workItemId,
    brief: normalized.request.brief,
    batchNumber: input.batchNumber,
    feedback,
  });

  if (!candidates.length) {
    if (artifactBriefRequiresMeasuredImpact(normalized.request.brief)) {
      const message = "Repository research did not find approved or self-reported measured impact evidence. Add the actual metric, measurement window, and what changed before generating a quantified artifact.";
      await failAgentRun({ runId: run.id, message, insufficient: true });
      return { status: "insufficient_context", message };
    }
    if (input.batchNumber < 2) {
      return { status: "retry_research", batchNumber: input.batchNumber + 1 };
    }
    const message =
      "Research did not find a defensible new highlight for this artifact request. Add project context or approve a relevant existing highlight first.";
    await failAgentRun({ runId: run.id, message, insufficient: true });
    return { status: "insufficient_context", message };
  }

  const pendingSafetyCandidates = await prisma.agentRunCandidate.findMany({
    where: {
      id: { in: candidates.map((candidate) => candidate.id) },
      status: "pending",
    },
    select: { id: true },
  });
  if (!pendingSafetyCandidates.length) {
    await appendAgentRunEvent({
      runId: run.id,
      type: "status_change",
      message: `Auto-applied ${candidates.length} verified Highlight${candidates.length === 1 ? "" : "s"}; rechecking artifact context without blocking for review.`,
    });
    return { status: "retry_research", batchNumber: input.batchNumber + 1 };
  }

  const awaitingReview = await prisma.agentRun.updateMany({
    where: { id: run.id, status: "running" },
    data: {
      status: "awaiting_review",
      attemptNumber: input.batchNumber,
    },
  });
  if (!awaitingReview.count) {
    throw new Error("The artifact run became terminal before candidate review began.");
  }
  await appendAgentRunEvent({
    runId: run.id,
    type: "status_change",
    message: `Review ${pendingSafetyCandidates.length} quarantined candidate${pendingSafetyCandidates.length === 1 ? "" : "s"}; verified candidates were already applied.`,
  });

  return {
    status: "awaiting_review",
    candidateIds: pendingSafetyCandidates.map((candidate) => candidate.id),
    batchNumber: input.batchNumber,
  };
}
