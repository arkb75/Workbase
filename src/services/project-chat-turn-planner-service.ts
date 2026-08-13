import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { appendAgentRunEvent } from "@/src/services/project-chat-store";
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";
import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";

export const PROJECT_CHAT_TURN_PLAN_VERSION = "project-chat-turn-plan-v1";

export const projectChatTurnPlanSchema = z.object({
  version: z.literal(PROJECT_CHAT_TURN_PLAN_VERSION),
  objective: z.string().trim().min(1).max(2_000),
  action: z.enum(["answer", "refresh_then_answer", "artifact"]),
  allowRepositoryResearch: z.boolean(),
  knowledgeQueries: z.array(z.string().trim().min(1).max(1_000)).max(6),
  outputFormat: z.string().trim().min(1).max(120),
  outputRequirements: z.array(z.string().trim().min(1).max(500)).max(12),
  reasonCodes: z.array(z.string().trim().min(1).max(100)).max(8),
  confidence: z.number().min(0).max(1),
});

export type ProjectChatTurnPlan = z.infer<typeof projectChatTurnPlanSchema> & {
  generationRunId: string | null;
};

const projectChatTurnPlanJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "objective",
    "action",
    "allowRepositoryResearch",
    "knowledgeQueries",
    "outputFormat",
    "outputRequirements",
    "reasonCodes",
    "confidence",
  ],
  properties: {
    version: { type: "string", enum: [PROJECT_CHAT_TURN_PLAN_VERSION] },
    objective: { type: "string", minLength: 1, maxLength: 2_000 },
    action: {
      type: "string",
      enum: ["answer", "refresh_then_answer", "artifact"],
    },
    allowRepositoryResearch: { type: "boolean" },
    knowledgeQueries: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    outputFormat: { type: "string", minLength: 1, maxLength: 120 },
    outputRequirements: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    reasonCodes: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function providerSafeText(value: string) {
  return redactRepositorySecrets(value).content;
}

export function readStoredProjectChatTurnPlan(value: unknown): ProjectChatTurnPlan | null {
  const stored = record(value).projectChatTurnPlan;
  const parsed = projectChatTurnPlanSchema.safeParse(stored);
  if (!parsed.success) return null;
  const generationRunId = typeof record(stored).generationRunId === "string"
    ? String(record(stored).generationRunId)
    : null;
  return { ...parsed.data, generationRunId };
}

export function compactProjectChatPlanningTranscript(messages: Array<{
  id: string;
  sequence: number;
  role: string;
  status: string;
  content: string;
  citations: Array<{ ordinal: number; kind: string; label: string }>;
}>, currentMessageId: string) {
  const completed = messages
    .filter((message) => message.id !== currentMessageId && message.status === "completed")
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 8_000),
      usedSources: message.citations.slice(0, 12).map((citation) => ({
        ordinal: citation.ordinal,
        kind: citation.kind,
        label: citation.label.slice(0, 240),
      })),
    }));
  return completed;
}

export interface ProjectChatTurnPlanPromptInput {
  currentRequest: string;
  conversation: Array<{
    role: string;
    content: string;
    usedSources: Array<{ ordinal: number; kind: string; label: string }>;
  }>;
  rollingSummary: string | null;
  workItem: { title: string; type: string };
  repositories: Array<{ sourceId: string; label: string; repository: string }>;
}

export function sanitizeProjectChatTurnPlanPromptInput(
  input: ProjectChatTurnPlanPromptInput,
): ProjectChatTurnPlanPromptInput {
  return {
    currentRequest: providerSafeText(input.currentRequest),
    conversation: input.conversation.map((message) => ({
      ...message,
      content: providerSafeText(message.content),
      usedSources: message.usedSources.map((source) => ({
        ...source,
        label: providerSafeText(source.label),
      })),
    })),
    rollingSummary: input.rollingSummary
      ? providerSafeText(input.rollingSummary)
      : null,
    workItem: {
      title: providerSafeText(input.workItem.title),
      type: input.workItem.type,
    },
    repositories: input.repositories.map((repository) => ({
      ...repository,
      label: providerSafeText(repository.label),
      repository: providerSafeText(repository.repository),
    })),
  };
}

export function buildProjectChatTurnPlanPrompts(input: ProjectChatTurnPlanPromptInput) {
  return {
    systemPrompt: [
      "You plan one Workbase project-chat turn from the complete chronological conversation.",
      "Resolve pronouns, ellipsis, freshness follow-ups, requested presentation, and the user's actual objective semantically. Small wording changes must not change the objective when the conversation meaning is the same.",
      "Choose refresh_then_answer only when answering requires the latest attached repository state. A question about prior messages, current runtime configuration, or an already-running refresh does not itself require a repository refresh.",
      "Choose artifact only when the user is asking Workbase to create or revise an artifact, not merely discussing artifacts.",
      "allowRepositoryResearch means the answer model may inspect attached repository code if durable project memory is insufficient. It does not authorize an unattached repository or another user's data.",
      "Describe the requested output semantically. Treat matrix, grid, comparison table, columns, and equivalent phrasing according to their conversational meaning rather than exact trigger words.",
      "Return a compact plan, not an answer. Do not invent repositories, tools, facts, or side effects.",
    ].join(" "),
    userPrompt: JSON.stringify({
      currentRequest: input.currentRequest,
      conversation: input.conversation,
      rollingSummary: input.rollingSummary,
      workItem: input.workItem,
      attachedRepositories: input.repositories,
      availableActions: ["answer", "refresh_then_answer", "artifact"],
      availableAnswerTools: [
        "search_project_memory",
        "inspect_runtime_model_profiles",
        "inspect_repository_state",
        "inspect_prior_answer_sources",
        ...(input.repositories.length ? ["research_repository"] : []),
      ],
    }),
  };
}

