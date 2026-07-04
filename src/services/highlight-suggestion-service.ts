import { Prisma } from "@/src/generated/prisma/client";
import type { ClaimDraft, ClaimSnapshot, JsonValue } from "@/src/domain/types";
import { prisma } from "@/src/lib/prisma";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";

type HighlightUpdateTransaction = Prisma.TransactionClient;

function toInputJson(value: JsonValue | null | undefined) {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function toJsonValue<T>(value: T) {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function getDraftEvidenceIds(draft: ClaimDraft) {
  return draft.evidence.sourceRefs.flatMap((sourceRef) =>
    sourceRef.evidenceItemId ? [sourceRef.evidenceItemId] : [],
  );
}

export function snapshotHighlight(highlight: ClaimSnapshot) {
  return toJsonValue({
    id: highlight.id,
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
    evidenceItemIds: getDraftEvidenceIds(highlight),
    tags: highlight.tags,
  });
}

export function serializeHighlightDraft(draft: ClaimDraft) {
  return toJsonValue({
    text: draft.text,
    summary: draft.summary,
    confidence: draft.confidence,
    ownershipClarity: draft.ownershipClarity,
    sensitivityFlag: draft.sensitivityFlag,
    verificationStatus: draft.verificationStatus,
    visibility: draft.visibility,
    risksSummary: draft.risksSummary ?? null,
    missingInfo: draft.missingInfo ?? null,
    rejectionReason: draft.rejectionReason ?? null,
    verificationNotes: draft.verificationNotes ?? null,
    metadata: draft.metadata ?? null,
    evidence: draft.evidence,
    tags: draft.tags,
  });
}

export function coerceStoredHighlightDraft(value: unknown): ClaimDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const draft = value as Partial<ClaimDraft>;

  if (
    typeof draft.text !== "string" ||
    typeof draft.summary !== "string" ||
    !draft.evidence ||
    typeof draft.evidence !== "object" ||
    !Array.isArray(draft.evidence.sourceRefs) ||
    !Array.isArray(draft.tags)
  ) {
    return null;
  }

  return {
    text: draft.text,
    summary: draft.summary,
    confidence: draft.confidence ?? "medium",
    ownershipClarity: draft.ownershipClarity ?? "partial",
    sensitivityFlag: Boolean(draft.sensitivityFlag),
    verificationStatus: draft.verificationStatus ?? "draft",
    visibility: draft.visibility ?? "resume_safe",
    risksSummary: draft.risksSummary ?? null,
    missingInfo: draft.missingInfo ?? null,
    rejectionReason: draft.rejectionReason ?? null,
    verificationNotes: draft.verificationNotes ?? null,
    metadata: draft.metadata ?? null,
    evidence: draft.evidence,
    tags: draft.tags,
  };
}

export async function createOrUpdateHighlightSuggestion(input: {
  workItemId: string;
  sourceHighlight: ClaimSnapshot;
  draft: ClaimDraft;
  matchReason: string;
  cosineDistance: number | null;
  generationRunIds: string[];
}) {
  const existingPending = await prisma.highlightSuggestion.findFirst({
    where: {
      sourceHighlightId: input.sourceHighlight.id,
      status: "pending",
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  const data = {
    workItemId: input.workItemId,
    sourceHighlightId: input.sourceHighlight.id,
    suggestionType: "revision",
    currentSnapshot: snapshotHighlight(input.sourceHighlight) as Prisma.InputJsonValue,
    suggestedDraft: serializeHighlightDraft(input.draft) as Prisma.InputJsonValue,
    matchReason: input.matchReason,
    cosineDistance: input.cosineDistance,
    sourceEvidenceIds: getDraftEvidenceIds(input.draft) as Prisma.InputJsonValue,
    generationRunIds: input.generationRunIds as Prisma.InputJsonValue,
  };

  if (existingPending) {
    return prisma.highlightSuggestion.update({
      where: {
        id: existingPending.id,
      },
      data,
    });
  }

  return prisma.highlightSuggestion.create({
    data,
  });
}

export async function applyDraftToHighlight(input: {
  tx: HighlightUpdateTransaction;
  highlightId: string;
  existingStatus: ClaimSnapshot["verificationStatus"];
  draft: ClaimDraft;
  overrideText?: string | null;
  mergeEvidence?: boolean;
}) {
  const text = input.overrideText?.trim() || input.draft.text;
  const nextStatus =
    input.existingStatus === "approved" ? "approved" : input.draft.verificationStatus;
  const evidenceIds = getDraftEvidenceIds(input.draft);

  await input.tx.highlight.update({
    where: {
      id: input.highlightId,
    },
    data: {
      text,
      summary: input.draft.summary,
      searchText: [text, input.draft.summary, input.draft.verificationNotes ?? ""]
        .filter(Boolean)
        .join(" "),
      confidence: input.draft.confidence,
      ownershipClarity: input.draft.ownershipClarity,
      sensitivityFlag: input.draft.sensitivityFlag,
      verificationStatus: nextStatus,
      visibility: input.draft.visibility,
      risksSummary: input.draft.risksSummary ?? null,
      missingInfo: input.draft.missingInfo ?? null,
      rejectionReason: nextStatus === "rejected" ? input.draft.rejectionReason ?? null : null,
      verificationNotes: input.draft.verificationNotes ?? null,
      metadata: toInputJson(input.draft.metadata),
    },
  });

  if (!input.mergeEvidence) {
    await input.tx.highlightEvidence.deleteMany({
      where: {
        highlightId: input.highlightId,
      },
    });
  }

  if (evidenceIds.length) {
    await input.tx.highlightEvidence.createMany({
      data: evidenceIds.map((evidenceItemId) => ({
        highlightId: input.highlightId,
        evidenceItemId,
        relevanceScore: null,
      })),
      skipDuplicates: true,
    });
  }

  await input.tx.highlightTag.deleteMany({
    where: {
      highlightId: input.highlightId,
    },
  });

  if (input.draft.tags.length) {
    await input.tx.highlightTag.createMany({
      data: input.draft.tags.map((tag) => ({
        highlightId: input.highlightId,
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score ?? null,
      })),
      skipDuplicates: true,
    });
  }
}

export async function refreshHighlightEmbeddingFromDraft(input: {
  highlightId: string;
  draft: ClaimDraft;
  overrideText?: string | null;
}) {
  await upsertHighlightEmbedding({
    highlightId: input.highlightId,
    inputText: buildHighlightEmbeddingText({
      ...input.draft,
      text: input.overrideText?.trim() || input.draft.text,
    }),
  });
}
