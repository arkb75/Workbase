import { Prisma } from "@/src/generated/prisma/client";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { looksLikeArtifactRequest } from "@/src/services/artifact-brief-service";
import { selectReferencedCitations } from "@/src/services/chat-citation-service";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function citationRows(messageId: string, citations: ProjectKnowledgeCitation[]) {
  return citations.map((citation, index) => ({
    messageId,
    kind: citation.kind,
    ordinal: index + 1,
    highlightId: citation.highlightId ?? null,
    projectFactId: citation.projectFactId ?? null,
    evidenceItemId: citation.evidenceItemId ?? null,
    artifactId: citation.artifactId ?? null,
    sourceId: citation.sourceId ?? null,
    label: citation.label.slice(0, 300),
    excerpt: citation.excerpt.slice(0, 2_000),
    immutableUrl: citation.url ?? null,
    repository: citation.repository ?? null,
    commitSha: citation.commitSha ?? null,
    blobSha: citation.blobSha ?? null,
    path: citation.path ?? null,
    startLine: citation.startLine ?? null,
    endLine: citation.endLine ?? null,
    contentHash: citation.contentHash ?? null,
    metadata:
      citation.redacted || citation.redactionCategories?.length
        ? toInputJson({
            redacted: citation.redacted ?? false,
            redactionCategories: citation.redactionCategories ?? [],
          })
        : Prisma.JsonNull,
  }));
}

export async function createProjectChatThread(input: {
  userId: string;
  workItemId: string;
  title?: string;
}) {
  await prisma.workItem.findFirstOrThrow({
    where: {
      id: input.workItemId,
      userId: input.userId,
    },
    select: { id: true },
  });

  return prisma.chatThread.create({
    data: {
      userId: input.userId,
      workItemId: input.workItemId,
      title: input.title?.trim().slice(0, 80) || "New conversation",
    },
  });
}

export async function renameProjectChatThread(input: {
  userId: string;
  workItemId: string;
  threadId: string;
  title: string;
}) {
  return prisma.chatThread.updateMany({
    where: {
      id: input.threadId,
      workItemId: input.workItemId,
      userId: input.userId,
      archivedAt: null,
    },
    data: {
      title: normalizeWhitespace(input.title).slice(0, 80) || "Conversation",
    },
  });
}

export async function archiveProjectChatThread(input: {
  userId: string;
  workItemId: string;
  threadId: string;
}) {
  return prisma.chatThread.updateMany({
    where: {
      id: input.threadId,
      workItemId: input.workItemId,
      userId: input.userId,
    },
    data: {
      archivedAt: new Date(),
    },
  });
}

