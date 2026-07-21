import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { Prisma } from "@/src/generated/prisma/client";
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
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";

const REVIEW_HOOK_RESUME_ATTEMPTS = 5;
const REVIEW_HOOK_RETRY_DELAY_MS = 100;

const candidateReviewArgs = {
  include: {
    agentRun: true,
    highlight: {
      include: { evidence: { include: { evidenceItem: true } } },
    },
    highlightSuggestion: { include: { sourceHighlight: true } },
    projectFact: {
      include: { evidence: { include: { evidenceItem: true } } },
    },
  },
} as const satisfies Prisma.AgentRunCandidateDefaultArgs;

type ReviewCandidate = Prisma.AgentRunCandidateGetPayload<
  typeof candidateReviewArgs
>;

type EligibleEvidence = {
  id: string;
  included: boolean;
  lifecycleStatus: "active" | "needs_validation" | "stale" | "superseded" | "retired" | "quarantined";
  reviewState: "pending_review" | "reviewed" | "reverted";
  approvalSource: "automation" | "user" | "legacy";
};

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resumeResolvedReviewBatchIfReady(input: {
  agentRunId: string;
  batchNumber: number;
}) {
  const pendingCount = await prisma.agentRunCandidate.count({
    where: {
      agentRunId: input.agentRunId,
      batchNumber: input.batchNumber,
      status: "pending",
    },
  });
  if (pendingCount) return null;

  for (let attempt = 0; attempt < REVIEW_HOOK_RESUME_ATTEMPTS; attempt += 1) {
    const run = await prisma.agentRun.findUnique({
      where: { id: input.agentRunId },
      select: { status: true },
    });
    // A concurrent review request may already have resumed the hook and moved
    // the run forward. Terminal or running states are therefore idempotent
    // success for the review action.
    if (!run || run.status !== "awaiting_review") return null;

    try {
      const resumed = await resumeHook(
        `agent-run:${input.agentRunId}:review:${input.batchNumber}`,
        { reviewed: true },
      );
      return resumed.runId;
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      // The workflow step that publishes candidates can commit just before the
      // workflow registers its hook. Workflow's documented pattern is to retry
      // HookNotFoundError briefly rather than treating it as already resumed.
      if (attempt < REVIEW_HOOK_RESUME_ATTEMPTS - 1) {
        await wait(REVIEW_HOOK_RETRY_DELAY_MS);
        continue;
      }
      const latest = await prisma.agentRun.findUnique({
        where: { id: input.agentRunId },
        select: { status: true },
      });
      if (!latest || latest.status !== "awaiting_review") return null;
      throw new Error(
        "The review decision was saved, but the workflow resume hook was not available yet. Retry the review action; the saved decision will not be duplicated.",
        { cause: error },
      );
    }
  }
  return null;
}

function loadAuthorizedCandidate(
  userId: string,
  candidateId: string,
  client: Pick<Prisma.TransactionClient, "agentRunCandidate"> = prisma,
): Promise<ReviewCandidate> {
  return client.agentRunCandidate.findFirstOrThrow({
    where: { id: candidateId, agentRun: { userId } },
    ...candidateReviewArgs,
  });
}

function uniqueIds(ids: readonly string[]) {
  return Array.from(new Set(ids));
}

function evidenceCanSupportApproval(evidence: EligibleEvidence) {
  if (evidence.lifecycleStatus !== "active" || evidence.reviewState === "reverted") {
    return false;
  }
  if (evidence.included) return true;
  return evidence.reviewState === "pending_review" &&
    evidence.approvalSource === "automation";
}

async function requireEligibleEvidence(input: {
  tx: Prisma.TransactionClient;
  workItemId: string;
  evidenceIds: readonly string[];
}) {
  const ids = uniqueIds(input.evidenceIds);
  if (!ids.length) {
    throw new Error("This candidate no longer has eligible supporting evidence. Refresh the candidate before approving it.");
  }
  await input.tx.$queryRaw`
    SELECT "id"
    FROM "EvidenceItem"
    WHERE "id" IN (${Prisma.join(ids)})
    FOR UPDATE
  `;
  const evidence = await input.tx.evidenceItem.findMany({
    where: { id: { in: ids }, workItemId: input.workItemId },
    select: {
      id: true,
      included: true,
      lifecycleStatus: true,
      reviewState: true,
      approvalSource: true,
    },
  });
  if (
    evidence.length !== ids.length ||
    evidence.some((entry) => !evidenceCanSupportApproval(entry))
  ) {
    throw new Error("Supporting evidence changed or was excluded after this candidate was proposed. Refresh the candidate before approving it.");
  }
  return evidence;
}

