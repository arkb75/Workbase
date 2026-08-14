import type { BedrockConverseAgentEvent } from "@/src/lib/bedrock-converse-agent";
import { appendAgentRunEvent } from "@/src/services/project-chat-store";

export async function persistResearchAgentEvent(
  runId: string,
  event: BedrockConverseAgentEvent,
) {
  if (event.type === "tool_call_started") {
    const toolInput = event.input && typeof event.input === "object" &&
        !Array.isArray(event.input)
      ? event.input as Record<string, unknown>
      : {};
    const inspectionModes = event.toolName === "inspect_project"
      ? [
          ...(Array.isArray(toolInput.knowledgeQueries) &&
          toolInput.knowledgeQueries.length
            ? ["knowledge"]
            : []),
          ...(Array.isArray(toolInput.repositoryQueries) &&
          toolInput.repositoryQueries.length
            ? ["repository"]
            : []),
        ]
      : [];
    await appendAgentRunEvent({
      runId,
      type: "tool_call",
      toolName: event.toolName,
      message:
        event.toolName === "inspect_project" && inspectionModes.length === 2
          ? "Inspecting project knowledge and the pinned repository."
          : event.toolName === "inspect_project" && inspectionModes.includes("repository")
            ? "Inspecting the pinned repository."
            : event.toolName === "inspect_project"
              ? "Searching project knowledge."
              : event.toolName === "read_repository_file" || event.toolName === "read_repository_files"
          ? "Reading pinned repository excerpts."
          : event.toolName === "search_repository"
            ? "Searching an attached repository."
            : "Inspecting safe repository paths.",
      payload: {
        iteration: event.iteration,
        toolCall: event.toolCall,
        toolUseId: event.toolUseId,
        ...(inspectionModes.length ? { inspectionModes } : {}),
      },
    });
    return;
  }

  if (event.type === "tool_call_completed") {
    const errorCode =
      event.output &&
      typeof event.output === "object" &&
      !Array.isArray(event.output) &&
      "error" in event.output &&
      event.output.error &&
      typeof event.output.error === "object" &&
      !Array.isArray(event.output.error) &&
      "code" in event.output.error
        ? String(event.output.error.code)
        : null;
    await appendAgentRunEvent({
      runId,
      type: "tool_result",
      toolName: event.toolName,
      message: `${event.toolName.replace(/_/g, " ")} completed.`,
      payload: {
        iteration: event.iteration,
        toolCall: event.toolCall,
        toolUseId: event.toolUseId,
        outcome: event.outcome,
        ...(errorCode ? { errorCode } : {}),
        durationMs: event.durationMs,
      },
    });
    return;
  }

  await appendAgentRunEvent({
    runId,
    type: "progress",
    message:
      event.type === "model_call_started"
        ? "Reviewing the available project evidence."
        : event.type === "model_call_failed"
          ? "The model provider did not complete evidence review."
        : "Project evidence review completed.",
    payload:
      event.type === "model_call_completed"
        ? {
            modelEvent: event.type,
            iteration: event.iteration,
            stopReason: event.stopReason,
            durationMs: event.durationMs,
            requestId: event.requestId,
            provider: event.provider ?? null,
            routedProvider: event.routedProvider ?? null,
            modelId: event.modelId ?? null,
            profile: event.profile ?? null,
            costUsd: event.costUsd ?? null,
            usage: event.usage,
            aggregateUsage: event.aggregateUsage,
          }
        : event.type === "model_call_failed"
          ? {
              modelEvent: event.type,
              iteration: event.iteration,
              durationMs: event.durationMs,
              provider: event.provider,
              modelId: event.modelId,
              profile: event.profile ?? null,
              requestIds: event.requestIds,
              routedProviders: event.routedProviders,
              providerStatus: event.providerStatus,
              retryable: event.retryable,
              providerCode: event.providerCode,
              usage: event.usage,
              aggregateUsage: event.aggregateUsage,
            }
        : {
            modelEvent: event.type,
            iteration: event.iteration,
            profile: event.profile ?? null,
          },
    isUserVisible: false,
  });
}
