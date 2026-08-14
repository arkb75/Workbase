import { z } from "zod";

export const PROJECT_CHAT_SEMANTIC_ROBUSTNESS_SCHEMA_VERSION =
  "workbase-project-chat-semantic-robustness-v2";

const familySchema = z.enum([
  "durable_freshness",
  "current_source_investigation",
  "durable_knowledge",
  "prior_turn_provenance",
  "artifact_action",
  "formatting",
  "unsupported_request",
  "conversational",
]);

const outcomeSchema = z.enum([
  "answered",
  "artifact_requested",
  "insufficient_context",
]);

type ProjectChatSemanticCapability =
  | "knowledge_search"
  | "durable_refresh"
  | "repository_inspection"
  | "prior_turn_inspection"
  | "artifact_creation";

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
  repositoryDomain: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4_000),
  observedOutcome: outcomeSchema,
  observedToolNames: z.array(z.string().trim().min(1).max(100)).max(30),
  observedInspectionModes: z.array(z.enum(["knowledge", "repository"])).max(2),
  compositionMode: z.string().trim().min(1).max(100),
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
  repositoryDomain: string;
  prompt: string;
  expectedOutcome: z.infer<typeof outcomeSchema>;
  requiredCapabilities: ProjectChatSemanticCapability[];
  forbiddenCapabilities?: ProjectChatSemanticCapability[];
}

/**
 * Scenarios vary repository domain, wording, requested presentation, and
 * source strategy. They intentionally describe outcomes and capabilities—not
 * answer strings, regex triggers, exact search queries, or implementation
 * tool names.
 */
export const projectChatSemanticRobustnessScenarios: readonly ProjectChatSemanticRobustnessScenario[] = [
  {
    id: "freshness_plain",
    family: "durable_freshness",
    repositoryDomain: "web_application",
    prompt: "Bring the project knowledge up to date from the repo, then revise your summary.",
    expectedOutcome: "answered",
    requiredCapabilities: ["durable_refresh", "knowledge_search"],
  },
  {
    id: "freshness_elliptical",
    family: "durable_freshness",
    repositoryDomain: "command_line_tool",
    prompt: "There have been more commits—sync what you know and update that answer.",
    expectedOutcome: "answered",
    requiredCapabilities: ["durable_refresh", "knowledge_search"],
  },
  {
    id: "freshness_colloquial",
    family: "durable_freshness",
    repositoryDomain: "mobile_application",
    prompt: "Pull in the new repo state first; I want the reusable project picture refreshed.",
    expectedOutcome: "answered",
    requiredCapabilities: ["durable_refresh", "knowledge_search"],
  },
  {
    id: "source_current_config",
    family: "current_source_investigation",
    repositoryDomain: "machine_learning_library",
    prompt: "Check the current source and show which execution backends are configured, in a table.",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_implementation_location",
    family: "current_source_investigation",
    repositoryDomain: "game_engine",
    prompt: "Where is frame pacing implemented, and what does the relevant code actually do?",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_security_trace",
    family: "current_source_investigation",
    repositoryDomain: "infrastructure_operator",
    prompt: "Trace how credentials move from configuration to the deployment client; cite the exact files.",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_merged_work",
    family: "current_source_investigation",
    repositoryDomain: "developer_platform",
    prompt: "What were the last two substantial changes merged here? Compare what each one changed and qualify how you judged their scope.",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_release_delta",
    family: "current_source_investigation",
    repositoryDomain: "scientific_pipeline",
    prompt: "What changed between the two most recent release tags, especially in the analysis pipeline?",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_change_rationale",
    family: "current_source_investigation",
    repositoryDomain: "network_service",
    prompt: "When was the retry ceiling introduced, what changed around it, and what repository evidence explains why?",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "source_project_orientation",
    family: "current_source_investigation",
    repositoryDomain: "embedded_system",
    prompt: "Orient me to this unfamiliar repository: map the important areas, then inspect only what you need to explain the command path.",
    expectedOutcome: "answered",
    requiredCapabilities: ["repository_inspection"],
    forbiddenCapabilities: ["durable_refresh"],
  },
  {
    id: "knowledge_accomplishments",
    family: "durable_knowledge",
    repositoryDomain: "scientific_pipeline",
    prompt: "What are the three strongest engineering accomplishments here, and why do they matter?",
    expectedOutcome: "answered",
    requiredCapabilities: ["knowledge_search"],
  },
  {
    id: "knowledge_tradeoffs",
    family: "durable_knowledge",
    repositoryDomain: "data_platform",
    prompt: "Compare the main architectural trade-offs without turning the answer into a source inventory.",
    expectedOutcome: "answered",
    requiredCapabilities: ["knowledge_search"],
  },
  {
    id: "formatting_matrix",
    family: "formatting",
    repositoryDomain: "compiler",
    prompt: "Put the pipeline stages beside their responsibilities and evidence in a compact matrix.",
    expectedOutcome: "answered",
    requiredCapabilities: ["knowledge_search"],
  },
  {
    id: "formatting_rephrase",
    family: "formatting",
    repositoryDomain: "design_system",
    prompt: "Same substance as before, but organize it by purpose instead of by component.",
    expectedOutcome: "answered",
    requiredCapabilities: ["knowledge_search"],
  },
  {
    id: "prior_source_direct",
    family: "prior_turn_provenance",
    repositoryDomain: "any",
    prompt: "Which sources and tool results did you actually rely on for that answer?",
    expectedOutcome: "answered",
    requiredCapabilities: ["prior_turn_inspection"],
  },
  {
    id: "prior_source_elliptical",
    family: "prior_turn_provenance",
    repositoryDomain: "any",
    prompt: "And what was that based on?",
    expectedOutcome: "answered",
    requiredCapabilities: ["prior_turn_inspection"],
  },
  {
    id: "artifact_case_study",
    family: "artifact_action",
    repositoryDomain: "developer_tool",
    prompt: "Turn the supported project story into a case-study artifact for a hiring manager.",
    expectedOutcome: "artifact_requested",
    requiredCapabilities: ["artifact_creation"],
  },
  {
    id: "unsupported_business_metrics",
    family: "unsupported_request",
    repositoryDomain: "open_source_library",
    prompt: "How many paying users do we have and what is production p95 latency?",
    expectedOutcome: "answered",
    requiredCapabilities: ["knowledge_search"],
  },
  {
    id: "conversational_acknowledgement",
    family: "conversational",
    repositoryDomain: "any",
    prompt: "That makes sense, thanks.",
    expectedOutcome: "answered",
    requiredCapabilities: [],
    forbiddenCapabilities: ["durable_refresh", "repository_inspection"],
  },
] as const;

