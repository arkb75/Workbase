import { createHook, getWritable } from "workflow";
import type { ChatProgressEvent } from "@/src/domain/project-chat";
import type { BedrockConverseAgentEvent } from "@/src/lib/bedrock-converse-agent";
import { prisma } from "@/src/lib/prisma";
import {
  appendAgentRunEvent,
  completeAgentRun,
  failAgentRun,
  markAgentRunAwaitingReview,
  markAgentRunRunning,
} from "@/src/services/project-chat-store";
import { proposeHighlightFromChatContext } from "@/src/services/chat-highlight-candidate-service";
import { executeArtifactAttempt } from "@/src/services/artifact-workflow-service";
import { persistResearchAgentEvent } from "@/src/services/research-event-persistence-service";
import {
  finalizeProjectChatAfterFactReview,
  requiresLiveRepositoryResearch,
  runProjectChatAgent,
} from "@/src/services/project-chat-agent-service";
import { looksLikeArtifactRequest } from "@/src/services/artifact-brief-service";
import {
  knowledgeRefreshService,
  startKnowledgeRefresh,
} from "@/src/services/knowledge-refresh-service";
import { knowledgeReconciliationService } from "@/src/services/knowledge-reconciliation-service";
import { knowledgeStalenessService } from "@/src/services/knowledge-staleness-service";

async function emitProgress(
  runId: string,
  message: string,
  type: ChatProgressEvent["type"] = "status",
) {
  "use step";

  await appendAgentRunEvent({
    runId,
    type: type === "error" ? "error" : "progress",
    message,
  });
  const writable = getWritable<ChatProgressEvent>();
  const writer = writable.getWriter();
  try {
    await writer.write({
      type,
      message,
      createdAt: new Date().toISOString(),
      refs: { runId },
    });
  } finally {
    writer.releaseLock();
  }
}

async function closeProgressStream() {
  "use step";
  await getWritable<ChatProgressEvent>().close();
}

async function startRequiredKnowledgeRefresh(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { messages: { where: { role: "user" }, orderBy: { sequence: "desc" }, take: 1 } },
  });
  const question = run.messages[0]?.content ?? "";
  if (!requiresLiveRepositoryResearch(question) && !looksLikeArtifactRequest(question)) {
    return { required: false as const, refreshRunId: null, alreadyComplete: false };
  }
  const refresh = await startKnowledgeRefresh({
    userId: run.userId,
    workItemId: run.workItemId,
    trigger: "chat_freshness",
    idempotencyKey: `agent-run:${run.id}:freshness`,
  });
  return { required: true as const, refreshRunId: refresh.runId, alreadyComplete: refresh.status === "completed" };
}

async function inventoryRequiredKnowledge(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.inventory(refreshRunId);
}

async function analyzeRequiredKnowledgeBatch(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.analyzeBatch({ runId: refreshRunId, batchSize: 4 });
}

async function finalizeRequiredCoverage(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.finalizeCoverage(refreshRunId);
}

async function reconcileRequiredKnowledge(refreshRunId: string) {
  "use step";
  const reconciled = await knowledgeReconciliationService.reconcile(refreshRunId);
  const staleness = await knowledgeStalenessService.reconcile({
    runId: refreshRunId,
    appliedFactIds: reconciled.appliedFactIds,
    appliedHighlightIds: reconciled.appliedHighlightIds,
  });
  await knowledgeRefreshService.complete(refreshRunId);
  return {
    appliedFactIds: reconciled.appliedFactIds,
    appliedHighlightIds: reconciled.appliedHighlightIds,
    promotedEvidenceIds: reconciled.promotedEvidenceIds,
    staleness,
  };
}

async function failRequiredKnowledgeRefresh(refreshRunId: string, errorMessage: string) {
  "use step";
  return knowledgeRefreshService.fail(refreshRunId, new Error(errorMessage));
}

