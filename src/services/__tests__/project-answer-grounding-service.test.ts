import { describe, expect, it } from "vitest";
import {
  detectGroundingContractIssues,
  extractClaimCitationMap,
} from "@/src/services/project-answer-grounding-service";
import { parseProjectResearchDossier } from "@/src/services/project-research-dossier-service";

describe("project answer grounding contract", () => {
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
});
