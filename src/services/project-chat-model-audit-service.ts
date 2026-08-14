import type { BedrockConverseAgentRunResult } from "@/src/lib/bedrock-converse-agent";
import { sanitizeBedrockConverseEventValue } from "@/src/lib/bedrock-converse-agent";
import { z } from "zod";
import type {
  ProjectKnowledgeCitation,
  ProjectResearchResult,
} from "@/src/domain/project-chat";
import type { JsonValue } from "@/src/domain/types";
import type { Prisma } from "@/src/generated/prisma/client";
import {
  createGenerationRun,
  createGenerationRunIdempotently,
  findSuccessfulGenerationRunReplay,
  generationRunFailureTokenUsage,
  GenerationRunReplayError,
} from "@/src/lib/generation-runs";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";

export const PROJECT_CHAT_MODEL_CHECKPOINT_VERSION = "project-chat-model-checkpoint-v9";

export interface ProjectChatModelControl {
  refreshRequested: boolean;
  refreshReason: string | null;
  artifactBrief: string | null;
}

export interface ProjectChatModelCheckpoint {
  version: typeof PROJECT_CHAT_MODEL_CHECKPOINT_VERSION;
  answer: string;
  catalog: ProjectKnowledgeCitation[];
  entries: ProjectAnswerGroundingEntry[];
  research: ProjectResearchResult | null;
  toolNames: string[];
  control: ProjectChatModelControl;
}

const replayCheckpointSchema = z.object({
  version: z.literal(PROJECT_CHAT_MODEL_CHECKPOINT_VERSION),
  answer: z.string().max(20_000),
  catalog: z.array(z.object({
    kind: z.enum(["highlight", "project_fact", "evidence", "artifact", "github_file"]),
    label: z.string().min(1).max(1_000),
    excerpt: z.string().max(20_000),
  }).passthrough()).max(40),
  entries: z.array(z.object({
    kind: z.string().min(1).max(100),
    authority: z.string().min(1).max(100),
    title: z.string().min(1).max(1_000),
    content: z.string().max(20_000),
    currentRun: z.boolean(),
    citationIndexes: z.array(z.number().int().positive()).max(20),
    supportingSources: z.array(z.unknown()).max(20),
  }).passthrough()).max(100),
  research: z.unknown().nullable(),
  toolNames: z.array(z.string().min(1).max(100)).max(30),
  control: z.object({
    refreshRequested: z.boolean(),
    refreshReason: z.string().max(1_000).nullable(),
    artifactBrief: z.string().max(5_000).nullable(),
  }),
});

