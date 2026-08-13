import { describe, expect, it } from "vitest";
import {
  evaluateProjectChatSemanticRobustness,
  projectChatSemanticRobustnessScenarios,
  type ProjectChatSemanticRobustnessObservation,
} from "@/src/evals/project-chat-semantic-robustness";

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
    prompt: scenario.prompt,
    expectedAction: scenario.expectedAction,
    observedAction: scenario.expectedAction,
    requiredToolNames: [...scenario.requiredToolNames],
    observedToolNames: [...scenario.requiredToolNames],
    compositionMode: "model_tool_loop",
    planningRunCount: 1,
    primaryAnswerRunCount: 1,
    semanticVerificationRunCount: 1,
    deterministicAnswerRunCount: 0,
    answer: "A natural model-authored answer whose exact wording is not part of the contract.",
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
  it("passes varied wording, multi-turn, distractor, format, and parity observations without answer regexes", () => {
    const result = evaluateProjectChatSemanticRobustness({
      observations: projectChatSemanticRobustnessScenarios.map(observation),
    });
    expect(result.passed).toBe(true);
    expect(result.scenarioCount).toBe(projectChatSemanticRobustnessScenarios.length);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("catches one paraphrase falling back to a lexical route", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    const target = observations.find((candidate) => candidate.scenarioId === "freshness_pronoun")!;
    target.observedAction = "answer";
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "freshness_pronoun: planner preserves intended action",
      passed: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "freshness_follow_up: paraphrases preserve action semantics",
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

  it("requires audited semantic-judge identity instead of accepting self-scored output", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    observations[0]!.judge.requestId = "";
    expect(() => evaluateProjectChatSemanticRobustness({ observations }))
      .toThrow();
  });

  it("requires an authoritative same-model direct-agent control", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    observations[0]!.directAgentBaseline = null;
    observations[1]!.directAgentBaseline!.modelId = "different-model";
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual(expect.arrayContaining([
        "freshness_plain: same-model direct control is present",
        "freshness_pronoun: direct control uses the same primary model",
      ]));
  });
});
