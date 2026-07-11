import { prisma } from "@/src/lib/prisma";
import type { PriorTurnProvenanceService } from "@/src/services/types";

function readBoolean(value: unknown, key: string) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[key] === true,
  );
}

function readRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

export const priorTurnProvenanceService: PriorTurnProvenanceService = {
  async inspect(input) {
    const message = await prisma.chatMessage.findFirstOrThrow({
      where: {
        ...(input.assistantMessageId ? { id: input.assistantMessageId } : {}),
        role: "assistant",
        threadId: input.threadId,
        thread: {
          userId: input.userId,
          workItemId: input.workItemId,
        },
      },
      orderBy: input.assistantMessageId ? undefined : { sequence: "desc" },
      include: {
        citations: { orderBy: { ordinal: "asc" } },
        agentRun: {
          select: {
            result: true,
            researchState: true,
            environmentSnapshot: true,
            events: {
              where: { type: "tool_call" },
              orderBy: { sequence: "asc" },
            },
            candidates: { select: { snapshot: true } },
          },
        },
      },
    });
    const counts = new Map<string, number>();
    for (const event of message.agentRun?.events ?? []) {
      if (!event.toolName) continue;
      counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + 1);
    }
    const result = message.agentRun?.result;
    const researchState = message.agentRun?.researchState;
    const usage = readRecord(researchState, "usage");
    const treeLookups = typeof usage?.treeLookups === "number" ? usage.treeLookups : 0;
    const searches = typeof usage?.searches === "number" ? usage.searches : 0;
    const fileReads = typeof usage?.fileReads === "number" ? usage.fileReads : 0;
    if (treeLookups && !counts.has("list_repository_paths")) counts.set("list_repository_paths", treeLookups);
    if (searches && !counts.has("search_repository")) counts.set("search_repository", searches);
    if (fileReads && !counts.has("read_repository_file") && !counts.has("read_repository_files")) {
      counts.set("read_repository_file", fileReads);
    }
    const toolNames = Array.from(counts.keys());
    const manifestIntent = readRecord(message.agentRun?.environmentSnapshot, "intent");
    const researchPhase = researchState && typeof researchState === "object" && !Array.isArray(researchState)
      ? (researchState as Record<string, unknown>).phase
      : null;

    return {
      messageId: message.id,
      repositoryInspected:
        manifestIntent?.kind === "repository_research" ||
        typeof researchPhase === "string" ||
        toolNames.some((name) => ["research_project", "list_repository_paths", "search_repository", "read_repository_file", "read_repository_files"].includes(name)),
      partial:
        readBoolean(result, "partial") ||
        readBoolean(researchState, "partial") ||
        (message.agentRun?.candidates ?? []).some((candidate) => readBoolean(candidate.snapshot, "partial")),
      fallbackUsed: readBoolean(result, "fallbackUsed"),
      toolCalls: Array.from(counts, ([name, count]) => ({ name, count })),
      usedSources: message.citations.map((citation) => ({
        kind: citation.kind,
        title: citation.label,
      })),
    };
  },
};