export async function createProjectChatRun(input: {
  userId: string;
  workItemId: string;
  threadId: string;
  message: string;
  idempotencyKey: string;
  kind?: "chat_turn" | "artifact_workflow";
}) {
  const message = normalizeWhitespace(input.message).slice(0, 4_000);

  if (message.length < 2) {
    throw new Error("A chat message must contain at least two characters.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "ChatThread"
      WHERE "id" = ${input.threadId}
        AND "workItemId" = ${input.workItemId}
        AND "userId" = ${input.userId}
        AND "archivedAt" IS NULL
      FOR UPDATE
    `;
    const thread = await tx.chatThread.findFirstOrThrow({
      where: {
        id: input.threadId,
        workItemId: input.workItemId,
        userId: input.userId,
        archivedAt: null,
      },
    });
    const existingRun = await tx.agentRun.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existingRun) {
      return existingRun;
    }
    const activeRun = await tx.agentRun.findFirst({
      where: {
        threadId: thread.id,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      select: { id: true },
    });
    if (activeRun) {
      throw new Error("Finish or cancel the active thread run before sending another message.");
    }

    const sequence =
      (
        await tx.chatMessage.aggregate({
          where: { threadId: thread.id },
          _max: { sequence: true },
        })
      )._max.sequence ?? 0;
    const kind =
      input.kind ?? (looksLikeArtifactRequest(message) ? "artifact_workflow" : "chat_turn");
    const run = await tx.agentRun.create({
      data: {
        userId: input.userId,
        workItemId: input.workItemId,
        threadId: thread.id,
        idempotencyKey: input.idempotencyKey,
        kind,
        request: toInputJson({ message, brief: kind === "artifact_workflow" ? message : null }),
      },
    });

    await tx.chatMessage.createMany({
      data: [
        {
          threadId: thread.id,
          agentRunId: run.id,
          sequence: sequence + 1,
          role: "user",
          status: "completed",
          content: message,
        },
        {
          threadId: thread.id,
          agentRunId: run.id,
          sequence: sequence + 2,
          role: "assistant",
          status: "queued",
          content: "",
        },
      ],
    });

    if (thread.title === "New conversation") {
      await tx.chatThread.update({
        where: { id: thread.id },
        data: {
          title: message.length > 58 ? `${message.slice(0, 57).trim()}…` : message,
        },
      });
    } else {
      await tx.chatThread.update({
        where: { id: thread.id },
        data: { updatedAt: new Date() },
      });
    }

    return run;
  });
}

export async function attachWorkflowToAgentRun(input: {
  runId: string;
  workflowId: string;
}) {
  await prisma.agentRun.update({
    where: { id: input.runId },
    data: { workflowId: input.workflowId },
  });
}

export async function appendAgentRunEvent(input: {
  runId: string;
  type: "progress" | "tool_call" | "tool_result" | "status_change" | "warning" | "error";
  message?: string | null;
  toolName?: string | null;
  payload?: unknown;
  isUserVisible?: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "AgentRun" WHERE "id" = ${input.runId} FOR UPDATE
    `;
    if (!runs[0] || ["completed", "insufficient_context", "failed", "cancelled"].includes(runs[0].status)) {
      return null;
    }
    const max = await tx.agentRunEvent.aggregate({
      where: { agentRunId: input.runId },
      _max: { sequence: true },
    });

    return tx.agentRunEvent.create({
      data: {
        agentRunId: input.runId,
        sequence: (max._max.sequence ?? 0) + 1,
        type: input.type,
        message: input.message?.slice(0, 500) ?? null,
        toolName: input.toolName?.slice(0, 120) ?? null,
        payload: input.payload == null ? Prisma.JsonNull : toInputJson(input.payload),
        isUserVisible: input.isUserVisible ?? true,
      },
    });
  });
}

export async function markAgentRunRunning(runId: string) {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.agentRun.updateMany({
      where: {
        id: runId,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: {
        status: "running",
        startedAt: new Date(),
      },
    });
    if (!updated.count) return;
    await tx.chatMessage.updateMany({
      where: { agentRunId: runId, role: "assistant" },
      data: { status: "running" },
    });
  });
}

