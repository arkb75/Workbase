import { describe, expect, it } from "vitest";
import {
  evaluateProjectChatScenario,
  evaluateProjectChatSuite,
  validateProjectChatScenarioFixtures,
  type ProjectChatScenarioObservation,
} from "@/src/evals/project-chat-evaluation";
import {
  projectChatEvaluationFixtures,
  type ProjectChatScenarioId,
} from "@/src/evals/project-chat-fixtures";

function architectureObservation(
  overrides: Partial<ProjectChatScenarioObservation> = {},
): ProjectChatScenarioObservation {
  return {
    scenarioId: "architecture_from_memory",
    route: "memory_only",
    lifecycle: "answered",
    tools: [],
    sources: [{
      kind: "project_fact",
      authority: "verified_project_fact",
      title: "Architecture flow",
      used: true,
      presentation: "primary",
    }, {
      kind: "project_fact",
      authority: "verified_project_fact",
      title: "Durable orchestration",
      used: true,
      presentation: "primary",
    }],
    metrics: {
      latencyMs: 1_200,
      modelCalls: 1,
      totalTokens: 2_000,
      estimatedCostUsd: 0.02,
      repositoryTreeLookups: 0,
      repositorySearches: 0,
      repositoryFileReads: 0,
      repositoryVisibleBytes: 0,
      workerCount: 0,
    },
    answer: "## Architecture\n\n- Requests flow through durable orchestration. [citation:1]",
    coverageGaps: [],
    partial: false,
    repositoryHeadsCurrent: true,
    ...overrides,
  };
}

