import { describe, expect, it } from "vitest";
import { deterministicExecutionDecision } from "@/src/services/project-execution-router-service";
import type { ProjectTurnIntent } from "@/src/services/project-agent-harness";

function intent(overrides: Partial<ProjectTurnIntent> = {}): ProjectTurnIntent {
  return {
    kind: "direct_answer",
    confidence: 0.9,
    reason: "Approved current memory answers the request.",
    freshness: "none",
    coverage: "targeted",
    deliverable: "Answer the project question.",
    references: [],
    ...overrides,
  };
}

describe("project execution router safety envelope", () => {
  it("keeps ordinary grounded conversation in memory", () => {
    expect(deterministicExecutionDecision(intent(), 1)).toMatchObject({
      mode: "memory_only",
      suggestedWorkerCount: 0,
    });
  });

  it("routes broad freshness requests to a bounded four-worker refresh", () => {
    expect(deterministicExecutionDecision(intent({
      kind: "repository_research",
      freshness: "required",
      coverage: "bounded_comprehensive",
    }), 1)).toMatchObject({
      mode: "repository_refresh",
      breadth: "exhaustive",
      suggestedWorkerCount: 4,
    });
  });

  it("refuses repository research when no attached repository is authorized", () => {
    expect(deterministicExecutionDecision(intent({ kind: "repository_research" }), 0)).toMatchObject({
      mode: "insufficient_context",
      suggestedWorkerCount: 0,
    });
  });
});
