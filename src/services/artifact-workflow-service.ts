import { Prisma } from "@/src/generated/prisma/client";
import type {
  ClaimSnapshot,
  EvidenceItemSnapshot,
  JsonValue,
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

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
    }),
    prisma.evidenceItem.findMany({
      where: {
        id: { in: input.draft.supportingEvidenceItemIds },
        workItemId: input.workItemId,
        included: true,
        lifecycleStatus: "active",
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
    sources: [
      ...highlights.map((highlight) => ({
        kind: "highlight" as const,
        title: highlight.text,
        content: highlight.summary,
        ownershipClarity: highlight.ownershipClarity,
        sensitivityFlag: highlight.sensitivityFlag,
        publicSafetyStatus: highlight.publicSafetyStatus,
      })),
      ...evidence.map((item) => ({
        kind: "evidence" as const,
        title: item.title,
        content: item.content,
        sensitivityFlag: false,
        publicSafetyStatus: "verified",
      })),
    ],
  });
  const persistedContent = publicVerification.eligible && publicVerification.correctedContent
    ? publicVerification.correctedContent
    : input.draft.content;
  const artifact = await prisma.artifact.upsert({
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
      lifecycleStatus: publicVerification.eligible ? "active" : "quarantined",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: publicVerification.eligible ? "verified" : "failed",
      staleReason: publicVerification.eligible ? null : publicVerification.reasons.join(" ").slice(0, 1_000),
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
  if (input.supersedesArtifactId && publicVerification.eligible) {
    await prisma.artifact.updateMany({
      where: { id: input.supersedesArtifactId, workItemId: input.workItemId },
      data: { lifecycleStatus: "superseded" },
    });
  }
  await upsertArtifactEmbedding({
    artifactId: artifact.id,
    inputText: buildArtifactEmbeddingText(artifact),
  });
  await recordChange({
    workItemId: input.workItemId,
    entityKind: "artifact",
    action: publicVerification.eligible ? "created" : "quarantined",
    entityId: artifact.id,
    afterSnapshot: {
      id: artifact.id,
      content: artifact.content,
      lifecycleStatus: artifact.lifecycleStatus,
      publicSafetyStatus: artifact.publicSafetyStatus,
    },
    reason: publicVerification.eligible
      ? "The generated Artifact passed final claim-level public verification."
      : publicVerification.reasons.join(" ") || "The generated Artifact failed final public verification.",
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
  const promoted = await promoteRepositoryCitations({
    workItemId: input.workItemId,
    citations: research.citations,
  });
  const knowledge = await projectKnowledgeRetrievalService.retrieve({
    userId: input.userId,
    workItemId: input.workItemId,
    query: input.brief,
    purpose: "project_research",
    limits: { evidence: 12, highlights: 8, artifacts: 3 },
  });
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
  const surfaced = await prisma.$transaction(async (tx) => {
    const entries: Array<{ id: string; highlightId: string }> = [];
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
      entries.push({ id: candidate.id, highlightId: highlight.id });
    }
    return entries;
  });
  const selectedEvidenceIds = new Set([
    ...promoted.promotedIds,
    ...knowledge.selectedEvidenceItemIds,
  ]);
  const evidenceItems = context.evidenceItems
    .filter(
      (item) =>
        selectedEvidenceIds.has(item.id) &&
        (item.included || promoted.promotedIds.includes(item.id)),
    )
    .slice(0, 16)
    .map(mapEvidence);

  if (!evidenceItems.length) {
    return surfaced;
  }

  const normalizedBrief = normalizeArtifactBrief(input.brief);
  if (normalizedBrief.status !== "ok") return surfaced;
  const workItem = mapWorkItem(context);
  const existingHighlights = context.highlights.map(mapHighlight);
  const normalizedEvidence = await sourceIngestionService.normalize({
    workItem,
    sources: context.sources.map(mapSource),
    evidenceItems,
  });
  const generated = await claimResearchService.generate({
    workItem,
    evidenceItems: normalizedEvidence,
    existingHighlights,
    artifactRequest: {
      userId: input.userId,
      workItemId: input.workItemId,
      ...normalizedBrief.request,
    },
  });
  const verified = await claimVerificationService.verify({
    workItem,
    evidenceItems: normalizedEvidence,
    highlights: generated.highlights,
  });
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

  if (!drafts.length && promoted.newIds.length) {
    await prisma.evidenceItem.deleteMany({
      where: { id: { in: promoted.newIds }, type: "github_file_excerpt", included: false },
    });
  }
  const created = await prisma.$transaction(async (tx) => {
    const entries: Array<{
      id: string;
      highlightId: string;
      draft: (typeof drafts)[number];
    }> = [];

    for (const [index, draft] of drafts.entries()) {
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

    return entries;
  });
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
  if (created.length && promoted.newIds.length) {
    await prisma.evidenceItem.updateMany({
      where: { id: { in: promoted.newIds } },
      data: { included: true },
    });
  }
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
  | { status: "completed"; artifactId: string }
  | { status: "awaiting_review"; candidateIds: string[]; batchNumber: number }
  | { status: "retry_research"; batchNumber: number }
  | { status: "clarification_required" | "insufficient_context"; message: string };

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
    if (run.artifact.lifecycleStatus === "quarantined") {
      const message = run.artifact.staleReason ?? "The generated Artifact did not pass public verification.";
      return { status: "insufficient_context", message };
    }
    await completeAgentRun({
      runId: run.id,
      content: run.artifact.content,
      result: { status: "completed", artifactId: run.artifact.id, replayed: true },
      citationPolicy: "none",
    });
    return { status: "completed", artifactId: run.artifact.id };
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
    await completeAgentRun({
      runId: run.id,
      content: normalized.message,
      result: { status: "clarification_required" },
      citationPolicy: "none",
    });
    return { status: "clarification_required", message: normalized.message };
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
    const citations = [
      ...artifactResult.retrieval.highlights
        .filter((highlight) => usedHighlightIds.has(highlight.id))
        .map((highlight) => ({
        kind: "highlight" as const,
        label: highlight.text,
        excerpt: highlight.summary,
        highlightId: highlight.id,
        })),
      ...artifactResult.retrieval.supportingEvidence
        .filter((item) => usedEvidenceIds.has(item.id))
        .map((item) => {
          const metadata =
            item.type === "github_file_excerpt" &&
            item.metadata &&
            typeof item.metadata === "object" &&
            !Array.isArray(item.metadata)
              ? item.metadata
              : null;
          return {
            kind: metadata ? ("github_file" as const) : ("evidence" as const),
            label: item.title,
            excerpt: item.content,
            evidenceItemId: item.id,
            sourceId: item.sourceId,
            repository:
              metadata && typeof metadata.repository === "string"
                ? metadata.repository
                : undefined,
            commitSha:
              metadata && typeof metadata.commitSha === "string"
                ? metadata.commitSha
                : undefined,
            blobSha:
              metadata && typeof metadata.blobSha === "string" ? metadata.blobSha : undefined,
            path: metadata && typeof metadata.path === "string" ? metadata.path : undefined,
            startLine:
              metadata && typeof metadata.startLine === "number"
                ? metadata.startLine
                : undefined,
            endLine:
              metadata && typeof metadata.endLine === "number" ? metadata.endLine : undefined,
            url: metadata && typeof metadata.url === "string" ? metadata.url : undefined,
            contentHash:
              metadata && typeof metadata.excerptHash === "string"
                ? metadata.excerptHash
                : undefined,
          };
        }),
    ];
    await completeAgentRun({
      runId: run.id,
      content: artifact.content,
      result: { status: "completed", artifactId: artifact.id },
      citations,
      citationPolicy: "attached",
    });
    return { status: "completed", artifactId: artifact.id };
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
