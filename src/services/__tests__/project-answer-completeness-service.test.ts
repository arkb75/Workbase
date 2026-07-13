import { describe, expect, it } from "vitest";
import {
  MAX_ACCOMPLISHMENT_CITATIONS,
  TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS,
  auditAccomplishmentBlocks,
  buildDeterministicAccomplishmentBlocks,
  selectAccomplishmentRequirementSet,
  selectAccomplishmentRequirements,
  serializeGroundedBlocks,
  verifyCompletedAccomplishmentAnswer,
  type AccomplishmentGroundingEntry,
} from "@/src/services/project-answer-completeness-service";
import { groundProjectAnswer } from "@/src/services/project-answer-grounding-service";

const descriptions: Record<string, string> = {
  product_surface: "Delivers the complete career content product surface from evidence intake through reviewed output.",
  repository_knowledge_lifecycle: "Refreshes repository knowledge and reconciles stale facts against an immutable commit.",
  project_chat_grounding: "Grounds project chat answers in reviewed memory with claim-level citations.",
  artifact_generation: "Drafts resume bullets and project summaries from approved highlights.",
  knowledge_review_lifecycle: "Supports review, revision, approval, rejection, and supersession of project knowledge.",
  workflow_orchestration: "Resumes durable workflows safely across review boundaries and retries.",
  ai_runtime: "Runs schema-constrained Bedrock generation with bounded tool orchestration.",
  retrieval_provenance: "Combines lexical and vector retrieval while preserving immutable provenance.",
  ingestion_integrations: "Imports repository evidence through authenticated GitHub integration.",
  domain_data: "Persists chat, facts, highlights, artifacts, evidence, and workflow runs in a normalized data model.",
  review_ui: "Provides review workspaces for sources, highlights, facts, artifacts, and chat citations.",
  tests_operations: "Tests domain rules, AI runtimes, repository exploration, retrieval, workflows, and interfaces.",
};

function entry(
  index: number,
  subsystemKey: string,
  options: {
    importance?: number;
    content?: string;
    title?: string;
    citationIndexes?: number[];
    currentRun?: boolean;
    ranking?: AccomplishmentGroundingEntry["accomplishmentRanking"];
  } = {},
): AccomplishmentGroundingEntry {
  const importance = options.importance ?? 5;
  const label = subsystemKey.replaceAll("_", " ");
  return {
    kind: "project_fact",
    authority: "verified_project_fact",
    title: options.title ?? `${label} capability`,
    content: options.content ?? descriptions[subsystemKey] ?? `Coordinates ${label} with verified safeguards and durable state.`,
    currentRun: options.currentRun ?? true,
    citationIndexes: options.citationIndexes ?? [index],
    supportingSources: [],
    subsystemKey,
    accomplishmentRanking: options.ranking === undefined ? {
      evidenceStrength: 5,
      productImportance: importance,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      ownershipAuthority: 1,
      distinctiveness: 4,
      freshness: 5,
      impactBonus: 0,
      uncertainty: null,
    } : options.ranking,
  };
}