describe("project-chat evaluation fixtures", () => {
  it("defines a valid, unique matrix covering all required realistic scenarios", () => {
    expect(validateProjectChatScenarioFixtures()).toEqual([]);
    expect(projectChatEvaluationFixtures).toHaveLength(15);
    expect(new Set(projectChatEvaluationFixtures.map((fixture) => fixture.id)).size).toBe(15);
    expect(projectChatEvaluationFixtures.map((fixture) => fixture.id)).toEqual(expect.arrayContaining([
      "accomplishments_same_sha",
      "accomplishments_one_file_delta",
      "architecture_from_memory",
      "architecture_follow_up",
      "prior_turn_provenance",
      "targeted_code_question",
      "missing_production_metric",
      "artifact_from_adequate_context",
      "artifact_missing_impact",
      "self_reported_impact",
      "stale_knowledge_mutation",
      "unattached_repository_rejection",
      "multi_repository_research",
      "provider_limit_partial_result",
      "long_thread_markdown",
    ] satisfies ProjectChatScenarioId[]));
  });

  it("accepts a grounded memory answer within its performance envelope", () => {
    const result = evaluateProjectChatScenario(architectureObservation());
    expect(result.passed).toBe(true);
    expect(result.checks.every((entry) => entry.passed)).toBe(true);
  });

  it("fails wrong routing, unnecessary research, unused citations, and peer GitHub files", () => {
    const result = evaluateProjectChatScenario(architectureObservation({
      route: "targeted_repository_research",
      tools: ["research_project"],
      sources: [{
        kind: "github_file",
        authority: "included_evidence",
        title: "src/worker.ts",
        used: false,
        presentation: "primary",
      }],
    }));
    expect(result.passed).toBe(false);
    expect(result.checks.filter((entry) => !entry.passed).map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "route",
      "forbidden_tool",
      "unused_source",
      "source_kind",
      "raw_repository_source",
      "required_source",
    ]));
  });

  it("allows immutable GitHub excerpts only as non-counting nested provenance", () => {
    const observation = architectureObservation();
    const result = evaluateProjectChatScenario({
      ...observation,
      sources: [...observation.sources, {
        kind: "github_file",
        authority: "included_evidence",
        title: "src/workflow.ts at abc123",
        used: true,
        presentation: "nested_provenance",
      }],
    });
    expect(result.passed).toBe(true);
  });

  it("enforces latency, model-call, token, cost, and repository-work budgets", () => {
    const result = evaluateProjectChatScenario(architectureObservation({
      metrics: {
        latencyMs: 12_001,
        modelCalls: 2,
        totalTokens: 20_001,
        estimatedCostUsd: 0.151,
        repositoryTreeLookups: 1,
        repositorySearches: 1,
        repositoryFileReads: 1,
        repositoryVisibleBytes: 1,
        workerCount: 1,
      },
    }));
    const failedBudgets = result.checks.filter((entry) => entry.code === "performance_budget" && !entry.passed);
    expect(failedBudgets).toHaveLength(9);
  });

  it("requires partial labeling and an explicit gap after a provider limit", () => {
    const observation: ProjectChatScenarioObservation = {
      scenarioId: "provider_limit_partial_result",
      route: "partial_finalization",
      lifecycle: "partially_answered",
      tools: ["refresh_repository_knowledge"],
      sources: [],
      metrics: {
        latencyMs: 40_000,
        modelCalls: 2,
        totalTokens: 30_000,
        estimatedCostUsd: 0.25,
        repositoryTreeLookups: 1,
        repositorySearches: 1,
        repositoryFileReads: 3,
        repositoryVisibleBytes: 24_000,
        workerCount: 1,
      },
      answer: "This is a partial assessment; the coverage gap is the uninspected UI routes.",
      coverageGaps: ["UI routes were not inspected before the provider limit."],
      partial: true,
      repositoryHeadsCurrent: false,
    };
    expect(evaluateProjectChatScenario(observation).passed).toBe(true);

    const failed = evaluateProjectChatScenario({ ...observation, partial: false, coverageGaps: [] });
    expect(failed.passed).toBe(false);
    expect(failed.checks.filter((entry) => !entry.passed).map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "coverage_gap",
      "partial_result",
    ]));
  });

  it("does not let a multi-repository comparison use two sources from one repository", () => {
    const base: ProjectChatScenarioObservation = {
      scenarioId: "multi_repository_research",
      route: "targeted_repository_research",
      lifecycle: "answered",
      tools: ["research_project"],
      sources: [
        { kind: "project_fact", authority: "verified_project_fact", title: "Request entry", used: true, repository: "owner/repo-a" },
        { kind: "project_fact", authority: "verified_project_fact", title: "Request handler", used: true, repository: "owner/repo-a" },
      ],
      metrics: {
        latencyMs: 10_000,
        modelCalls: 2,
        totalTokens: 10_000,
        estimatedCostUsd: 0.1,
        repositoryTreeLookups: 2,
        repositorySearches: 2,
        repositoryFileReads: 4,
        repositoryVisibleBytes: 32_000,
        workerCount: 2,
      },
      answer: "Repository A and repository B use the same request flow.",
      coverageGaps: [],
      partial: false,
      repositoryHeadsCurrent: true,
    };

    const unsupportedComparison = evaluateProjectChatScenario(base);
    expect(unsupportedComparison.passed).toBe(false);
    expect(unsupportedComparison.checks).toContainEqual(expect.objectContaining({ code: "repository_scope", passed: false }));

    const honestPartial = evaluateProjectChatScenario({
      ...base,
      lifecycle: "partially_answered",
      partial: true,
      coverageGaps: ["The bounded file budget did not inspect owner/repo-b."],
      answer: "This is partial: owner/repo-b was not inspected within the bounded file budget.",
    });
    expect(honestPartial.checks).toContainEqual(expect.objectContaining({ code: "repository_scope", passed: true }));
    expect(honestPartial.passed).toBe(true);
  });

  it("requires a complete, non-duplicated observation set for a suite pass", () => {
    const incomplete = evaluateProjectChatSuite([architectureObservation(), architectureObservation()]);
    expect(incomplete.passed).toBe(false);
    expect(incomplete.duplicateScenarioIds).toEqual(["architecture_from_memory"]);
    expect(incomplete.missingScenarioIds).toContain("accomplishments_same_sha");
    expect(incomplete.evaluatedScenarios).toBe(1);
  });
});
