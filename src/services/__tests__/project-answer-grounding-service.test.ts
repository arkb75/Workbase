import { describe, expect, it } from "vitest";
import {
  detectGroundingContractIssues,
  evaluateDeterministicAnswerGrounding,
  extractClaimCitationMap,
  findUnsupportedOwnershipClaims,
  groundProjectAnswer,
  projectAnswerGroundingExecutionOptions,
} from "@/src/services/project-answer-grounding-service";
import { parseProjectResearchDossier } from "@/src/services/project-research-dossier-service";

describe("project answer grounding contract", () => {
  const projectFactEntry = {
    kind: "project_fact",
    authority: "verified_project_fact",
    title: "Grounded chat is implemented",
    content: "The repository implements grounded project chat.",
    currentRun: true,
    citationIndexes: [1],
    ownershipAuthority: 0,
    supportingSources: [],
  };
  const ownedHighlightEntry = {
    kind: "highlight",
    authority: "verified_highlight",
    title: "Designed grounded project chat",
    content: "The user designed the grounded chat system.",
    currentRun: false,
    citationIndexes: [2],
    ownershipAuthority: 5,
    supportingSources: [],
  };
  const selfReportedDescriptionEntry = {
    kind: "evidence",
    authority: "included_evidence",
    title: "Work Item description",
    content: "Built Workbase as a full-stack project.",
    currentRun: false,
    citationIndexes: [3],
    ownershipAuthority: 3,
    supportingSources: [],
  };

  it("rejects unavailable citation ordinals", () => {
    expect(detectGroundingContractIssues({
      answer: "A supported claim [citation:1] and an invalid claim [citation:7].",
      citationCount: 2,
    })).toContain("The answer references unavailable citation [citation:7].");
  });

  it("bounds the optional final verifier to one native structured request", () => {
    const options = projectAnswerGroundingExecutionOptions(true);
    expect(options.transportPreference).toEqual(["json_schema"]);
    expect(options.budget?.limits).toEqual({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 30_000,
    });
  });

  it("records claim-level citation mappings", () => {
    expect(extractClaimCitationMap(
      "Implemented durable workflow resumption [citation:2].\n\nAdded SHA-pinned research [citation:1][citation:3].",
    )).toEqual([
      { claim: "Implemented durable workflow resumption.", citationIndexes: [2] },
      { claim: "Added SHA-pinned research.", citationIndexes: [1, 3] },
    ]);
  });

  it("does not let an old import date masquerade as current after live research", () => {
    const dossier = parseProjectResearchDossier({
      objective: "Current assessment",
      phase: "finalizing",
      updatedAt: "2026-07-10T20:30:00.000Z",
      repositories: [{
        sourceId: "source-1",
        name: "arkb75/Workbase",
        importedAt: "2026-04-06T02:05:31.418Z",
        pinnedSha: "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5",
        committedAt: "2026-07-09T23:02:00.000Z",
        resolvedAt: "2026-07-10T20:30:00.000Z",
      }],
    });
    expect(detectGroundingContractIssues({
      answer: "This assessment is current as of April 6, 2026.",
      citationCount: 0,
      dossier,
    })).toContain("The answer labels the source import date as current even though a newer repository inspection exists.");
  });

  it("does not let repository-only facts establish personal ownership", () => {
    expect(findUnsupportedOwnershipClaims({
      answer: "You solo-built the grounded chat system. [citation:1]",
      entries: [projectFactEntry, ownedHighlightEntry],
    })).toEqual(["You solo-built the grounded chat system."]);

    expect(findUnsupportedOwnershipClaims({
      answer: "You designed the grounded chat system. [citation:2]",
      entries: [projectFactEntry, ownedHighlightEntry],
    })).toEqual([]);

    expect(findUnsupportedOwnershipClaims({
      answer: "You built Workbase as a full-stack project. [citation:3]",
      entries: [projectFactEntry, ownedHighlightEntry, selfReportedDescriptionEntry],
    })).toEqual([]);
  });

  it("deterministically removes an unsupported ownership block before finalization", async () => {
    const result = await groundProjectAnswer({
      answer: [
        "You solo-built grounded chat. [citation:1]",
        "The repository implements grounded chat. [citation:1]",
        "You designed the grounded chat system. [citation:2]",
      ].join("\n\n"),
      entries: [projectFactEntry, ownedHighlightEntry],
      citationCount: 2,
    });

    expect(result.blocks.map((block) => block.bodyMarkdown)).toEqual([
      "The repository implements grounded chat.",
      "You designed the grounded chat system.",
    ]);
    expect(result.issues).toEqual([
      expect.stringContaining("Repository-only sources cannot establish personal ownership"),
    ]);
  });

  it("allows private-chat ownership grounded in explicit included self-report", async () => {
    const result = await groundProjectAnswer({
      answer: "You built Workbase as a full-stack project. [citation:3]",
      entries: [projectFactEntry, ownedHighlightEntry, selfReportedDescriptionEntry],
      citationCount: 3,
    });

    expect(result.blocks).toEqual([{
      heading: null,
      bodyMarkdown: "You built Workbase as a full-stack project.",
      citationIndexes: [3],
    }]);
  });

  it("treats zero supported cited blocks as a normal grounding result", async () => {
    const result = await groundProjectAnswer({
      answer: "Redis and Kubernetes provide durable workflow retries. [citation:1]",
      entries: [projectFactEntry],
      citationCount: 1,
    });

    expect(result.blocks).toEqual([]);
    expect(result.tokenUsage).toBeNull();
  });

  it("exposes only the deterministically safe subset of a mixed draft", () => {
    const dossier = parseProjectResearchDossier({
      objective: "Current assessment",
      phase: "finalizing",
      updatedAt: "2026-07-10T20:30:00.000Z",
      repositories: [{
        sourceId: "source-1",
        name: "arkb75/Workbase",
        importedAt: "2026-04-06T02:05:31.418Z",
        pinnedSha: "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5",
        committedAt: "2026-07-09T23:02:00.000Z",
        resolvedAt: "2026-07-10T20:30:00.000Z",
      }],
    });
    const entries = [{
      ...projectFactEntry,
      content: [
        "The repository implements grounded project chat.",
        "The assessment was imported on April 6, 2026.",
      ].join(" "),
    }];
    const result = evaluateDeterministicAnswerGrounding({
      answer: [
        "The repository implements grounded project chat. [citation:1]",
        "The repository implements grounded project chat. [citation:1][citation:9]",
        "You solo-built grounded project chat. [citation:1]",
        "The repository always implements grounded project chat. [citation:1]",
        "The repository implements 99 grounded chat workflows. [citation:1]",
        "This assessment is current as of April 6, 2026. [citation:1]",
        "Redis and Kubernetes provide durable workflow retries. [citation:1]",
      ].join("\n\n"),
      entries,
      citationCount: 1,
      dossier,
    });

    expect(result.safeBlocks).toEqual([{
      heading: null,
      bodyMarkdown: "The repository implements grounded project chat.",
      citationIndexes: [1],
    }]);
    expect(result.blocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("citation:9"),
    }));
    expect(result.blocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("solo-built"),
    }));
    expect(result.safeBlocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("always"),
    }));
    expect(result.safeBlocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("99"),
    }));
    expect(result.safeBlocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("April 6, 2026"),
    }));
    expect(result.safeBlocks).not.toContainEqual(expect.objectContaining({
      bodyMarkdown: expect.stringContaining("Redis"),
    }));
    expect(result.issues).toEqual(expect.arrayContaining([
      "The answer references unavailable citation [citation:9].",
      expect.stringContaining("Repository-only sources cannot establish personal ownership"),
      "The answer labels the source import date as current even though a newer repository inspection exists.",
    ]));
    expect(result.requiresModel).toBe(true);
  });

  it("rejects malformed and out-of-range ordinals from deterministic safe blocks", () => {
    const result = evaluateDeterministicAnswerGrounding({
      answer: [
        "The repository implements grounded project chat. [citation:1]",
        "The repository implements grounded project chat. [citation:0]",
        "The repository implements grounded project chat. [citation:-1]",
        "The repository implements grounded project chat. [citation:1.5]",
        "The repository implements grounded project chat. [citation:nope]",
      ].join("\n\n"),
      entries: [projectFactEntry],
      citationCount: 1,
    });

    expect(result.safeBlocks).toHaveLength(1);
    expect(result.issues).toEqual(expect.arrayContaining([
      "The answer references unavailable citation [citation:0].",
      "The answer references unavailable citation [citation:-1].",
      "The answer references unavailable citation [citation:1.5].",
      "The answer references unavailable citation [citation:nope].",
    ]));
  });

});
