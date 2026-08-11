import { describe, expect, it, vi } from "vitest";
import {
  evaluateEmbeddingIndexQueries,
  type EmbeddingRankingResult,
} from "@/src/evals/embedding-index-query-evaluation";

function ranking(projectFacts: Array<[string, number]>): EmbeddingRankingResult {
  return {
    matches: {
      highlights: new Map(),
      projectFacts: new Map(projectFacts),
      evidence: new Map(),
      artifacts: new Map(),
    },
    telemetry: {
      latencyMs: 10,
      inputTokens: 4,
      totalTokens: 4,
      costUsd: 0.001,
    },
  };
}

const queries = [{
  id: "rollback_source",
  query: "How is rollback kept available?",
  required: { projectFacts: [["titan-primary", "titan-successor"]] },
}];

describe("embedding index query evaluation", () => {
  it("never calls the active provider in rollback mode", async () => {
    const rankActive = vi.fn(async () => {
      throw new Error("active provider is unavailable");
    });
    const rankCandidate = vi.fn(async () => ranking([["titan-primary", 0.91]]));

    const reports = await evaluateEmbeddingIndexQueries({
      mode: "rollback",
      queries,
      rankActive,
      rankCandidate,
    });

    expect(rankActive).not.toHaveBeenCalled();
    expect(rankCandidate).toHaveBeenCalledOnce();
    expect(reports[0]).toMatchObject({
      baseline: null,
      requiredSourceLoss: [],
      candidate: { recallAt10: 1, reciprocalRank: 1 },
    });
  });

  it("reports an absolute source-integrity loss when rollback misses the fixture source", async () => {
    const reports = await evaluateEmbeddingIndexQueries({
      mode: "rollback",
      queries,
      rankCandidate: async () => ranking([["unrelated", 0.99]]),
    });

    expect(reports[0]?.requiredSourceLoss).toEqual([
      "projectFacts:titan-primary|projectFacts:titan-successor",
    ]);
    expect(reports[0]?.candidate.recallAt10).toBe(0);
  });

  it("preserves active-versus-candidate source comparison for promotion", async () => {
    const rankActive = vi.fn(async () => ranking([["titan-primary", 0.91]]));
    const rankCandidate = vi.fn(async () => ranking([["unrelated", 0.99]]));

    const reports = await evaluateEmbeddingIndexQueries({
      mode: "promotion",
      queries,
      rankActive,
      rankCandidate,
    });

    expect(rankActive).toHaveBeenCalledOnce();
    expect(rankCandidate).toHaveBeenCalledOnce();
    expect(reports[0]?.baseline?.recallAt10).toBe(1);
    expect(reports[0]?.requiredSourceLoss).toEqual([
      "projectFacts:titan-primary|projectFacts:titan-successor",
    ]);
  });

  it("fails closed when promotion has no active ranker", async () => {
    await expect(evaluateEmbeddingIndexQueries({
      mode: "promotion",
      queries,
      rankCandidate: async () => ranking([["titan-primary", 0.91]]),
    })).rejects.toThrow("Promotion evaluation requires an active-index ranker.");
  });

  it("fails closed before ranking when a query has no required source group", async () => {
    const rankCandidate = vi.fn(async () => ranking([["anything", 0.91]]));

    await expect(evaluateEmbeddingIndexQueries({
      mode: "rollback",
      queries: [{ id: "empty", query: "Empty fixture", required: {} }],
      rankCandidate,
    })).rejects.toThrow("must require at least one source group");
    expect(rankCandidate).not.toHaveBeenCalled();
  });
});
