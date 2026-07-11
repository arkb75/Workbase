import { resumeHook } from "workflow/api";
import { prisma } from "@/src/lib/prisma";
import {
  coerceStoredHighlightDraft,
  refreshHighlightEmbeddingFromDraft,
} from "@/src/services/highlight-suggestion-service";
import type { CandidateReviewService } from "@/src/services/types";
import {
  buildProjectFactEmbeddingText,
  upsertProjectFactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import { createHighlightWithRelations } from "@/src/lib/evidence-persistence";

export async function resolveAgentCandidate(
  input: Parameters<CandidateReviewService["resolve"]>[0],
) {
  const candidate = await prisma.agentRunCandidate.findFirstOrThrow({
    where: {
      id: input.candidateId,
      agentRun: {
        userId: input.userId,
      },
    },
    include: {
      agentRun: true,
      highlight: {
        include: {
          evidence: { include: { evidenceItem: true } },
        },
      },
      highlightSuggestion: {
        include: { sourceHighlight: true },
      },
      projectFact: {
        include: { evidence: { include: { evidenceItem: true } } },
      },
    },
  });

  if (candidate.status !== "pending") {
    return {
      candidateId: candidate.id,
      status: candidate.status === "denied" ? ("denied" as const) : ("approved" as const),
      resumedRunId: null,
    };
  }

  const editedText = input.editedText?.trim() || null;
  const isProjectFact = candidate.kind === "new_project_fact" || candidate.kind === "project_fact_revision";
  const maxEditedLength = isProjectFact ? 500 : 240;
  if (editedText && (editedText.length < 10 || editedText.length > maxEditedLength)) {
    throw new Error(`Approved ${isProjectFact ? "project fact" : "highlight"} text must contain between 10 and ${maxEditedLength} characters.`);
  }
  const feedback = input.feedback?.trim().slice(0, 1_000) || null;
  const reviewNotes = input.reviewNotes?.trim().slice(0, 1_200) || null;
  const reviewOverrides = {
    ...(input.visibility ? { visibility: input.visibility } : {}),
    ...(input.sensitivityFlag != null ? { sensitivityFlag: input.sensitivityFlag } : {}),
    ...(reviewNotes ? { verificationNotes: reviewNotes } : {}),
  };

  if (isProjectFact && candidate.projectFact) {
    const applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRunCandidate.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: {
          status:
            input.decision === "approve"
              ? editedText
                ? "edited_and_approved"
                : "approved"
              : "denied",
          editedText: input.decision === "approve" ? editedText : null,
          feedback,
          reviewedAt: new Date(),
        },
      });
      if (!claimed.count) return null;
      if (input.decision === "deny") {
        await tx.projectFact.update({
          where: { id: candidate.projectFact!.id },
          data: {
            status: "rejected",
            lifecycleStatus: "retired",
            reviewState: "reviewed",
            rejectionReason: feedback ?? "Dismissed during project chat review.",
          },
        });
        return null;
      }

      const statement = editedText ?? candidate.projectFact!.statement;
      await tx.projectFact.update({
        where: { id: candidate.projectFact!.id },
        data: {
          statement,
          category: input.category ?? candidate.projectFact!.category,
          sensitivityFlag: input.sensitivityFlag ?? candidate.projectFact!.sensitivityFlag,
          reviewNotes: reviewNotes ?? candidate.projectFact!.reviewNotes,
          searchText: [
            statement,
            input.category ?? candidate.projectFact!.category,
            reviewNotes ?? candidate.projectFact!.reviewNotes ?? "",
          ].join(" "),
          status: "approved",
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          rejectionReason: null,
        },
      });
      if (candidate.projectFact!.supersedesProjectFactId) {
        await tx.projectFact.updateMany({
          where: {
            id: candidate.projectFact!.supersedesProjectFactId,
            workItemId: candidate.projectFact!.workItemId,
            status: "approved",
          },
          data: { status: "superseded", lifecycleStatus: "superseded" },
        });
      }
      await tx.evidenceItem.updateMany({
        where: {
          id: { in: candidate.projectFact!.evidence.map((entry) => entry.evidenceItemId) },
          type: "github_file_excerpt",
        },
        data: { included: true },
      });
      return true;
    });
    if (applied && input.decision === "approve") {
      const statement = editedText ?? candidate.projectFact.statement;
      await upsertProjectFactEmbedding({
        projectFactId: candidate.projectFact.id,
        inputText: buildProjectFactEmbeddingText({
          statement,
          category: input.category ?? candidate.projectFact.category,
          reviewNotes: reviewNotes ?? candidate.projectFact.reviewNotes,
        }),
      });
    }
  } else if (candidate.kind === "highlight_revision" && candidate.highlightSuggestion) {
    const draft = coerceStoredHighlightDraft(candidate.snapshot);
    if (!draft) throw new Error("The stored highlight revision is invalid.");
    const applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRunCandidate.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: {
          status:
            input.decision === "approve"
              ? editedText
                ? "edited_and_approved"
                : "approved"
              : "denied",
          editedText: input.decision === "approve" ? editedText : null,
          feedback,
          reviewedAt: new Date(),
        },
      });
      if (!claimed.count) return null;

      if (input.decision === "deny") {
        await tx.highlightSuggestion.update({
          where: { id: candidate.highlightSuggestion!.id },
          data: { status: "dismissed" },
        });
        return null;
      }

      const sourceHighlight = await tx.highlight.findUniqueOrThrow({
        where: { id: candidate.highlightSuggestion!.sourceHighlightId },
      });
      const expectedSnapshot = candidate.highlightSuggestion!.currentSnapshot;
      if (
        expectedSnapshot &&
        typeof expectedSnapshot === "object" &&
        !Array.isArray(expectedSnapshot) &&
        typeof expectedSnapshot.text === "string" &&
        expectedSnapshot.text !== sourceHighlight.text
      ) {
        throw new Error("This highlight changed after the revision was proposed. Review a fresh revision.");
      }
      const successorDraft = {
        ...draft,
        text: editedText ?? draft.text,
        verificationStatus: "approved" as const,
      };
      const successor = await createHighlightWithRelations({
        tx,
        workItemId: sourceHighlight.workItemId,
        draft: successorDraft,
      });
      await tx.highlight.update({
        where: { id: successor.id },
        data: {
          ...reviewOverrides,
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          supersedesHighlightId: sourceHighlight.id,
        },
      });
      await tx.highlight.update({
        where: { id: sourceHighlight.id },
        data: { lifecycleStatus: "superseded" },
      });
      const evidenceIds = draft.evidence.sourceRefs.flatMap((entry) =>
        entry.evidenceItemId ? [entry.evidenceItemId] : [],
      );
      if (evidenceIds.length) {
        await tx.evidenceItem.updateMany({
          where: { id: { in: evidenceIds }, type: "chat_user_statement" },
          data: { included: true },
        });
      }
      await tx.highlightSuggestion.update({
        where: { id: candidate.highlightSuggestion!.id },
        data: { status: "accepted" },
      });
      return successor.id;
    });
    if (applied && input.decision === "approve") {
      await refreshHighlightEmbeddingFromDraft({
        highlightId: applied,
        draft,
        overrideText: editedText,
      });
    }
  } else if (candidate.highlight) {
    const applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.agentRunCandidate.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: {
          status:
            input.decision === "approve"
              ? editedText
                ? "edited_and_approved"
                : "approved"
              : "denied",
          editedText: input.decision === "approve" ? editedText : null,
          feedback,
          reviewedAt: new Date(),
        },
      });
      if (!claimed.count) return false;

      if (input.decision === "deny") {
        await tx.highlight.update({
          where: { id: candidate.highlight!.id },
          data: {
            verificationStatus: "rejected",
            lifecycleStatus: "retired",
            reviewState: "reviewed",
            rejectionReason: feedback ?? "Dismissed during project chat review.",
          },
        });
        return true;
      }
      await tx.highlight.update({
        where: { id: candidate.highlight!.id },
        data: {
          text: editedText ?? candidate.highlight!.text,
          searchText: [
            editedText ?? candidate.highlight!.text,
            candidate.highlight!.summary,
            candidate.highlight!.verificationNotes ?? "",
          ].join(" "),
          verificationStatus: "approved",
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "pending",
          rejectionReason: null,
          ...reviewOverrides,
        },
      });
      const evidenceIds = candidate.highlight!.evidence
        .filter((entry) => entry.evidenceItem.type === "chat_user_statement")
        .map((entry) => entry.evidenceItemId);
      if (evidenceIds.length) {
        await tx.evidenceItem.updateMany({
          where: { id: { in: evidenceIds } },
          data: { included: true },
        });
      }
      return true;
    });
    const storedDraft = coerceStoredHighlightDraft(candidate.snapshot);
    if (applied && input.decision === "approve" && storedDraft) {
      await refreshHighlightEmbeddingFromDraft({
        highlightId: candidate.highlight.id,
        draft: storedDraft,
        overrideText: editedText,
      });
    }
  } else {
    throw new Error("The candidate no longer references a highlight or revision.");
  }

  const pendingCount = await prisma.agentRunCandidate.count({
    where: {
      agentRunId: candidate.agentRunId,
      batchNumber: candidate.batchNumber,
      status: "pending",
    },
  });
  let resumedRunId: string | null = null;

  const runStatus = await prisma.agentRun.findUnique({
    where: { id: candidate.agentRunId },
    select: { status: true },
  });
  if (!pendingCount && runStatus?.status === "awaiting_review") {
    try {
      const resumed = await resumeHook(
        `agent-run:${candidate.agentRunId}:review:${candidate.batchNumber}`,
        { reviewed: true },
      );
      resumedRunId = resumed.runId;
    } catch {
      // The workflow may already have resumed after another idempotent review request.
    }
  }

  const resolvedCandidate = await prisma.agentRunCandidate.findUniqueOrThrow({
    where: { id: candidate.id },
    select: { status: true },
  });
  return {
    candidateId: candidate.id,
    status: resolvedCandidate.status === "denied" ? ("denied" as const) : ("approved" as const),
    resumedRunId,
  };
}

export const candidateReviewService: CandidateReviewService = {
  resolve: resolveAgentCandidate,
};
