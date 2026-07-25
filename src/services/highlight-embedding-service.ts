import type { ClaimDraft, ClaimSnapshot, HighlightTagAssignment } from "@/src/domain/types";
import { Prisma } from "@/src/generated/prisma/client";
import {
  type EmbeddingIndexIdentity,
  WORKBASE_EMBEDDING_DIMENSIONS,
} from "@/src/lib/embedding-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  EmbeddingWriteFenceChangedError,
  type EmbeddingIndexVersion,
  type EmbeddingWriteSet,
  persistVersionedEmbeddingBatch,
  recordEmbeddingIndexShadowFailure,
  resolveActiveEmbeddingIndex,
  resolveEmbeddingWriteSet,
} from "@/src/services/embedding-index-service";
import {
  generateEmbeddingForIndex,
  hashEmbeddingInput,
  type GeneratedEmbedding,
  vectorToSqlLiteral,
} from "@/src/services/embedding-runtime";

export const HIGHLIGHT_EMBEDDING_DIMENSIONS = WORKBASE_EMBEDDING_DIMENSIONS;
export { hashEmbeddingInput, vectorToSqlLiteral };

type EmbeddableHighlight = Pick<
  ClaimDraft | ClaimSnapshot,
  "text" | "summary" | "verificationNotes" | "tags" | "evidence"
>;

type ExistingHighlightForEmbedding = ClaimSnapshot & {
  id: string;
};

type ExistingEmbeddingIdentity = {
  indexVersionId: string;
  inputHash: string;
  modelId: string;
  dimensions: number;
};

const embeddingPromiseCache = new Map<string, {
  expiresAt: number;
  promise: Promise<GeneratedEmbedding>;
  settled: boolean;
}>();

function embeddingCacheTtlMs() {
  const configured = Number(process.env.WORKBASE_EMBEDDING_CACHE_TTL_MS ?? 300_000);
  return Number.isFinite(configured)
    ? Math.max(0, Math.min(configured, 3_600_000))
    : 300_000;
}

