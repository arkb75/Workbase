import { describe, expect, it } from "vitest";
import {
  completeProjectResearchDossier,
  mergeProjectResearchDossier,
  parseProjectResearchDossier,
  PROJECT_RESEARCH_NOTEBOOK_MAX_EXCERPT_BYTES,
  PROJECT_RESEARCH_NOTEBOOK_MAX_TOTAL_EXCERPT_BYTES,
  repositoryFreshnessFromDossier,
  truncateUtf8ToByteLength,
} from "@/src/services/project-research-dossier-service";
import { mergeCompletedRunResult } from "@/src/services/project-chat-store";

const JULY_SHA = "06f3ae5d40a3efbd7959b9e179cd8a9059cc70e5";

const environmentSnapshot = {
  objective: "Summarize my strongest accomplishments and make sure your information is up to date.",
  capabilities: {
    repositoryResearch: {
      repositories: [{
        sourceId: "source-1",
        name: "arkb75/Workbase",
        importedAt: "2026-04-06T02:05:31.418Z",
        pinnedSha: JULY_SHA,
        committedAt: "2026-07-09T23:02:00.000Z",
        resolvedAt: "2026-07-10T20:30:00.000Z",
      }],
    },
  },
};

describe("project research dossier", () => {
  it("truncates notebook excerpts at exact UTF-8 byte boundaries", () => {
    const threeByteCodePoint = "€";
    const truncated = truncateUtf8ToByteLength(
      threeByteCodePoint.repeat(4_000),
      PROJECT_RESEARCH_NOTEBOOK_MAX_EXCERPT_BYTES,
    );

    expect(Buffer.byteLength(truncated, "utf8")).toBe(8_190);
    expect(truncated).not.toContain("\uFFFD");
    expect(truncated.endsWith(threeByteCodePoint)).toBe(true);
  });

  it("enforces the 8KB per-excerpt and 64KB total notebook limits while parsing", () => {
    const oversizedMultibyteExcerpt = "€".repeat(4_000);
    const dossier = parseProjectResearchDossier({
      objective: "Inspect the current repository.",
      phase: "finalizing",
      updatedAt: "2026-07-10T20:30:00.000Z",
      notebook: {
        paths: [],
        citations: Array.from({ length: 10 }, (_, index) => ({
          type: "github_file",
          title: `src/file-${index}.ts`,
          excerpt: oversizedMultibyteExcerpt,
        })),
      },
    });
    const excerpts = dossier?.notebook?.citations.map((citation) => citation.excerpt ?? "") ?? [];

    expect(excerpts).toHaveLength(10);
    expect(excerpts.every((excerpt) =>
      Buffer.byteLength(excerpt, "utf8") <= PROJECT_RESEARCH_NOTEBOOK_MAX_EXCERPT_BYTES
    )).toBe(true);
    expect(excerpts.reduce(
      (total, excerpt) => total + Buffer.byteLength(excerpt, "utf8"),
      0,
    )).toBeLessThanOrEqual(PROJECT_RESEARCH_NOTEBOOK_MAX_TOTAL_EXCERPT_BYTES);
    expect(excerpts.join("")).not.toContain("\uFFFD");
    expect(excerpts.slice(0, 8).every((excerpt) =>
      Buffer.byteLength(excerpt, "utf8") === 8_190
    )).toBe(true);
    expect(Buffer.byteLength(excerpts[8]!, "utf8")).toBe(15);
    expect(excerpts[9]).toBe("");
  });

  it("reports repository freshness from the July snapshot instead of the April import", () => {
    const dossier = parseProjectResearchDossier({
      phase: "awaiting_review",
      partial: true,
      updatedAt: "2026-07-10T20:30:00.000Z",
      coverage: {
        planned: ["service architecture", "UI and routes"],
        achieved: ["service architecture"],
        uninspected: ["UI and routes were not inspected."],
        omittedRepositories: [],
      },
    }, environmentSnapshot);

    expect(repositoryFreshnessFromDossier(dossier)).toEqual({
      latestSourceImportedAt: "2026-04-06T02:05:31.418Z",
      latestRepositoryCommitAt: "2026-07-09T23:02:00.000Z",
      latestRepositoryInspectedAt: "2026-07-10T20:30:00.000Z",
      pinnedRevisions: [{
        repository: "arkb75/Workbase",
        commitSha: JULY_SHA,
        committedAt: "2026-07-09T23:02:00.000Z",
        inspectedAt: "2026-07-10T20:30:00.000Z",
      }],
    });
  });

  it("keeps partial status and coverage gaps monotonic through finalization", () => {
    const awaitingReview = parseProjectResearchDossier({
      objective: "Current accomplishment assessment",
      phase: "awaiting_review",
      startedAt: "2026-07-10T20:20:00.000Z",
      updatedAt: "2026-07-10T20:30:00.000Z",
      researchedAt: "2026-07-10T20:30:00.000Z",
      repositories: environmentSnapshot.capabilities.repositoryResearch.repositories,
      partial: true,
      coverageGaps: ["UI and routes were not inspected."],
      coverage: {
        planned: ["service architecture", "UI and routes"],
        achieved: ["service architecture"],
        uninspected: ["UI and routes were not inspected."],
        omittedRepositories: [],
      },
      candidateIds: ["candidate-1", "candidate-2"],
      provisionalProjectFactIds: ["fact-current-1", "fact-current-2"],
    }, environmentSnapshot);
    expect(awaitingReview).not.toBeNull();

    const merged = mergeProjectResearchDossier(awaitingReview, {
      objective: "Current accomplishment assessment",
      phase: "finalizing",
      repositories: awaitingReview!.repositories,
      // A post-review stage must never make earlier bounded research appear
      // exhaustive merely because it did not add a new gap of its own.
      partial: false,
      coverageGaps: [],
    });
    const completed = completeProjectResearchDossier(merged, environmentSnapshot, {
      status: "completed",
      citationCount: 2,
      usedProjectFactIds: ["fact-current-1", "fact-current-2"],
    });

    expect(completed).toMatchObject({
      phase: "completed",
      partial: true,
      coverageGaps: ["UI and routes were not inspected."],
      candidateIds: ["candidate-1", "candidate-2"],
      provisionalProjectFactIds: ["fact-current-1", "fact-current-2"],
      finalization: {
        citationCount: 2,
        usedProjectFactIds: ["fact-current-1", "fact-current-2"],
      },
    });
  });

  it("does not let completion overwrite the canonical research audit", () => {
    const researchState = {
      objective: "Current assessment",
      phase: "completed",
      updatedAt: "2026-07-10T20:31:00.000Z",
      researchedAt: "2026-07-10T20:30:00.000Z",
      repositories: environmentSnapshot.capabilities.repositoryResearch.repositories,
      partial: true,
      coverageGaps: ["UI and routes were not inspected."],
      warnings: ["Bounded repository assessment."],
      notebook: {
        citations: [{
          type: "github_file",
          title: "src/services/project-chat-agent-service.ts",
          repository: "arkb75/Workbase",
          commitSha: JULY_SHA,
          path: "src/services/project-chat-agent-service.ts",
        }],
      },
    };
    const merged = mergeCompletedRunResult({
      existing: {
        status: "awaiting_review",
        partial: true,
        coverageGaps: ["UI and routes were not inspected."],
        exploredEvidenceCount: 1,
      },
      next: {
        status: "answered",
        partial: false,
        coverageGaps: [],
        exploredEvidenceCount: 0,
      },
      researchState,
      environmentSnapshot,
    });

    expect(merged).toMatchObject({
      status: "answered",
      partial: true,
      coverageGaps: ["UI and routes were not inspected."],
      warnings: ["Bounded repository assessment."],
      exploredEvidenceCount: 1,
      research: {
        partial: true,
        exploredEvidenceCount: 1,
        repositories: [expect.objectContaining({ pinnedSha: JULY_SHA })],
      },
    });
  });
});
