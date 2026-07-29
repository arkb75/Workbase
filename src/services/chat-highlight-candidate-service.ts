import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue, ClaimSnapshot, HighlightDraft } from "@/src/domain/types";
import { createHighlightWithRelations } from "@/src/lib/evidence-persistence";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { inferEvidenceTags } from "@/src/lib/highlight-tags";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
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
import { upsertReviewableKnowledgeChangeInTransaction } from "@/src/services/knowledge-change-service";
import { KNOWLEDGE_LIFECYCLE_POLICY_VERSION } from "@/src/services/knowledge-reconciliation-service";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";

const ownershipPattern =
  /\b(i|we)\s+(built|created|designed|implemented|led|owned|shipped|migrated|optimized|improved|reduced|increased|launched|fixed|introduced|architected)\b/i;
const impactPattern =
  /\b\d+(?:\.\d+)?\s*(?:%|x|×|ms|s|sec|seconds?|minutes?|hours?|users?|requests?|records?|repository|repositories|imports?|jobs?|builds?|deployments?|incidents?|customers?)(?=\s|[.,;:!?)]|$)/i;
const nonAssertionPattern =
  /\b(?:did not|didn't|didn’t|do not|don't|don’t|does not|doesn't|doesn’t|is not|isn't|isn’t|are not|aren't|aren’t|was not|wasn't|wasn’t|were not|weren't|weren’t|has not|hasn't|hasn’t|have not|haven't|haven’t|had not|hadn't|hadn’t|never|no longer|failed to)\b/i;
const questionOrPoliteRequestPattern =
  /^(?:how|what|why|when|where|who|which|can|could|would|will|should|may|might|do|does|did|is|are|am|was|were|has|have|had|tell|show|list|give|help|make sure|resume bullets?|linkedin (?:entry|experience|summary)|project summary|sources?|citations?|provenance|tool calls?)\b|\b(?:please|can you|could you|would you|will you|i (?:want|need|would like) (?:you )?to)\b/i;
const commandClausePattern =
  /(?:^|[,.!;:—–]\s*|\s+-\s+|\b(?:and|then|also)\s+)(?:please\s+)?(?:write|draft|generate|create|turn|convert|use|make|craft|rewrite|summari[sz]e|explain|compare|assess|analy[sz]e|grade|rank|check|inspect|search|research|look|find|read|access|pull|refresh|verify|validate|confirm|corroborate|investigate|approve|deny|reject|accept|edit|update|delete|remove|retire|restore|revert|keep|mark|flag|identify|cite|source)\s+(?:me\b|a\b|an\b|the\b|this\b|that\b|these\b|those\b|it\b|my\b|our\b|all\b|any\b|which\b|for\b|at\b|into\b|evidence\b|sources?\b|repo(?:sitory)?\b|github\b|codebase\b|answer\b|claim\b|candidate\b|highlight\b|fact\b|citation\b|resume\b|linkedin\b|project\b)/i;
const prospectiveOrHedgedPattern =
  /\b(?:plan(?:s|ned|ning)?\s+to|intend(?:s|ed|ing)?\s+to|aim(?:s|ed|ing)?\s+to|hope(?:s|d|ing)?\s+to|expect(?:s|ed|ing)?\s+to|target(?:s|ed|ing)?\s+(?:is|was|to|of)|goal\s+(?:is|was|to|of)|should|could|would|might|may|will|maybe|perhaps|possibly|probably|potentially|forecast(?:ed)?|projected|aspirational|estimated?|roughly|approximately|apparently|attempted to|tried to|i think|i believe|i suspect|appears? to|seems? to)\b/i;
const quotedOrAttributedPattern =
  /["“”`]|(?:^|[\s(])['‘][^'’\n]{5,}['’](?=$|[\s).,;:])|\b(?:according to|(?:someone|they|he|she|the (?:user|assistant|model|agent)) (?:said|claimed|wrote|suggested)|(?:prior|previous|earlier) (?:assistant|answer|message|response))\b/i;

export type SelfReportedContextClassification =
  | "eligible"
  | "too_short"
  | "question_or_request"
  | "negated"
  | "prospective_or_hedged"
  | "quoted_or_attributed"
  | "not_reusable";

export function classifySelfReportedProjectContext(value: string): SelfReportedContextClassification {
  const normalized = normalizeWhitespace(value);
  if (normalized.length < 24) return "too_short";
  if (
    normalized.includes("?") ||
    questionOrPoliteRequestPattern.test(normalized) ||
    commandClausePattern.test(normalized)
  ) {
    return "question_or_request";
  }
  if (nonAssertionPattern.test(normalized)) return "negated";
  if (prospectiveOrHedgedPattern.test(normalized)) return "prospective_or_hedged";
  if (quotedOrAttributedPattern.test(normalized)) return "quoted_or_attributed";
  if (!ownershipPattern.test(normalized) && !impactPattern.test(normalized)) {
    return "not_reusable";
  }
  return "eligible";
}

export function isHighlightWorthyUserContext(value: string) {
  return classifySelfReportedProjectContext(value) === "eligible";
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

const ACTIVE_CHAT_HIGHLIGHT_RUN_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_review",
]);
const CHAT_HIGHLIGHT_PERSISTENCE_ATTEMPTS = 5;

function persistenceErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
}

function isRetryableChatHighlightPersistenceError(error: unknown) {
  const code = persistenceErrorCode(error);
  if (code === "P2002" || code === "P2034") return true;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return message.includes("TransactionWriteConflict");
}

async function chatHighlightPersistenceBackoff(attempt: number) {
  const baseDelayMs = Math.min(250, 10 * (2 ** attempt));
  const delayMs = baseDelayMs + Math.floor(Math.random() * Math.max(1, baseDelayMs / 2));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function loadScopedChatHighlightCandidate(input: {
  agentRunId: string;
  userId: string;
  workItemId: string;
}) {
  return prisma.agentRunCandidate.findFirst({
    where: {
      agentRunId: input.agentRunId,
      agentRun: {
        userId: input.userId,
        workItemId: input.workItemId,
      },
    },
  });
}

async function lockScopedChatHighlightRun(
  tx: Prisma.TransactionClient,
  input: {
    agentRunId: string;
    userId: string;
    workItemId: string;
  },
) {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status"
    FROM "AgentRun"
    WHERE "id" = ${input.agentRunId}
      AND "userId" = ${input.userId}
      AND "workItemId" = ${input.workItemId}
    FOR UPDATE
  `;
  return rows[0]?.status ?? "missing";
}

function materializedChatHighlightDraft(input: {
  draft: HighlightDraft;
  evidence: {
    id: string;
    title: string;
    content: string;
  };
  source: {
    id: string;
    label: string;
  };
}): HighlightDraft {
  return {
    ...input.draft,
    evidence: {
      ...input.draft.evidence,
      sourceRefs: [{
        evidenceItemId: input.evidence.id,
        sourceId: input.source.id,
        sourceLabel: input.source.label,
        sourceType: "chat_context",
        title: input.evidence.title,
        excerpt: input.evidence.content,
      }],
    },
  };
}

function toInputJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
  const existingCandidate = await loadScopedChatHighlightCandidate(input);
  if (existingCandidate) return existingCandidate;

  const activeRun = await prisma.agentRun.findFirst({
    where: {
      id: input.agentRunId,
      userId: input.userId,
      workItemId: input.workItemId,
      status: { in: ["queued", "running", "awaiting_review"] },
    },
    select: { id: true },
  });
  if (!activeRun) return null;

  const dlp = redactRepositorySecrets(normalizeWhitespace(input.text));
  const context = await loadCandidateContext(input.userId, input.workItemId);
  const normalizedText = dlp.content;
  // Keep chat context transient while extraction and verification can still be
  // cancelled. Source, Evidence, tags, Highlight, candidate, review card, and
  // any supersession are materialized together only after the scoped AgentRun
  // is row-locked and confirmed active.
  const source = {
    id: `transient-chat-source:${input.threadId}`,
    workItemId: input.workItemId,
    type: "chat_context" as const,
    label: "Self-reported chat context",
    externalId: input.threadId,
    rawContent: null,
    metadata: {
      threadId: input.threadId,
      selfReported: true,
    },
  };
  const evidence = {
    id: `transient-chat-evidence:${input.messageId}`,
    workItemId: input.workItemId,
    sourceId: source.id,
    externalId: `chat-message:${input.messageId}`,
    type: "chat_user_statement" as const,
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
    source: {
      id: source.id,
      label: source.label,
      type: source.type,
      externalId: source.externalId,
    },
    tags: [],
    createdAt: undefined,
    updatedAt: undefined,
  };
  const evidenceTags = inferEvidenceTags({
    title: evidence.title,
    content: evidence.content,
    sourceType: "chat_context",
    evidenceType: "chat_user_statement",
  });

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
        audit: {
          workItemId: input.workItemId,
          idempotencyKey:
            `public-chat-highlight-verification:${input.messageId}`,
        },
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

  if (matchClassification === "duplicate" || matchClassification === "rejected_guidance_match") {
    return null;
  }

  type CandidateRecord = NonNullable<Awaited<ReturnType<typeof loadScopedChatHighlightCandidate>>>;
  type MaterializationResult =
    | { status: "inactive" }
    | { status: "stale_revision_target" }
    | { status: "existing"; candidate: CandidateRecord }
    | {
        status: "created";
        candidate: CandidateRecord;
        highlightId: string | null;
        draft: HighlightDraft;
      };

  let materialized: MaterializationResult | null = null;
  for (let attempt = 0; attempt < CHAT_HIGHLIGHT_PERSISTENCE_ATTEMPTS; attempt += 1) {
    try {
      materialized = await prisma.$transaction(async (tx): Promise<MaterializationResult> => {
        // Join repository reconciliation and user review on the shared Work
        // Item mutation lock before taking the AgentRun row. A cancellation can
        // therefore finish while this transaction waits, and every knowledge
        // writer observes one current Highlight lineage at a time.
        await lockKnowledgeWorkItemMutation(tx, input.workItemId);
        const runStatus = await lockScopedChatHighlightRun(tx, input);
        const winner = await tx.agentRunCandidate.findFirst({
          where: { agentRunId: input.agentRunId },
        });
        if (winner) return { status: "existing", candidate: winner };
        if (!ACTIVE_CHAT_HIGHLIGHT_RUN_STATUSES.has(runStatus)) {
          return { status: "inactive" };
        }

        const expectsRevision = Boolean(match && matchClassification === "revision");
        const revisionTarget = expectsRevision && match?.updatedAt
          ? await tx.highlight.findFirst({
              where: {
                id: match.id,
                workItemId: input.workItemId,
                lifecycleStatus: "active",
                verificationStatus: "approved",
                updatedAt: match.updatedAt,
              },
              select: { id: true, text: true, updatedAt: true },
            })
          : null;
        if (expectsRevision && !revisionTarget) {
          // The target was edited, retired, marked stale, or superseded after
          // semantic matching. Do not attach a successor to that stale
          // snapshot and do not persist the transient chat Evidence.
          return { status: "stale_revision_target" };
        }

        const persistedSource = await tx.source.upsert({
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
            label: source.label,
            externalId: input.threadId,
            metadata: toInputJson(source.metadata),
          },
          update: {
            label: source.label,
            metadata: toInputJson(source.metadata),
          },
        });
        const persistedEvidence = await tx.evidenceItem.upsert({
          where: {
            sourceId_externalId: {
              sourceId: persistedSource.id,
              externalId: evidence.externalId,
            },
          },
          create: {
            workItemId: input.workItemId,
            sourceId: persistedSource.id,
            externalId: evidence.externalId,
            type: evidence.type,
            title: evidence.title,
            content: normalizedText,
            searchText: normalizedText,
            parentKind: evidence.parentKind,
            parentKey: evidence.parentKey,
            included: false,
            metadata: toInputJson(evidence.metadata),
            lifecycleStatus: dlp.categories.length ? "quarantined" : "active",
            reviewState: "pending_review",
            approvalSource: "automation",
          },
          update: {
            title: evidence.title,
            content: normalizedText,
            searchText: normalizedText,
            metadata: toInputJson(evidence.metadata),
          },
        });
        if (evidenceTags.length) {
          await tx.evidenceTag.createMany({
            data: evidenceTags.map((tag) => ({
              evidenceItemId: persistedEvidence.id,
              dimension: tag.dimension,
              tag: tag.tag,
              score: tag.score ?? null,
            })),
            skipDuplicates: true,
          });
        }

        const draft = materializedChatHighlightDraft({
          draft: candidateDraft,
          evidence: persistedEvidence,
          source: persistedSource,
        });
        const ordinal = await tx.agentRunCandidate.count({
          where: { agentRunId: input.agentRunId, batchNumber },
        });

        if (revisionTarget && !autoSafe) {
          const suggestion = await tx.highlightSuggestion.create({
            data: {
              workItemId: input.workItemId,
              sourceHighlightId: revisionTarget.id,
              suggestionType: "revision",
              currentSnapshot: snapshotHighlight(match!) as never,
              suggestedDraft: serializeHighlightDraft(draft) as never,
              matchReason: "New self-reported chat context may strengthen this approved highlight.",
              cosineDistance: matchDistance,
              sourceEvidenceIds: getDraftEvidenceIds(draft),
              generationRunIds,
            },
          });
          const candidate = await tx.agentRunCandidate.create({
            data: {
              agentRunId: input.agentRunId,
              highlightSuggestionId: suggestion.id,
              kind: "highlight_revision",
              batchNumber,
              ordinal: ordinal + 1,
              snapshot: toInputJson(draft),
            },
          });
          return { status: "created", candidate, highlightId: null, draft };
        }

        const highlight = await createHighlightWithRelations({
          tx,
          workItemId: input.workItemId,
          draft,
        });
        const isRevision = Boolean(revisionTarget);
        await tx.highlight.update({
          where: { id: highlight.id },
          data: {
            lifecycleStatus: autoSafe ? "active" : "quarantined",
            reviewState: "pending_review",
            approvalSource: "automation",
            publicSafetyStatus: publicVerification.eligible
              ? "verified"
              : autoSafe
                ? "failed"
                : "not_eligible",
            autoAppliedAt: autoSafe ? new Date() : null,
            supersedesHighlightId: revisionTarget?.id ?? null,
          },
        });
        if (autoSafe && revisionTarget) {
          const superseded = await tx.highlight.updateMany({
            where: {
              id: revisionTarget.id,
              workItemId: input.workItemId,
              lifecycleStatus: "active",
              verificationStatus: "approved",
              updatedAt: revisionTarget.updatedAt,
            },
            data: { lifecycleStatus: "superseded" },
          });
          if (superseded.count !== 1) {
            // A non-participating writer changed the row after our re-read.
            // Abort the whole transaction rather than committing a parallel
            // active successor or reviving an obsolete lineage.
            throw Object.assign(new Error("The chat Highlight revision target changed during materialization."), {
              code: "P2034",
            });
          }
        }
        if (autoSafe) {
          await tx.evidenceItem.update({
            where: { id: persistedEvidence.id },
            data: {
              included: true,
              lifecycleStatus: "active",
              autoAppliedAt: new Date(),
            },
          });
        }
        const candidate = await tx.agentRunCandidate.create({
          data: {
            agentRunId: input.agentRunId,
            highlightId: highlight.id,
            kind: "new_highlight",
            status: autoSafe ? "approved" : "pending",
            batchNumber,
            ordinal: ordinal + 1,
            snapshot: toInputJson(draft),
            reviewedAt: autoSafe ? new Date() : null,
          },
        });
        const action = autoSafe ? (isRevision ? "updated" : "created") : "quarantined";
        await upsertReviewableKnowledgeChangeInTransaction({
          workItemId: input.workItemId,
          entityKind: "highlight",
          action,
          entityId: highlight.id,
          beforeSnapshot: revisionTarget
            ? { id: revisionTarget.id, text: revisionTarget.text }
            : undefined,
          afterSnapshot: {
            id: highlight.id,
            text: draft.text,
            summary: draft.summary,
            lifecycleStatus: autoSafe ? "active" : "quarantined",
          },
          reason: autoSafe
            ? isRevision
              ? "New self-reported context auto-applied a verified Highlight successor."
              : "A verified self-reported Highlight was auto-applied for later review."
            : "A self-reported Highlight was quarantined by the automatic safety gate.",
          provenance: {
            agentRunId: input.agentRunId,
            messageId: input.messageId,
            evidenceId: persistedEvidence.id,
            selfReported: true,
            dlpCategories: dlp.categories,
          },
          policyVersion: KNOWLEDGE_LIFECYCLE_POLICY_VERSION,
          modelId: resolveActiveTextModelIdentity("drafting").modelId,
          idempotencyKey: `direct:highlight:${action}:${input.agentRunId}:${highlight.id}`,
        }, tx);
        return { status: "created", candidate, highlightId: highlight.id, draft };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
      break;
    } catch (error) {
      if (!isRetryableChatHighlightPersistenceError(error)) throw error;
      const winner = await loadScopedChatHighlightCandidate(input);
      if (winner) return winner;
      if (attempt >= CHAT_HIGHLIGHT_PERSISTENCE_ATTEMPTS - 1) throw error;
      await chatHighlightPersistenceBackoff(attempt);
    }
  }

  if (
    !materialized ||
    materialized.status === "inactive" ||
    materialized.status === "stale_revision_target"
  ) return null;
  if (materialized.status === "existing") return materialized.candidate;
  if (materialized.highlightId) {
    await upsertHighlightEmbedding({
      highlightId: materialized.highlightId,
      inputText: buildHighlightEmbeddingText(materialized.draft),
    }).catch(() => undefined);
  }
  return materialized.candidate;
}
