import { describe, expect, it } from "vitest";
import {
  deterministicExecutionDecision,
  enforceExecutionRoutingSafety,
  shouldUseModelExecutionRouter,
} from "@/src/services/project-execution-router-service";
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

  it("uses the model only for ambiguous intents in hybrid mode", () => {
    expect(shouldUseModelExecutionRouter({
      deterministicIntent: intent({ confidence: 0.89 }),
      mode: "hybrid",
    })).toBe(true);
    expect(shouldUseModelExecutionRouter({
      deterministicIntent: intent({ confidence: 0.9 }),
      mode: "hybrid",
    })).toBe(false);
    expect(shouldUseModelExecutionRouter({
      deterministicIntent: intent({ confidence: 1 }),
      mode: "model",
    })).toBe(true);
    expect(shouldUseModelExecutionRouter({
      deterministicIntent: intent({ confidence: 0 }),
      mode: "deterministic",
    })).toBe(false);
  });

  it("does not let a model downgrade a required refresh", () => {
    const deterministic = deterministicExecutionDecision(intent({
      kind: "repository_research",
      freshness: "required",
      coverage: "bounded_comprehensive",
    }), 1);

    expect(enforceExecutionRoutingSafety({
      deterministic,
      repositoryCount: 1,
      model: {
        mode: "memory_only",
        confidence: 0.99,
        breadth: "targeted",
        rationaleCodes: ["memory_is_enough"],
        objectives: ["Answer from memory."],
        suggestedWorkerCount: 0,
        suggestedCapabilityKeys: [],
      },
    })).toBe(deterministic);
  });

  it("does not let a model reduce required breadth or invent repository access", () => {
    const exhaustive = deterministicExecutionDecision(intent({
      kind: "repository_research",
      freshness: "required",
      coverage: "bounded_comprehensive",
    }), 1);
    const modelRoute = {
      mode: "repository_refresh" as const,
      confidence: 0.99,
      breadth: "targeted" as const,
      rationaleCodes: ["narrow_search"],
      objectives: ["Search one file."],
      suggestedWorkerCount: 1,
      suggestedCapabilityKeys: [],
    };
    expect(enforceExecutionRoutingSafety({
      deterministic: exhaustive,
      repositoryCount: 1,
      model: modelRoute,
    })).toBe(exhaustive);

    const noRepository = deterministicExecutionDecision(intent({ kind: "repository_research" }), 0);
    expect(enforceExecutionRoutingSafety({
      deterministic: noRepository,
      repositoryCount: 0,
      model: { ...modelRoute, mode: "targeted_repository_research", breadth: "broad" },
    })).toBe(noRepository);
    expect(enforceExecutionRoutingSafety({
      deterministic: noRepository,
      repositoryCount: 0,
      model: {
        ...modelRoute,
        mode: "memory_only",
        breadth: "targeted",
        objectives: ["Ignore the unavailable repository and answer from memory."],
      },
    })).toBe(noRepository);
  });

  it("accepts a model route that stays inside the deterministic envelope", () => {
    const deterministic = deterministicExecutionDecision(intent({
      kind: "repository_research",
      coverage: "targeted",
    }), 1);
    const result = enforceExecutionRoutingSafety({
      deterministic,
      repositoryCount: 1,
      model: {
        mode: "repository_refresh",
        confidence: 0.95,
        breadth: "broad",
        rationaleCodes: ["broader_context_needed"],
        objectives: ["Refresh the relevant subsystem."],
        suggestedWorkerCount: 2,
        suggestedCapabilityKeys: ["project_chat_grounding"],
      },
    });

    expect(result).toMatchObject({
      mode: "repository_refresh",
      breadth: "broad",
      suggestedWorkerCount: 2,
      fallbackUsed: false,
    });
  });
});