async function attachRefreshToAgentRun(runId: string, refreshRunId: string) {
  "use step";
  const refresh = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: refreshRunId } });
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      researchState: {
        kind: "repository_knowledge_refresh",
        refreshRunId,
        status: refresh.status,
        targetHeads: refresh.targetHeads,
        coverage: refresh.coverage,
        partial: false,
        completedAt: refresh.finishedAt?.toISOString() ?? new Date().toISOString(),
      },
    },
  });
}

async function runRequiredKnowledgeRefresh(runId: string) {
  const requirement = await startRequiredKnowledgeRefresh(runId);
  if (!requirement.required || !requirement.refreshRunId) return null;
  if (requirement.alreadyComplete) {
    await attachRefreshToAgentRun(runId, requirement.refreshRunId);
    await emitProgress(runId, "Repository knowledge is already complete at the latest resolved commit.", "research");
    return { refreshRunId: requirement.refreshRunId };
  }
  await emitProgress(runId, "Resolving the latest repository commit and inventorying every safe file.", "research");
  try {
    await inventoryRequiredKnowledge(requirement.refreshRunId);
    let remaining = 1;
    while (remaining > 0) {
      const batch = await analyzeRequiredKnowledgeBatch(requirement.refreshRunId);
      remaining = batch.remaining;
      await emitProgress(
        runId,
        remaining > 0
          ? `Analyzing complete repository coverage (${remaining} safe files remaining).`
          : "Every safe repository file has been analyzed.",
        "research",
      );
    }
    await finalizeRequiredCoverage(requirement.refreshRunId);
    await emitProgress(runId, "Reconciling current Facts, Highlights, Evidence, and Artifacts.", "candidate");
    const reconciliation = await reconcileRequiredKnowledge(requirement.refreshRunId);
    await attachRefreshToAgentRun(runId, requirement.refreshRunId);
    return { refreshRunId: requirement.refreshRunId, ...reconciliation };
  } catch (error) {
    await failRequiredKnowledgeRefresh(
      requirement.refreshRunId,
      error instanceof Error ? error.message : "Unknown repository refresh error.",
    );
    throw error;
  }
}

async function answerProjectQuestion(runId: string, afterFactReview = false) {
  "use step";

  await markAgentRunRunning(runId);
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      messages: {
        orderBy: { sequence: "asc" },
      },
      thread: {
        include: {
          messages: {
            where: { status: "completed" },
            orderBy: { sequence: "desc" },
            take: 13,
            include: { citations: { orderBy: { ordinal: "asc" } } },
          },
        },
      },
    },
  });
  const userMessage = run.messages.find((message) => message.role === "user");
  const question = userMessage?.content ?? "";

  if (!question) {
    await failAgentRun({ runId, message: "The chat request did not contain a question." });
    return { status: "failed" as const };
  }

  const existingCandidate = await prisma.agentRunCandidate.findFirst({
    where: { agentRunId: run.id },
  });

  if (!existingCandidate && run.threadId && userMessage) {
    try {
      const candidate = await proposeHighlightFromChatContext({
        userId: run.userId,
        workItemId: run.workItemId,
        threadId: run.threadId,
        messageId: userMessage.id,
        agentRunId: run.id,
        text: question,
      });

      if (candidate) {
        await appendAgentRunEvent({
          runId,
          type: "status_change",
          message: "Prepared a reviewable highlight candidate from your new context.",
        });
      }
    } catch (error) {
      await appendAgentRunEvent({
        runId,
        type: "warning",
        message: "The answer is continuing, but Workbase could not prepare a highlight candidate.",
        payload: { error: error instanceof Error ? error.message : "unknown" },
        isUserVisible: false,
      });
    }
  }

  const history = run.thread?.messages
    .slice()
    .reverse()
    .filter((message) => message.id !== userMessage?.id)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.citations.map((citation) => ({
        ordinal: citation.ordinal,
        kind: citation.kind,
        label: citation.label,
      })),
    }));
  const agentInput = {
    runId: run.id,
    userId: run.userId,
    workItemId: run.workItemId,
    threadId: run.threadId!,
    messageId: userMessage!.id,
    question,
    history,
    rollingSummary: run.thread?.rollingSummary,
    allowResearch: !afterFactReview,
    onAgentEvent: (event: BedrockConverseAgentEvent) => persistResearchAgentEvent(run.id, event),
  };
  const result = afterFactReview
    ? await finalizeProjectChatAfterFactReview(agentInput)
    : await runProjectChatAgent(agentInput);

  if (result.status === "artifact_requested") {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        kind: "artifact_workflow",
        request: { message: question, brief: result.brief },
      },
    });
    return { status: "artifact_requested" as const };
  }

  if (result.status === "insufficient_context") {
    await failAgentRun({
      runId,
      message: result.answer,
      insufficient: true,
    });
    return { status: "insufficient_context" as const };
  }

  if (result.status === "awaiting_review") {
    await markAgentRunAwaitingReview({
      runId: run.id,
      content: result.answer,
      citations: result.citations,
      result: {
        status: "awaiting_review",
        candidateIds: result.research.candidateIds,
        coverageGaps: result.research.coverageGaps,
        warnings: result.research.warnings,
        partial: result.research.partial,
        exploredEvidenceCount: result.research.exploredEvidence.length,
      },
    });
    return { status: "awaiting_review" as const };
  }

  await completeAgentRun({
    runId,
    content: result.answer,
    result: {
      status: result.research.status,
      findings: result.research.findings,
      coverageGaps: result.research.coverageGaps,
      warnings: result.research.warnings,
      citationCount: result.citations.length,
      generationRunIds: result.research.generationRunIds,
      partial: result.research.partial,
      exploredEvidenceCount: result.research.exploredEvidence.length,
      groundedClaims: result.research.groundedClaims ?? [],
      fallbackUsed: false,
    },
    citations: result.citations,
    researchFinalization: {
      usedProjectFactIds: result.citations.flatMap((citation) => citation.projectFactId ? [citation.projectFactId] : []),
    },
  });
  return { status: "completed" as const };
}

