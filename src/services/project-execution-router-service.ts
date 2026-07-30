import { z } from "zod";
import type { ProjectKnowledgeHit } from "@/src/domain/project-chat";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
import type { ProjectTurnIntent } from "@/src/services/project-agent-harness";
import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";

export const PROJECT_EXECUTION_ROUTER_VERSION = "project-execution-router-v2";

export const routingSchema = z.object({
  mode: z.enum(["memory_only", "targeted_repository_research", "repository_refresh", "clarification", "insufficient_context"]),
  confidence: z.number().min(0).max(1),
  breadth: z.enum(["targeted", "broad", "exhaustive"]),
  rationaleCodes: z.array(z.string().trim().min(2).max(100)),
  objectives: z.array(z.string().trim().min(2).max(500)),
  suggestedWorkerCount: z.number().int().min(0).max(4),
  suggestedCapabilityKeys: z.array(z.string().trim().min(2).max(100)),
});

export const routingJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "confidence", "breadth", "rationaleCodes", "objectives", "suggestedWorkerCount", "suggestedCapabilityKeys"],
  properties: {
    mode: { type: "string", enum: ["memory_only", "targeted_repository_research", "repository_refresh", "clarification", "insufficient_context"] },
    confidence: { type: "number" },
    breadth: { type: "string", enum: ["targeted", "broad", "exhaustive"] },
    rationaleCodes: { type: "array", items: { type: "string", minLength: 2, maxLength: 100 } },
    objectives: { type: "array", items: { type: "string", minLength: 2, maxLength: 500 } },
    suggestedWorkerCount: { type: "integer" },
    suggestedCapabilityKeys: { type: "array", items: { type: "string", minLength: 2, maxLength: 100 } },
  },
};

export type ExecutionRoutingDecision = z.infer<typeof routingSchema> & {
  routerVersion: string;
  generationRunId: string | null;
  fallbackUsed: boolean;
};

export function deterministicExecutionDecision(intent: ProjectTurnIntent, repositoryCount: number): ExecutionRoutingDecision {
  const research = intent.kind === "repository_research";
  const mode = !repositoryCount && research
    ? "insufficient_context"
    : research && intent.freshness === "required"
      ? "repository_refresh"
      : research
        ? "targeted_repository_research"
        : intent.kind === "clarification"
          ? "clarification"
          : "memory_only";
  return {
    mode,
    confidence: intent.confidence,
    breadth: intent.coverage === "bounded_comprehensive" ? "exhaustive" : intent.coverage === "broad_synthesis" ? "broad" : "targeted",
    rationaleCodes: [intent.reason.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 100)],
    objectives: [intent.deliverable],
    suggestedWorkerCount: mode === "repository_refresh" ? 4 : mode === "targeted_repository_research" ? 1 : 0,
    suggestedCapabilityKeys: [],
    routerVersion: PROJECT_EXECUTION_ROUTER_VERSION,
    generationRunId: null,
    fallbackUsed: true,
  };
}

export function shouldUseModelExecutionRouter(input: {
  deterministicIntent: ProjectTurnIntent;
  mode?: string;
}) {
  const mode = input.mode ?? process.env.WORKBASE_EXECUTION_ROUTER_MODE ?? "hybrid";
  if (mode === "deterministic") return false;
  if (mode === "model") return true;
  // Deterministic routing is the safety and cost envelope. The model is useful
  // only when confidence is genuinely ambiguous; paying for it on explicit
  // freshness, provenance, artifact, or ordinary high-authority memory paths
  // adds latency without changing the authorized action.
  return input.deterministicIntent.confidence < 0.9;
}

export function enforceExecutionRoutingSafety(input: {
  deterministic: ExecutionRoutingDecision;
  model: z.infer<typeof routingSchema>;
  repositoryCount: number;
}): ExecutionRoutingDecision {
  const fallback = input.deterministic;
  const model = input.model;
  const researchModes = new Set(["targeted_repository_research", "repository_refresh"]);
  if (!input.repositoryCount && fallback.mode === "insufficient_context") return fallback;
  if (!input.repositoryCount && researchModes.has(model.mode)) return fallback;
  if (fallback.mode === "repository_refresh" && model.mode !== "repository_refresh") return fallback;
  if (fallback.mode === "targeted_repository_research" && !researchModes.has(model.mode)) return fallback;
  const breadthRank = { targeted: 0, broad: 1, exhaustive: 2 } as const;
  if (breadthRank[model.breadth] < breadthRank[fallback.breadth]) return fallback;
  return {
    ...model,
    suggestedWorkerCount: Math.min(4, model.suggestedWorkerCount),
    routerVersion: PROJECT_EXECUTION_ROUTER_VERSION,
    generationRunId: null,
    fallbackUsed: false,
  };
}

