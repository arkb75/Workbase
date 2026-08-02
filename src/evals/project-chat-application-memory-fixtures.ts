export type GroundedComparisonEvaluationScenarioId =
  | "compare_refresh_and_research"
  | "long_thread_rollover";

export type GroundedComparisonEvaluationFactKey =
  | "repository_refresh"
  | "targeted_research"
  | "earlier_memory_decision"
  | "current_runtime";

export interface GroundedComparisonEvaluationFact {
  key: GroundedComparisonEvaluationFactKey;
  statement: string;
  evidenceTitle: string;
  evidenceContent: string;
  subsystemKey: string;
  category: "architecture" | "behavior" | "data_flow";
}

export interface PersistedGroundedComparisonEvaluationFact
  extends GroundedComparisonEvaluationFact {
  id: string;
  evidenceItemId: string;
}

export interface GroundedComparisonEvaluationFixture {
  scenarioId: GroundedComparisonEvaluationScenarioId;
  sourceLabel: string;
  facts: readonly GroundedComparisonEvaluationFact[];
}

const groundedComparisonEvaluationFixtures = {
  compare_refresh_and_research: {
    scenarioId: "compare_refresh_and_research",
    sourceLabel: "Application evaluation evidence · refresh and targeted research",
    facts: [
      {
        key: "repository_refresh",
        statement:
          "Repository knowledge refresh: Workbase should use this path for broad, project-wide currency across an attached repository. It reconciles supported outputs into reviewed Project Facts and Highlights, which keeps trusted memory current, provenance-backed, and free of retired stale knowledge.",
        evidenceTitle: "Repository knowledge refresh scope and memory outcome",
        evidenceContent:
          "Workbase uses repository knowledge refresh for broad, project-wide currency across an attached repository. It reconciles supported refresh outputs into reviewed Project Facts and Highlights, which keeps trusted memory current and provenance-backed while stale knowledge is retired.",
        subsystemKey: "repository_knowledge_lifecycle",
        category: "data_flow",
      },
      {
        key: "targeted_research",
        statement:
          "Targeted repository research: Workbase should use this path for a specific evidence gap that approved memory cannot answer. It promotes supported outputs into reviewed Project Facts or Highlights with nested provenance, which lets chat reuse trusted findings while unsupported gaps remain explicit.",
        evidenceTitle: "Targeted repository research scope and memory outcome",
        evidenceContent:
          "Workbase uses targeted repository research for a specific evidence gap that approved memory cannot answer. It promotes supported findings into reviewed Project Facts or Highlights with nested provenance, which lets chat reuse trusted memory while unsupported gaps remain explicit.",
        subsystemKey: "project_chat_grounding",
        category: "behavior",
      },
    ],
  },
  long_thread_rollover: {
    scenarioId: "long_thread_rollover",
    sourceLabel: "Application evaluation evidence · long-thread comparison",
    facts: [
      {
        key: "earlier_memory_decision",
        statement:
          "Earlier decision: repository discoveries become reviewed durable Project Facts with provenance before ordinary project chat reuses them; raw repository exploration remains internal.",
        evidenceTitle: "Earlier reviewed-memory decision",
        evidenceContent:
          "The earlier decision requires repository discoveries to become reviewed durable Project Facts with provenance before ordinary project chat reuses them. Raw repository exploration remains internal.",
        subsystemKey: "project_chat_grounding",
        category: "behavior",
      },
      {
        key: "current_runtime",
        statement:
          "Current runtime: the provider-neutral model tool loop enforces iteration, tool, and token limits inside the durable workflow boundary for each project-chat turn.",
        evidenceTitle: "Current bounded model runtime",
        evidenceContent:
          "The current provider-neutral model tool loop enforces iteration, tool, and token limits inside the durable workflow boundary for each project-chat turn.",
        subsystemKey: "ai_runtime",
        category: "architecture",
      },
    ],
  },
} as const satisfies Record<
  GroundedComparisonEvaluationScenarioId,
  GroundedComparisonEvaluationFixture
>;

