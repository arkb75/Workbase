import { describe, expect, it } from "vitest";
import {
  MAX_ACCOMPLISHMENT_CITATIONS,
  TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS,
  auditAccomplishmentBlocks,
  buildDeterministicAccomplishmentBlocks,
  compactAlreadyGroundedAccomplishmentBlocks,
  selectAccomplishmentRequirementSet,
  selectAccomplishmentRequirements,
  serializeGroundedBlocks,
  validateExactSourceAccomplishmentBlocks,
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
    expect(new Set(runtime?.citationIndexes)).toEqual(new Set([1, 2]));
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
    expect(selection.coverageWarning).toMatch(/10 capability areas.*1 additional supported capability area/i);
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

  it("caps a broad requirement at two representatives and does not warn about dropped same-area detail", () => {
    const product = entry(1, "product_surface", {
      importance: 3,
      ranking: {
        evidenceStrength: 5,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        ownershipAuthority: 1,
        distinctiveness: 4,
        freshness: 5,
        impactBonus: 0,
        uncertainty: null,
      },
    });
    const artifactPrimary = entry(2, "artifact_generation");
    const artifactExtra = entry(3, "artifact_generation", {
      content: "Persists immutable artifact evidence snapshots and refreshed embeddings.",
    });
    const selection = selectAccomplishmentRequirementSet([artifactPrimary, artifactExtra, product]);
    const requirement = selection.requirements[0]!;

    expect(requirement.requirementKey).toBe("product_and_artifact_generation");
    expect(requirement.members.map((member) => member.subsystemKey)).toEqual([
      "product_surface",
      "artifact_generation",
    ]);
    expect(selection.coverageWarning).toBeNull();
  });

  it.each([
    {
      subsystem: "ingestion_integrations",
      broadTitle: "Implemented GitHub OAuth repository import",
      broadContent: "GitHub OAuth connect and callback routes authorize bounded repository source imports.",
      narrowTitle: "Optimized internal source-key normalization",
    },
    {
      subsystem: "domain_data",
      broadTitle: "Designed the Prisma and PostgreSQL data model",
      broadContent: "The Prisma schema persists normalized application state in Neon PostgreSQL.",
      narrowTitle: "Adjusted one internal record mapper",
    },
    {
      subsystem: "tests_operations",
      broadTitle: "Built broad automated Vitest coverage",
      broadContent: "Automated unit, integration, workflow, and UI tests run through the Vitest test suite.",
      narrowTitle: "Refined one fixture helper",
    },
    {
      subsystem: "review_ui",
      broadTitle: "Built the project workspace user interface",
      broadContent: "The project workspace provides chat, source, review, artifact, citation, and progress views.",
      narrowTitle: "Refined one citation popover",
    },
  ])("prioritizes broad $subsystem coverage anchors over a higher-scored narrow detail", ({
    subsystem,
    broadTitle,
    broadContent,
    narrowTitle,
  }) => {
    const broad = entry(1, subsystem, {
      title: broadTitle,
      content: broadContent,
      ranking: {
        evidenceStrength: 4,
        productImportance: 3,
        implementationBreadth: 2,
        technicalDifficulty: 3,
        ownershipAuthority: 1,
        distinctiveness: 3,
        freshness: 5,
        impactBonus: 0,
        uncertainty: null,
      },
    });
    const narrow = entry(2, subsystem, {
      title: narrowTitle,
      content: "A narrow internal implementation detail was changed.",
    });

    const requirement = selectAccomplishmentRequirementSet([narrow, broad]).requirements[0]!;
    expect(requirement.members[0]?.title).toBe(broadTitle);
  });

  it("deduplicates near-identical same-subsystem facts while preserving distinct work", () => {
    const primary = entry(1, "repository_knowledge_lifecycle", {
      title: "Audited multi-subsystem LLM synthesis with deterministic fallback",
      content: "Repository knowledge synthesis batches subsystems through audited LLM generation with deterministic regex fallback and provenance citation indexes.",
    });
    const duplicate = entry(2, "repository_knowledge_lifecycle", {
      title: "Repository knowledge synthesis with audited LLM fallback",
      content: "Audited repository knowledge synthesis batches multiple subsystems, emits provenance citation indexes, and uses a deterministic regex fallback when LLM generation is unavailable.",
    });
    const distinct = entry(3, "repository_knowledge_lifecycle", {
      title: "Knowledge change supersession and invalidation",
      content: "Quarantine guards, supersession detection, transactional reverts, embedding refresh, and cascading artifact invalidation govern reviewed knowledge changes.",
    });

    const requirement = selectAccomplishmentRequirementSet([primary, duplicate, distinct]).requirements[0]!;
    expect(requirement.members.map((member) => member.title)).toEqual([
      primary.title,
      distinct.title,
    ]);
    expect(requirement.citationIndexes).toEqual([1, 3]);
  });

  it("safely compacts overlong already-grounded coverage without adding prose", () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS
      .map((subsystem, index) => entry(index + 1, subsystem));
    const originalBlocks = entries.map((item) => ({
      heading: null,
      bodyMarkdown: item.content,
      citationIndexes: item.citationIndexes,
    }));
    expect(auditAccomplishmentBlocks(originalBlocks, entries).complete).toBe(false);
    expect(auditAccomplishmentBlocks(originalBlocks, entries).missingMembers).toEqual([]);

    const compacted = compactAlreadyGroundedAccomplishmentBlocks(originalBlocks, entries);
    expect(compacted).not.toBeNull();
    expect(compacted).toHaveLength(10);
    expect(compacted!.every((block) => Boolean(block.heading))).toBe(true);
    expect(auditAccomplishmentBlocks(compacted!, entries).complete).toBe(true);
    for (const paragraph of compacted!.flatMap((block) => block.bodyMarkdown.split("\n\n"))) {
      expect(originalBlocks.map((block) => block.bodyMarkdown)).toContain(paragraph);
    }
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

  it("builds a complete ten-area fallback from exact durable titles and exact ownership citations", () => {
    const technicalEntries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.map((subsystem, index) =>
      entry(index + 1, subsystem, {
        title: `Implemented ${subsystem.replaceAll("_", " ")}`,
      })
    );
    const ownershipEntry: AccomplishmentGroundingEntry = {
      kind: "evidence",
      authority: "included_evidence",
      title: "Work Item description",
      content: "The user built Workbase.",
      currentRun: false,
      citationIndexes: [99],
      ownershipAuthority: 3,
      supportingSources: [],
      subsystemKey: null,
      accomplishmentRanking: null,
    };
    const entries = [...technicalEntries, ownershipEntry];
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    const validated = validateExactSourceAccomplishmentBlocks({
      blocks,
      entries,
      citationCount: 99,
    });

    expect(blocks).toHaveLength(10);
    expect(validated.audit.complete).toBe(true);
    expect(validated.audit.coverageWarning).toBeNull();
    expect(blocks.every((block) => block.citationIndexes.includes(99))).toBe(true);
    expect(blocks[0]).toMatchObject({
      heading: "Career Content Product & Artifact Pipeline",
      bodyMarkdown: expect.stringContaining("- Implemented product surface"),
    });
    for (const technicalEntry of technicalEntries) {
      expect(blocks.some((block) => block.bodyMarkdown.includes(technicalEntry.title))).toBe(true);
      expect(blocks.some((block) => block.citationIndexes.includes(technicalEntry.citationIndexes[0]!))).toBe(true);
    }
  });

  it("publishes a validated exact-source editor fallback without calling a verifier", async () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.map((subsystem, index) => entry(index + 1, subsystem));
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    const completion = {
      blocks,
      exactSourceBlocks: blocks,
      audit: auditAccomplishmentBlocks(blocks, entries),
      generationRunId: null,
      fallbackUsed: true,
      warning: "The completeness editor failed.",
    };
    let calls = 0;
    const verified = await verifyCompletedAccomplishmentAnswer({
      completion,
      entries,
      citationCount: entries.length,
      verifier: (async () => {
        calls += 1;
        throw new Error("verifier should not run");
      }) as typeof groundProjectAnswer,
    });

    expect(calls).toBe(0);
    expect(verified.partial).toBe(false);
    expect(verified.grounded.blocks).toEqual(blocks);
    expect(verified.audit.complete).toBe(true);
  });

  it("rejects an exact-source fallback whose ownership language lacks an ownership source", () => {
    const entries = [entry(1, "product_surface", {
      title: "You solo-built Workbase",
      content: "You solo-built the complete Workbase product.",
    })];
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);

    expect(() => validateExactSourceAccomplishmentBlocks({
      blocks,
      entries,
      citationCount: 1,
    })).toThrow(/violated the grounding contract/i);
  });

  it("falls back after one failed combined verifier without pair or singleton recovery fanout", async () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS
      .map((subsystem, index) => entry(index + 1, subsystem));
    const exactSourceBlocks = buildDeterministicAccomplishmentBlocks([], entries);
    const completion = {
      blocks: exactSourceBlocks.map((block) => ({
        heading: block.heading ?? "Accomplishment",
        bodyMarkdown: `${block.bodyMarkdown} `,
        citationIndexes: block.citationIndexes,
      })),
      exactSourceBlocks,
      audit: auditAccomplishmentBlocks(exactSourceBlocks, entries),
      generationRunId: "generation-1",
      fallbackUsed: false,
      warning: null,
    };
    let calls = 0;
    const verifier = (async () => {
      calls += 1;
      throw new Error("combined verifier parse failure");
    }) as typeof groundProjectAnswer;

    const verified = await verifyCompletedAccomplishmentAnswer({
      completion,
      entries,
      citationCount: entries.length,
      verifier,
    });

    expect(calls).toBe(1);
    expect(verified.partial).toBe(false);
    expect(verified.audit.complete).toBe(true);
    expect(verified.grounded.blocks).toEqual(exactSourceBlocks);
    expect(verified.grounded.issues).toEqual([
      expect.stringContaining("restored from exact durable source text"),
    ]);
  });

  it("uses one single-attempt combined verifier when the editor succeeds", async () => {
    const entries = TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.slice(0, 8).map((subsystem, index) => entry(index + 1, subsystem));
    const blocks = buildDeterministicAccomplishmentBlocks([], entries);
    const completion = {
      blocks: blocks.map((block) => ({
        heading: block.heading ?? "Accomplishment",
        bodyMarkdown: block.bodyMarkdown,
        citationIndexes: block.citationIndexes,
      })),
      exactSourceBlocks: blocks,
      audit: auditAccomplishmentBlocks(blocks, entries),
      generationRunId: "generation-1",
      fallbackUsed: false,
      warning: null,
    };
    let calls = 0;
    const verifier = (async (input: Parameters<typeof groundProjectAnswer>[0]) => {
      calls += 1;
      expect(input.singleAttempt).toBe(true);
      return groundProjectAnswer(input);
    }) as typeof groundProjectAnswer;

    const verified = await verifyCompletedAccomplishmentAnswer({
      completion,
      entries,
      citationCount: entries.length,
      verifier,
    });

    expect(calls).toBe(1);
    expect(verified.partial).toBe(false);
    expect(verified.audit.complete).toBe(true);
  });
});
