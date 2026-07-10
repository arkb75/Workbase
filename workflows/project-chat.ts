import { createHook, getWritable } from "workflow";
import type { ChatProgressEvent } from "@/src/domain/project-chat";
import { prisma } from "@/src/lib/prisma";
import {
  appendAgentRunEvent,
  completeAgentRun,
  failAgentRun,
  markAgentRunRunning,
} from "@/src/services/project-chat-store";
import { proposeHighlightFromChatContext } from "@/src/services/chat-highlight-candidate-service";
import { executeArtifactAttempt } from "@/src/services/artifact-workflow-service";
import { persistResearchAgentEvent } from "@/src/services/research-event-persistence-service";
import { runProjectChatAgent } from "@/src/services/project-chat-agent-service";

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

async function answerProjectQuestion(runId: string) {
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
            take: 10,
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

  const hints = run.thread
    ? [
        `Recent conversation (oldest to newest):\n${run.thread.messages
          .slice()
          .reverse()
          .filter((message) => message.id !== userMessage?.id)
          .map(
            (message) =>
              `${message.role}: ${message.content.slice(0, 700)}`,
          )
          .join("\n")}`,
      ]
    : undefined;
  const result = await runProjectChatAgent({
    runId: run.id,
    userId: run.userId,
    workItemId: run.workItemId,
    threadId: run.threadId!,
    messageId: userMessage!.id,
    question,
    hints,
    onAgentEvent: (event) => persistResearchAgentEvent(run.id, event),
  });

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
    },
    citations: result.citations,
  });
  return { status: "completed" as const };
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
      "Research found candidate highlights. Waiting for every review decision.",
      "candidate",
    );
    using review = createHook<{ reviewed: true }>({
      token: `agent-run:${runId}:review:${batchNumber}`,
    });
    if (await hasPendingReviewCandidates(runId, batchNumber)) {
      await review;
    }
    await setArtifactRunRunning(runId);
    await emitProgress(runId, "Review complete. Rechecking approved context.", "retrieval");
  }

  const message = "The artifact workflow finished without enough approved context.";
  await emitProgress(runId, message, "error");
  return { status: "insufficient_context" as const, message };
}

export async function projectChatTurnWorkflow(runId: string) {
  "use workflow";

  try {
    await emitProgress(runId, "Searching verified project memory.", "retrieval");
    const result = await answerProjectQuestion(runId);
    if (result.status === "artifact_requested") {
      await emitProgress(runId, "Starting the approval-gated artifact workflow.", "artifact");
      return await runArtifactLifecycle(runId);
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
