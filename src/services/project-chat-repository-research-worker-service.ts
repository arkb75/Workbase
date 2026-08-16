import { z } from "zod";
import type {
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import {
  BedrockConverseAgentError,
  BedrockConverseLimitError,
  defineBedrockConverseTool,
  type BedrockConverseAgentEvent,
} from "@/src/lib/bedrock-converse-agent";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";
import {
  runAuditedProjectChatModel,
} from "@/src/services/project-chat-model-audit-service";
import {
  repositoryEvidenceTargetUrl,
  type ProjectRepositoryEvidenceSegment,
} from "@/src/services/project-chat-repository-evidence-service";
import {
  ProjectChatRepositoryInspector,
} from "@/src/services/project-chat-repository-inspection-service";
import { createTextConverseAgent } from "@/src/services/bedrock-runtime";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";

export const PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_VERSION =
  "project-chat-repository-research-worker-v1";

export const PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS = {
  // The worker may spend all six tool calls gathering evidence. Keep one
  // additional model turn available so it can write the cited handoff instead
  // of structurally hitting the iteration limit immediately after research.
  maxIterations: 7,
  maxToolCalls: 6,
  maxTotalTokens: 40_000,
} as const;

const repositoryQuerySchema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  args: z.array(z.string().min(1).max(1_000)).min(1).max(40),
});

const repositoryExpansionSchema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  evidenceId: z.string().trim().min(16).max(128),
  startLine: z.number().int().positive(),
  maxLines: z.number().int().min(1).max(120),
});

const workerInspectionSchema = z.object({
  repositoryQueries: z.array(repositoryQuerySchema).max(4),
  repositoryExpansions: z.array(repositoryExpansionSchema).max(2).default([]),
}).superRefine((value, context) => {
  if (!value.repositoryQueries.length && !value.repositoryExpansions.length) {
    context.addIssue({
      code: "custom",
      message: "At least one repository query or evidence expansion is required.",
    });
  }
});

const workerInspectionJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["repositoryQueries", "repositoryExpansions"],
  properties: {
    repositoryQueries: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceId", "args"],
        properties: {
          sourceId: { type: "string", minLength: 1, maxLength: 200 },
          args: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
      },
    },
    repositoryExpansions: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceId", "evidenceId", "startLine", "maxLines"],
        properties: {
          sourceId: { type: "string", minLength: 1, maxLength: 200 },
          evidenceId: { type: "string", minLength: 16, maxLength: 128 },
          startLine: { type: "integer", minimum: 1 },
          maxLines: { type: "integer", minimum: 1, maximum: 120 },
        },
      },
    },
  },
};

function safe(value: string) {
  return redactRepositorySecrets(value).content;
}

function citationKey(citation: ProjectKnowledgeCitation) {
  return [
    citation.kind,
    citation.sourceId,
    citation.repository,
    citation.commitSha,
    citation.contentHash,
  ].join(":");
}

function addSegment(input: {
  segment: ProjectRepositoryEvidenceSegment;
  snapshotUrl: string;
  catalog: ProjectKnowledgeCitation[];
  entries: ProjectAnswerGroundingEntry[];
}) {
  const segment = input.segment;
  const label = safe(
    `${segment.repository} — ${segment.command} — output lines ${segment.startLine}-${segment.endLine}`,
  ).slice(0, 1_000);
  const citation: ProjectKnowledgeCitation = {
    kind: "evidence",
    label,
    excerpt: safe(segment.excerpt),
    sourceId: segment.sourceId,
    repository: segment.repository,
    commitSha: segment.commitSha,
    url: repositoryEvidenceTargetUrl(segment.repository, segment.target) ?? undefined,
    contentHash: segment.excerptHash,
    evidenceHandle: segment.evidenceId,
    evidenceArchiveVersion: segment.version,
    evidenceTarget: segment.target,
    repositorySnapshotUrl: input.snapshotUrl,
    sourceOutputHash: segment.outputHash,
    sourceOutputBytes: segment.totalBytes,
    sourceCommand: segment.command,
    sourceStartLine: segment.startLine,
    sourceEndLine: segment.endLine,
    sourceTotalLines: segment.totalLines,
    truncated: segment.truncated,
  };
  const key = citationKey(citation);
  let citationIndex = input.catalog.findIndex((candidate) =>
    citationKey(candidate) === key
  ) + 1;
  if (!citationIndex) {
    input.catalog.push(citation);
    citationIndex = input.catalog.length;
  }
  if (!input.entries.some((entry) =>
    entry.citationIndexes.length === 1 && entry.citationIndexes[0] === citationIndex
  )) {
    input.entries.push({
      kind: "tool_authority",
      authority: "included_evidence",
      title: label,
      content: citation.excerpt,
      currentRun: true,
      citationIndexes: [citationIndex],
      ownershipAuthority: 0,
      supportingSources: [],
    });
  }
  return {
    evidenceId: segment.evidenceId,
    segmentId: segment.segmentId,
    citationIndex,
    command: segment.command,
    excerpt: citation.excerpt,
    outputLines: {
      start: segment.startLine,
      end: segment.endLine,
      total: segment.totalLines,
    },
    truncated: segment.truncated,
  };
}

