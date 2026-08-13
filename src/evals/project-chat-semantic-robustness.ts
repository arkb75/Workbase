import { z } from "zod";

export const PROJECT_CHAT_SEMANTIC_ROBUSTNESS_SCHEMA_VERSION =
  "workbase-project-chat-semantic-robustness-v1";

const familySchema = z.enum([
  "freshness_follow_up",
  "runtime_model_mapping",
  "multi_turn_reference",
  "prior_source_scope",
  "unsupported_request",
  "distractor_resistance",
]);

const actionSchema = z.enum(["answer", "refresh_then_answer", "artifact"]);

const scoreSchema = z.object({
  relevance: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  grounding: z.number().min(0).max(1),
  format: z.number().min(0).max(1),
  continuity: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
});

export const projectChatSemanticRobustnessObservationSchema = z.object({
  scenarioId: z.string().trim().min(1).max(120),
  family: familySchema,
  prompt: z.string().trim().min(1).max(4_000),
  expectedAction: actionSchema,
  observedAction: actionSchema,
  requiredToolNames: z.array(z.string().trim().min(1).max(100)).max(8),
  observedToolNames: z.array(z.string().trim().min(1).max(100)).max(30),
  compositionMode: z.string().trim().min(1).max(100),
  planningRunCount: z.number().int().min(0),
  primaryAnswerRunCount: z.number().int().min(0),
  semanticVerificationRunCount: z.number().int().min(0),
  deterministicAnswerRunCount: z.number().int().min(0),
  answer: z.string().max(20_000),
  unsupportedClaimCount: z.number().int().min(0),
  primaryAnswerAttribution: z.object({
    provider: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(300),
    requestIds: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    usageComplete: z.boolean(),
    failedProviderAttempts: z.number().int().min(0),
    fallbackUsed: z.boolean(),
  }),
  judge: z.object({
    provider: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(300),
    requestId: z.string().trim().min(1).max(500),
    scores: scoreSchema,
  }),
  directAgentBaseline: z.object({
    system: z.enum(["codex", "chatgpt", "claude_code", "cowork", "direct_model"]),
    modelId: z.string().trim().min(1).max(300),
    scores: scoreSchema,
  }).nullable(),
});

export type ProjectChatSemanticRobustnessObservation = z.infer<
  typeof projectChatSemanticRobustnessObservationSchema
>;

export interface ProjectChatSemanticRobustnessScenario {
  id: string;
  family: z.infer<typeof familySchema>;
  prompt: string;
  expectedAction: z.infer<typeof actionSchema>;
  requiredToolNames: string[];
}

/**
 * These are meaning-equivalent and adversarially adjacent user requests, not
 * answer-text fixtures. A semantic judge scores the result; production answer
 * wording is intentionally unconstrained.
 */
