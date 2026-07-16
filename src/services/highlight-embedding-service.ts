import { createHash, randomUUID } from "crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import type { ClaimDraft, ClaimSnapshot, HighlightTagAssignment } from "@/src/domain/types";
import { Prisma } from "@/src/generated/prisma/client";
import { resolveBedrockEmbeddingConfig, resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";

export const HIGHLIGHT_EMBEDDING_DIMENSIONS = 512;

export function resolveCurrentHighlightEmbeddingIdentity() {
  if (resolveWorkbaseLlmProvider() === "mock") {
    return {
      modelId: "mock-titan-embed-text-v2",
      dimensions: HIGHLIGHT_EMBEDDING_DIMENSIONS,
    };
  }

  const config = resolveBedrockEmbeddingConfig();
  return { modelId: config.modelId, dimensions: config.dimensions };
}

type EmbeddableHighlight = Pick<
  ClaimDraft | ClaimSnapshot,
  "text" | "summary" | "verificationNotes" | "tags" | "evidence"
>;

type ExistingHighlightForEmbedding = ClaimSnapshot & {
  id: string;
};

let cachedEmbeddingClient: BedrockRuntimeClient | null = null;
const embeddingPromiseCache = new Map<string, {
  expiresAt: number;
  promise: Promise<Awaited<ReturnType<typeof generateHighlightEmbeddingUncached>>>;
  settled: boolean;
}>();

function embeddingCacheTtlMs() {
  const configured = Number(process.env.WORKBASE_EMBEDDING_CACHE_TTL_MS ?? 300_000);
  return Number.isFinite(configured) ? Math.max(0, Math.min(configured, 3_600_000)) : 300_000;
}

function pruneEmbeddingPromiseCache(now: number) {
  for (const [key, entry] of embeddingPromiseCache) {
    if (entry.settled && entry.expiresAt <= now) embeddingPromiseCache.delete(key);
  }
  while (embeddingPromiseCache.size >= 128) {
    const oldest = Array.from(embeddingPromiseCache.entries())
      .find(([, entry]) => entry.settled)?.[0];
    if (!oldest) break;
    embeddingPromiseCache.delete(oldest);
  }
}

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

async function generateHighlightEmbeddingUncached(inputText: string) {
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

export async function generateHighlightEmbedding(inputText: string) {
  const identity = resolveCurrentHighlightEmbeddingIdentity();
  const inputHash = hashEmbeddingInput(inputText);
  const key = `${identity.modelId}:${identity.dimensions}:${inputHash}`;
  const now = Date.now();
  pruneEmbeddingPromiseCache(now);
  const cached = embeddingPromiseCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const ttlMs = embeddingCacheTtlMs();
  const promise = generateHighlightEmbeddingUncached(inputText);
  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
    settled: false,
  };
  embeddingPromiseCache.set(key, entry);
  try {
    const result = await promise;
    entry.settled = true;
    entry.expiresAt = Date.now() + ttlMs;
    if (ttlMs === 0) embeddingPromiseCache.delete(key);
    return result;
  } catch (error) {
    embeddingPromiseCache.delete(key);
    throw error;
  }
}

type ExistingEmbeddingIdentity = {
  inputHash: string;
  modelId: string;
  dimensions: number;
};

export function embeddingIdentityIsFresh(
  row: ExistingEmbeddingIdentity | undefined,
  inputText: string,
) {
  const expected = resolveCurrentHighlightEmbeddingIdentity();
  return row?.inputHash === hashEmbeddingInput(inputText) &&
    row.modelId === expected.modelId &&
    row.dimensions === expected.dimensions;
}

export async function upsertHighlightEmbedding(input: {
  highlightId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  if (!input.skipFreshnessCheck) {
    const existingRows = await prisma.$queryRaw<ExistingEmbeddingIdentity[]>`
      SELECT "inputHash", "modelId", "dimensions"
      FROM "HighlightEmbedding"
      WHERE "highlightId" = ${input.highlightId}
      LIMIT 1
    `;
    if (embeddingIdentityIsFresh(existingRows[0], input.inputText)) {
      const identity = resolveCurrentHighlightEmbeddingIdentity();
      return {
        ...identity,
        inputHash: hashEmbeddingInput(input.inputText),
        inputText: input.inputText,
        vector: null,
        reused: true,
      };
    }
  }
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

  return { ...embedding, reused: false };
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
    Array<{ highlightId: string; inputHash: string; modelId: string; dimensions: number }>
  >(Prisma.sql`
    SELECT "highlightId", "inputHash", "modelId", "dimensions"
    FROM "HighlightEmbedding"
    WHERE "highlightId" IN (${Prisma.join(highlights.map((highlight) => highlight.id))})
  `);
  const existingByHighlightId = new Map(existingRows.map((row) => [row.highlightId, row]));
  const expectedIdentity = resolveCurrentHighlightEmbeddingIdentity();

  const pending: Array<{ highlightId: string; inputText: string }> = [];
  for (const highlight of highlights) {
    const inputText = inputByHighlightId.get(highlight.id) ?? "";
    const nextHash = hashEmbeddingInput(inputText);

    const existing = existingByHighlightId.get(highlight.id);
    if (
      existing?.inputHash === nextHash &&
      existing.modelId === expectedIdentity.modelId &&
      existing.dimensions === expectedIdentity.dimensions
    ) {
      continue;
    }
    pending.push({ highlightId: highlight.id, inputText });
  }
  // Embedding backfills are independent, but an unbounded Promise.all can
  // spike Bedrock throttling and database connections. Small waves preserve
  // throughput without turning one stale row into serial latency for all rows.
  for (let offset = 0; offset < pending.length; offset += 4) {
    await Promise.all(pending.slice(offset, offset + 4).map((entry) =>
      upsertHighlightEmbedding({ ...entry, skipFreshnessCheck: true })
    ));
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