async function approvedProjectFactCandidateCount(runId: string) {
  "use step";
  return prisma.agentRunCandidate.count({
    where: {
      agentRunId: runId,
      kind: { in: ["new_project_fact", "project_fact_revision"] },
      status: { in: ["approved", "edited_and_approved"] },
      projectFact: { status: "approved" },
    },
  });
}

async function finishDeniedProjectFactReview(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { result: true } });
  const stored = run?.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result as Record<string, unknown>
    : null;
  const gaps = Array.isArray(stored?.coverageGaps)
    ? stored.coverageGaps.filter((gap): gap is string => typeof gap === "string").slice(0, 3)
    : [];
  const message = [
    "None of the repository-derived Project Facts were approved, so Workbase cannot retain or use those provisional claims.",
    gaps.length ? `Unresolved coverage: ${gaps.join("; ")}` : "Retry with a narrower question or different repository scope if you want another research pass.",
  ].join(" ");
  await failAgentRun({ runId, message, insufficient: true });
  return { status: "insufficient_context" as const, message };
}

async function setArtifactRunRunning(runId: string) {
  "use step";
  await markAgentRunRunning(runId);
}

async function runArtifactAttempt(runId: string, batchNumber: number) {
  "use step";
  return executeArtifactAttempt({ runId, batchNumber });
}

async function hasPendingReviewCandidates(runId: string, batchNumber: number) {
  "use step";
  return (
    (await prisma.agentRunCandidate.count({
      where: { agentRunId: runId, batchNumber, status: "pending" },
    })) > 0
  );
}

async function failWorkflowRun(runId: string, errorMessage: string) {
  "use step";
  const message = errorMessage
    ? `The durable agent run failed: ${errorMessage.slice(0, 400)}`
    : "The durable agent run failed unexpectedly.";
  await failAgentRun({ runId, message });
  return message;
}

