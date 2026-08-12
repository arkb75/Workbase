import { Prisma } from "@/src/generated/prisma/client";
import type { EmbeddingIndexIdentity } from "@/src/lib/embedding-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  EmbeddingWriteFenceChangedError,
  type EmbeddingEntityKind,
  persistVersionedEmbeddingBatch,
  resolveActiveEmbeddingIndex,
  resolveEmbeddingWriteSet,
} from "@/src/services/embedding-index-service";
import {
  embeddingIdentityIsFresh,
  beginEmbeddingWriteGeneration,
  generateHighlightEmbedding,
  hashEmbeddingInput,
  scheduleShadowEmbeddingWrites,
  vectorToSqlLiteral,
} from "@/src/services/highlight-embedding-service";

type ExistingEmbeddingIdentity = {
  indexVersionId: string;
  inputHash: string;
  modelId: string;
  dimensions: number;
};

export function buildEvidenceEmbeddingText(input: {
  title: string;
  content: string;
  searchText: string;
  sourceLabel?: string | null;
}) {
  return normalizeWhitespace(
    [input.title, input.sourceLabel ?? "", input.content, input.searchText].join("\n"),
  ).slice(0, 20_000);
}

export function buildArtifactEmbeddingText(input: {
  content: string;
  requestBrief?: string | null;
  type: string;
  targetAngle: string;
  tone: string;
}) {
  return normalizeWhitespace(
    [
      input.requestBrief ?? "",
      input.type.replace(/_/g, " "),
      input.targetAngle.replace(/_/g, " "),
      input.tone.replace(/_/g, " "),
      input.content,
    ].join("\n"),
  ).slice(0, 20_000);
}

export function buildProjectFactEmbeddingText(input: {
  statement: string;
  category: string;
  reviewNotes?: string | null;
}) {
  return normalizeWhitespace(
    [input.category.replace(/_/g, " "), input.statement, input.reviewNotes ?? ""].join("\n"),
  ).slice(0, 20_000);
}

async function loadExistingRows(input: {
  kind: Exclude<EmbeddingEntityKind, "highlight">;
  entityId: string;
  targetIds: string[];
}) {
  if (input.kind === "evidence") {
    return prisma.$queryRaw<ExistingEmbeddingIdentity[]>(Prisma.sql`
      SELECT "indexVersionId", "inputHash", "modelId", "dimensions"
      FROM "EvidenceEmbedding"
      WHERE "evidenceItemId" = ${input.entityId}
        AND "indexVersionId" IN (${Prisma.join(input.targetIds)})
    `);
  }
  if (input.kind === "artifact") {
    return prisma.$queryRaw<ExistingEmbeddingIdentity[]>(Prisma.sql`
      SELECT "indexVersionId", "inputHash", "modelId", "dimensions"
      FROM "ArtifactEmbedding"
      WHERE "artifactId" = ${input.entityId}
        AND "indexVersionId" IN (${Prisma.join(input.targetIds)})
    `);
  }
  return prisma.$queryRaw<ExistingEmbeddingIdentity[]>(Prisma.sql`
    SELECT "indexVersionId", "inputHash", "modelId", "dimensions"
    FROM "ProjectFactEmbedding"
    WHERE "projectFactId" = ${input.entityId}
      AND "indexVersionId" IN (${Prisma.join(input.targetIds)})
  `);
}

function reusedEmbedding(
  identity: Awaited<ReturnType<typeof resolveActiveEmbeddingIndex>>,
  inputText: string,
) {
  return {
    ...identity,
    inputHash: hashEmbeddingInput(inputText),
    inputText,
    vector: null,
    usage: { inputTokens: null, totalTokens: null, costUsd: null },
    reused: true as const,
  };
}