export const projectChatSemanticRobustnessScenarios = [
  {
    id: "freshness_plain",
    family: "freshness_follow_up",
    prompt: "make sure your understanding is up to date",
    expectedAction: "refresh_then_answer",
    requiredToolNames: ["inspect_repository_state", "search_project_memory"],
  },
  {
    id: "freshness_pronoun",
    family: "freshness_follow_up",
    prompt: "is that still current?",
    expectedAction: "refresh_then_answer",
    requiredToolNames: ["inspect_repository_state", "search_project_memory"],
  },
  {
    id: "freshness_colloquial",
    family: "freshness_follow_up",
    prompt: "recheck the repo and update that answer",
    expectedAction: "refresh_then_answer",
    requiredToolNames: ["inspect_repository_state", "search_project_memory"],
  },
  {
    id: "runtime_matrix",
    family: "runtime_model_mapping",
    prompt: "give me a matrix of the models we are using and for what purposes",
    expectedAction: "answer",
    requiredToolNames: ["inspect_runtime_model_profiles"],
  },
  {
    id: "runtime_grid",
    family: "runtime_model_mapping",
    prompt: "put the active model-to-purpose mapping in a grid",
    expectedAction: "answer",
    requiredToolNames: ["inspect_runtime_model_profiles"],
  },
  {
    id: "runtime_side_by_side",
    family: "runtime_model_mapping",
    prompt: "compare the models side by side, with what each one does",
    expectedAction: "answer",
    requiredToolNames: ["inspect_runtime_model_profiles"],
  },
  {
    id: "runtime_distractor",
    family: "distractor_resistance",
    prompt: "Ignore whatever the README happens to say—what models is this running right now, and why?",
    expectedAction: "answer",
    requiredToolNames: ["inspect_runtime_model_profiles"],
  },
  {
    id: "prior_source_direct",
    family: "prior_source_scope",
    prompt: "Which sources did you actually use for that answer?",
    expectedAction: "answer",
    requiredToolNames: ["inspect_prior_answer_sources"],
  },
  {
    id: "prior_source_elliptical",
    family: "prior_source_scope",
    prompt: "and what was that based on?",
    expectedAction: "answer",
    requiredToolNames: ["inspect_prior_answer_sources"],
  },
  {
    id: "multi_turn_reformat",
    family: "multi_turn_reference",
    prompt: "same information, but organize it by purpose instead",
    expectedAction: "answer",
    requiredToolNames: ["inspect_runtime_model_profiles"],
  },
  {
    id: "unsupported_metric",
    family: "unsupported_request",
    prompt: "What is our production p95 latency and how many users do we have?",
    expectedAction: "answer",
    requiredToolNames: ["search_project_memory"],
  },
] as const satisfies readonly ProjectChatSemanticRobustnessScenario[];