async function runArtifactLifecycle(runId: string) {
  await setArtifactRunRunning(runId);
  await emitProgress(runId, "Selecting approved highlights for the artifact.", "retrieval");

  // The third attempt never researches. It only re-evaluates the context approved
  // after the second and final review batch before declaring an evidence gap.
  for (let batchNumber = 1; batchNumber <= 3; batchNumber += 1) {
    const result = await runArtifactAttempt(runId, batchNumber);

    if (
      result.status === "completed" ||
      result.status === "clarification_required" ||
      result.status === "insufficient_context"
    ) {
      await emitProgress(
        runId,
        result.status === "completed"
          ? "Artifact generated from approved highlights."
          : result.message,
        result.status === "completed" ? "complete" : "error",
      );
      return result;
    }

    if (result.status === "retry_research") {
      await emitProgress(runId, "Refining the repository research target.", "research");
      continue;
    }

    await emitProgress(
      runId,
      "Verified Highlights were auto-applied; waiting only on quarantined safety exceptions.",
      "candidate",
    );
    using review = createHook<{ reviewed: true }>({
      token: `agent-run:${runId}:review:${batchNumber}`,
    });
    if (await hasPendingReviewCandidates(runId, batchNumber)) {
      await review;
    }
    await setArtifactRunRunning(runId);
    await emitProgress(runId, "Safety review complete. Rechecking auto-applied context.", "retrieval");
  }

  const message = "The artifact workflow finished without enough approved context.";
  await emitProgress(runId, message, "error");
  return { status: "insufficient_context" as const, message };
}

export async function projectChatTurnWorkflow(runId: string) {
  "use workflow";

  try {
    await runRequiredKnowledgeRefresh(runId);
    await emitProgress(runId, "Searching verified project memory.", "retrieval");
    let result = await answerProjectQuestion(runId);
    if (result.status === "artifact_requested") {
      await emitProgress(runId, "Starting the approval-gated artifact workflow.", "artifact");
      return await runArtifactLifecycle(runId);
    }
    if (result.status === "awaiting_review") {
      await emitProgress(
        runId,
        "Repository research found project facts. Waiting for every review decision.",
        "candidate",
      );
      using review = createHook<{ reviewed: true }>({
        token: `agent-run:${runId}:review:1`,
      });
      if (await hasPendingReviewCandidates(runId, 1)) await review;
      if (!(await approvedProjectFactCandidateCount(runId))) {
        return await finishDeniedProjectFactReview(runId);
      }
      await emitProgress(runId, "Fact review complete. Resuming the saved research and finalizing from approved facts.", "retrieval");
      result = await answerProjectQuestion(runId, true);
    }
    await emitProgress(
      runId,
      result.status === "completed"
        ? "Answer grounded and citations attached."
        : "Project context was not sufficient for a grounded answer.",
      result.status === "completed" ? "complete" : "error",
    );
    return result;
  } catch (error) {
    const message = await failWorkflowRun(
      runId,
      error instanceof Error ? error.message : "",
    );
    return { status: "failed" as const, message };
  } finally {
    await closeProgressStream();
  }
}

export async function artifactGenerationWorkflow(runId: string) {
  "use workflow";

  try {
    await runRequiredKnowledgeRefresh(runId);
    return await runArtifactLifecycle(runId);
  } catch (error) {
    const message = await failWorkflowRun(
      runId,
      error instanceof Error ? error.message : "",
    );
    return { status: "failed" as const, message };
  } finally {
    await closeProgressStream();
  }
}

export async function repositoryKnowledgeRefreshWorkflow(refreshRunId: string) {
  "use workflow";

  try {
    await inventoryRequiredKnowledge(refreshRunId);
    let remaining = 1;
    while (remaining > 0) {
      const batch = await analyzeRequiredKnowledgeBatch(refreshRunId);
      remaining = batch.remaining;
    }
    await finalizeRequiredCoverage(refreshRunId);
    return await reconcileRequiredKnowledge(refreshRunId);
  } catch (error) {
    await failRequiredKnowledgeRefresh(
      refreshRunId,
      error instanceof Error ? error.message : "Unknown repository refresh error.",
    );
    throw error;
  }
}
