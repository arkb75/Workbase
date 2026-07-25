import { readFile, writeFile } from "node:fs/promises";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  recordEmbeddingQualityGate,
  resolveActiveEmbeddingIndex,
  resolveEmbeddingIndexByKey,
} from "@/src/services/embedding-index-service";
import { rankProjectKnowledgeForIndex } from "@/src/services/knowledge-embedding-service";

type RequiredSources = {
  highlights?: Array<string | string[]>;
  projectFacts?: Array<string | string[]>;
  evidence?: Array<string | string[]>;
  artifacts?: Array<string | string[]>;
};

type Fixture = {
  name?: string;
  workItemId?: string;
  baselineThresholds?: {
    recallAt10?: number;
    mrr?: number;
    meanLatencyMs?: number;
  };
  queries: Array<{
    id: string;
    query: string;
    required: RequiredSources;
  }>;
};

type RankedSource = {
  key: string;
  kind: keyof RequiredSources;
  id: string;
  similarity: number;
};

type RankedResult = Awaited<ReturnType<typeof rankProjectKnowledgeForIndex>>;
type ScoredRanking = ReturnType<typeof scoreRanking>;
type QueryReport = {
  id: string;
  query: string;
  required: RequiredSources;
  baseline: ScoredRanking & { telemetry: RankedResult["telemetry"] };
  candidate: ScoredRanking & { telemetry: RankedResult["telemetry"] };
  requiredSourceLoss: string[];
};

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredGroups(required: RequiredSources) {
  return (
    Object.entries(required) as Array<
      [keyof RequiredSources, Array<string | string[]> | undefined]
    >
  ).flatMap(([kind, entries]) =>
    (entries ?? []).map((entry) => {
      const ids = Array.isArray(entry) ? entry : [entry];
      return ids.map((id) => `${kind}:${id}`);
    })
  );
}

function requiredIdsForKind(
  fixture: Fixture,
  kind: keyof RequiredSources,
) {
  return Array.from(new Set(fixture.queries.flatMap((query) =>
    query.required[kind]?.flatMap((entry) =>
      Array.isArray(entry) ? entry : [entry]
    ) ?? []
  )));
}

async function validateFixtureSources(fixture: Fixture) {
  const highlightIds = requiredIdsForKind(fixture, "highlights");
  const projectFactIds = requiredIdsForKind(fixture, "projectFacts");
  const evidenceIds = requiredIdsForKind(fixture, "evidence");
  const artifactIds = requiredIdsForKind(fixture, "artifacts");
  const [highlights, projectFacts, evidence, artifacts] = await Promise.all([
    highlightIds.length
      ? prisma.$queryRaw<Array<{ id: string; workItemId: string }>>(Prisma.sql`
          SELECT "id", "workItemId"
          FROM "Claim"
          WHERE "id" IN (${Prisma.join(highlightIds)})
        `)
      : Promise.resolve([]),
    projectFactIds.length
      ? prisma.$queryRaw<Array<{ id: string; workItemId: string }>>(Prisma.sql`
          SELECT "id", "workItemId"
          FROM "ProjectFact"
          WHERE "id" IN (${Prisma.join(projectFactIds)})
        `)
      : Promise.resolve([]),
    evidenceIds.length
      ? prisma.$queryRaw<Array<{ id: string; workItemId: string }>>(Prisma.sql`
          SELECT "id", "workItemId"
          FROM "EvidenceItem"
          WHERE "id" IN (${Prisma.join(evidenceIds)})
        `)
      : Promise.resolve([]),
    artifactIds.length
      ? prisma.$queryRaw<Array<{ id: string; workItemId: string | null }>>(Prisma.sql`
          SELECT "id", "workItemId"
          FROM "Artifact"
          WHERE "id" IN (${Prisma.join(artifactIds)})
        `)
      : Promise.resolve([]),
  ]);
  const expectedIds = [
    ...highlightIds,
    ...projectFactIds,
    ...evidenceIds,
    ...artifactIds,
  ];
  const foundRows = [...highlights, ...projectFacts, ...evidence, ...artifacts];
  const foundIds = new Set(foundRows.map((row) => row.id));
  const missingIds = expectedIds.filter((id) => !foundIds.has(id));
  if (missingIds.length) {
    throw new Error(
      `Embedding fixture references missing required IDs: ${missingIds.join(", ")}.`,
    );
  }
  const workItemIds = new Set(
    foundRows.flatMap((row) => row.workItemId ? [row.workItemId] : []),
  );
  if (
    foundRows.some((row) => !row.workItemId) ||
    workItemIds.size !== 1 ||
    (fixture.workItemId && !workItemIds.has(fixture.workItemId))
  ) {
    throw new Error(
      "Every required fixture source must belong to the fixture's one Work Item.",
    );
  }
  const resolvedWorkItemId = fixture.workItemId ?? Array.from(workItemIds)[0];
  if (!resolvedWorkItemId) {
    throw new Error("Embedding fixture did not resolve a Work Item.");
  }
  return resolvedWorkItemId;
}

