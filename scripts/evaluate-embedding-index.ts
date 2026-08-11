import { readFile, writeFile } from "node:fs/promises";
import {
  evaluateEmbeddingIndexQualityGate,
  type EmbeddingQualityGateMode,
} from "@/src/evals/embedding-index-quality-gate";
import {
  assertEmbeddingEvaluationQueries,
  evaluateEmbeddingIndexQueries,
  scoreEmbeddingRankingResult,
  type EmbeddingQueryReport,
  type EmbeddingRequiredSources,
} from "@/src/evals/embedding-index-query-evaluation";
import { embeddingIndexEvaluationErrorMessage } from "@/src/evals/embedding-index-error";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  recordEmbeddingQualityGate,
  resolveActiveEmbeddingIndex,
  resolveEmbeddingQualityValidationContext,
} from "@/src/services/embedding-index-service";
import { rankProjectKnowledgeForIndex } from "@/src/services/knowledge-embedding-service";

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
    required: EmbeddingRequiredSources;
  }>;
};

function usage() {
  return `
Usage:
  npm run eval:embeddings -- --fixture FIXTURE --baseline-only [--output REPORT]
  npm run eval:embeddings -- --fixture FIXTURE --candidate KEY [--mode promotion|rollback] [--record] [--output REPORT]

Modes:
  promotion  Require the candidate to meet or exceed both the active index and historical fixture thresholds (default).
  rollback   Re-gate a ready, reconciled rollback index using only its provider, historical fixture thresholds, and absolute required-source checks.
`.trim();
}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function qualityGateMode(): EmbeddingQualityGateMode {
  const value = option("mode") ?? "promotion";
  if (value !== "promotion" && value !== "rollback") {
    throw new Error('--mode must be "promotion" or "rollback".');
  }
  return value;
}

function requiredIdsForKind(
  fixture: Fixture,
  kind: keyof EmbeddingRequiredSources,
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
  if (process.argv.includes("--help")) {
    console.info(usage());
    return;
  }
  const fixturePath = requiredOption("fixture");
  const mode = qualityGateMode();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  if (!fixture.queries?.length) {
    throw new Error("Embedding fixture must include at least one query.");
  }
  assertEmbeddingEvaluationQueries(fixture.queries);
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
  if (process.argv.includes("--baseline-only")) {
    if (mode !== "promotion") {
      throw new Error("--baseline-only cannot be combined with --mode rollback.");
    }
    const active = await resolveActiveEmbeddingIndex();
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
        ...scoreEmbeddingRankingResult(result, query.required),
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
  const {
    active,
    candidate,
    validationFence,
  } = await resolveEmbeddingQualityValidationContext(candidateKey);
  if (candidate.id === active.id) throw new Error("Candidate is already the active index.");
  if (
    candidate.status !== "ready" ||
    validationFence.candidateReconciledAt === null ||
    candidate.baseActivationEpoch !== validationFence.activationEpoch
  ) {
    throw new Error(
      `Embedding index "${candidate.key}" must be ready and reconciled to the current active epoch before quality validation.`,
    );
  }

  const queryReports = await evaluateEmbeddingIndexQueries({
    mode,
    queries: fixture.queries,
    rankActive: mode === "promotion"
      ? (query) => rankProjectKnowledgeForIndex({
        workItemId,
        query: query.query,
        index: active,
        limit: 30,
      })
      : undefined,
    rankCandidate: (query) => rankProjectKnowledgeForIndex({
      workItemId,
      query: query.query,
      index: candidate,
      limit: 30,
    }),
  });

  const baselineRecallAt10 = mode === "promotion"
    ? average(queryReports.map((entry) => entry.baseline!.recallAt10))
    : null;
  const candidateRecallAt10 = average(
    queryReports.map((entry) => entry.candidate.recallAt10),
  );
  const baselineMrr = mode === "promotion"
    ? average(queryReports.map((entry) => entry.baseline!.reciprocalRank))
    : null;
  const candidateMrr = average(
    queryReports.map((entry) => entry.candidate.reciprocalRank),
  );
  const requiredSourceLoss = queryReports.reduce(
    (sum, entry) => sum + entry.requiredSourceLoss.length,
    0,
  );
  const latencySummary = (side: "baseline" | "candidate") => {
    const rankings = queryReports
      .map((entry) => entry[side])
      .filter((entry): entry is NonNullable<EmbeddingQueryReport[typeof side]> =>
        entry !== null
      );
    if (!rankings.length) return null;
    const values = rankings.map((entry) => entry.telemetry.latencyMs);
    const costs = rankings
      .map((entry) => entry.telemetry.costUsd)
      .filter((value): value is number => value !== null);
    const inputTokens = rankings
      .map((entry) => entry.telemetry.inputTokens)
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
  const gate = evaluateEmbeddingIndexQualityGate({
    mode,
    activeRecallAt10: baselineRecallAt10,
    activeMrr: baselineMrr,
    candidateRecallAt10,
    candidateMrr,
    historicalRecallAt10: fixture.baselineThresholds.recallAt10,
    historicalMrr: fixture.baselineThresholds.mrr,
    requiredSourceLoss,
    candidateStatus: candidate.status,
    candidateReconciledAt: validationFence.candidateReconciledAt,
    candidateBaseActivationEpoch: candidate.baseActivationEpoch,
    activeActivationEpoch: validationFence.activationEpoch,
  });
  const report = {
    kind: mode === "rollback"
      ? "embedding_index_rollback_validation"
      : "embedding_index_comparison",
    validationMode: mode,
    fixture: fixture.name ?? fixturePath,
    recordedAt: new Date().toISOString(),
    workItemId,
    active: { key: active.key, provider: active.provider, modelId: active.modelId },
    providerEvaluation: {
      activeQueried: mode === "promotion",
      candidateQueried: true,
    },
    candidate: {
      key: candidate.key,
      provider: candidate.provider,
      modelId: candidate.modelId,
    },
    validationFence,
    thresholds: {
      ...gate.thresholds,
      historicalBaselineMeanLatencyMs:
        fixture.baselineThresholds?.meanLatencyMs ?? null,
    },
    checks: gate.checks,
    aggregate: {
      baselineRecallAt10,
      candidateRecallAt10,
      baselineMrr,
      candidateMrr,
      requiredSourceLoss,
      baselineTelemetry: latencySummary("baseline"),
      candidateTelemetry: latencySummary("candidate"),
    },
    passed: gate.passed,
    queries: queryReports,
  };
  const outputPath = option("output");
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--record")) {
    await recordEmbeddingQualityGate({
      key: candidate.key,
      passed: gate.passed,
      report,
      expectedValidationFence: validationFence,
    });
  }
  console.info(JSON.stringify(report, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(embeddingIndexEvaluationErrorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