async function approvePendingEvidence(
  tx: Prisma.TransactionClient,
  evidence: readonly EligibleEvidence[],
) {
  const pendingIds = evidence.flatMap((entry) =>
    entry.reviewState === "pending_review" && entry.approvalSource === "automation"
      ? [entry.id]
      : []
  );
  if (!pendingIds.length) return;
  const approved = await tx.evidenceItem.updateMany({
    where: {
      id: { in: pendingIds },
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
    },
    data: {
      included: true,
      reviewState: "reviewed",
      approvalSource: "user",
    },
  });
  if (approved.count !== pendingIds.length) {
    throw new Error("Supporting evidence changed while this candidate was being approved. Retry with a fresh candidate.");
  }
}

function isExpectedProjectFactCandidate(candidate: ReviewCandidate) {
  const fact = candidate.projectFact;
  if (!fact) return false;
  const snapshot = candidate.snapshot && typeof candidate.snapshot === "object" && !Array.isArray(candidate.snapshot)
    ? candidate.snapshot as Record<string, unknown>
    : null;
  return fact.status === "draft" &&
    fact.lifecycleStatus === "quarantined" &&
    fact.reviewState === "pending_review" &&
    fact.approvalSource === "automation" &&
    (typeof snapshot?.statement !== "string" || snapshot.statement === fact.statement);
}

function isExpectedHighlightCandidate(candidate: ReviewCandidate) {
  const highlight = candidate.highlight;
  if (!highlight) return false;
  const draft = coerceStoredHighlightDraft(candidate.snapshot);
  return Boolean(
    draft &&
    highlight.lifecycleStatus === "quarantined" &&
    highlight.reviewState === "pending_review" &&
    highlight.approvalSource === "automation" &&
    highlight.text === draft.text &&
    highlight.summary === draft.summary,
  );
}

async function runSerializableCandidateReview<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      if (code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("The candidate review transaction could not be completed.");
}

async function replayCandidateEmbedding(candidate: ReviewCandidate) {
  if (candidate.status !== "approved" && candidate.status !== "edited_and_approved") return;
  if (
    candidate.projectFact?.status === "approved" &&
    candidate.projectFact.lifecycleStatus === "active"
  ) {
    await upsertProjectFactEmbedding({
      projectFactId: candidate.projectFact.id,
      inputText: buildProjectFactEmbeddingText(candidate.projectFact),
    });
    return;
  }
  if (candidate.highlight?.lifecycleStatus === "active") {
    const draft = coerceStoredHighlightDraft(candidate.snapshot);
    if (!draft) return;
    await refreshHighlightEmbeddingFromDraft({
      highlightId: candidate.highlight.id,
      draft,
      overrideText: candidate.editedText,
    });
  }
}

async function runCandidatePostCommit(candidate: ReviewCandidate) {
  // Embeddings are idempotent and lexical retrieval remains available. Never
  // turn a committed decision into an ambiguous API error; a later idempotent
  // review retry reconstructs this exact operation from the resolved row.
  await Promise.allSettled([replayCandidateEmbedding(candidate)]);
}

