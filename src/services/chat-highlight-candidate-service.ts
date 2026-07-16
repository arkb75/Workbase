import type { JsonValue, ClaimSnapshot, HighlightDraft } from "@/src/domain/types";
import { createHighlightWithRelations } from "@/src/lib/evidence-persistence";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { inferEvidenceTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import {
  buildHighlightEmbeddingText,
  findNearestHighlightEmbedding,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  getDraftEvidenceIds,
  serializeHighlightDraft,
  snapshotHighlight,
} from "@/src/services/highlight-suggestion-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";
import { publicKnowledgeVerificationService } from "@/src/services/public-knowledge-verification-service";
import { recordChange } from "@/src/services/knowledge-reconciliation-service";

const ownershipPattern =
  /\b(i|we)\s+(built|created|designed|implemented|led|owned|shipped|migrated|optimized|improved|reduced|increased|launched|fixed|introduced|architected)\b/i;
const impactPattern = /\b\d+(?:\.\d+)?\s*(?:%|x|×|ms|s|sec|seconds?|minutes?|hours?|users?|requests?|records?)(?=\s|[.,;:!?)]|$)/i;
const nonAssertionPattern =
  /\b(did (?:i|we)|have (?:i|we)|if (?:i|we)|hypothetically|for example|imagine (?:i|we)|(?:i|we) (?:did not|didn't|never|might|could|would))\b/i;

export function isHighlightWorthyUserContext(value: string) {
  const normalized = normalizeWhitespace(value);
  return (
    normalized.length >= 24 &&
    !nonAssertionPattern.test(normalized) &&
    (ownershipPattern.test(normalized) || impactPattern.test(normalized))
  );
}

export function classifyChatCandidateMatch(input: {
  verificationStatus?: "draft" | "approved" | "flagged" | "rejected" | null;
  cosineDistance?: number | null;
}) {
  if (input.cosineDistance == null || input.cosineDistance > 0.18 || !input.verificationStatus) {
    return "new" as const;
  }
  if (input.verificationStatus === "approved") return "revision" as const;
  if (input.verificationStatus === "rejected") return "rejected_guidance_match" as const;
  return "duplicate" as const;
}

export function chatCandidateTextSimilarity(left: string, right: string) {
  const tokens = (value: string) => new Set(normalizeWhitespace(value.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2));
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return Math.max(
    overlap / new Set([...leftTokens, ...rightTokens]).size,
    overlap / Math.min(leftTokens.size, rightTokens.size),
  );
}

function mapHighlight(highlight: Awaited<ReturnType<typeof loadCandidateContext>>["highlights"][number]): ClaimSnapshot {
  return {
    id: highlight.id,
    workItemId: highlight.workItemId,
    text: highlight.text,
    summary: highlight.summary,
    confidence: highlight.confidence,
    ownershipClarity: highlight.ownershipClarity,
    sensitivityFlag: highlight.sensitivityFlag,
    verificationStatus: highlight.verificationStatus,
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

function loadCandidateContext(userId: string, workItemId: string) {
  return prisma.workItem.findFirstOrThrow({
    where: { id: workItemId, userId },
    include: {
      highlights: {
        include: {
          evidence: {
            include: {
              evidenceItem: { include: { source: true } },
            },
          },
          tags: true,
        },
      },
    },
  });
}

export async function proposeHighlightFromChatContext(input: {
  userId: string;
  workItemId: string;
  threadId: string;
  messageId: string;
  agentRunId: string;
  text: string;
  batchNumber?: number;
}) {
  if (!isHighlightWorthyUserContext(input.text)) {
    return null;
  }

  // Most chat turns are questions, not reusable ownership/impact statements.
  // Reject those in memory before paying for an idempotency lookup and the
  // larger candidate context graph.
  const existingCandidate = await prisma.agentRunCandidate.findFirst({
    where: { agentRunId: input.agentRunId },
  });
  if (existingCandidate) return existingCandidate;

  const dlp = redactRepositorySecrets(normalizeWhitespace(input.text));
  const context = await loadCandidateContext(input.userId, input.workItemId);
  const source = await prisma.source.upsert({
    where: {
      workItemId_type_externalId: {
        workItemId: input.workItemId,
        type: "chat_context",
        externalId: input.threadId,
      },
    },
    create: {
      workItemId: input.workItemId,
      type: "chat_context",
      label: "Self-reported chat context",
      externalId: input.threadId,
      metadata: {
        threadId: input.threadId,
        selfReported: true,
      },
    },
    update: {
      updatedAt: new Date(),
    },
  });
  const normalizedText = dlp.content;
  const evidence = await prisma.evidenceItem.upsert({
    where: {
      sourceId_externalId: {
        sourceId: source.id,
        externalId: `chat-message:${input.messageId}`,
      },
    },
    create: {
      workItemId: input.workItemId,
      sourceId: source.id,
      externalId: `chat-message:${input.messageId}`,
      type: "chat_user_statement",
      title: "Self-reported project context",
      content: normalizedText,
      searchText: normalizedText,
      parentKind: "chat_thread",
      parentKey: input.threadId,
      included: false,
      metadata: {
        threadId: input.threadId,
        messageId: input.messageId,
        selfReported: true,
        corroborationStatus: "not_checked",
        dlpCategories: dlp.categories,
      },
      lifecycleStatus: dlp.categories.length ? "quarantined" : "active",
      reviewState: "pending_review",
      approvalSource: "automation",
    },
    update: {
      content: normalizedText,
      searchText: normalizedText,
    },
    include: {
      source: true,
      tags: true,
    },
  });
  const evidenceTags = inferEvidenceTags({
    title: evidence.title,
    content: evidence.content,
    sourceType: "chat_context",
    evidenceType: "chat_user_statement",
  });

  if (!evidence.tags.length && evidenceTags.length) {
    await prisma.evidenceTag.createMany({
      data: evidenceTags.map((tag) => ({
        evidenceItemId: evidence.id,
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score ?? null,
      })),
      skipDuplicates: true,
    });
  }

  const existingHighlights = context.highlights.map(mapHighlight);
  const useModelGeneration = (process.env.WORKBASE_CHAT_CONTEXT_GENERATION_MODE ?? "deterministic") === "model";

  let candidateDraft: HighlightDraft;
  let autoSafe: boolean;
  let publicVerification: Awaited<ReturnType<typeof publicKnowledgeVerificationService.verify>>;
  let generationRunIds: string[] = [];

  if (!useModelGeneration) {
    autoSafe = !dlp.categories.length;
    publicVerification = {
      eligible: false,
      correctedText: null,
      reasons: dlp.categories.length
        ? ["The user statement contained suspected secret material and was redacted."]
        : ["Self-reported context is active as private project memory; public artifact use requires a separate visibility and safety review."],
      claimChecks: [],
      tokenUsage: null,
    };
    const conciseText = normalizedText.length <= 240
      ? normalizedText
      : `${normalizedText.slice(0, 237).trimEnd()}...`;
    candidateDraft = {
      text: conciseText,
      summary: normalizedText.slice(0, 1_000),
      confidence: "high",
      ownershipClarity: ownershipPattern.test(normalizedText) ? "clear" : "partial",
      sensitivityFlag: dlp.categories.length > 0,
      verificationStatus: autoSafe ? "approved" : "flagged",
      visibility: "private",
      risksSummary: publicVerification.reasons.join(" ").slice(0, 1_000),
      missingInfo: "This statement is self-reported and has not been independently corroborated.",
      rejectionReason: null,
      verificationNotes: "Auto-applied from an explicit user-authored project statement for later review.",
      metadata: {
        origin: "chat_user_statement",
        selfReported: true,
        corroborationStatus: "not_checked",
        messageId: input.messageId,
        publicVerification,
        dlpCategories: dlp.categories,
      },
      evidence: {
        summary: normalizedText,
        verificationNotes: "The user supplied this statement directly in project chat.",
        sourceRefs: [{
          evidenceItemId: evidence.id,
          sourceId: source.id,
          sourceLabel: source.label,
          sourceType: "chat_context",
          title: evidence.title,
          excerpt: evidence.content,
        }],
      },
      tags: evidenceTags,
    };
  } else {
    const evidenceSnapshot = {
    id: evidence.id,
    workItemId: evidence.workItemId,
    sourceId: evidence.sourceId,
    externalId: evidence.externalId,
    type: evidence.type,
    title: evidence.title,
    content: evidence.content,
    searchText: evidence.searchText,
    parentKind: evidence.parentKind,
    parentKey: evidence.parentKey,
    included: evidence.included,
    metadata: (evidence.metadata as JsonValue | null) ?? null,
    source: {
      id: evidence.source.id,
      label: evidence.source.label,
      type: evidence.source.type,
      externalId: evidence.source.externalId,
    },
    tags: evidenceTags,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
  };
    const normalizedEvidence = await sourceIngestionService.normalize({
    workItem: {
      id: context.id,
      userId: context.userId,
      title: context.title,
      type: context.type,
      description: context.description,
      startDate: context.startDate,
      endDate: context.endDate,
    },
    sources: [
      {
        id: source.id,
        workItemId: source.workItemId,
        type: source.type,
        label: source.label,
        externalId: source.externalId,
        rawContent: source.rawContent,
        metadata: (source.metadata as JsonValue | null) ?? null,
      },
    ],
    evidenceItems: [evidenceSnapshot],
  });
    const generated = await claimResearchService.generate({
    workItem: {
      id: context.id,
      userId: context.userId,
      title: context.title,
      type: context.type,
      description: context.description,
      startDate: context.startDate,
      endDate: context.endDate,
    },
    evidenceItems: normalizedEvidence,
    existingHighlights,
  });
    const verified = await claimVerificationService.verify({
    workItem: {
      id: context.id,
      userId: context.userId,
      title: context.title,
      type: context.type,
      description: context.description,
      startDate: context.startDate,
      endDate: context.endDate,
    },
    evidenceItems: normalizedEvidence,
    highlights: generated.highlights,
  });
    const draft = verified[0];

    if (!draft) return null;

    autoSafe =
      !dlp.categories.length &&
      draft.verificationStatus === "approved" &&
      !draft.sensitivityFlag &&
      draft.confidence !== "low";
    publicVerification = autoSafe
      ? await publicKnowledgeVerificationService.verify({
        text: draft.text,
        summary: draft.summary,
        confidence: draft.confidence,
        ownershipClarity: draft.ownershipClarity,
        sensitivityFlag: draft.sensitivityFlag,
        evidence: [{ title: evidence.title, excerpt: evidence.content }],
      })
      : { eligible: false, correctedText: null, reasons: dlp.categories.length ? ["The user statement contained suspected secret material and was redacted."] : ["The generated Highlight failed the automatic safety gate."], claimChecks: [], tokenUsage: null };

    candidateDraft = {
      ...draft,
      text: publicVerification.eligible && publicVerification.correctedText ? publicVerification.correctedText : draft.text,
      verificationStatus: autoSafe ? ("approved" as const) : ("flagged" as const),
      visibility: publicVerification.eligible ? draft.visibility : ("private" as const),
      risksSummary: publicVerification.reasons.join(" ").slice(0, 1_000) || draft.risksSummary,
      metadata: {
        ...(draft.metadata && typeof draft.metadata === "object" && !Array.isArray(draft.metadata)
          ? draft.metadata
          : {}),
        origin: "chat_user_statement",
        selfReported: true,
        messageId: input.messageId,
        publicVerification,
        dlpCategories: dlp.categories,
      },
    };
    const verificationRun = readGenerationRunMetadata(verified);
    generationRunIds = [
      ...generated.generationRunIds.generation,
      verificationRun?.id ?? generated.generationRunIds.verification,
    ].filter((id): id is string => Boolean(id));
  }

  const nearest = useModelGeneration && existingHighlights.length
    ? await findNearestHighlightEmbedding({
        workItemId: input.workItemId,
        inputText: buildHighlightEmbeddingText(candidateDraft),
        limit: 1,
      }).catch(() => [])
    : [];
  const deterministicMatch = !useModelGeneration
    ? existingHighlights
        .map((highlight) => ({
          highlight,
          similarity: chatCandidateTextSimilarity(normalizedText, `${highlight.text} ${highlight.summary}`),
        }))
        .sort((left, right) => right.similarity - left.similarity)[0] ?? null
    : null;
  const matchDistance = useModelGeneration
    ? nearest[0]?.cosineDistance ?? null
    : deterministicMatch && deterministicMatch.similarity >= 0.62 ? 0.1 : null;
  const match = useModelGeneration
    ? matchDistance != null && matchDistance <= 0.18
      ? existingHighlights.find((highlight) => highlight.id === nearest[0]?.highlightId) ?? null
      : null
    : matchDistance != null ? deterministicMatch!.highlight : null;
  const matchClassification = classifyChatCandidateMatch({
    verificationStatus: match?.verificationStatus ?? null,
    cosineDistance: matchDistance,
  });
  const batchNumber = input.batchNumber ?? 1;
  const ordinal = await prisma.agentRunCandidate.count({
    where: { agentRunId: input.agentRunId, batchNumber },
  });

  if (matchClassification === "duplicate" || matchClassification === "rejected_guidance_match") {
    return null;
  }

  if (match && matchClassification === "revision") {
    if (autoSafe) {
      const created = await prisma.$transaction(async (tx) => {
        const highlight = await createHighlightWithRelations({ tx, workItemId: input.workItemId, draft: candidateDraft });
        await tx.highlight.update({
          where: { id: highlight.id },
          data: {
            lifecycleStatus: "active",
            reviewState: "pending_review",
            approvalSource: "automation",
            publicSafetyStatus: publicVerification.eligible ? "verified" : "failed",
            autoAppliedAt: new Date(),
            supersedesHighlightId: match.id,
          },
        });
        await tx.highlight.update({ where: { id: match.id }, data: { lifecycleStatus: "superseded" } });
        await tx.evidenceItem.update({ where: { id: evidence.id }, data: { included: true, lifecycleStatus: "active", autoAppliedAt: new Date() } });
        const candidate = await tx.agentRunCandidate.create({
          data: {
            agentRunId: input.agentRunId,
            highlightId: highlight.id,
            kind: "new_highlight",
            status: "approved",
            batchNumber,
            ordinal: ordinal + 1,
            snapshot: JSON.parse(JSON.stringify(candidateDraft)),
            reviewedAt: new Date(),
          },
        });
        return { highlight, candidate };
      });
      await upsertHighlightEmbedding({
        highlightId: created.highlight.id,
        inputText: buildHighlightEmbeddingText(candidateDraft),
      }).catch(() => undefined);
      await recordChange({
        workItemId: input.workItemId,
        entityKind: "highlight",
        action: "updated",
        entityId: created.highlight.id,
        beforeSnapshot: { id: match.id, text: match.text },
        afterSnapshot: { id: created.highlight.id, text: candidateDraft.text, summary: candidateDraft.summary },
        reason: "New self-reported context auto-applied a verified Highlight successor.",
        provenance: { messageId: input.messageId, evidenceId: evidence.id, selfReported: true },
        suffix: `${input.agentRunId}:${created.highlight.id}`,
      });
      return created.candidate;
    }
    return prisma.$transaction(async (tx) => {
      const suggestion = await tx.highlightSuggestion.create({
        data: {
          workItemId: input.workItemId,
          sourceHighlightId: match.id,
          suggestionType: "revision",
          currentSnapshot: snapshotHighlight(match) as never,
          suggestedDraft: serializeHighlightDraft(candidateDraft) as never,
          matchReason: "New self-reported chat context may strengthen this approved highlight.",
          cosineDistance: matchDistance,
          sourceEvidenceIds: getDraftEvidenceIds(candidateDraft),
          generationRunIds,
        },
      });

      return tx.agentRunCandidate.create({
        data: {
          agentRunId: input.agentRunId,
          highlightSuggestionId: suggestion.id,
          kind: "highlight_revision",
          batchNumber,
          ordinal: ordinal + 1,
          snapshot: JSON.parse(JSON.stringify(candidateDraft)),
        },
      });
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const highlight = await createHighlightWithRelations({
      tx,
      workItemId: input.workItemId,
      draft: candidateDraft,
    });
    const candidate = await tx.agentRunCandidate.create({
      data: {
        agentRunId: input.agentRunId,
        highlightId: highlight.id,
        kind: "new_highlight",
        status: autoSafe ? "approved" : "pending",
        batchNumber,
        ordinal: ordinal + 1,
        snapshot: JSON.parse(JSON.stringify(candidateDraft)),
        reviewedAt: autoSafe ? new Date() : null,
      },
    });
    await tx.highlight.update({
      where: { id: highlight.id },
      data: {
        lifecycleStatus: autoSafe ? "active" : "quarantined",
        reviewState: "pending_review",
        approvalSource: "automation",
        publicSafetyStatus: publicVerification.eligible ? "verified" : autoSafe ? "failed" : "not_eligible",
        autoAppliedAt: autoSafe ? new Date() : null,
      },
    });
    if (autoSafe) {
      await tx.evidenceItem.update({ where: { id: evidence.id }, data: { included: true, lifecycleStatus: "active", autoAppliedAt: new Date() } });
    }
    return { highlight, candidate };
  });
  await upsertHighlightEmbedding({
    highlightId: created.highlight.id,
    inputText: buildHighlightEmbeddingText(candidateDraft),
  }).catch(() => undefined);
  await recordChange({
    workItemId: input.workItemId,
    entityKind: "highlight",
    action: autoSafe ? "created" : "quarantined",
    entityId: created.highlight.id,
    afterSnapshot: { id: created.highlight.id, text: candidateDraft.text, summary: candidateDraft.summary },
    reason: autoSafe
      ? "A verified self-reported Highlight was auto-applied for later review."
      : "A self-reported Highlight was quarantined by the automatic safety gate.",
    provenance: { messageId: input.messageId, evidenceId: evidence.id, selfReported: true, dlpCategories: dlp.categories },
    suffix: `${input.agentRunId}:${created.highlight.id}`,
  });

  return created.candidate;
}