function fallbackSummary(entries: ProjectAnswerGroundingEntry[]) {
  if (!entries.length) {
    return "No citable repository evidence was established for the delegated objective.";
  }
  return entries.slice(0, 8).map((entry) => {
    const excerpt = entry.content.replace(/\s+/g, " ").trim().slice(0, 400);
    const citations = entry.citationIndexes.map((index) => `[citation:${index}]`).join("");
    return `- ${entry.title}: ${excerpt} ${citations}`.trim();
  }).join("\n");
}

export interface ProjectChatRepositoryResearchWorkerResult {
  summary: string;
  catalog: ProjectKnowledgeCitation[];
  entries: ProjectAnswerGroundingEntry[];
  generationRunId: string | null;
  partial: boolean;
}

export async function runProjectChatRepositoryResearchWorker(input: {
  runId: string;
  workItemId: string;
  phase: "initial" | "after_source_refresh" | "after_fact_review";
  objective: string;
  sourceIds: string[];
  repositoryInspector: ProjectChatRepositoryInspector;
  onAgentEvent?: (event: BedrockConverseAgentEvent) => void | Promise<void>;
}): Promise<ProjectChatRepositoryResearchWorkerResult> {
  const allowedSourceIds = new Set(input.sourceIds);
  const catalog: ProjectKnowledgeCitation[] = [];
  const entries: ProjectAnswerGroundingEntry[] = [];
  const tools = [defineBedrockConverseTool({
    name: "inspect_repository_snapshot",
    description:
      "Run bounded read-only Git queries against the authorized immutable repository snapshots, or expand a previously returned evidence handle. Use ordinary Git argument arrays only—no shell syntax, pipes, redirects, host paths, network commands, or mutation commands. Results are exact bounded excerpts; full redacted output remains outside your context.",
    inputSchema: workerInspectionSchema,
    jsonSchema: workerInspectionJsonSchema,
    strict: true,
    execute: async ({ repositoryQueries, repositoryExpansions }) => {
      if (
        repositoryQueries.some((query) => !allowedSourceIds.has(query.sourceId)) ||
        repositoryExpansions.some((request) => !allowedSourceIds.has(request.sourceId))
      ) {
        return {
          status: "rejected",
          code: "source_not_authorized",
          instruction: "Use only the repository source IDs supplied with this objective.",
        };
      }
      const queriesBySource = new Map<string, Array<{ args: string[] }>>();
      for (const query of repositoryQueries) {
        const queries = queriesBySource.get(query.sourceId) ?? [];
        queries.push({ args: query.args });
        queriesBySource.set(query.sourceId, queries);
      }
      const expansionsBySource = new Map<
        string,
        Array<{ evidenceId: string; startLine: number; maxLines: number }>
      >();
      for (const request of repositoryExpansions) {
        const requests = expansionsBySource.get(request.sourceId) ?? [];
        requests.push({
          evidenceId: request.evidenceId,
          startLine: request.startLine,
          maxLines: request.maxLines,
        });
        expansionsBySource.set(request.sourceId, requests);
      }
      const sourceIds = new Set([
        ...queriesBySource.keys(),
        ...expansionsBySource.keys(),
      ]);
      const repositories = [];
      for (const sourceId of sourceIds) {
        const inspection = await input.repositoryInspector.inspect({
          sourceId,
          objective: input.objective,
          queries: queriesBySource.get(sourceId) ?? [],
          expansions: expansionsBySource.get(sourceId) ?? [],
        });
        if (inspection.status !== "completed") {
          repositories.push(inspection);
          continue;
        }
        repositories.push({
          status: inspection.status,
          snapshot: inspection.snapshot,
          results: inspection.results.map((result) =>
            result.status === "success"
              ? {
                  args: result.args,
                  status: result.status,
                  evidenceId: result.evidenceId,
                  totalBytes: result.totalBytes,
                  totalLines: result.totalLines,
                  truncated: result.truncated,
                  evidence: result.segments.map((segment) => addSegment({
                    segment,
                    snapshotUrl: inspection.snapshot.commitUrl,
                    catalog,
                    entries,
                  })),
                }
              : result
          ),
          expansions: inspection.expansions.map((expansion) =>
            expansion.status === "success"
              ? {
                  evidenceId: expansion.evidenceId,
                  status: expansion.status,
                  evidence: addSegment({
                    segment: expansion.segment,
                    snapshotUrl: inspection.snapshot.commitUrl,
                    catalog,
                    entries,
                  }),
                }
              : expansion
          ),
          remainingQueryBudget: inspection.remainingQueryBudget,
        });
      }
      return {
        status: "completed",
        repositories,
        instruction:
          "Continue only if a material relationship in the delegated objective remains unsupported. Otherwise write the evidence handoff now.",
      };
    },
  })];

  const agent = createTextConverseAgent({
    profile: "primary_answer",
    defaultLimits: PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_LIMITS,
  });
  try {
    const audited = await runAuditedProjectChatModel({
      workItemId: input.workItemId,
      agentRunId: input.runId,
      phase: input.phase,
      attempt: "repository_research_1",
      inputSummary: {
        workerVersion: PROJECT_CHAT_REPOSITORY_RESEARCH_WORKER_VERSION,
        objectiveCharacters: input.objective.length,
        sourceCount: input.sourceIds.length,
        availableToolNames: tools.map((tool) => tool.name),
      },
      execute: async () => {
        const result = await agent.run({
          systemPrompt: [
            "You are one isolated repository-research worker supporting a separate answer model.",
            "Investigate only the delegated objective. Use the one repository-inspection capability adaptively for current files, configuration, diffs, history, blame, contributors, merges, tags, or relationships as required.",
            "Prefer concise scoped Git arguments. Stop when the evidence establishes the requested relationships; do not inventory the repository or repeat a completed query.",
            "Every factual handoff claim must cite one or more returned source ordinals using [citation:N]. State unresolved gaps precisely.",
            "Return a compact evidence handoff, not a user-facing answer, plan, tool trace, or raw output dump.",
          ].join(" "),
          messages: [{
            role: "user",
            content: [{
              text: safe(JSON.stringify({
                objective: input.objective,
                authorizedRepositories: input.repositoryInspector.summaries()
                  .filter((summary) => allowedSourceIds.has(summary.sourceId)),
              })),
            }],
          }],
          tools,
          maxTokens: 3_000,
          temperature: 0,
          effort: "medium",
          enablePromptCaching: true,
          onEvent: input.onAgentEvent,
        });
        return {
          result,
          checkpoint: {
            catalog,
            entries,
            research: null,
            repositoryResearchUsed: true,
            supportingGenerationRunIds: [],
            control: {
              refreshRequested: false,
              refreshReason: null,
              artifactBrief: null,
            },
          },
        };
      },
    });
    return {
      summary: audited.checkpoint.answer,
      catalog: audited.checkpoint.catalog,
      entries: audited.checkpoint.entries,
      generationRunId: audited.generationRunId,
      partial: false,
    };
  } catch (error) {
    if (!(error instanceof BedrockConverseAgentError)) throw error;
    if (!(error instanceof BedrockConverseLimitError) && !entries.length) throw error;
    return {
      summary: fallbackSummary(entries),
      catalog,
      entries,
      generationRunId: null,
      partial: true,
    };
  }
}
