import { Prisma } from "@/src/generated/prisma/client";
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

interface PriorTurnProvenanceRow {
  messageId: string;
  knowledgeRefreshRunId: string | null;
  result: unknown;
  researchState: unknown;
  environmentSnapshot: unknown;
  candidatePartial: boolean;
  toolCallCounts: unknown;
  usedSources: unknown;
}

function readToolCallCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Map<string, number>();
  }
  return new Map(
    Object.entries(value as Record<string, unknown>).flatMap(([name, count]) =>
      typeof count === "number" && Number.isFinite(count) && count > 0
        ? [[name, Math.floor(count)] as const]
        : []
    ),
  );
}

function readUsedSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const record = source as Record<string, unknown>;
    return typeof record.kind === "string" && typeof record.title === "string"
      ? [{ kind: record.kind, title: record.title }]
      : [];
  });
}

export const priorTurnProvenanceService: PriorTurnProvenanceService = {
  async inspect(input) {
    // Prisma's nested relation include issues a separate query for the
    // message, citations, run, events, and candidates. This command is a
    // latency-sensitive control-plane read, so aggregate the same sanitized
    // metadata and its compact tool audit in one authorized SQL round trip.
    // No source excerpts or file contents are selected.
    const assistantMessageFilter = input.assistantMessageId
      ? Prisma.sql`AND message."id" = ${input.assistantMessageId}`
      : Prisma.empty;
    const rows = await prisma.$queryRaw<PriorTurnProvenanceRow[]>(Prisma.sql`
      WITH provenance AS (
        SELECT
          message."id" AS "messageId",
          run."knowledgeRefreshRunId" AS "knowledgeRefreshRunId",
          run."result" AS "result",
          run."researchState" AS "researchState",
          run."environmentSnapshot" AS "environmentSnapshot",
          EXISTS (
            SELECT 1
            FROM "AgentRunCandidate" candidate
            WHERE candidate."agentRunId" = run."id"
              AND candidate."snapshot" @> '{"partial": true}'::jsonb
          ) AS "candidatePartial",
          COALESCE((
            SELECT jsonb_object_agg(grouped."toolName", grouped."callCount")
            FROM (
              SELECT event."toolName", COUNT(*)::int AS "callCount"
              FROM "AgentRunEvent" event
              WHERE event."agentRunId" = run."id"
                AND event."type" = 'tool_call'
                AND event."toolName" IS NOT NULL
              GROUP BY event."toolName"
            ) grouped
          ), '{}'::jsonb) AS "toolCallCounts",
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'kind', citation."kind"::text,
                'title', citation."label"
              )
              ORDER BY citation."ordinal" ASC
            )
            FROM "ChatCitation" citation
            WHERE citation."messageId" = message."id"
          ), '[]'::jsonb) AS "usedSources"
        FROM "ChatMessage" message
        JOIN "ChatThread" thread ON thread."id" = message."threadId"
        LEFT JOIN "AgentRun" run ON run."id" = message."agentRunId"
        WHERE message."threadId" = ${input.threadId}
          AND message."role" = 'assistant'
          AND thread."userId" = ${input.userId}
          AND thread."workItemId" = ${input.workItemId}
          ${assistantMessageFilter}
        ORDER BY message."sequence" DESC
        LIMIT 1
      ),
      audit_run AS (
        SELECT current_run."id"
        FROM "AgentRun" current_run
        WHERE current_run."id" = ${input.auditRunId ?? ""}
          AND current_run."userId" = ${input.userId}
          AND current_run."workItemId" = ${input.workItemId}
          AND current_run."threadId" = ${input.threadId}
          AND current_run."status" NOT IN ('completed', 'insufficient_context', 'failed', 'cancelled')
        FOR UPDATE
      ),
      audit_event AS (
        INSERT INTO "AgentRunEvent" (
          "id",
          "agentRunId",
          "sequence",
          "type",
          "message",
          "toolName",
          "payload",
          "isUserVisible",
          "createdAt"
        )
        SELECT
          CONCAT('prov_', md5(audit_run."id" || ':' || provenance."messageId" || ':' || clock_timestamp()::text)),
          audit_run."id",
          COALESCE((
            SELECT MAX(existing_event."sequence") + 1
            FROM "AgentRunEvent" existing_event
            WHERE existing_event."agentRunId" = audit_run."id"
          ), 1),
          'tool_call',
          NULL,
          'inspect_prior_turn_provenance',
          jsonb_build_object(
            'assistantMessageId', provenance."messageId",
            'completed', true
          ),
          false,
          NOW()
        FROM audit_run
        CROSS JOIN provenance
        RETURNING "id"
      )
      SELECT provenance.*
      FROM provenance
      LEFT JOIN (SELECT COUNT(*) AS count FROM audit_event) persisted_audit ON true
    `);
    const message = rows[0];
    if (!message) {
      throw new Error("The requested prior assistant message was not found.");
    }
    const counts = readToolCallCounts(message.toolCallCounts);
    const result = message.result;
    const researchState = message.researchState;
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
    const manifestIntent = readRecord(message.environmentSnapshot, "intent");
    const researchPhase = researchState && typeof researchState === "object" && !Array.isArray(researchState)
      ? (researchState as Record<string, unknown>).phase
      : null;
    const researchKind = researchState && typeof researchState === "object" && !Array.isArray(researchState)
      ? (researchState as Record<string, unknown>).kind
      : null;
    const knowledgeRefresh =
      researchKind === "repository_knowledge_refresh" ||
      Boolean(message.knowledgeRefreshRunId);
    const targetedResearch =
      manifestIntent?.kind === "repository_research" ||
      (typeof researchPhase === "string" && researchKind !== "repository_knowledge_refresh") ||
      toolNames.some((name) =>
        [
          "research_project",
          "list_repository_paths",
          "search_repository",
          "read_repository_file",
          "read_repository_files",
        ].includes(name)
      );
    const repositoryActivity =
      knowledgeRefresh && targetedResearch
        ? "knowledge_refresh_and_targeted_research"
        : knowledgeRefresh
          ? "knowledge_refresh"
          : targetedResearch
            ? "targeted_research"
            : "none";

    return {
      messageId: message.messageId,
      repositoryInspected: repositoryActivity !== "none",
      repositoryActivity,
      partial:
        readBoolean(result, "partial") ||
        readBoolean(researchState, "partial") ||
        message.candidatePartial,
      fallbackUsed: readBoolean(result, "fallbackUsed"),
      toolCalls: Array.from(counts, ([name, count]) => ({ name, count })),
      usedSources: readUsedSources(message.usedSources),
    };
  },
};
