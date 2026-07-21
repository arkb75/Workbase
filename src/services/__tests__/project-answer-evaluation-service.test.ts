import { describe, expect, it } from "vitest";
import {
  evaluateAccomplishmentAnswerStructure,
  evaluateRuntimeRequirementCoverage,
  isEntityValidationCurrent,
  parseRuntimeAccomplishmentAudit,
} from "@/src/services/project-answer-evaluation-service";

describe("project answer evaluation", () => {
  it("requires 4–6 prioritized cited accomplishments without artifact-only grounding", () => {
    const capabilities = [
      ["Career product", "Turned project evidence into career content."],
      ["Repository lifecycle", "Reconciled current repository knowledge."],
      ["AI runtime", "Implemented structured Bedrock generation."],
      ["Durable workflows", "Orchestrated retry-aware background runs."],
      ["Grounded retrieval", "Combined retrieval with citation provenance."],
    ];
    const content = capabilities.map(([heading, body], index) =>
      `### ${heading}\n${body} [citation:${index + 1}]`,
    ).join("\n\n");
    const evaluation = evaluateAccomplishmentAnswerStructure({
      content,
      citations: Array.from({ length: 5 }, (_, index) => ({ ordinal: index + 1, kind: "project_fact" })),
    });
    expect(evaluation).toMatchObject({
      accomplishmentCount: 5,
      countInRange: true,
      nonredundant: true,
      allBlocksCited: true,
      noArtifactOnlyBlocks: true,
    });
  });

  it("flags redundant, uncited, and artifact-only blocks", () => {
    const evaluation = evaluateAccomplishmentAnswerStructure({
      content: [
        "### Retrieval system\nBuilt grounded retrieval with citations. [citation:1]",
        "### Retrieval and citation system\nBuilt grounded retrieval with citations and sources. [citation:1]",
        "### UI\nBuilt a review workspace.",
      ].join("\n\n"),
      citations: [{ ordinal: 1, kind: "artifact" }],
    });
    expect(evaluation.nonredundant).toBe(false);
    expect(evaluation.uncitedBlocks).toEqual([3]);
    expect(evaluation.artifactOnlyBlocks).toEqual([1, 2]);
  });

  it("uses the runtime completeness bounds instead of imposing seven blocks unconditionally", () => {
    const content = Array.from({ length: 4 }, (_, index) =>
      `### Capability ${index + 1}\nImplemented supported capability ${index + 1}. [citation:${index + 1}]`,
    ).join("\n\n");
    const evaluation = evaluateAccomplishmentAnswerStructure({
      content,
      citations: Array.from({ length: 4 }, (_, index) => ({ ordinal: index + 1, kind: "project_fact" })),
      countRange: { minimum: 4, maximum: 10 },
    });

    expect(evaluation.countInRange).toBe(true);
    expect(evaluation.countRange).toEqual({ minimum: 4, maximum: 10 });
  });

  it("parses and evaluates the runtime requirement manifest as the completeness authority", () => {
    const audit = parseRuntimeAccomplishmentAudit({
      requirements: [
        { key: "ai_runtime", subsystemKeys: ["ai_runtime"], sourceRefs: [{ kind: "project_fact", sourceId: "fact-ai", title: "AI runtime" }] },
        { key: "workflow_orchestration", subsystemKeys: ["workflow_orchestration"], sourceRefs: [{ kind: "project_fact", sourceId: "fact-workflow", title: "Workflows" }] },
      ],
      minimumBlocks: 2,
      maximumBlocks: 10,
    });
    expect(audit).not.toBeNull();
    expect(evaluateRuntimeRequirementCoverage({
      requirements: audit!.requirements,
      citedSources: [{ kind: "project_fact", sourceId: "fact-ai" }],
    })).toMatchObject({
      complete: false,
      missing: [expect.objectContaining({ key: "workflow_orchestration" })],
    });
  });

  it("requires a represented source for every member of a grouped runtime requirement", () => {
    const audit = parseRuntimeAccomplishmentAudit({
      requirements: [{
        key: "project_chat_grounding",
        subsystemKeys: ["project_chat_grounding"],
        sourceRefs: [
          { kind: "project_fact", sourceId: "fact-chat", title: "Chat" },
          { kind: "project_fact", sourceId: "fact-citations", title: "Citations" },
        ],
        members: [
          { title: "Chat", sourceRefs: [{ kind: "project_fact", sourceId: "fact-chat", title: "Chat" }] },
          { title: "Citations", sourceRefs: [{ kind: "project_fact", sourceId: "fact-citations", title: "Citations" }] },
        ],
      }],
      minimumBlocks: 1,
      maximumBlocks: 10,
    });
    const coverage = evaluateRuntimeRequirementCoverage({
      requirements: audit!.requirements,
      citedSources: [{ kind: "project_fact", sourceId: "fact-chat" }],
    });

    expect(coverage.complete).toBe(false);
    expect(coverage.missingMembers).toEqual([{ requirementKey: "project_chat_grounding", title: "Citations" }]);
  });

  it("validates every repository head recorded by a multi-repository entity", () => {
    const targets = [
      { sourceId: "repo-a", commitSha: "a".repeat(40) },
      { sourceId: "repo-b", commitSha: "b".repeat(40) },
    ];
    expect(isEntityValidationCurrent({
      validationHeads: { "repo-a": "a".repeat(40), "repo-b": "b".repeat(40) },
      validatedThroughSha: null,
      targetHeads: targets,
    })).toBe(true);
    expect(isEntityValidationCurrent({
      validationHeads: { "repo-a": "a".repeat(40), "repo-b": "c".repeat(40) },
      validatedThroughSha: "a".repeat(40),
      targetHeads: targets,
    })).toBe(false);
  });
});
