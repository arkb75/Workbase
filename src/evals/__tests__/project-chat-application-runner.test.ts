import { describe, expect, it, vi } from "vitest";
import {
  evaluateProjectChatApplicationObservation,
  projectChatApplicationScenarios,
  runProjectChatApplicationScenarios,
  type ProjectChatApplicationDriver,
  type ProjectChatApplicationMetrics,
  type ProjectChatApplicationObservation,
  type ProjectChatApplicationScenario,
} from "@/src/evals/project-chat-application-runner";

const zeroMetrics: ProjectChatApplicationMetrics = {
  latencyMs: 10,
  modelCalls: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  usageComplete: true,
  repositoryTreeLookups: 0,
  repositorySearches: 0,
  repositoryFileReads: 0,
  repositoryVisibleBytes: 0,
};

function successfulObservation(
  scenario: ProjectChatApplicationScenario,
  historyMessageCount: number,
): ProjectChatApplicationObservation {
  const base: ProjectChatApplicationObservation = {
    scenarioId: scenario.id,
    runId: `run-${scenario.id}`,
    threadId: `thread-${scenario.threadKey}`,
    workItemId: `work-item-${scenario.workspace}`,
    outcome: "answered",
    answer: "The workflow retries a bounded step because doing so preserves durable progress. [citation:1]",
    citationCount: 1,
    citationKinds: ["project_fact"],
    citationOrdinals: [1],
    tools: [],
    historyMessageCount,
    candidate: null,
    artifact: null,
    coverageGaps: [],
    metrics: { ...zeroMetrics },
    error: null,
  };
  switch (scenario.id) {
    case "memory_answer":
      return {
        ...base,
        answer: "The career-content product uses repository knowledge refresh and grounded multi-turn project chat. [citation:1][citation:2][citation:3]",
        citationCount: 3,
        citationKinds: ["project_fact", "project_fact", "project_fact"],
        citationOrdinals: [1, 2, 3],
      };
    case "prior_turn_provenance":
      return { ...base, citationCount: 0, citationKinds: [], citationOrdinals: [], tools: ["inspect_prior_turn_provenance"], answer: "No. The prior turn did not inspect the repository." };
    case "missing_metric":
      return { ...base, outcome: "insufficient_context", citationCount: 0, citationKinds: [], citationOrdinals: [], coverageGaps: ["No production telemetry is present."], answer: "No measured production request volume is available." };
    case "artifact_routing":
      return { ...base, outcome: "artifact_requested", citationCount: 0, citationKinds: [], citationOrdinals: [], answer: "Artifact workflow selected." };
    case "artifact_from_approved_context":
      return {
        ...base,
        outcome: "artifact_completed",
        answer: "- Built a typed backend orchestration layer.",
        citationCount: 1,
        citationKinds: ["highlight"],
        citationOrdinals: [],
        artifact: {
          exists: true,
          lifecycleStatus: "active",
          publicSafetyStatus: "verified",
          usedHighlightCount: 1,
          usedEvidenceCount: 1,
        },
      };
    case "artifact_missing_impact":
      return {
        ...base,
        outcome: "insufficient_context",
        answer: "No measured impact metric is available for a quantified artifact.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
        coverageGaps: ["No measured impact evidence is available."],
      };
    case "artifact_review_gate":
      return {
        ...base,
        outcome: "awaiting_review",
        answer: "Artifact generation is waiting for candidate review.",
        citationCount: 0,
        citationKinds: [],
        citationOrdinals: [],
        candidate: {
          exists: true,
          status: "pending",
          kind: "new_highlight",
          highlightLifecycleStatus: "quarantined",
          highlightReviewState: "pending_review",
          evidenceTypes: [],
        },
      };
    case "unattached_repository_security":
      return { ...base, outcome: "insufficient_context", citationCount: 0, citationKinds: [], citationOrdinals: [], answer: "No attached repository is authorized." };
    case "self_reported_context":
      return {
        ...base,
        candidate: {
          exists: true,
          status: "approved",
          kind: "new_highlight",
          highlightLifecycleStatus: "active",
          highlightReviewState: "pending_review",
          evidenceTypes: ["chat_user_statement"],
        },
      };
    case "targeted_repository_research":
      return {
        ...base,
        answer: "No retry policy was found. The loop exits by throwing when `iterations >= maxIterations`, and `stopReason` controls response exits. [citation:1]",
        tools: ["list_repository_paths", "search_repository", "read_repository_file"],
        metrics: {
          ...zeroMetrics,
          latencyMs: 1_000,
          repositoryTreeLookups: 1,
          repositorySearches: 1,
          repositoryFileReads: 3,
          repositoryVisibleBytes: 12_000,
        },
      };
    default:
      return base;
  }
}