async function upsertKnowledgeEmbedding(input: {
  kind: Exclude<EmbeddingEntityKind, "highlight">;
  entityId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  for (let fenceAttempt = 0; fenceAttempt < 3; fenceAttempt += 1) {
    const writeSet = await resolveEmbeddingWriteSet();
    const existingRows = input.skipFreshnessCheck
      ? []
      : await loadExistingRows({
          kind: input.kind,
          entityId: input.entityId,
          targetIds: writeSet.targets.map((target) => target.id),
        });
    const existingByVersion = new Map(
      existingRows.map((row) => [row.indexVersionId, row]),
    );
    const staleTargets = writeSet.targets.filter(
      (target) =>
        !embeddingIdentityIsFresh(
          existingByVersion.get(target.id),
          input.inputText,
          target,
        ),
    );
    if (!staleTargets.length) return reusedEmbedding(writeSet.active, input.inputText);

    const generation = beginEmbeddingWriteGeneration({
      writeSet,
      staleTargets,
      inputText: input.inputText,
    });
    try {
      const activeGenerated = await generation.activeEmbedding;
      if (activeGenerated) {
        await persistVersionedEmbeddingBatch({
          writeSet,
          kind: input.kind,
          entityId: input.entityId,
          embeddings: [activeGenerated],
        });
      }
      // Shadow generation began concurrently, but it is deliberately detached
      // only after the availability-critical active write has committed.
      scheduleShadowEmbeddingWrites({
        writeSet,
        kind: input.kind,
        entityId: input.entityId,
        shadowTargets: generation.shadowTargets,
        shadowResults: generation.shadowResults,
      });
      return activeGenerated
        ? { ...activeGenerated, reused: false as const }
        : reusedEmbedding(writeSet.active, input.inputText);
    } catch (error) {
      if (error instanceof EmbeddingWriteFenceChangedError && fenceAttempt < 2) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Embedding write set did not stabilize.");
}

export function upsertEvidenceEmbedding(input: {
  evidenceItemId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  return upsertKnowledgeEmbedding({
    kind: "evidence",
    entityId: input.evidenceItemId,
    inputText: input.inputText,
    skipFreshnessCheck: input.skipFreshnessCheck,
  });
}

export function upsertArtifactEmbedding(input: {
  artifactId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  return upsertKnowledgeEmbedding({
    kind: "artifact",
    entityId: input.artifactId,
    inputText: input.inputText,
    skipFreshnessCheck: input.skipFreshnessCheck,
  });
}

export function upsertProjectFactEmbedding(input: {
  projectFactId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  return upsertKnowledgeEmbedding({
    kind: "projectFact",
    entityId: input.projectFactId,
    inputText: input.inputText,
    skipFreshnessCheck: input.skipFreshnessCheck,
  });
}

export async function ensureProjectKnowledgeEmbeddings(input: {
  projectFacts: Array<{
    id: string;
    statement: string;
    category: string;
    reviewNotes?: string | null;
  }>;
  evidenceItems: Array<{
    id: string;
    title: string;
    content: string;
    searchText: string;
    source: { label: string };
  }>;
  artifacts: Array<{
    id: string;
    content: string;
    requestBrief?: string | null;
    type: string;
    targetAngle: string;
    tone: string;
  }>;
}) {
  const writes = [
    ...input.projectFacts.map((fact) => () =>
      upsertProjectFactEmbedding({
        projectFactId: fact.id,
        inputText: buildProjectFactEmbeddingText(fact),
      })
    ),
    ...input.evidenceItems.map((item) => () =>
      upsertEvidenceEmbedding({
        evidenceItemId: item.id,
        inputText: buildEvidenceEmbeddingText({
          ...item,
          sourceLabel: item.source.label,
        }),
      })
    ),
    ...input.artifacts.map((artifact) => () =>
      upsertArtifactEmbedding({
        artifactId: artifact.id,
        inputText: buildArtifactEmbeddingText(artifact),
      })
    ),
  ];
  for (let offset = 0; offset < writes.length; offset += 4) {
    await Promise.allSettled(writes.slice(offset, offset + 4).map((write) => write()));
  }
}

export async function findNearestProjectKnowledge(input: {
  workItemId: string;
  query: string;
  limit?: number;
}) {
  const active = await resolveActiveEmbeddingIndex();
  const ranked = await rankProjectKnowledgeForIndex({
    ...input,
    index: active,
  });
  return ranked.matches;
}

export async function rankProjectKnowledgeForIndex(input: {
  workItemId: string;
  query: string;
  index: EmbeddingIndexIdentity;
  limit?: number;
}) {
  const startedAt = performance.now();
  const embedding = await generateHighlightEmbedding(input.query, input.index);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);
  const limit = input.limit ?? 30;
  const [highlightRows, projectFactRows, evidenceRows, artifactRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "HighlightEmbedding"."highlightId" AS "id",
        (1 - ("HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "HighlightEmbedding"
      INNER JOIN "Claim" ON "Claim"."id" = "HighlightEmbedding"."highlightId"
      WHERE "Claim"."workItemId" = ${input.workItemId}
        AND "Claim"."verificationStatus" = 'approved'
        AND "Claim"."lifecycleStatus" = 'active'
        AND "HighlightEmbedding"."indexVersionId" = ${input.index.id}
      ORDER BY "HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "ProjectFactEmbedding"."projectFactId" AS "id",
        (1 - ("ProjectFactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "ProjectFactEmbedding"
      INNER JOIN "ProjectFact" ON "ProjectFact"."id" = "ProjectFactEmbedding"."projectFactId"
      WHERE "ProjectFact"."workItemId" = ${input.workItemId}
        AND "ProjectFact"."status" = 'approved'
        AND "ProjectFact"."lifecycleStatus" = 'active'
        AND "ProjectFactEmbedding"."indexVersionId" = ${input.index.id}
      ORDER BY "ProjectFactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "EvidenceEmbedding"."evidenceItemId" AS "id",
        (1 - ("EvidenceEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "EvidenceEmbedding"
      INNER JOIN "EvidenceItem" ON "EvidenceItem"."id" = "EvidenceEmbedding"."evidenceItemId"
      WHERE "EvidenceItem"."workItemId" = ${input.workItemId}
        AND "EvidenceItem"."included" = true
        AND "EvidenceItem"."lifecycleStatus" = 'active'
        AND "EvidenceEmbedding"."indexVersionId" = ${input.index.id}
      ORDER BY "EvidenceEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "ArtifactEmbedding"."artifactId" AS "id",
        (1 - ("ArtifactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "ArtifactEmbedding"
      INNER JOIN "Artifact" ON "Artifact"."id" = "ArtifactEmbedding"."artifactId"
      WHERE "Artifact"."workItemId" = ${input.workItemId}
        AND "Artifact"."lifecycleStatus" = 'active'
        AND "ArtifactEmbedding"."indexVersionId" = ${input.index.id}
      ORDER BY "ArtifactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
  ]);

  return {
    matches: {
      highlights: new Map(highlightRows.map((row) => [row.id, Number(row.similarity)])),
      projectFacts: new Map(projectFactRows.map((row) => [row.id, Number(row.similarity)])),
      evidence: new Map(evidenceRows.map((row) => [row.id, Number(row.similarity)])),
      artifacts: new Map(artifactRows.map((row) => [row.id, Number(row.similarity)])),
    },
    telemetry: {
      latencyMs: performance.now() - startedAt,
      inputTokens: embedding.usage.inputTokens,
      totalTokens: embedding.usage.totalTokens,
      costUsd: embedding.usage.costUsd,
    },
  };
}