export async function routeProjectExecution(input: {
  runId: string;
  userId: string;
  workItemId: string;
  question: string;
  deterministicIntent: ProjectTurnIntent;
  memoryHits: ProjectKnowledgeHit[];
  repositories: Array<{ name: string; pinnedSha?: string | null }>;
  coverageState?: unknown;
}) {
  const fallback = deterministicExecutionDecision(input.deterministicIntent, input.repositories.length);
  if (["artifact_request", "candidate_review", "prior_turn_provenance"].includes(input.deterministicIntent.kind)) return fallback;
  const mode = process.env.WORKBASE_EXECUTION_ROUTER_MODE ?? "hybrid";
  if (
    resolveWorkbaseLlmProvider() === "mock" ||
    !shouldUseModelExecutionRouter({ deterministicIntent: input.deterministicIntent, mode })
  ) return fallback;
  try {
    const result = await runAuditedStructuredGeneration({
      workItemId: input.workItemId,
      agentRunId: input.runId,
      kind: "execution_routing",
      profile: "routing",
      idempotencyKey: `execution-route:${input.runId}:${PROJECT_EXECUTION_ROUTER_VERSION}`,
      inputSummary: {
        question: input.question.slice(0, 1_000),
        deterministicIntent: input.deterministicIntent,
        memoryHitCount: input.memoryHits.length,
        repositoryCount: input.repositories.length,
      },
      execute: () => getStructuredLlmClient("routing").generateStructured({
        systemPrompt: [
          "You route one Workbase project-chat request within a deterministic safety and budget envelope.",
          "Choose memory when approved current memory is sufficient; targeted research for a bounded code question; refresh for broad or explicitly current repository assessment.",
          "Repository availability, authorization, and hard limits are authoritative. Do not invent tools or repositories.",
          "Use up to four workers only when independent capability areas justify parallel research.",
        ].join(" "),
        userPrompt: JSON.stringify({
          request: input.question,
          deterministicIntent: input.deterministicIntent,
          memory: input.memoryHits.slice(0, 20).map((hit) => ({ kind: hit.kind, authority: hit.authority, title: hit.title, subsystemKey: hit.subsystemKey, validatedThroughSha: hit.validatedThroughSha })),
          repositories: input.repositories,
          coverageState: input.coverageState ?? null,
          availableModes: input.repositories.length
            ? ["memory_only", "targeted_repository_research", "repository_refresh", "clarification", "insufficient_context"]
            : ["memory_only", "clarification", "insufficient_context"],
          maxWorkers: 4,
          maxTotalTokens: 160_000,
        }),
        schema: routingSchema,
        schemaName: "project_execution_route",
        schemaDescription: "A bounded execution route for one project-chat request.",
        jsonSchema: routingJsonSchema,
        maxTokens: 2_000,
        temperature: 0,
        effort: "medium",
        repairStrategy: "repair_last_failure",
        extraValidation: (value) => {
          const errors: string[] = [];
          if (!input.repositories.length && ["targeted_repository_research", "repository_refresh"].includes(value.mode)) errors.push("Repository research is unavailable.");
          if (value.suggestedWorkerCount > 4) errors.push("The route exceeds the worker limit.");
          if (value.mode === "memory_only" && !input.memoryHits.some((hit) => ["verified_highlight", "verified_project_fact", "included_evidence"].includes(hit.authority))) errors.push("Memory-only requires high-authority project memory.");
          return errors;
        },
      }),
    });
    const decision = enforceExecutionRoutingSafety({
      deterministic: fallback,
      model: result.data,
      repositoryCount: input.repositories.length,
    });
    const auditedDecision = decision.fallbackUsed
      ? decision
      : { ...decision, generationRunId: result.generationRunId };
    return mode === "shadow" ? { ...fallback, shadowDecision: auditedDecision } : auditedDecision;
  } catch {
    return fallback;
  }
}

export const projectExecutionRouterService = { route: routeProjectExecution };
