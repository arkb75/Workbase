import { describe, expect, it } from "vitest";
import {
  detectGroundingContractIssues,
  extractClaimCitationMap,
  findUnsupportedOwnershipClaims,
  groundProjectAnswer,
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
        "You designed the reviewed chat experience. [citation:2]",
      ].join("\n\n"),
      entries: [projectFactEntry, ownedHighlightEntry],
      citationCount: 2,
    });

    expect(result.blocks.map((block) => block.bodyMarkdown)).toEqual([
      "The repository implements grounded chat.",
      "You designed the reviewed chat experience.",
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
});
