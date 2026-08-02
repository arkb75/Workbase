import { describe, expect, it } from "vitest";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";
import {
  buildLongThreadEvaluationCitationRows,
  currentRunGroundedComparisonEvaluationFacts,
  groundedComparisonEvaluationFixtureForScenario,
  longThreadEvaluationMessageCore,
  projectChatApplicationCleanupTargets,
  projectChatApplicationSandboxIsolationKey,
  type GroundedComparisonEvaluationScenarioId,
  type PersistedGroundedComparisonEvaluationFact,
} from "@/src/evals/project-chat-application-memory-fixtures";
import { projectChatApplicationScenarios } from "@/src/evals/project-chat-application-runner";
import { evaluateProjectChatAnswerQuality } from "@/src/evals/project-chat-answer-quality";
import {
  classifyProjectAnswerEditorialProfile,
  hasGroundedProjectAnswerComparison,
  selectProjectAnswerEditorialThemes,
} from "@/src/services/project-answer-editorial-service";
import { buildRollingConversationSummary } from "@/src/services/project-chat-store";

function scenario(id: GroundedComparisonEvaluationScenarioId) {
  return projectChatApplicationScenarios.find((candidate) => candidate.id === id)!;
}

function persistedFacts(
  scenarioId: GroundedComparisonEvaluationScenarioId,
): PersistedGroundedComparisonEvaluationFact[] {
  const fixture = groundedComparisonEvaluationFixtureForScenario(scenarioId)!;
  return fixture.facts.map((fact, index) => ({
    ...fact,
    id: `${scenarioId}-fact-${index + 1}`,
    evidenceItemId: `${scenarioId}-evidence-${index + 1}`,
  }));
}

function editorialEntries(
  facts: readonly PersistedGroundedComparisonEvaluationFact[],
  currentFactIds: ReadonlySet<string>,
): ProjectAnswerGroundingEntry[] {
  return facts.map((fact, index) => ({
    kind: "project_fact",
    authority: "verified_project_fact",
    title: fact.statement,
    content: fact.statement,
    currentRun: currentFactIds.has(fact.id),
    citationIndexes: [index + 1],
    retrievalRelevance: 1,
    ownershipAuthority: 0,
    supportingSources: [{
      type: "evidence",
      title: fact.evidenceTitle,
    }],
    subsystemKey: fact.subsystemKey,
    accomplishmentRanking: null,
  }));
}

function longThreadContext(
  facts: readonly PersistedGroundedComparisonEvaluationFact[],
) {
  const messages = Array.from({ length: 16 }, (_, index) => {
    const sequence = index + 1;
    const role = sequence % 2 === 1 ? "user" as const : "assistant" as const;
    return {
      id: `message-${sequence}`,
      sequence,
      role,
      content: `${longThreadEvaluationMessageCore(sequence, role)} ${
        role === "user" ? "q" : "a"
      }`.padEnd(4_100, role === "user" ? "q" : "a"),
    };
  });
  const assistants = messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({ id: message.id, sequence: message.sequence }));
  const citationRows = buildLongThreadEvaluationCitationRows(assistants, facts);
  const citationBySequence = new Map(
    assistants.map((message, index) => [message.sequence, citationRows[index]!]),
  );
  const rollingSummary = buildRollingConversationSummary(
    messages.slice(0, 4).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.role === "assistant"
        ? [{
            kind: "project_fact",
            label: citationBySequence.get(message.sequence)!.label,
          }]
        : [],
    })),
    6_000,
  );
  if (!rollingSummary) {
    throw new Error("The long-thread fixture must produce a rolling summary.");
  }
  const priorUser = messages[14]!;
  const priorAssistant = messages[15]!;
  return {
    citationRows,
    comparisonContext: {
      rollingSummary: rollingSummary.replace(/\s+/g, " ").trim().slice(0, 3_000),
      priorUserObjective: priorUser.content.replace(/\s+/g, " ").trim().slice(0, 1_000),
      priorAssistantAnswer: priorAssistant.content.replace(/\s+/g, " ").trim().slice(0, 2_000),
    },
  };
}

