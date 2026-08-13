import { describe, expect, it } from "vitest";
import {
  evaluateProjectChatSemanticRobustness,
  projectChatSemanticRobustnessScenarios,
  type ProjectChatSemanticRobustnessObservation,
} from "@/src/evals/project-chat-semantic-robustness";

const capabilityTool = {
  knowledge_search: "search_project_knowledge",
  source_inventory: "list_project_sources",
  durable_refresh: "refresh_project_sources",
  source_search: "search_project_sources",
  source_read: "read_project_source",
  prior_turn_inspection: "inspect_prior_turn",
  artifact_creation: "create_project_artifact",
} as const;

function observation(
  scenario: (typeof projectChatSemanticRobustnessScenarios)[number],
): ProjectChatSemanticRobustnessObservation {
  const scores = {
    relevance: 0.94,
    completeness: 0.91,
    grounding: 0.97,
    format: 0.92,
    continuity: 0.94,
    overall: 0.93,
  };
  return {
    scenarioId: scenario.id,
    family: scenario.family,
    repositoryDomain: scenario.repositoryDomain,
    prompt: scenario.prompt,
    observedOutcome: scenario.expectedOutcome,
    observedToolNames: scenario.requiredCapabilities.map((capability) =>
      capabilityTool[capability]
    ),
    compositionMode: "model_tool_loop",
    primaryAnswerRunCount: 1,
    semanticVerificationRunCount:
      scenario.expectedOutcome === "answered" ? 1 : 0,
    deterministicAnswerRunCount: 0,
    answer: scenario.expectedOutcome === "answered"
      ? "A natural model-authored answer whose exact wording is not part of the contract."
      : "",
    unsupportedClaimCount: 0,
    primaryAnswerAttribution: {
      provider: "openrouter",
      modelId: "same-primary-model",
      requestIds: [`primary-${scenario.id}`],
      usageComplete: true,
      failedProviderAttempts: 0,
      fallbackUsed: false,
    },
    judge: {
      provider: "openrouter",
      modelId: "semantic-judge",
      requestId: `judge-${scenario.id}`,
      scores,
    },
    directAgentBaseline: {
      system: "codex",
      modelId: "same-primary-model",
      scores: { ...scores, overall: 0.96 },
    },
  };
}

describe("project-chat semantic robustness gate", () => {
  it("passes varied repositories, wording, source strategies, formatting, and direct-agent parity without answer regexes", () => {
    const result = evaluateProjectChatSemanticRobustness({
      observations: projectChatSemanticRobustnessScenarios.map(observation),
    });
    expect(result.passed).toBe(true);
    expect(result.scenarioCount).toBe(projectChatSemanticRobustnessScenarios.length);
    expect(result.familyCount).toBeGreaterThanOrEqual(8);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("catches one freshness paraphrase that fails to request durable synchronization", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    const target = observations.find((candidate) => candidate.scenarioId === "freshness_elliptical")!;
    target.observedToolNames = ["search_project_knowledge"];
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "freshness_elliptical: required capabilities were exercised",
      passed: false,
    }));
  });

  it("rejects over-eager full refresh for a narrow current-source inspection", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    const target = observations.find((candidate) => candidate.scenarioId === "source_current_config")!;
    target.observedToolNames.push("refresh_project_sources");
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "source_current_config: forbidden capabilities were avoided",
      passed: false,
    }));
  });

  it("rejects deterministic synthesis even when the prose scores well", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    observations[0]!.compositionMode = "deterministic_source_synthesis";
    observations[0]!.deterministicAnswerRunCount = 1;
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual(expect.arrayContaining([
        "freshness_plain: answer is model composed",
        "freshness_plain: no deterministic answer synthesis",
      ]));
  });

  it("fails answers that are materially worse than the same-model direct-agent control", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    observations[0]!.judge.scores.completeness = 0.8;
    observations[0]!.directAgentBaseline!.scores.completeness = 0.98;
    const result = evaluateProjectChatSemanticRobustness({
      observations,
      directParityMargin: 0.1,
    });
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "freshness_plain: completeness is non-inferior to direct agent",
      passed: false,
    }));
  });

  it("requires audited semantic-judge identity and a same-model direct control", () => {
    const invalidJudge = projectChatSemanticRobustnessScenarios.map(observation);
    invalidJudge[0]!.judge.requestId = "";
    expect(() => evaluateProjectChatSemanticRobustness({ observations: invalidJudge }))
      .toThrow();

    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    observations[0]!.directAgentBaseline = null;
    observations[1]!.directAgentBaseline!.modelId = "different-model";
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual(expect.arrayContaining([
        "freshness_plain: same-model direct control is present",
        "freshness_elliptical: direct control uses the same primary model",
      ]));
  });
});