function flattenMatches(matches: Awaited<ReturnType<typeof rankProjectKnowledgeForIndex>>["matches"]) {
  const groups: Array<[keyof RequiredSources, Map<string, number>]> = [
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

function scoreRanking(ranking: RankedSource[], required: RequiredSources) {
  const expected = requiredGroups(required);
  const requiredKinds = new Set(
    (Object.entries(required) as Array<
      [keyof RequiredSources, Array<string | string[]> | undefined]
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

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

async function main() {
  const fixturePath = requiredOption("fixture");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  if (!fixture.queries?.length) {
    throw new Error("Embedding fixture must include at least one query.");
  }
  if (
    fixture.baselineThresholds?.recallAt10 === undefined ||
    fixture.baselineThresholds.mrr === undefined ||
    fixture.baselineThresholds.recallAt10 <= 0 ||
    fixture.baselineThresholds.recallAt10 > 1 ||
    fixture.baselineThresholds.mrr <= 0 ||
    fixture.baselineThresholds.mrr > 1
  ) {
    throw new Error(
      "Embedding fixture must include positive recallAt10 and MRR baseline thresholds.",
    );
  }
  const workItemId = await validateFixtureSources(fixture);
  const active = await resolveActiveEmbeddingIndex();
  if (process.argv.includes("--baseline-only")) {
    const queries = [];
    for (const query of fixture.queries) {
      const result = await rankProjectKnowledgeForIndex({
        workItemId,
        query: query.query,
        index: active,
        limit: 30,
      });
      queries.push({
        id: query.id,
        query: query.query,
        required: query.required,
        ...scoreRanking(flattenMatches(result.matches), query.required),
        telemetry: result.telemetry,
      });
    }
    const recallAt10 = average(queries.map((entry) => entry.recallAt10));
    const mrr = average(queries.map((entry) => entry.reciprocalRank));
    const latencyValues = queries.map((entry) => entry.telemetry.latencyMs);
    const report = {
      kind: "embedding_index_baseline_validation",
      fixture: fixture.name ?? fixturePath,
      recordedAt: new Date().toISOString(),
      workItemId,
      active: {
        key: active.key,
        provider: active.provider,
        modelId: active.modelId,
      },
      aggregate: {
        recallAt10,
        mrr,
        averageLatencyMs: average(latencyValues),
        p95LatencyMs: percentile95(latencyValues),
      },
      thresholds: fixture.baselineThresholds ?? null,
      passed:
        recallAt10 + Number.EPSILON >=
          (fixture.baselineThresholds?.recallAt10 ?? 0) &&
        mrr + Number.EPSILON >= (fixture.baselineThresholds?.mrr ?? 0),
      queries,
    };
    const outputPath = option("output");
    if (outputPath) {
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.info(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const candidateKey = requiredOption("candidate");
  const candidate = await resolveEmbeddingIndexByKey(candidateKey);
  if (candidate.id === active.id) throw new Error("Candidate is already the active index.");

  const queryReports: QueryReport[] = [];
  for (const query of fixture.queries) {
    const [baselineResult, candidateResult] = await Promise.all([
      rankProjectKnowledgeForIndex({
        workItemId,
        query: query.query,
        index: active,
        limit: 30,
      }),
      rankProjectKnowledgeForIndex({
        workItemId,
        query: query.query,
        index: candidate,
        limit: 30,
      }),
    ]);
    const baseline = scoreRanking(flattenMatches(baselineResult.matches), query.required);
    const challenger = scoreRanking(flattenMatches(candidateResult.matches), query.required);
    const baselineHits = new Set(baseline.hitGroups);
    const candidateHits = new Set(challenger.hitGroups);
    queryReports.push({
      id: query.id,
      query: query.query,
      required: query.required,
      baseline: { ...baseline, telemetry: baselineResult.telemetry },
      candidate: { ...challenger, telemetry: candidateResult.telemetry },
      requiredSourceLoss: Array.from(baselineHits).filter((key) => !candidateHits.has(key)),
    });
  }

  const baselineRecallAt10 = average(
    queryReports.map((entry) => entry.baseline.recallAt10),
  );
  const candidateRecallAt10 = average(
    queryReports.map((entry) => entry.candidate.recallAt10),
  );
  const baselineMrr = average(
    queryReports.map((entry) => entry.baseline.reciprocalRank),
  );
  const candidateMrr = average(
    queryReports.map((entry) => entry.candidate.reciprocalRank),
  );
  const requiredSourceLoss = queryReports.reduce(
    (sum, entry) => sum + entry.requiredSourceLoss.length,
    0,
  );
  const latencySummary = (side: "baseline" | "candidate") => {
    const values = queryReports.map((entry) => entry[side].telemetry.latencyMs);
    const costs = queryReports
      .map((entry) => entry[side].telemetry.costUsd)
      .filter((value): value is number => value !== null);
    const inputTokens = queryReports
      .map((entry) => entry[side].telemetry.inputTokens)
      .filter((value): value is number => value !== null);
    return {
      averageMs: average(values),
      p95Ms: percentile95(values),
      measuredCostUsd: costs.length
        ? costs.reduce((sum, value) => sum + value, 0)
        : null,
      measuredInputTokens: inputTokens.length
        ? inputTokens.reduce((sum, value) => sum + value, 0)
        : null,
    };
  };
  const passed =
    candidateRecallAt10 + Number.EPSILON >= Math.max(
      baselineRecallAt10,
      fixture.baselineThresholds?.recallAt10 ?? 0,
    ) &&
    candidateMrr + Number.EPSILON >= Math.max(
      baselineMrr,
      fixture.baselineThresholds?.mrr ?? 0,
    ) &&
    requiredSourceLoss === 0;
  const report = {
    kind: "embedding_index_comparison",
    fixture: fixture.name ?? fixturePath,
    recordedAt: new Date().toISOString(),
    workItemId,
    active: { key: active.key, provider: active.provider, modelId: active.modelId },
    candidate: {
      key: candidate.key,
      provider: candidate.provider,
      modelId: candidate.modelId,
    },
    thresholds: {
      recallAt10Minimum: Math.max(
        baselineRecallAt10,
        fixture.baselineThresholds?.recallAt10 ?? 0,
      ),
      mrrMinimum: Math.max(
        baselineMrr,
        fixture.baselineThresholds?.mrr ?? 0,
      ),
      requiredSourceLossMustBeZero: true,
      historicalBaselineMeanLatencyMs:
        fixture.baselineThresholds?.meanLatencyMs ?? null,
    },
    aggregate: {
      baselineRecallAt10,
      candidateRecallAt10,
      baselineMrr,
      candidateMrr,
      requiredSourceLoss,
      baselineTelemetry: latencySummary("baseline"),
      candidateTelemetry: latencySummary("candidate"),
    },
    passed,
    queries: queryReports,
  };
  const outputPath = option("output");
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--record")) {
    await recordEmbeddingQualityGate({
      key: candidate.key,
      passed,
      report,
    });
  }
  console.info(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
