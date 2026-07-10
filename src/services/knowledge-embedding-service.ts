import { randomUUID } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  generateHighlightEmbedding,
  hashEmbeddingInput,
  resolveCurrentHighlightEmbeddingIdentity,
  vectorToSqlLiteral,
} from "@/src/services/highlight-embedding-service";

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

export async function upsertEvidenceEmbedding(input: {
  evidenceItemId: string;
  inputText: string;
}) {
  const embedding = await generateHighlightEmbedding(input.inputText);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);

  await prisma.$executeRaw`
    INSERT INTO "EvidenceEmbedding"
      ("id", "evidenceItemId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.evidenceItemId}, ${embedding.modelId}, ${embedding.dimensions}, ${embedding.inputHash}, ${embedding.inputText}, CAST(${vectorLiteral} AS vector), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("evidenceItemId") DO UPDATE SET
      "modelId" = EXCLUDED."modelId",
      "dimensions" = EXCLUDED."dimensions",
      "inputHash" = EXCLUDED."inputHash",
      "inputText" = EXCLUDED."inputText",
      "embedding" = EXCLUDED."embedding",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return embedding;
}

export async function upsertArtifactEmbedding(input: {
  artifactId: string;
  inputText: string;
}) {
  const embedding = await generateHighlightEmbedding(input.inputText);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);

  await prisma.$executeRaw`
    INSERT INTO "ArtifactEmbedding"
      ("id", "artifactId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.artifactId}, ${embedding.modelId}, ${embedding.dimensions}, ${embedding.inputHash}, ${embedding.inputText}, CAST(${vectorLiteral} AS vector), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("artifactId") DO UPDATE SET
      "modelId" = EXCLUDED."modelId",
      "dimensions" = EXCLUDED."dimensions",
      "inputHash" = EXCLUDED."inputHash",
      "inputText" = EXCLUDED."inputText",
      "embedding" = EXCLUDED."embedding",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return embedding;
}

export async function ensureProjectKnowledgeEmbeddings(input: {
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
  const evidenceInputById = new Map(
    input.evidenceItems.map((item) => [
      item.id,
      buildEvidenceEmbeddingText({
        ...item,
        sourceLabel: item.source.label,
      }),
    ]),
  );
  const artifactInputById = new Map(
    input.artifacts.map((artifact) => [
      artifact.id,
      buildArtifactEmbeddingText(artifact),
    ]),
  );
  const [evidenceRows, artifactRows] = await Promise.all([
    input.evidenceItems.length
      ? prisma.$queryRaw<Array<{ evidenceItemId: string; inputHash: string; modelId: string; dimensions: number }>>(Prisma.sql`
          SELECT "evidenceItemId", "inputHash", "modelId", "dimensions"
          FROM "EvidenceEmbedding"
          WHERE "evidenceItemId" IN (${Prisma.join(input.evidenceItems.map((item) => item.id))})
        `)
      : Promise.resolve([]),
    input.artifacts.length
      ? prisma.$queryRaw<Array<{ artifactId: string; inputHash: string; modelId: string; dimensions: number }>>(Prisma.sql`
          SELECT "artifactId", "inputHash", "modelId", "dimensions"
          FROM "ArtifactEmbedding"
          WHERE "artifactId" IN (${Prisma.join(input.artifacts.map((item) => item.id))})
        `)
      : Promise.resolve([]),
  ]);
  const evidenceById = new Map(evidenceRows.map((row) => [row.evidenceItemId, row]));
  const artifactById = new Map(artifactRows.map((row) => [row.artifactId, row]));
  const expectedIdentity = resolveCurrentHighlightEmbeddingIdentity();
  const isFresh = (row: { inputHash: string; modelId: string; dimensions: number } | undefined, inputText: string) =>
    row?.inputHash === hashEmbeddingInput(inputText) &&
    row.modelId === expectedIdentity.modelId &&
    row.dimensions === expectedIdentity.dimensions;

  await Promise.allSettled([
    ...input.evidenceItems.flatMap((item) => {
      const inputText = evidenceInputById.get(item.id) ?? "";
      return isFresh(evidenceById.get(item.id), inputText)
        ? []
        : [upsertEvidenceEmbedding({ evidenceItemId: item.id, inputText })];
    }),
    ...input.artifacts.flatMap((artifact) => {
      const inputText = artifactInputById.get(artifact.id) ?? "";
      return isFresh(artifactById.get(artifact.id), inputText)
        ? []
        : [upsertArtifactEmbedding({ artifactId: artifact.id, inputText })];
    }),
  ]);
}

export async function findNearestProjectKnowledge(input: {
  workItemId: string;
  query: string;
  limit?: number;
}) {
  const embedding = await generateHighlightEmbedding(input.query);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);
  const limit = input.limit ?? 30;
  const [highlightRows, evidenceRows, artifactRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "HighlightEmbedding"."highlightId" AS "id",
        (1 - ("HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "HighlightEmbedding"
      INNER JOIN "Claim" ON "Claim"."id" = "HighlightEmbedding"."highlightId"
      WHERE "Claim"."workItemId" = ${input.workItemId}
      ORDER BY "HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "EvidenceEmbedding"."evidenceItemId" AS "id",
        (1 - ("EvidenceEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "EvidenceEmbedding"
      INNER JOIN "EvidenceItem" ON "EvidenceItem"."id" = "EvidenceEmbedding"."evidenceItemId"
      WHERE "EvidenceItem"."workItemId" = ${input.workItemId}
      ORDER BY "EvidenceEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
    prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT "ArtifactEmbedding"."artifactId" AS "id",
        (1 - ("ArtifactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)))::float8 AS "similarity"
      FROM "ArtifactEmbedding"
      INNER JOIN "Artifact" ON "Artifact"."id" = "ArtifactEmbedding"."artifactId"
      WHERE "Artifact"."workItemId" = ${input.workItemId}
      ORDER BY "ArtifactEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
      LIMIT ${limit}
    `,
  ]);

  return {
    highlights: new Map(highlightRows.map((row) => [row.id, Number(row.similarity)])),
    evidence: new Map(evidenceRows.map((row) => [row.id, Number(row.similarity)])),
    artifacts: new Map(artifactRows.map((row) => [row.id, Number(row.similarity)])),
  };
}
