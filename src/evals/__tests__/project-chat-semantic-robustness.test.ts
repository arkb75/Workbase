import { describe, expect, it } from "vitest";
import {
  evaluateProjectChatSemanticRobustness,
  projectChatSemanticRobustnessScenarios,
  type ProjectChatSemanticRobustnessObservation,
} from "@/src/evals/project-chat-semantic-robustness";

const capabilityTool = {
  knowledge_search: "inspect_project",
  durable_refresh: "refresh_project_knowledge",
  repository_inspection: "inspect_project",
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
    observedInspectionModes: [
      ...(scenario.requiredCapabilities.includes("knowledge_search")
        ? ["knowledge" as const]
        : []),
      ...(scenario.requiredCapabilities.includes("repository_inspection")
        ? ["repository" as const]
        : []),
    ],
    compositionMode: "model_tool_loop",
    primaryAnswerRunCount: 1,
    semanticVerificationRunCount:
      scenario.expectedOutcome === "answered" ? 1 : 0,
    deterministicAnswerRunCount: 0,
    answer: scenario.expectedOutcome === "answered"
      ? "A natural model-authored answer whose exact wording is not part of the contract."
      : "",
    unsupportedClaimCount: 0,
    publicationOutcome: scenario.expectedOutcome === "answered"
      ? scenario.family === "partial_support"
        ? "answered_with_gaps"
        : "answered"
      : null,
    claimLedger: scenario.expectedOutcome === "answered" && scenario.requiredCapabilities.length
      ? {
          version: "project-chat-claim-ledger-v1",
          entryCount: scenario.family === "partial_support" ? 3 : 2,
          supportedCount: 2,
          qualifiedCount: scenario.family === "partial_support" ? 1 : 0,
          removedCount: 0,
        }
      : null,
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
    target.observedToolNames = ["inspect_project"];
    target.observedInspectionModes = ["knowledge"];
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
    target.observedToolNames.push("refresh_project_knowledge");
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

  it("rejects over-refusal when a partial-support prompt has surviving grounded claims", () => {
    const observations = projectChatSemanticRobustnessScenarios.map(observation);
    const target = observations.find((candidate) =>
      candidate.scenarioId === "partial_model_roles_with_unknown_cost"
    )!;
    target.observedOutcome = "insufficient_context";
    target.answer = "I could not safely publish the requested answer.";
    target.publicationOutcome = null;
    const result = evaluateProjectChatSemanticRobustness({ observations });
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name))
      .toEqual(expect.arrayContaining([
        "partial_model_roles_with_unknown_cost: model-led outcome matches",
        "partial_model_roles_with_unknown_cost: partial support publishes surviving content with gaps",
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