export function groundedComparisonEvaluationFixtureForScenario(
  scenarioId: string,
): GroundedComparisonEvaluationFixture | null {
  if (
    scenarioId !== "compare_refresh_and_research" &&
    scenarioId !== "long_thread_rollover"
  ) {
    return null;
  }
  return groundedComparisonEvaluationFixtures[scenarioId];
}

export function currentRunGroundedComparisonEvaluationFacts<
  T extends GroundedComparisonEvaluationFact,
>(scenarioId: string, facts: readonly T[]) {
  if (scenarioId === "compare_refresh_and_research") return [...facts];
  if (scenarioId === "long_thread_rollover") {
    return facts.filter((fact) => fact.key === "current_runtime");
  }
  return [];
}

const isolatedApplicationScenarioIds = new Set([
  "compare_refresh_and_research",
  "long_thread_rollover",
  "artifact_from_approved_context",
  "artifact_missing_impact",
  "artifact_review_gate",
]);

/**
 * Scenarios that write purpose-built evidence receive their own cleanup-owned
 * sandbox. This keeps their facts out of the selected real Work Item and keeps
 * one evaluation fixture from satisfying another scenario accidentally.
 */
export function projectChatApplicationSandboxIsolationKey(
  scenarioId: string,
) {
  return isolatedApplicationScenarioIds.has(scenarioId)
    ? scenarioId
    : undefined;
}

export function projectChatApplicationCleanupTargets(input: {
  createdRunIds: Iterable<string>;
  createdThreadIds: Iterable<string>;
  sandboxWorkItemIds: Iterable<string>;
}) {
  return {
    runIds: Array.from(new Set(input.createdRunIds)),
    threadIds: Array.from(new Set(input.createdThreadIds)),
    sandboxWorkItemIds: Array.from(new Set(input.sandboxWorkItemIds)),
  };
}

export function longThreadEvaluationMessageCore(
  sequence: number,
  role: "user" | "assistant",
) {
  if (sequence === 1) {
    return "Earlier decision under discussion: repository discoveries should become reviewed durable Project Facts before ordinary chat reuses them.";
  }
  if (sequence === 2) {
    return "Decision adopted: keep raw repository exploration internal and promote only supported findings into durable memory with provenance.";
  }
  if (sequence === 15) {
    return "Current-runtime question: how does the bounded model tool loop control a project-chat turn?";
  }
  if (sequence === 16) {
    return "Current runtime context: the provider-neutral model loop enforces tool and token limits inside the durable workflow boundary.";
  }
  return role === "user"
    ? `Intermediate project question ${Math.ceil(sequence / 2)} asked about repository knowledge and grounded chat.`
    : `Intermediate answer ${Math.ceil(sequence / 2)} explained that repository analysis becomes reviewed Project Facts with durable provenance.`;
}

function requiredPersistedFact(
  facts: readonly PersistedGroundedComparisonEvaluationFact[],
  key: GroundedComparisonEvaluationFactKey,
) {
  const fact = facts.find((candidate) => candidate.key === key);
  if (!fact) {
    throw new Error(
      `Application evaluation fixture is missing its required ${key} Project Fact.`,
    );
  }
  return fact;
}

/**
 * Builds canonical citation manifests for the seeded long thread. Historical
 * assistant turns cite the reviewed-memory decision; the final current-runtime
 * turn cites the current-run runtime fact.
 */
export function buildLongThreadEvaluationCitationRows(
  assistants: readonly { id: string; sequence: number }[],
  facts: readonly PersistedGroundedComparisonEvaluationFact[],
) {
  const earlierFact = requiredPersistedFact(facts, "earlier_memory_decision");
  const currentFact = requiredPersistedFact(facts, "current_runtime");
  return assistants.map((message) => {
    const fact = message.sequence === 16 ? currentFact : earlierFact;
    return {
      messageId: message.id,
      kind: "project_fact" as const,
      ordinal: 1,
      projectFactId: fact.id,
      label: fact.statement,
      excerpt: fact.statement,
    };
  });
}