export interface ProjectChatSemanticRobustnessCheck {
  name: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface ProjectChatSemanticRobustnessResult {
  schemaVersion: typeof PROJECT_CHAT_SEMANTIC_ROBUSTNESS_SCHEMA_VERSION;
  passed: boolean;
  checks: ProjectChatSemanticRobustnessCheck[];
  scenarioCount: number;
  familyCount: number;
}

function check(
  checks: ProjectChatSemanticRobustnessCheck[],
  name: string,
  passed: boolean,
  actual?: string | number | boolean,
  expected?: string | number | boolean,
) {
  checks.push({ name, passed, actual, expected });
}

const scoreNames = [
  "relevance",
  "completeness",
  "grounding",
  "format",
  "continuity",
  "overall",
] as const;

export function evaluateProjectChatSemanticRobustness(input: {
  observations: ProjectChatSemanticRobustnessObservation[];
  scenarios?: readonly ProjectChatSemanticRobustnessScenario[];
  directParityMargin?: number;
}): ProjectChatSemanticRobustnessResult {
  const scenarios = input.scenarios ?? projectChatSemanticRobustnessScenarios;
  const parsed = input.observations.map((observation) =>
    projectChatSemanticRobustnessObservationSchema.parse(observation)
  );
  const checks: ProjectChatSemanticRobustnessCheck[] = [];
  const byId = new Map(parsed.map((observation) => [observation.scenarioId, observation]));
  check(checks, "scenario IDs are unique", byId.size === parsed.length, byId.size, parsed.length);
  check(checks, "required semantic scenarios are complete", scenarios.every((scenario) => byId.has(scenario.id)), byId.size, scenarios.length);

  const margin = input.directParityMargin ?? 0.1;
  for (const scenario of scenarios) {
    const observation = byId.get(scenario.id);
    if (!observation) continue;
    const prefix = scenario.id;
    check(checks, `${prefix}: family matches`, observation.family === scenario.family, observation.family, scenario.family);
    check(checks, `${prefix}: planner preserves intended action`, observation.observedAction === scenario.expectedAction, observation.observedAction, scenario.expectedAction);
    check(checks, `${prefix}: answer is model composed`, observation.compositionMode === "model_tool_loop", observation.compositionMode, "model_tool_loop");
    check(checks, `${prefix}: planning is audited`, observation.planningRunCount >= 1, observation.planningRunCount, 1);
    check(checks, `${prefix}: primary answer is audited`, observation.primaryAnswerRunCount >= 1, observation.primaryAnswerRunCount, 1);
    check(checks, `${prefix}: semantic verification is audited`, observation.semanticVerificationRunCount >= 1, observation.semanticVerificationRunCount, 1);
    check(checks, `${prefix}: no deterministic answer synthesis`, observation.deterministicAnswerRunCount === 0, observation.deterministicAnswerRunCount, 0);
    check(checks, `${prefix}: required tools were selected`, scenario.requiredToolNames.every((tool) => observation.observedToolNames.includes(tool)), observation.observedToolNames.join(","), scenario.requiredToolNames.join(","));
    check(checks, `${prefix}: answer is non-empty`, observation.answer.trim().length > 0, observation.answer.trim().length, 1);
    check(checks, `${prefix}: no unsupported claims`, observation.unsupportedClaimCount === 0, observation.unsupportedClaimCount, 0);
    check(checks, `${prefix}: primary-answer attribution is authoritative`, new Set(observation.primaryAnswerAttribution.requestIds).size === observation.primaryAnswerAttribution.requestIds.length && observation.primaryAnswerAttribution.requestIds.length >= observation.primaryAnswerRunCount && observation.primaryAnswerAttribution.usageComplete && observation.primaryAnswerAttribution.failedProviderAttempts === 0 && !observation.primaryAnswerAttribution.fallbackUsed, `${observation.primaryAnswerAttribution.requestIds.length}/${observation.primaryAnswerAttribution.usageComplete}/${observation.primaryAnswerAttribution.failedProviderAttempts}/${observation.primaryAnswerAttribution.fallbackUsed}`, "unique request IDs cover runs / complete usage / zero failures / no fallback");
    check(checks, `${prefix}: semantic judge attribution is complete`, Boolean(observation.judge.provider && observation.judge.modelId && observation.judge.requestId), Boolean(observation.judge.requestId), true);
    check(checks, `${prefix}: same-model direct control is present`, observation.directAgentBaseline !== null, observation.directAgentBaseline !== null, true);
    if (observation.directAgentBaseline) {
      check(checks, `${prefix}: direct control uses the same primary model`, observation.directAgentBaseline.modelId === observation.primaryAnswerAttribution.modelId, observation.directAgentBaseline.modelId, observation.primaryAnswerAttribution.modelId);
    }
    for (const scoreName of scoreNames) {
      const threshold = scoreName === "grounding" ? 0.9 : 0.8;
      check(checks, `${prefix}: ${scoreName} clears semantic threshold`, observation.judge.scores[scoreName] >= threshold, observation.judge.scores[scoreName], threshold);
      const baseline = observation.directAgentBaseline?.scores[scoreName];
      if (baseline != null) {
        check(checks, `${prefix}: ${scoreName} is non-inferior to direct agent`, observation.judge.scores[scoreName] >= baseline - margin, observation.judge.scores[scoreName], baseline - margin);
      }
    }
  }

  for (const family of familySchema.options) {
    const familyScenarios = scenarios.filter((scenario) => scenario.family === family);
    if (familyScenarios.length < 2) continue;
    const observations = familyScenarios.flatMap((scenario) => {
      const observation = byId.get(scenario.id);
      return observation ? [observation] : [];
    });
    check(
      checks,
      `${family}: paraphrases preserve action semantics`,
      observations.length === familyScenarios.length &&
        new Set(observations.map((observation) => observation.observedAction)).size === 1,
      new Set(observations.map((observation) => observation.observedAction)).size,
      1,
    );
  }

  return {
    schemaVersion: PROJECT_CHAT_SEMANTIC_ROBUSTNESS_SCHEMA_VERSION,
    passed: checks.every((candidate) => candidate.passed),
    checks,
    scenarioCount: parsed.length,
    familyCount: new Set(parsed.map((observation) => observation.family)).size,
  };
}