describe("project-chat application scenario runner", () => {
  it("covers real conversation, provenance, missing context, user context, artifact, research, and security paths", () => {
    expect(projectChatApplicationScenarios.map((scenario) => scenario.id)).toEqual([
      "memory_answer",
      "conversation_follow_up",
      "prior_turn_provenance",
      "missing_metric",
      "artifact_routing",
      "artifact_from_approved_context",
      "artifact_missing_impact",
      "artifact_review_gate",
      "unattached_repository_security",
      "self_reported_context",
      "targeted_repository_research",
    ]);
  });

  it("runs scenarios in order, shares conversation state, evaluates each result, and cleans up", async () => {
    const messageCountByThread = new Map<string, number>();
    const cleanup = vi.fn(async () => undefined);
    const driver: ProjectChatApplicationDriver = {
      async run(scenario) {
        const historyMessageCount = messageCountByThread.get(scenario.threadKey) ?? 0;
        messageCountByThread.set(scenario.threadKey, historyMessageCount + 2);
        return successfulObservation(scenario, historyMessageCount);
      },
      cleanup,
    };

    const suite = await runProjectChatApplicationScenarios({ driver });

    expect(suite.results.flatMap((result) =>
      result.checks.filter((check) => !check.passed).map((check) => `${result.scenario.id}: ${check.name}`),
    )).toEqual([]);
    expect(suite.passed).toBe(true);
    expect(suite.results).toHaveLength(11);
    expect(suite.results.find((result) => result.scenario.id === "conversation_follow_up")?.observation.historyMessageCount).toBe(2);
    expect(suite.results.find((result) => result.scenario.id === "prior_turn_provenance")?.observation.historyMessageCount).toBe(4);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails inconsistent zero-call telemetry and repository work on a memory path", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "memory_answer")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      tools: ["read_repository_file"],
      metrics: { ...observation.metrics, totalTokens: 25 },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(expect.arrayContaining([
      "memory answer avoided repository work",
      "zero-call telemetry is internally consistent",
    ]));
  });

  it("fails the performance gate when provider usage metadata is incomplete", () => {
    const scenario = projectChatApplicationScenarios.find((entry) => entry.id === "memory_answer")!;
    const observation = successfulObservation(scenario, 0);
    const result = evaluateProjectChatApplicationObservation(scenario, {
      ...observation,
      metrics: { ...observation.metrics, usageComplete: false },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "provider usage telemetry is complete")?.passed).toBe(false);
  });

  it("always cleans up when a driver throws", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(runProjectChatApplicationScenarios({
      scenarioIds: ["memory_answer"],
      driver: {
        run: vi.fn(async () => { throw new Error("boom"); }),
        cleanup,
      },
    })).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("automatically runs persisted-history prerequisites for a provenance-only request", async () => {
    const executed: string[] = [];
    const messageCountByThread = new Map<string, number>();
    const suite = await runProjectChatApplicationScenarios({
      scenarioIds: ["prior_turn_provenance"],
      driver: {
        async run(scenario) {
          executed.push(scenario.id);
          const history = messageCountByThread.get(scenario.threadKey) ?? 0;
          messageCountByThread.set(scenario.threadKey, history + 2);
          return successfulObservation(scenario, history);
        },
        async cleanup() {},
      },
    });
    expect(executed).toEqual(["memory_answer", "conversation_follow_up", "prior_turn_provenance"]);
    expect(suite.passed).toBe(true);
  });
});