export async function ensureProjectChatTurnPlan(runId: string): Promise<ProjectChatTurnPlan> {
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      messages: {
        orderBy: { sequence: "asc" },
        include: { citations: { orderBy: { ordinal: "asc" } } },
      },
      thread: {
        include: {
          messages: {
            where: { status: "completed" },
            // Fetch the newest window, then the compactor restores
            // chronological order. Taking the first 25 ascending messages
            // silently lost recent referents on long threads.
            orderBy: { sequence: "desc" },
            take: 25,
            include: { citations: { orderBy: { ordinal: "asc" } } },
          },
        },
      },
      workItem: {
        select: {
          title: true,
          type: true,
          sources: {
            where: { type: "github_repo" },
            select: { id: true, label: true, metadata: true },
          },
        },
      },
    },
  });
  const existing = readStoredProjectChatTurnPlan(run.request);
  if (existing) return existing;

  const userMessage = run.messages.find((message) => message.role === "user");
  if (!userMessage?.content.trim()) {
    throw new Error("The project-chat turn has no user request to plan.");
  }
  const repositories = run.workItem.sources.map((source) => ({
    sourceId: source.id,
    label: source.label,
    repository:
      typeof record(record(source.metadata).repository).fullName === "string"
        ? String(record(record(source.metadata).repository).fullName)
        : source.label,
  }));

  // Unit tests use the mock provider and exercise the model contract through
  // injected structured-client fixtures. Production providers never take a
  // lexical/regex semantic route: the durable plan below is model-authored.
  if (resolveWorkbaseLlmProvider() === "mock") {
    return {
      version: PROJECT_CHAT_TURN_PLAN_VERSION,
      objective: userMessage.content,
      action: "answer",
      allowRepositoryResearch: repositories.length > 0,
      knowledgeQueries: [userMessage.content],
      outputFormat: "follow the user's requested format",
      outputRequirements: [],
      reasonCodes: ["mock_test_plan"],
      confidence: 1,
      generationRunId: null,
    };
  }

  const transcript = compactProjectChatPlanningTranscript(
    run.thread?.messages ?? [],
    userMessage.id,
  );
  const prompts = buildProjectChatTurnPlanPrompts(
    sanitizeProjectChatTurnPlanPromptInput({
      currentRequest: userMessage.content,
      conversation: transcript,
      rollingSummary: run.thread?.rollingSummary ?? null,
      workItem: { title: run.workItem.title, type: run.workItem.type },
      repositories,
    }),
  );
  const result = await runAuditedStructuredGeneration({
    workItemId: run.workItemId,
    agentRunId: run.id,
    kind: "project_chat_planning",
    profile: "primary_answer",
    idempotencyKey: `project-chat-plan:${run.id}:${PROJECT_CHAT_TURN_PLAN_VERSION}`,
    inputSummary: {
      messageId: userMessage.id,
      messageCharacters: userMessage.content.length,
      historyMessageCount: transcript.length,
      repositoryCount: repositories.length,
      planVersion: PROJECT_CHAT_TURN_PLAN_VERSION,
    },
    execute: () => getStructuredLlmClient("primary_answer").generateStructured({
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      schema: projectChatTurnPlanSchema,
      schemaName: "project_chat_turn_plan",
      schemaDescription: "A semantic plan for one project-chat turn.",
      jsonSchema: projectChatTurnPlanJsonSchema,
      maxTokens: 2_000,
      temperature: 0,
      effort: "medium",
      repairStrategy: "repair_last_failure",
      extraValidation: (plan) => [
        ...(!repositories.length && plan.action === "refresh_then_answer"
          ? ["Repository refresh is unavailable because no repository is attached."]
          : []),
        ...(!repositories.length && plan.allowRepositoryResearch
          ? ["Repository research is unavailable because no repository is attached."]
          : []),
      ],
    }),
  });
  const plan: ProjectChatTurnPlan = {
    ...result.data,
    generationRunId: result.generationRunId,
  };
  const effectivePlan = await prisma.$transaction(async (tx) => {
    const current = await tx.agentRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { request: true },
    });
    const winner = readStoredProjectChatTurnPlan(current.request);
    if (winner) return winner;
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        request: json({
          ...record(current.request),
          projectChatTurnPlan: plan,
        }),
      },
    });
    return plan;
  });
  await appendAgentRunEvent({
    runId: run.id,
    type: "tool_result",
    toolName: "plan_project_chat_turn",
    payload: {
      planVersion: effectivePlan.version,
      action: effectivePlan.action,
      outputFormat: effectivePlan.outputFormat,
      knowledgeQueryCount: effectivePlan.knowledgeQueries.length,
      allowRepositoryResearch: effectivePlan.allowRepositoryResearch,
      generationRunId: effectivePlan.generationRunId,
    },
    isUserVisible: false,
  }).catch(() => null);
  return effectivePlan;
}

export const projectChatTurnPlannerService = {
  ensure: ensureProjectChatTurnPlan,
  read: readStoredProjectChatTurnPlan,
};