export async function markAgentRunAwaitingReview(input: {
  runId: string;
  content: string;
  result: unknown;
  citations: ProjectKnowledgeCitation[];
}) {
  const selected = selectReferencedCitations(input.content, input.citations);
  await prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "AgentRun" WHERE "id" = ${input.runId} FOR UPDATE
    `;
    if (!runs[0] || !["queued", "running", "awaiting_review"].includes(runs[0].status)) return;
    const message = await tx.chatMessage.findFirstOrThrow({
      where: { agentRunId: input.runId, role: "assistant" },
      orderBy: { sequence: "desc" },
    });
    await tx.chatCitation.deleteMany({ where: { messageId: message.id } });
    if (selected.citations.length) {
      await tx.chatCitation.createMany({ data: citationRows(message.id, selected.citations) });
    }
    await tx.chatMessage.update({
      where: { id: message.id },
      data: {
        content: selected.content,
        status: "awaiting_review",
        finalizedAt: null,
        metadata: toInputJson({ provisional: true, originatingRunId: input.runId }),
      },
    });
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status: "awaiting_review",
        result: toInputJson(input.result),
        provisionalResult: toInputJson({
          content: selected.content,
          citations: selected.citations.map((citation, index) => ({
            ordinal: index + 1,
            kind: citation.kind,
            label: citation.label,
            projectFactId: citation.projectFactId ?? null,
          })),
          capturedAt: new Date().toISOString(),
        }),
      },
    });
  });
}

export async function completeAgentRun(input: {
  runId: string;
  content: string;
  result: unknown;
  citations?: ProjectKnowledgeCitation[];
}) {
  const selected = selectReferencedCitations(input.content, input.citations ?? []);
  await prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "AgentRun" WHERE "id" = ${input.runId} FOR UPDATE
    `;
    if (
      !runs[0] ||
      ["completed", "insufficient_context", "failed", "cancelled"].includes(runs[0].status)
    ) {
      return;
    }
    const message = await tx.chatMessage.findFirstOrThrow({
      where: { agentRunId: input.runId, role: "assistant" },
      orderBy: { sequence: "desc" },
    });
    await tx.chatCitation.deleteMany({ where: { messageId: message.id } });

    if (selected.citations.length) {
      await tx.chatCitation.createMany({ data: citationRows(message.id, selected.citations) });
    }

    await tx.chatMessage.update({
      where: { id: message.id },
      data: {
        content: selected.content,
        status: "completed",
        finalizedAt: new Date(),
        metadata: toInputJson({ provisional: false, originatingRunId: input.runId }),
      },
    });
    const threadMessages = await tx.chatMessage.findMany({
      where: { threadId: message.threadId },
      orderBy: { sequence: "asc" },
    });
    const olderMessages = threadMessages.slice(0, Math.max(0, threadMessages.length - 12));
    const rollingSummary = olderMessages
      .map((entry) => `${entry.role}: ${entry.id === message.id ? selected.content : entry.content}`)
      .join("\n");
    await tx.chatThread.update({
      where: { id: message.threadId },
      data: {
        rollingSummary: rollingSummary ? rollingSummary.slice(-6_000) : null,
        conversationState: toInputJson({
          version: 1,
          olderTurns: olderMessages.slice(-24).map((entry) => ({
            messageId: entry.id,
            role: entry.role,
            summary: (entry.id === message.id ? selected.content : entry.content).slice(0, 800),
          })),
          lastCompletedRunId: input.runId,
          updatedAt: new Date().toISOString(),
        }),
      },
    });
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status: "completed",
        result: toInputJson(input.result),
        finishedAt: new Date(),
      },
    });
  });
}

export async function failAgentRun(input: {
  runId: string;
  message: string;
  insufficient?: boolean;
}) {
  const status = input.insufficient ? "insufficient_context" : "failed";
  await prisma.$transaction(async (tx) => {
    const updated = await tx.agentRun.updateMany({
      where: {
        id: input.runId,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: {
        status,
        error: toInputJson({ message: input.message }),
        finishedAt: new Date(),
      },
    });
    if (!updated.count) return;
    await tx.chatMessage.updateMany({
      where: { agentRunId: input.runId, role: "assistant" },
      data: {
        status: "failed",
        content: input.message,
        finalizedAt: new Date(),
      },
    });
  });
}

export async function getProjectChatWorkspace(input: {
  userId: string;
  workItemId: string;
  activeThreadId?: string | null;
}) {
  const threads = await prisma.chatThread.findMany({
    where: {
      userId: input.userId,
      workItemId: input.workItemId,
      archivedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });
  const activeThread =
    threads.find((thread) => thread.id === input.activeThreadId) ?? threads[0] ?? null;

  if (!activeThread) {
    return {
      threads,
      activeThread: null,
      messages: [],
      runs: [],
      events: [],
      candidates: [],
    };
  }

  const [messages, runs] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { threadId: activeThread.id },
      include: {
        citations: {
          orderBy: { ordinal: "asc" },
          include: {
            projectFact: {
              include: {
                evidence: { include: { evidenceItem: true } },
              },
            },
          },
        },
      },
      orderBy: { sequence: "asc" },
    }),
    prisma.agentRun.findMany({
      where: { threadId: activeThread.id },
      include: {
        events: {
          where: { isUserVisible: true },
          orderBy: { sequence: "asc" },
        },
        candidates: {
          include: {
            highlight: {
              include: {
                tags: true,
                evidence: {
                  include: { evidenceItem: true },
                },
              },
            },
            highlightSuggestion: true,
            projectFact: {
              include: {
                evidence: { include: { evidenceItem: true } },
                supersedesProjectFact: true,
              },
            },
          },
          orderBy: [{ batchNumber: "asc" }, { ordinal: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    threads,
    activeThread,
    messages,
    runs,
    events: runs.flatMap((run) => run.events.map((event) => ({ ...event, runId: run.id }))),
    candidates: runs.flatMap((run) =>
      run.candidates.map((candidate) => ({ ...candidate, runId: run.id })),
    ),
  };
}
