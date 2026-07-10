import type { BedrockConverseAgentEvent } from "@/src/lib/bedrock-converse-agent";
import { appendAgentRunEvent } from "@/src/services/project-chat-store";

export async function persistResearchAgentEvent(
  runId: string,
  event: BedrockConverseAgentEvent,
) {
  if (event.type === "tool_call_started") {
    await appendAgentRunEvent({
      runId,
      type: "tool_call",
      toolName: event.toolName,
      message:
        event.toolName === "read_repository_file"
          ? "Reading a pinned repository excerpt."
          : event.toolName === "search_repository"
            ? "Searching an attached repository."
            : "Inspecting safe repository paths.",
      payload: {
        iteration: event.iteration,
        toolCall: event.toolCall,
        toolUseId: event.toolUseId,
      },
    });
    return;
  }

  if (event.type === "tool_call_completed") {
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
        : "Project evidence review completed.",
    payload:
      event.type === "model_call_completed"
        ? {
            iteration: event.iteration,
            stopReason: event.stopReason,
            usage: event.usage,
          }
        : { iteration: event.iteration },
    isUserVisible: false,
  });
}