function pruneEmbeddingPromiseCache(now: number) {
  for (const [key, entry] of embeddingPromiseCache) {
    if (entry.settled && entry.expiresAt <= now) embeddingPromiseCache.delete(key);
  }
  while (embeddingPromiseCache.size >= 256) {
    const oldest = Array.from(embeddingPromiseCache.entries())
      .find(([, entry]) => entry.settled)?.[0];
    if (!oldest) break;
    embeddingPromiseCache.delete(oldest);
  }
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

export async function resolveCurrentHighlightEmbeddingIdentity() {
  return resolveActiveEmbeddingIndex();
}

export async function generateHighlightEmbedding(
  inputText: string,
  identity?: EmbeddingIndexIdentity,
) {
  const resolvedIdentity = identity ?? await resolveActiveEmbeddingIndex();
  const inputHash = hashEmbeddingInput(inputText);
  const key = `${resolvedIdentity.id}:${resolvedIdentity.modelId}:${resolvedIdentity.dimensions}:${inputHash}`;
  const now = Date.now();
  pruneEmbeddingPromiseCache(now);
  const cached = embeddingPromiseCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const ttlMs = embeddingCacheTtlMs();
  const promise = generateEmbeddingForIndex({
    identity: resolvedIdentity,
    inputText,
  });
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

export function embeddingIdentityIsFresh(
  row: ExistingEmbeddingIdentity | undefined,
  inputText: string,
  expected: EmbeddingIndexIdentity,
) {
  return row?.indexVersionId === expected.id &&
    row.inputHash === hashEmbeddingInput(inputText) &&
    row.modelId === expected.modelId &&
    row.dimensions === expected.dimensions;
}

export function beginEmbeddingWriteGeneration(input: {
  writeSet: EmbeddingWriteSet;
  staleTargets: EmbeddingIndexVersion[];
  inputText: string;
}) {
  const activeTarget = input.staleTargets.find(
    (target) => target.id === input.writeSet.active.id,
  );
  const shadowTargets = input.staleTargets.filter(
    (target) => target.id !== input.writeSet.active.id,
  );
  const activeEmbedding = activeTarget
    ? generateHighlightEmbedding(input.inputText, activeTarget)
    : Promise.resolve(null);
  const shadowResults = Promise.allSettled(
    shadowTargets.map((target) =>
      generateHighlightEmbedding(input.inputText, target)
    ),
  );
  return { activeEmbedding, shadowTargets, shadowResults };
}

async function persistShadowEmbeddingResults(input: {
  writeSet: EmbeddingWriteSet;
  kind: "highlight" | "projectFact" | "evidence" | "artifact";
  entityId: string;
  shadowTargets: EmbeddingIndexVersion[];
  shadowResults: Promise<PromiseSettledResult<GeneratedEmbedding>[]>;
}) {
  const shadowResults = await input.shadowResults;
  const embeddings: GeneratedEmbedding[] = [];
  for (let index = 0; index < shadowResults.length; index += 1) {
    const result = shadowResults[index];
    if (result.status === "fulfilled") {
      embeddings.push(result.value);
      continue;
    }
    await Promise.allSettled([
      recordEmbeddingIndexShadowFailure({
        indexVersionId: input.shadowTargets[index].id,
        phase: "generation",
        error: result.reason,
      }),
    ]);
  }
  if (embeddings.length) {
    await persistVersionedEmbeddingBatch({
      writeSet: input.writeSet,
      kind: input.kind,
      entityId: input.entityId,
      embeddings,
    });
  }
}

const pendingShadowWrites = new Set<Promise<void>>();

export function scheduleShadowEmbeddingWrites(
  input: Parameters<typeof persistShadowEmbeddingResults>[0],
) {
  const task = persistShadowEmbeddingResults(input).catch(async (error) => {
    await Promise.allSettled(input.shadowTargets.map((target) =>
      recordEmbeddingIndexShadowFailure({
        indexVersionId: target.id,
        phase: "persistence",
        error,
      })
    ));
  });
  pendingShadowWrites.add(task);
  void task.finally(() => pendingShadowWrites.delete(task));
}

export async function awaitPendingEmbeddingShadowWrites() {
  await Promise.allSettled(Array.from(pendingShadowWrites));
}

function reusedEmbedding(identity: EmbeddingIndexIdentity, inputText: string) {
  return {
    ...identity,
    inputHash: hashEmbeddingInput(inputText),
    inputText,
    vector: null,
    usage: { inputTokens: null, totalTokens: null, costUsd: null },
    reused: true as const,
  };
}

export async function upsertHighlightEmbedding(input: {
  highlightId: string;
  inputText: string;
  skipFreshnessCheck?: boolean;
}) {
  for (let fenceAttempt = 0; fenceAttempt < 3; fenceAttempt += 1) {
    const writeSet = await resolveEmbeddingWriteSet();
    const existingRows = input.skipFreshnessCheck
      ? []
      : await prisma.$queryRaw<ExistingEmbeddingIdentity[]>(Prisma.sql`
          SELECT "indexVersionId", "inputHash", "modelId", "dimensions"
          FROM "HighlightEmbedding"
          WHERE "highlightId" = ${input.highlightId}
            AND "indexVersionId" IN (${Prisma.join(writeSet.targets.map((target) => target.id))})
        `);
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
          kind: "highlight",
          entityId: input.highlightId,
          embeddings: [activeGenerated],
        });
      }
      scheduleShadowEmbeddingWrites({
        writeSet,
        kind: "highlight",
        entityId: input.highlightId,
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

export async function ensureHighlightEmbeddings(
  highlights: ExistingHighlightForEmbedding[],
) {
  for (let offset = 0; offset < highlights.length; offset += 4) {
    await Promise.all(
      highlights.slice(offset, offset + 4).map((highlight) =>
        upsertHighlightEmbedding({
          highlightId: highlight.id,
          inputText: buildHighlightEmbeddingText(highlight),
        })
      ),
    );
  }
}

export async function findNearestHighlightEmbedding(input: {
  workItemId: string;
  inputText: string;
  limit?: number;
}) {
  const active = await resolveActiveEmbeddingIndex();
  const embedding = await generateHighlightEmbedding(input.inputText, active);
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
      AND "HighlightEmbedding"."indexVersionId" = ${active.id}
    ORDER BY "HighlightEmbedding"."embedding" <=> CAST(${vectorLiteral} AS vector)
    LIMIT ${input.limit ?? 1}
  `;

  return rows.map((row) => ({
    highlightId: row.highlightId,
    cosineDistance: Number(row.cosineDistance),
    cosineSimilarity: 1 - Number(row.cosineDistance),
  }));
}