describe("project answer completeness", () => {
  it("requires semantic coverage of each high-importance subsystem after grounding", () => {
    const entries = [entry(1, "ai_runtime"), entry(2, "workflow_orchestration"), entry(3, "retrieval_provenance")];
    const audit = auditAccomplishmentBlocks([
      { heading: "AI runtime", bodyMarkdown: entries[0]!.content, citationIndexes: [1] },
      { heading: "Retrieval", bodyMarkdown: entries[2]!.content, citationIndexes: [3] },
    ], entries);

    expect(audit.complete).toBe(false);
    expect(audit.missing.map((item) => item.subsystemKey)).toEqual(["workflow_orchestration"]);
  });

  it("does not let citation stuffing satisfy unrelated semantic requirements", () => {
    const entries = [entry(1, "ai_runtime"), entry(2, "workflow_orchestration"), entry(3, "retrieval_provenance")];
    const audit = auditAccomplishmentBlocks([{
      heading: "Schema-constrained AI",
      bodyMarkdown: entries[0]!.content,
      citationIndexes: [1, 2, 3],
    }], entries);

    expect(audit.missingMembers.map((item) => item.requirementKey)).toEqual([
      "workflow_orchestration",
      "retrieval_provenance",
    ]);
  });

  it("merges important same-subsystem facts instead of silently discarding one", () => {
    const requirements = selectAccomplishmentRequirements([
      entry(1, "ai_runtime", { content: "Runs bounded Bedrock Converse tool loops with token accounting." }),
      entry(2, "ai_runtime", { importance: 4, content: "Validates structured Bedrock responses against JSON schemas." }),
      entry(3, "workflow_orchestration"),
    ]);
    const runtime = requirements.find((requirement) => requirement.subsystemKey === "ai_runtime");

    expect(requirements.map((item) => item.subsystemKey)).toEqual(["workflow_orchestration", "ai_runtime"]);
    expect(runtime?.members).toHaveLength(2);
    expect(runtime?.citationIndexes).toEqual([1, 2]);
    expect(runtime?.content).toContain("bounded Bedrock Converse tool loops");
    expect(runtime?.content).toContain("JSON schemas");
    expect(serializeGroundedBlocks([{
      heading: "Durable workflows",
      bodyMarkdown: "Resumes durable workflows safely across review boundaries and retries.",
      citationIndexes: [3, 1],
    }])).toBe("### Durable workflows\nResumes durable workflows safely across review boundaries and retries. [citation:3][citation:1]");
  });

  it("treats module facts as supporting detail when seven top-level systems are supported", () => {
    const topLevel = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.slice(0, 7)
      .map((subsystem, index) => entry(index + 1, subsystem));
    const moduleFact = entry(20, "module:utility", {
      title: "Utility module",
      content: "Implements a narrow whitespace helper used by one service.",
    });

    const selection = selectAccomplishmentRequirementSet([...topLevel, moduleFact]);
    // product_surface and artifact_generation intentionally share one broad
    // product/output requirement, preserving both members inside the block.
    expect(selection.requirements).toHaveLength(6);
    expect(selection.requirements.some((requirement) => requirement.requirementKey === "module:utility")).toBe(false);
  });

  it("does not make an unranked current-run observation mandatory by itself", () => {
    const topLevel = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.slice(0, 7)
      .map((subsystem, index) => entry(index + 1, subsystem));
    const observation = entry(20, "recent_observation", {
      content: "A recently inspected symbol exists in one file.",
      ranking: null,
      currentRun: true,
    });

    const selection = selectAccomplishmentRequirementSet([...topLevel, observation]);
    expect(selection.requirements.some((requirement) => requirement.requirementKey === "recent_observation")).toBe(false);
  });

  it("surfaces honest overflow when more than ten important systems are supported", () => {
    const entries = [
      ...TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.map((subsystem, index) => entry(index + 1, subsystem)),
      entry(30, "security_operations", {
        content: "Redacts credentials and rejects unsafe repository content before model use.",
      }),
    ];
    const selection = selectAccomplishmentRequirementSet(entries);

    expect(selection.requirements).toHaveLength(10);
    expect(selection.omittedImportantEntries).toHaveLength(1);
    expect(selection.coverageWarning).toMatch(/10 capability areas.*1 additional supported item/i);
  });

  it("fits all twelve top-level systems into ten requirements through explicit aliases", () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS
      .map((subsystem, index) => entry(index + 1, subsystem));
    const selection = selectAccomplishmentRequirementSet(entries);

    expect(selection.requirements).toHaveLength(10);
    expect(selection.requirements.find((requirement) =>
      requirement.requirementKey === "product_and_artifact_generation"
    )?.members).toHaveLength(2);
    expect(selection.requirements.find((requirement) =>
      requirement.requirementKey === "knowledge_review_experience"
    )?.members).toHaveLength(2);
    expect(selection.requirements.flatMap((requirement) => requirement.members)).toHaveLength(12);
    expect(selection.coverageWarning).toBeNull();
  });

  it("never selects more than twenty unique citations", () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.slice(0, 10).map((subsystem, index) => {
      const start = index * 3 + 1;
      return entry(start, subsystem, { citationIndexes: [start, start + 1, start + 2] });
    });
    const selection = selectAccomplishmentRequirementSet(entries);
    const selectedCitationCount = new Set(selection.requirements.flatMap((requirement) => requirement.citationIndexes)).size;

    expect(selectedCitationCount).toBeLessThanOrEqual(MAX_ACCOMPLISHMENT_CITATIONS);
    expect(selection.requirements).toHaveLength(9);
    expect(selection.requirements.every((requirement) => requirement.members.length > 0)).toBe(true);
  });

  it("preserves each required source index in the deterministic notebook fallback", () => {
    const entries = [entry(2, "ai_runtime"), entry(5, "workflow_orchestration"), entry(8, "retrieval_provenance")];
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    expect(blocks.map((block) => block.citationIndexes)).toEqual([[5], [2], [8]]);
    expect(auditAccomplishmentBlocks(blocks, entries).missing).toEqual([]);
  });

  it("fails safely when the second verifier is unavailable", async () => {
    const entries = [entry(1, "ai_runtime")];
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    const completion = {
      blocks,
      safeOriginalBlocks: blocks,
      audit: auditAccomplishmentBlocks(blocks, entries),
      generationRunId: null,
      fallbackUsed: true,
      warning: "The completeness editor failed.",
    };

    const verified = await verifyCompletedAccomplishmentAnswer({
      completion,
      entries,
      citationCount: 1,
      verifier: (async () => { throw new Error("verifier outage"); }) as typeof groundProjectAnswer,
    });
    expect(verified.partial).toBe(true);
    expect(verified.grounded.blocks).toEqual(blocks);
    expect(verified.warning).toMatch(/subset already verified by the first grounding pass/i);
  });

  it("never publishes ownership language restored by a deterministic fallback", async () => {
    const entries = [entry(1, "product_surface", {
      title: "Solo ownership",
      content: "You solo-built the complete Workbase product.",
    })];
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    const completion = {
      blocks,
      safeOriginalBlocks: [],
      audit: auditAccomplishmentBlocks(blocks, entries),
      generationRunId: null,
      fallbackUsed: true,
      warning: "The completeness editor failed.",
    };

    await expect(verifyCompletedAccomplishmentAnswer({
      completion,
      entries,
      citationCount: 1,
    })).rejects.toThrow(/not safe to publish and should be retried/i);
  });
});