export async function resolveAgentCandidate(
  input: Parameters<CandidateReviewService["resolve"]>[0],
) {
  const candidate = await loadAuthorizedCandidate(input.userId, input.candidateId);

  if (candidate.status !== "pending") {
    await runCandidatePostCommit(candidate);
    const resumedRunId = await resumeResolvedReviewBatchIfReady({
      agentRunId: candidate.agentRunId,
      batchNumber: candidate.batchNumber,
    });
    return {
      candidateId: candidate.id,
      status: candidate.status === "denied" ? ("denied" as const) : ("approved" as const),
      resumedRunId,
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
  const nextStatus = input.decision === "approve"
    ? editedText ? "edited_and_approved" as const : "approved" as const
    : "denied" as const;
  const outcome = await runSerializableCandidateReview(async (tx) => {
    const workItemId = candidate.agentRun.workItemId;
    if (!workItemId) throw new Error("The candidate is no longer attached to a Work Item.");
    await lockKnowledgeWorkItemMutation(tx, workItemId);
    await tx.$queryRaw`
      SELECT 1::int AS locked
      FROM "AgentRunCandidate"
      WHERE "id" = ${candidate.id}
      FOR UPDATE
    `;
    const current = await loadAuthorizedCandidate(input.userId, candidate.id, tx);
    if (current.status !== "pending") return current;

    const claim = async (extra: Prisma.AgentRunCandidateUpdateManyMutationInput = {}) => {
      const claimed = await tx.agentRunCandidate.updateMany({
        where: { id: current.id, status: "pending" },
        data: {
          status: nextStatus,
          editedText: input.decision === "approve" ? editedText : null,
          feedback,
          reviewedAt: new Date(),
          ...extra,
        },
      });
      if (claimed.count !== 1) {
        throw new Error("This candidate was resolved by another review request.");
      }
    };

    if (isProjectFact && current.projectFact) {
      if (!isExpectedProjectFactCandidate(current)) {
        throw new Error("This Project Fact changed after it was proposed. Refresh the candidate before reviewing it.");
      }
      if (input.decision === "deny") {
        await claim();
        const retired = await tx.projectFact.updateMany({
          where: {
            id: current.projectFact.id,
            status: "draft",
            lifecycleStatus: "quarantined",
            reviewState: "pending_review",
            approvalSource: "automation",
          },
          data: {
            status: "rejected",
            lifecycleStatus: "retired",
            reviewState: "reviewed",
            rejectionReason: feedback ?? "Dismissed during project chat review.",
          },
        });
        if (retired.count !== 1) throw new Error("This Project Fact changed while it was being reviewed.");
      } else {
        const evidence = await requireEligibleEvidence({
          tx,
          workItemId,
          evidenceIds: current.projectFact.evidence.map((entry) => entry.evidenceItemId),
        });
        if (current.projectFact.supersedesProjectFactId) {
          const superseded = await tx.projectFact.updateMany({
            where: {
              id: current.projectFact.supersedesProjectFactId,
              workItemId,
              status: "approved",
              lifecycleStatus: "active",
            },
            data: { status: "superseded", lifecycleStatus: "superseded" },
          });
          if (superseded.count !== 1) {
            throw new Error("The Project Fact this revision replaces changed after the candidate was proposed.");
          }
        }
        await claim();
        await approvePendingEvidence(tx, evidence);
        const statement = editedText ?? current.projectFact.statement;
        const activated = await tx.projectFact.updateMany({
          where: {
            id: current.projectFact.id,
            statement: current.projectFact.statement,
            status: "draft",
            lifecycleStatus: "quarantined",
            reviewState: "pending_review",
            approvalSource: "automation",
          },
          data: {
            statement,
            category: input.category ?? current.projectFact.category,
            sensitivityFlag: input.sensitivityFlag ?? current.projectFact.sensitivityFlag,
            reviewNotes: reviewNotes ?? current.projectFact.reviewNotes,
            searchText: [statement, input.category ?? current.projectFact.category, reviewNotes ?? current.projectFact.reviewNotes ?? ""].join(" "),
            status: "approved",
            lifecycleStatus: "active",
            reviewState: "reviewed",
            approvalSource: "user",
            rejectionReason: null,
          },
        });
        if (activated.count !== 1) throw new Error("This Project Fact changed while it was being approved.");
      }
    } else if (current.kind === "highlight_revision" && current.highlightSuggestion) {
      const draft = coerceStoredHighlightDraft(current.snapshot);
      if (!draft) throw new Error("The stored highlight revision is invalid.");
      if (input.decision === "deny") {
        await claim();
        const dismissed = await tx.highlightSuggestion.updateMany({
          where: { id: current.highlightSuggestion.id, status: "pending" },
          data: { status: "dismissed" },
        });
        if (dismissed.count !== 1) throw new Error("This Highlight revision changed while it was being reviewed.");
      } else {
        const expected = current.highlightSuggestion.currentSnapshot;
        const snapshot = expected && typeof expected === "object" && !Array.isArray(expected)
          ? expected as Record<string, unknown>
          : null;
        const source = current.highlightSuggestion.sourceHighlight;
        if (
          !source ||
          source.lifecycleStatus !== "active" ||
          (typeof snapshot?.text === "string" && snapshot.text !== source.text) ||
          (typeof snapshot?.summary === "string" && snapshot.summary !== source.summary)
        ) {
          throw new Error("This Highlight changed after the revision was proposed. Review a fresh revision.");
        }
        const evidence = await requireEligibleEvidence({
          tx,
          workItemId,
          evidenceIds: draft.evidence.sourceRefs.flatMap((entry) => entry.evidenceItemId ? [entry.evidenceItemId] : []),
        });
        const superseded = await tx.highlight.updateMany({
          where: {
            id: source.id,
            workItemId,
            lifecycleStatus: "active",
            text: source.text,
            summary: source.summary,
          },
          data: { lifecycleStatus: "superseded" },
        });
        if (superseded.count !== 1) throw new Error("This Highlight changed while its revision was being approved.");
        await claim();
        await approvePendingEvidence(tx, evidence);
        const successor = await createHighlightWithRelations({
          tx,
          workItemId,
          draft: { ...draft, text: editedText ?? draft.text, verificationStatus: "approved" },
        });
        await tx.highlight.update({
          where: { id: successor.id },
          data: {
            ...reviewOverrides,
            lifecycleStatus: "active",
            reviewState: "reviewed",
            approvalSource: "user",
            publicSafetyStatus: "pending",
            supersedesHighlightId: source.id,
          },
        });
        const accepted = await tx.highlightSuggestion.updateMany({
          where: { id: current.highlightSuggestion.id, status: "pending" },
          data: { status: "accepted" },
        });
        if (accepted.count !== 1) throw new Error("This Highlight revision changed while it was being approved.");
        await tx.agentRunCandidate.update({
          where: { id: current.id },
          data: { highlightId: successor.id },
        });
      }
    } else if (current.highlight) {
      if (!isExpectedHighlightCandidate(current)) {
        throw new Error("This Highlight changed after it was proposed. Refresh the candidate before reviewing it.");
      }
      if (input.decision === "deny") {
        await claim();
        const retired = await tx.highlight.updateMany({
          where: {
            id: current.highlight.id,
            lifecycleStatus: "quarantined",
            reviewState: "pending_review",
            approvalSource: "automation",
          },
          data: {
            verificationStatus: "rejected",
            lifecycleStatus: "retired",
            reviewState: "reviewed",
            rejectionReason: feedback ?? "Dismissed during project chat review.",
          },
        });
        if (retired.count !== 1) throw new Error("This Highlight changed while it was being reviewed.");
      } else {
        const evidence = await requireEligibleEvidence({
          tx,
          workItemId,
          evidenceIds: current.highlight.evidence.map((entry) => entry.evidenceItemId),
        });
        if (current.highlight.supersedesHighlightId) {
          const superseded = await tx.highlight.updateMany({
            where: { id: current.highlight.supersedesHighlightId, workItemId, lifecycleStatus: "active" },
            data: { lifecycleStatus: "superseded" },
          });
          if (superseded.count !== 1) throw new Error("The Highlight this candidate replaces changed after it was proposed.");
        }
        await claim();
        await approvePendingEvidence(tx, evidence);
        const activated = await tx.highlight.updateMany({
          where: {
            id: current.highlight.id,
            text: current.highlight.text,
            summary: current.highlight.summary,
            lifecycleStatus: "quarantined",
            reviewState: "pending_review",
            approvalSource: "automation",
          },
          data: {
            text: editedText ?? current.highlight.text,
            searchText: [editedText ?? current.highlight.text, current.highlight.summary, current.highlight.verificationNotes ?? ""].join(" "),
            verificationStatus: "approved",
            lifecycleStatus: "active",
            reviewState: "reviewed",
            approvalSource: "user",
            publicSafetyStatus: "pending",
            rejectionReason: null,
            ...reviewOverrides,
          },
        });
        if (activated.count !== 1) throw new Error("This Highlight changed while it was being approved.");
      }
    } else {
      throw new Error("The candidate no longer references a Highlight, Project Fact, or revision.");
    }
    return loadAuthorizedCandidate(input.userId, current.id, tx);
  });

  await runCandidatePostCommit(outcome);

  const resumedRunId = await resumeResolvedReviewBatchIfReady({
    agentRunId: outcome.agentRunId,
    batchNumber: outcome.batchNumber,
  });
  return {
    candidateId: outcome.id,
    status: outcome.status === "denied" ? ("denied" as const) : ("approved" as const),
    resumedRunId,
  };
}

export const candidateReviewService: CandidateReviewService = {
  resolve: resolveAgentCandidate,
};
