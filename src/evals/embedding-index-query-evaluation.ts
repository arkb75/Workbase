import type { EmbeddingQualityGateMode } from "@/src/evals/embedding-index-quality-gate";

export type EmbeddingRequiredSources = {
  highlights?: Array<string | string[]>;
  projectFacts?: Array<string | string[]>;
  evidence?: Array<string | string[]>;
  artifacts?: Array<string | string[]>;
};

export type EmbeddingEvaluationQuery = {
  id: string;
  query: string;
  required: EmbeddingRequiredSources;
};

export type EmbeddingRankingResult = {
  matches: {
    highlights: Map<string, number>;
    projectFacts: Map<string, number>;
    evidence: Map<string, number>;
    artifacts: Map<string, number>;
  };
  telemetry: {
    latencyMs: number;
    inputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
};

type RankedSource = {
  key: string;
  kind: keyof EmbeddingRequiredSources;
  id: string;
  similarity: number;
};

export type EmbeddingScoredRanking = ReturnType<typeof scoreEmbeddingRanking>;

export type EmbeddingQueryReport = {
  id: string;
  query: string;
  required: EmbeddingRequiredSources;
  baseline: (EmbeddingScoredRanking & {
    telemetry: EmbeddingRankingResult["telemetry"];
  }) | null;
  candidate: EmbeddingScoredRanking & {
    telemetry: EmbeddingRankingResult["telemetry"];
  };
  requiredSourceLoss: string[];
};

type RankQuery = (
  query: EmbeddingEvaluationQuery,
) => Promise<EmbeddingRankingResult>;

export function embeddingRequiredGroups(required: EmbeddingRequiredSources) {
  return (
    Object.entries(required) as Array<
      [keyof EmbeddingRequiredSources, Array<string | string[]> | undefined]
    >
  ).flatMap(([kind, entries]) =>
    (entries ?? []).map((entry) => {
      const ids = Array.isArray(entry) ? entry : [entry];
      return ids.map((id) => `${kind}:${id}`);
    })
  );
}

export function assertEmbeddingEvaluationQueries(
  queries: EmbeddingEvaluationQuery[],
) {
  const ids = new Set<string>();
  for (const query of queries) {
    if (!query.id.trim() || !query.query.trim()) {
      throw new Error("Every embedding evaluation query must have an ID and query text.");
    }
    if (ids.has(query.id)) {
      throw new Error(`Embedding evaluation query ID "${query.id}" is duplicated.`);
    }
    ids.add(query.id);
    if (!embeddingRequiredGroups(query.required).length) {
      throw new Error(
        `Embedding evaluation query "${query.id}" must require at least one source group.`,
      );
    }
  }
}

function flattenEmbeddingMatches(matches: EmbeddingRankingResult["matches"]) {
  const groups: Array<
    [keyof EmbeddingRequiredSources, Map<string, number>]
  > = [
    ["highlights", matches.highlights],
    ["projectFacts", matches.projectFacts],
    ["evidence", matches.evidence],
    ["artifacts", matches.artifacts],
  ];
  return groups
    .flatMap(([kind, values]) =>
      Array.from(values, ([id, similarity]) => ({
        key: `${kind}:${id}`,
        kind,
        id,
        similarity,
      } satisfies RankedSource))
    )
    .sort((left, right) => right.similarity - left.similarity);
}

export function scoreEmbeddingRanking(
  ranking: RankedSource[],
  required: EmbeddingRequiredSources,
) {
  const expected = embeddingRequiredGroups(required);
  const requiredKinds = new Set(
    (Object.entries(required) as Array<
      [keyof EmbeddingRequiredSources, Array<string | string[]> | undefined]
    >)
      .filter(([, entries]) => Boolean(entries?.length))
      .map(([kind]) => kind),
  );
  const scopedRanking = ranking.filter((source) => requiredKinds.has(source.kind));
  const top10 = scopedRanking.slice(0, 10);
  const top10Keys = new Set(top10.map((source) => source.key));
  const hitGroups = expected
    .filter((alternatives) => alternatives.some((key) => top10Keys.has(key)))
    .map((alternatives) => alternatives.join("|"));
  const expectedKeys = new Set(expected.flat());
  const firstRelevantRank = scopedRanking.findIndex((source) =>
    expectedKeys.has(source.key)
  );
  return {
    requiredCount: expected.length,
    hitGroups,
    recallAt10: expected.length ? hitGroups.length / expected.length : 1,
    reciprocalRank: expected.length && firstRelevantRank >= 0
      ? 1 / (firstRelevantRank + 1)
      : expected.length
        ? 0
        : 1,
    top10,
  };
}

export function scoreEmbeddingRankingResult(
  result: EmbeddingRankingResult,
  required: EmbeddingRequiredSources,
) {
  return {
    ...scoreEmbeddingRanking(flattenEmbeddingMatches(result.matches), required),
    telemetry: result.telemetry,
  };
}

/**
 * Promotion compares a challenger with the active index. Rollback deliberately
 * does not rank against the active index: the active provider may be the reason
 * rollback is needed. Instead, every required fixture group is an absolute
 * source-integrity requirement for the rollback candidate.
 */
export async function evaluateEmbeddingIndexQueries(input: {
  mode: EmbeddingQualityGateMode;
  queries: EmbeddingEvaluationQuery[];
  rankCandidate: RankQuery;
  rankActive?: RankQuery;
}) {
  if (input.mode === "promotion" && !input.rankActive) {
    throw new Error("Promotion evaluation requires an active-index ranker.");
  }
  assertEmbeddingEvaluationQueries(input.queries);

  const reports: EmbeddingQueryReport[] = [];
  for (const query of input.queries) {
    if (input.mode === "rollback") {
      const candidate = scoreEmbeddingRankingResult(
        await input.rankCandidate(query),
        query.required,
      );
      const candidateHits = new Set(candidate.hitGroups);
      reports.push({
        id: query.id,
        query: query.query,
        required: query.required,
        baseline: null,
        candidate,
        requiredSourceLoss: embeddingRequiredGroups(query.required)
          .map((alternatives) => alternatives.join("|"))
          .filter((group) => !candidateHits.has(group)),
      });
      continue;
    }

    const [baselineResult, candidateResult] = await Promise.all([
      input.rankActive!(query),
      input.rankCandidate(query),
    ]);
    const baseline = scoreEmbeddingRankingResult(baselineResult, query.required);
    const candidate = scoreEmbeddingRankingResult(candidateResult, query.required);
    const baselineHits = new Set(baseline.hitGroups);
    const candidateHits = new Set(candidate.hitGroups);
    reports.push({
      id: query.id,
      query: query.query,
      required: query.required,
      baseline,
      candidate,
      requiredSourceLoss: Array.from(baselineHits)
        .filter((group) => !candidateHits.has(group)),
    });
  }
  return reports;
}