describe("grounded project-chat application memory fixtures", () => {
  it("grounds both exact refresh/research sides and every requested dimension", () => {
    const selectedScenario = scenario("compare_refresh_and_research");
    const facts = persistedFacts("compare_refresh_and_research");
    const currentRunFacts = currentRunGroundedComparisonEvaluationFacts(
      selectedScenario.id,
      facts,
    );
    const profile = classifyProjectAnswerEditorialProfile(selectedScenario.question);
    const selection = selectProjectAnswerEditorialThemes({
      question: selectedScenario.question,
      entries: editorialEntries(
        facts,
        new Set(currentRunFacts.map((fact) => fact.id)),
      ),
      profile,
    });

    expect(profile.comparisonContract?.requestedDimensions).toEqual([
      "when Workbase should use each",
      "how their outputs become trusted memory",
    ]);
    expect(hasGroundedProjectAnswerComparison(selection)).toBe(true);
    expect(selection.comparisonBindings?.map((binding) =>
      binding.supportedDimensions
    )).toEqual([
      profile.comparisonContract?.requestedDimensions,
      profile.comparisonContract?.requestedDimensions,
    ]);
    expect(selection.selectedThemes.map((theme) => theme.key)).toEqual([
      "repository_intelligence",
      "grounded_project_agent",
    ]);
    expect(currentRunFacts.map((fact) => fact.key)).toEqual([
      "repository_refresh",
      "targeted_research",
    ]);

    const deterministicTable = [
      "| Theme | Assessment |",
      "| --- | --- |",
      ...facts.map((fact, index) =>
        `| ${fact.key} | ${fact.statement} [citation:${index + 1}] |`
      ),
    ].join("\n");
    const qualityChecks = evaluateProjectChatAnswerQuality({
      answer: deterministicTable,
      contract: selectedScenario.answerContract!,
      citationMetadata: facts.map((fact, index) => ({
        ordinal: index + 1,
        type: "project_fact",
        title: fact.statement,
        statement: fact.statement,
      })),
    });
    expect(qualityChecks.filter((check) => !check.passed)).toEqual([]);
  });

  it("grounds the exact long-thread anchors only when current runtime is current-run evidence", () => {
    const selectedScenario = scenario("long_thread_rollover");
    const facts = persistedFacts("long_thread_rollover");
    const currentRuntime = facts.find((fact) => fact.key === "current_runtime")!;
    const earlierDecision = facts.find(
      (fact) => fact.key === "earlier_memory_decision",
    )!;
    const currentRunFacts = currentRunGroundedComparisonEvaluationFacts(
      selectedScenario.id,
      facts,
    );
    const { comparisonContext } = longThreadContext(facts);
    const profile = classifyProjectAnswerEditorialProfile(
      selectedScenario.question,
      comparisonContext,
    );
    const grounded = selectProjectAnswerEditorialThemes({
      question: selectedScenario.question,
      entries: editorialEntries(
        facts,
        new Set(currentRunFacts.map((fact) => fact.id)),
      ),
      profile,
    });
    const staleRuntime = selectProjectAnswerEditorialThemes({
      question: selectedScenario.question,
      entries: editorialEntries(facts, new Set()),
      profile,
    });

    expect(hasGroundedProjectAnswerComparison(grounded)).toBe(true);
    expect(grounded.selectedThemes.map((theme) => theme.key)).toEqual([
      "grounded_project_agent",
      "durable_ai_platform",
    ]);
    expect(grounded.comparisonBindings?.map((binding) => binding.subjectIndex))
      .toEqual([0, 1]);
    expect(currentRunFacts.map((fact) => fact.key)).toEqual([
      "current_runtime",
    ]);
    expect(editorialEntries(facts, new Set([currentRuntime.id]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: earlierDecision.statement,
          currentRun: false,
        }),
        expect.objectContaining({
          title: currentRuntime.statement,
          currentRun: true,
        }),
      ]),
    );
    expect(hasGroundedProjectAnswerComparison(staleRuntime)).toBe(false);
    expect(staleRuntime.comparisonBindings).toBeNull();
  });

  it("uses canonical Project Fact IDs in every seeded long-thread citation manifest", () => {
    const facts = persistedFacts("long_thread_rollover");
    const currentRuntime = facts.find((fact) => fact.key === "current_runtime")!;
    const earlierDecision = facts.find(
      (fact) => fact.key === "earlier_memory_decision",
    )!;
    const { citationRows } = longThreadContext(facts);

    expect(citationRows).toHaveLength(8);
    expect(citationRows.every((citation) =>
      citation.kind === "project_fact" && Boolean(citation.projectFactId)
    )).toBe(true);
    expect(citationRows.find((citation) => citation.messageId === "message-16"))
      .toMatchObject({
        projectFactId: currentRuntime.id,
        label: currentRuntime.statement,
        excerpt: currentRuntime.statement,
      });
    expect(citationRows
      .filter((citation) => citation.messageId !== "message-16")
      .every((citation) => citation.projectFactId === earlierDecision.id))
      .toBe(true);
  });

  it("isolates both fixtures from real memory and includes both sandboxes in cleanup", () => {
    const compareScenario = scenario("compare_refresh_and_research");
    const longThreadScenario = scenario("long_thread_rollover");
    const compareIsolationKey = projectChatApplicationSandboxIsolationKey(
      compareScenario.id,
    );
    const longThreadIsolationKey = projectChatApplicationSandboxIsolationKey(
      longThreadScenario.id,
    );
    const cleanup = projectChatApplicationCleanupTargets({
      createdRunIds: ["run-compare", "run-long", "run-compare"],
      createdThreadIds: ["thread-compare", "thread-long"],
      sandboxWorkItemIds: ["sandbox-compare", "sandbox-long"],
    });

    expect(compareScenario.workspace).toBe("empty_sandbox");
    expect(longThreadScenario.workspace).toBe("empty_sandbox");
    expect(compareIsolationKey).toBe("compare_refresh_and_research");
    expect(longThreadIsolationKey).toBe("long_thread_rollover");
    expect(compareIsolationKey).not.toBe(longThreadIsolationKey);
    expect(cleanup).toEqual({
      runIds: ["run-compare", "run-long"],
      threadIds: ["thread-compare", "thread-long"],
      sandboxWorkItemIds: ["sandbox-compare", "sandbox-long"],
    });
    expect(cleanup.sandboxWorkItemIds).not.toContain("main-work-item");
  });
});