interface ExecutedProjectChatModel {
  result: BedrockConverseAgentRunResult;
  checkpoint: Omit<ProjectChatModelCheckpoint, "version" | "answer" | "toolNames">;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseCheckpoint(value: unknown): ProjectChatModelCheckpoint {
  const validated = replayCheckpointSchema.safeParse(value);
  if (!validated.success) {
    throw new GenerationRunReplayError(
      "The project-chat model checkpoint is malformed and cannot be replayed.",
    );
  }
  const parsed = validated.data;
  return {
    version: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
    answer: parsed.answer,
    catalog: parsed.catalog as ProjectKnowledgeCitation[],
    entries: parsed.entries as ProjectAnswerGroundingEntry[],
    research: parsed.research && typeof parsed.research === "object"
      ? parsed.research as ProjectResearchResult
      : null,
    toolNames: parsed.toolNames,
    control: parsed.control,
  };
}

function modelTokenUsage(result: BedrockConverseAgentRunResult): JsonValue {
  const attempts = result.events.flatMap((event) =>
    event.type === "model_call_completed"
      ? [{
          ...event.usage,
          requestId: event.requestId,
          provider: event.provider ?? result.provider ?? null,
          routedProvider: event.routedProvider ?? null,
          modelId: event.modelId ?? result.modelId ?? null,
          costUsd: event.costUsd ?? event.usage.costUsd ?? null,
        }]
      : []
  );
  const failedAttempts = result.events.flatMap((event) =>
    event.type === "model_call_failed"
      ? event.requestIds.map((requestId) => ({
          requestId,
          provider: event.provider,
          modelId: event.modelId,
          status: event.providerStatus,
          code: event.providerCode,
          retryable: event.retryable,
        }))
      : []
  );
  return sanitizeBedrockConverseEventValue({
    attempts,
    failedAttempts,
    providerAttemptCount: attempts.length + failedAttempts.length,
    unknownUsageAttempts: result.usage.unknownUsageAttempts ?? 0,
  });
}

export async function runAuditedProjectChatModel(input: {
  workItemId: string;
  agentRunId: string;
  phase: "initial" | "after_source_refresh" | "after_fact_review";
  attempt: "initial" | "research_1" | "repair_1";
  inputSummary: Record<string, unknown>;
  execute: () => Promise<ExecutedProjectChatModel>;
}) {
  const idempotencyKey = [
    "project-chat-answer",
    input.agentRunId,
    PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
    input.phase,
    input.attempt,
  ].join(":");
  const replay = await findSuccessfulGenerationRunReplay({
    workItemId: input.workItemId,
    idempotencyKey,
    kind: "project_chat_answer",
  });
  if (replay) {
    return {
      checkpoint: parseCheckpoint(replay.parsedOutput),
      generationRunId: replay.id,
      replayed: true,
    };
  }

  const configured = resolveActiveTextModelIdentity("primary_answer");
  try {
    const executed = await input.execute();
    const result = executed.result;
    const toolNames = result.events.flatMap((event) =>
      event.type === "tool_call_completed" ? [event.toolName] : []
    );
    const checkpoint: ProjectChatModelCheckpoint = {
      version: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
      answer: result.text,
      catalog: executed.checkpoint.catalog,
      entries: executed.checkpoint.entries,
      research: executed.checkpoint.research,
      toolNames,
      control: executed.checkpoint.control,
    };
    const generationRun = await createGenerationRunIdempotently({
      workItemId: input.workItemId,
      kind: "project_chat_answer",
      status: "success",
      idempotencyKey,
      provider: result.provider ?? configured.provider,
      modelId: result.modelId ?? configured.modelId,
      inputSummary: json(sanitizeBedrockConverseEventValue({
        ...input.inputSummary,
        profile: "primary_answer",
        attempt: input.attempt,
        phase: input.phase,
        checkpointVersion: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
      })),
      rawOutput: result.text,
      parsedOutput: json(checkpoint),
      resultRefs: sanitizeBedrockConverseEventValue({
        agentRunId: input.agentRunId,
        profile: "primary_answer",
        configuredModelId: configured.modelId,
        requestIds: result.requestIds ?? [],
        routedProviders: result.routedProviders ?? [],
        iterations: result.iterations,
        toolCallCount: result.toolCalls,
        toolNames,
        answerCharacters: result.text.length,
        auditEvidenceTruncated: false,
      }),
      tokenUsage: modelTokenUsage(result),
      estimatedCostUsd: result.reportedCostUsd ?? null,
    });
    return {
      checkpoint,
      generationRunId: generationRun.id,
      replayed: false,
    };
  } catch (error) {
    await createGenerationRun({
      workItemId: input.workItemId,
      kind: "project_chat_answer",
      status: "provider_error",
      provider: configured.provider,
      modelId: configured.modelId,
      inputSummary: json(sanitizeBedrockConverseEventValue({
        ...input.inputSummary,
        profile: "primary_answer",
        attempt: input.attempt,
        phase: input.phase,
        checkpointVersion: PROJECT_CHAT_MODEL_CHECKPOINT_VERSION,
      })),
      validationErrors: sanitizeBedrockConverseEventValue({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Project-chat model failed.",
      }),
      resultRefs: sanitizeBedrockConverseEventValue({
        agentRunId: input.agentRunId,
        profile: "primary_answer",
        configuredModelId: configured.modelId,
      }),
      tokenUsage: generationRunFailureTokenUsage(error),
    }).catch(() => null);
    throw error;
  }
}
