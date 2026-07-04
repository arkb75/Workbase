import { createHash, randomUUID } from "crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ClaimDraft, ClaimSnapshot, HighlightTagAssignment } from "@/src/domain/types";
import { Prisma } from "@/src/generated/prisma/client";
import { resolveBedrockEmbeddingConfig, resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";

export const HIGHLIGHT_EMBEDDING_DIMENSIONS = 512;

type EmbeddableHighlight = Pick<
  ClaimDraft | ClaimSnapshot,
  "text" | "summary" | "verificationNotes" | "tags" | "evidence"
>;

type ExistingHighlightForEmbedding = ClaimSnapshot & {
  id: string;
};

let cachedEmbeddingClient: BedrockRuntimeClient | null = null;

function getBedrockEmbeddingClient() {
  if (!cachedEmbeddingClient) {
    const config = resolveBedrockEmbeddingConfig();
    cachedEmbeddingClient = new BedrockRuntimeClient({
      region: config.region,
      credentials: config.profile
        ? fromIni({
            profile: config.profile,
          })
        : undefined,
    });
  }

  return cachedEmbeddingClient;
}

export function buildHighlightEmbeddingText(highlight: EmbeddableHighlight) {
  const evidenceText = highlight.evidence.sourceRefs
    .slice(0, 8)
    .map((sourceRef) =>
      normalizeWhitespace(
        [
          sourceRef.title,
          sourceRef.sourceLabel,
          sourceRef.excerpt.slice(0, 800),
        ]
          .filter(Boolean)
          .join(" "),
      ),
    )
    .filter(Boolean);
  const tagText = highlight.tags
    .map((tag: HighlightTagAssignment) => `${tag.dimension}:${tag.tag}`)
    .join(" ");

  return normalizeWhitespace(
    [
      highlight.text,
      highlight.summary,
      highlight.verificationNotes ?? "",
      tagText,
      ...evidenceText,
    ].join("\n"),
  );
}

export function hashEmbeddingInput(inputText: string) {
  return createHash("sha256").update(inputText).digest("hex");
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!magnitude) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function deterministicEmbedding(inputText: string) {
  const vector = Array.from({ length: HIGHLIGHT_EMBEDDING_DIMENSIONS }, () => 0);
  const tokens = normalizeWhitespace(inputText.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash.readUInt16BE(0) % HIGHLIGHT_EMBEDDING_DIMENSIONS;
    const sign = hash[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  return normalizeVector(vector);
}

function assertEmbeddingVector(vector: unknown): asserts vector is number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== HIGHLIGHT_EMBEDDING_DIMENSIONS ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Bedrock embedding response did not include a valid 512-dimensional vector.");
  }
}

export function vectorToSqlLiteral(vector: number[]) {
  assertEmbeddingVector(vector);
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

export async function generateHighlightEmbedding(inputText: string) {
  const config = resolveBedrockEmbeddingConfig();

  if (resolveWorkbaseLlmProvider() === "mock") {
    return {
      modelId: "mock-titan-embed-text-v2",
      dimensions: HIGHLIGHT_EMBEDDING_DIMENSIONS,
      inputHash: hashEmbeddingInput(inputText),
      inputText,
      vector: deterministicEmbedding(inputText),
    };
  }

  const response = await getBedrockEmbeddingClient().send(
    new InvokeModelCommand({
      modelId: config.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText,
        dimensions: config.dimensions,
        normalize: config.normalize,
      }),
    }),
  );
  const rawBody = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(rawBody) as { embedding?: unknown };

  assertEmbeddingVector(parsed.embedding);

  return {
    modelId: config.modelId,
    dimensions: config.dimensions,
    inputHash: hashEmbeddingInput(inputText),
    inputText,
    vector: parsed.embedding,
  };
}

export async function upsertHighlightEmbedding(input: {
  highlightId: string;
  inputText: string;
}) {
  const embedding = await generateHighlightEmbedding(input.inputText);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);

  await prisma.$executeRaw`
    INSERT INTO "HighlightEmbedding"
      ("id", "highlightId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.highlightId}, ${embedding.modelId}, ${embedding.dimensions}, ${embedding.inputHash}, ${embedding.inputText}, CAST(${vectorLiteral} AS vector), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("highlightId") DO UPDATE SET
      "modelId" = EXCLUDED."modelId",
      "dimensions" = EXCLUDED."dimensions",
      "inputHash" = EXCLUDED."inputHash",
      "inputText" = EXCLUDED."inputText",
      "embedding" = EXCLUDED."embedding",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return embedding;
}

export async function ensureHighlightEmbeddings(
  highlights: ExistingHighlightForEmbedding[],
) {
  if (!highlights.length) {
    return;
  }

  const inputByHighlightId = new Map(
    highlights.map((highlight) => [
      highlight.id,
      buildHighlightEmbeddingText(highlight),
    ]),
  );
  const existingRows = await prisma.$queryRaw<
    Array<{ highlightId: string; inputHash: string }>
  >(Prisma.sql`
    SELECT "highlightId", "inputHash"
    FROM "HighlightEmbedding"
    WHERE "highlightId" IN (${Prisma.join(highlights.map((highlight) => highlight.id))})
  `);
  const existingHashByHighlightId = new Map(
    existingRows.map((row) => [row.highlightId, row.inputHash]),
  );

  for (const highlight of highlights) {
    const inputText = inputByHighlightId.get(highlight.id) ?? "";
    const nextHash = hashEmbeddingInput(inputText);

    if (existingHashByHighlightId.get(highlight.id) === nextHash) {
      continue;
    }

    await upsertHighlightEmbedding({
      highlightId: highlight.id,
      inputText,
    });
  }
}

export async function findNearestHighlightEmbedding(input: {
  workItemId: string;
  inputText: string;
  limit?: number;
}) {
  const embedding = await generateHighlightEmbedding(input.inputText);
  const vectorLiteral = vectorToSqlLiteral(embedding.vector);
  const rows = await prisma.$queryRaw<
    Array<{
      highlightId: string;
      cosineDistance: number;
    }>
  >`
    SELECT
      "HighlightEmbedding"."highlightId",
      ("HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector))::float8 AS "cosineDistance"
    FROM "HighlightEmbedding"
    INNER JOIN "Claim" ON "Claim"."id" = "HighlightEmbedding"."highlightId"
    WHERE "Claim"."workItemId" = ${input.workItemId}
    ORDER BY "HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
    LIMIT ${input.limit ?? 1}
  `;

  return rows.map((row) => ({
    highlightId: row.highlightId,
    cosineDistance: Number(row.cosineDistance),
    cosineSimilarity: 1 - Number(row.cosineDistance),
  }));
}