const toolCapabilities: Record<string, ProjectChatSemanticCapability> = {
  refresh_project_knowledge: "durable_refresh",
  inspect_prior_turn: "prior_turn_inspection",
  create_project_artifact: "artifact_creation",
};

export function projectChatCapabilitiesForTools(
  toolNames: readonly string[],
  inspectionModes: readonly ("knowledge" | "repository")[] = [],
) {
  const capabilities = toolNames.flatMap((toolName) => {
    const capability = toolCapabilities[toolName];
    return capability ? [capability] : [];
  });
  if (toolNames.includes("inspect_project")) {
    if (inspectionModes.includes("knowledge")) capabilities.push("knowledge_search");
    if (inspectionModes.includes("repository")) capabilities.push("repository_inspection");
  }
  return new Set(capabilities);
}

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
  check(
    checks,
    "scenario catalog spans diverse repository domains",
    new Set(scenarios.map((scenario) => scenario.repositoryDomain).filter((domain) => domain !== "any")).size >= 8,
    new Set(scenarios.map((scenario) => scenario.repositoryDomain).filter((domain) => domain !== "any")).size,
    8,
  );

  const margin = input.directParityMargin ?? 0.1;
  for (const scenario of scenarios) {
    const observation = byId.get(scenario.id);
    if (!observation) continue;
    const prefix = scenario.id;
    const capabilities = projectChatCapabilitiesForTools(
      observation.observedToolNames,
      observation.observedInspectionModes,
    );
    check(checks, `${prefix}: family matches`, observation.family === scenario.family, observation.family, scenario.family);
    check(checks, `${prefix}: repository domain matches`, observation.repositoryDomain === scenario.repositoryDomain, observation.repositoryDomain, scenario.repositoryDomain);
    check(checks, `${prefix}: model-led outcome matches`, observation.observedOutcome === scenario.expectedOutcome, observation.observedOutcome, scenario.expectedOutcome);
    check(checks, `${prefix}: answer is model composed`, observation.compositionMode === "model_tool_loop", observation.compositionMode, "model_tool_loop");
    check(checks, `${prefix}: primary answer is audited`, observation.primaryAnswerRunCount >= 1, observation.primaryAnswerRunCount, 1);
    check(checks, `${prefix}: semantic verification is audited when answering`, observation.observedOutcome !== "answered" || observation.semanticVerificationRunCount >= 1, observation.semanticVerificationRunCount, observation.observedOutcome === "answered" ? 1 : 0);
    check(checks, `${prefix}: no deterministic answer synthesis`, observation.deterministicAnswerRunCount === 0, observation.deterministicAnswerRunCount, 0);
    check(checks, `${prefix}: required capabilities were exercised`, scenario.requiredCapabilities.every((capability) => capabilities.has(capability)), Array.from(capabilities).sort().join(","), scenario.requiredCapabilities.join(","));
    check(checks, `${prefix}: forbidden capabilities were avoided`, (scenario.forbiddenCapabilities ?? []).every((capability) => !capabilities.has(capability)), Array.from(capabilities).sort().join(","), (scenario.forbiddenCapabilities ?? []).join(","));
    check(checks, `${prefix}: answered output is non-empty`, observation.observedOutcome !== "answered" || observation.answer.trim().length > 0, observation.answer.trim().length, observation.observedOutcome === "answered" ? 1 : 0);
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
    const outcomes = familyScenarios.flatMap((scenario) => {
      const observation = byId.get(scenario.id);
      return observation ? [observation.observedOutcome] : [];
    });
    check(
      checks,
      `${family}: varied scenarios preserve outcome semantics`,
      outcomes.length === familyScenarios.length && new Set(outcomes).size === 1,
      new Set(outcomes).size,
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
