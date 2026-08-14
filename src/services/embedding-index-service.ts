import { randomUUID } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import {
  assertEmbeddingIndexIdentity,
  type EmbeddingIndexIdentity,
  type EmbeddingProvider,
  WORKBASE_EMBEDDING_DIMENSIONS,
} from "@/src/lib/embedding-config";
import { prisma } from "@/src/lib/prisma";
import {
  generateEmbeddingForIndex,
  type GeneratedEmbedding,
  vectorToSqlLiteral,
} from "@/src/services/embedding-runtime";

export type EmbeddingIndexVersion = EmbeddingIndexIdentity & {
  status: "building" | "ready" | "active" | "failed" | "retired";
  writeEnabled: boolean;
  baseActivationEpoch: number;
  qualityGatePassed?: boolean;
  reconciledAt?: Date | null;
};

export type EmbeddingQualityValidationFence = {
  activeVersionId: string;
  candidateVersionId: string;
  activationEpoch: number;
  writeSetEpoch: number;
  // Corpus invalidation clears reconciledAt, while each reconciliation also
  // advances writeSetEpoch. Together they fence both transitions without a
  // separate mutable validation-token column.
  candidateReconciledAt: string | null;
};

export type EmbeddingWriteSet = {
  active: EmbeddingIndexVersion;
  targets: EmbeddingIndexVersion[];
  activationEpoch: number;
  writeSetEpoch: number;
};

export type EmbeddingEntityKind =
  | "highlight"
  | "projectFact"
  | "evidence"
  | "artifact";

type IndexRow = {
  id: string;
  key: string;
  provider: string;
  modelId: string;
  dimensions: number;
  status: EmbeddingIndexVersion["status"];
  writeEnabled: boolean;
  baseActivationEpoch: number;
  qualityGatePassed?: boolean;
  reconciledAt?: Date | null;
  activationEpoch?: number;
  writeSetEpoch?: number;
  isActive?: boolean;
};

type IndexQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type IndexWriteClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export class EmbeddingWriteFenceChangedError extends Error {
  constructor() {
    super("The embedding write set changed while vectors were being generated.");
    this.name = "EmbeddingWriteFenceChangedError";
  }
}

function toIndexVersion(row: IndexRow): EmbeddingIndexVersion {
  return {
    ...assertEmbeddingIndexIdentity({
      id: row.id,
      key: row.key,
      provider: row.provider as EmbeddingProvider,
      modelId: row.modelId,
      dimensions: Number(row.dimensions),
    }),
    status: row.status,
    writeEnabled: row.writeEnabled,
    baseActivationEpoch: Number(row.baseActivationEpoch),
    qualityGatePassed: row.qualityGatePassed,
    reconciledAt: row.reconciledAt,
  };
}

export async function resolveEmbeddingWriteSet(
  client: IndexQueryClient = prisma,
): Promise<EmbeddingWriteSet> {
  const rows = await client.$queryRaw<IndexRow[]>`
    SELECT
      version."id",
      version."key",
      version."provider",
      version."modelId",
      version."dimensions",
      version."status"::text AS "status",
      version."writeEnabled",
      version."baseActivationEpoch",
      version."qualityGatePassed",
      version."reconciledAt",
      control."activationEpoch",
      control."writeSetEpoch",
      (version."id" = control."activeVersionId") AS "isActive"
    FROM "EmbeddingIndexControl" AS control
    INNER JOIN "EmbeddingIndexVersion" AS version
      ON version."id" = control."activeVersionId"
      OR (
        version."writeEnabled" = true
        AND version."status" IN ('building', 'ready')
      )
    WHERE control."id" = 'default'
    ORDER BY
      (version."id" = control."activeVersionId") DESC,
      version."createdAt" ASC
  `;
  const activeRow = rows.find((row) => row.isActive);
  if (!activeRow || activeRow.status !== "active") {
    throw new Error(
      "No active embedding index is registered. Run database migrations and restore EmbeddingIndexControl.",
    );
  }

  const targets = rows.map(toIndexVersion);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new Error("Embedding write set contains duplicate index versions.");
  }

  return {
    active: toIndexVersion(activeRow),
    targets,
    activationEpoch: Number(activeRow.activationEpoch ?? 0),
    writeSetEpoch: Number(activeRow.writeSetEpoch ?? 0),
  };
}

export async function resolveActiveEmbeddingIndex(
  client: IndexQueryClient = prisma,
) {
  return (await resolveEmbeddingWriteSet(client)).active;
}

export async function runFencedEmbeddingWrite<T>(input: {
  expectedWriteSetEpoch: number;
  write: (client: IndexWriteClient) => Promise<T>;
}) {
  return prisma.$transaction(async (tx) => {
    const controls = await tx.$queryRaw<Array<{ writeSetEpoch: number }>>`
      SELECT "writeSetEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR SHARE
    `;
    if (Number(controls[0]?.writeSetEpoch) !== input.expectedWriteSetEpoch) {
      throw new EmbeddingWriteFenceChangedError();
    }
    return input.write(tx);
  });
}

function embeddingCostValue(embedding: GeneratedEmbedding) {
  return embedding.usage.costUsd === null
    ? null
    : embedding.usage.costUsd.toFixed(10);
}

async function invalidateChangedCandidateQualityGate(input: {
  client: Pick<Prisma.TransactionClient, "$executeRaw">;
  indexVersionId: string;
}) {
  await input.client.$executeRaw`
    UPDATE "EmbeddingIndexVersion"
    SET "status" = 'building',
        "qualityGatePassed" = false,
        "qualityValidatedAt" = NULL,
        "qualityReport" = NULL,
        "reconciledAt" = NULL,
        "validation" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.indexVersionId}
      AND "status" IN ('building', 'ready')
      AND (
        "status" = 'ready'
        OR "qualityGatePassed" = true
        OR "qualityValidatedAt" IS NOT NULL
        OR "qualityReport" IS NOT NULL
        OR "reconciledAt" IS NOT NULL
        OR "validation" IS NOT NULL
      )
  `;
}

export async function upsertVersionedEmbeddingRecord(input: {
  client: Pick<Prisma.TransactionClient, "$executeRaw">;
  kind: EmbeddingEntityKind;
  entityId: string;
  embedding: GeneratedEmbedding;
  invalidateCandidateQualityGate?: boolean;
}) {
  const vectorLiteral = vectorToSqlLiteral(input.embedding.vector);
  const inputTokens = input.embedding.usage.inputTokens;
  const costUsd = embeddingCostValue(input.embedding);

  if (input.kind === "highlight") {
    const result = await input.client.$executeRaw`
      INSERT INTO "HighlightEmbedding"
        ("id", "highlightId", "indexVersionId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "inputTokens", "costUsd", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${input.entityId}, ${input.embedding.id}, ${input.embedding.modelId}, ${input.embedding.dimensions}, ${input.embedding.inputHash}, ${input.embedding.inputText}, CAST(${vectorLiteral} AS vector), ${inputTokens}, ${costUsd}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("highlightId", "indexVersionId") DO UPDATE SET
        "modelId" = EXCLUDED."modelId",
        "dimensions" = EXCLUDED."dimensions",
        "inputHash" = EXCLUDED."inputHash",
        "inputText" = EXCLUDED."inputText",
        "embedding" = EXCLUDED."embedding",
        "inputTokens" = EXCLUDED."inputTokens",
        "costUsd" = EXCLUDED."costUsd",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
    if (input.invalidateCandidateQualityGate) {
      await invalidateChangedCandidateQualityGate({
        client: input.client,
        indexVersionId: input.embedding.id,
      });
    }
    return result;
  }
  if (input.kind === "projectFact") {
    const result = await input.client.$executeRaw`
      INSERT INTO "ProjectFactEmbedding"
        ("id", "projectFactId", "indexVersionId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "inputTokens", "costUsd", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${input.entityId}, ${input.embedding.id}, ${input.embedding.modelId}, ${input.embedding.dimensions}, ${input.embedding.inputHash}, ${input.embedding.inputText}, CAST(${vectorLiteral} AS vector), ${inputTokens}, ${costUsd}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("projectFactId", "indexVersionId") DO UPDATE SET
        "modelId" = EXCLUDED."modelId",
        "dimensions" = EXCLUDED."dimensions",
        "inputHash" = EXCLUDED."inputHash",
        "inputText" = EXCLUDED."inputText",
        "embedding" = EXCLUDED."embedding",
        "inputTokens" = EXCLUDED."inputTokens",
        "costUsd" = EXCLUDED."costUsd",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
    if (input.invalidateCandidateQualityGate) {
      await invalidateChangedCandidateQualityGate({
        client: input.client,
        indexVersionId: input.embedding.id,
      });
    }
    return result;
  }
  if (input.kind === "evidence") {
    const result = await input.client.$executeRaw`
      INSERT INTO "EvidenceEmbedding"
        ("id", "evidenceItemId", "indexVersionId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "inputTokens", "costUsd", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${input.entityId}, ${input.embedding.id}, ${input.embedding.modelId}, ${input.embedding.dimensions}, ${input.embedding.inputHash}, ${input.embedding.inputText}, CAST(${vectorLiteral} AS vector), ${inputTokens}, ${costUsd}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("evidenceItemId", "indexVersionId") DO UPDATE SET
        "modelId" = EXCLUDED."modelId",
        "dimensions" = EXCLUDED."dimensions",
        "inputHash" = EXCLUDED."inputHash",
        "inputText" = EXCLUDED."inputText",
        "embedding" = EXCLUDED."embedding",
        "inputTokens" = EXCLUDED."inputTokens",
        "costUsd" = EXCLUDED."costUsd",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
    if (input.invalidateCandidateQualityGate) {
      await invalidateChangedCandidateQualityGate({
        client: input.client,
        indexVersionId: input.embedding.id,
      });
    }
    return result;
  }
  const result = await input.client.$executeRaw`
    INSERT INTO "ArtifactEmbedding"
      ("id", "artifactId", "indexVersionId", "modelId", "dimensions", "inputHash", "inputText", "embedding", "inputTokens", "costUsd", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.entityId}, ${input.embedding.id}, ${input.embedding.modelId}, ${input.embedding.dimensions}, ${input.embedding.inputHash}, ${input.embedding.inputText}, CAST(${vectorLiteral} AS vector), ${inputTokens}, ${costUsd}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("artifactId", "indexVersionId") DO UPDATE SET
      "modelId" = EXCLUDED."modelId",
      "dimensions" = EXCLUDED."dimensions",
      "inputHash" = EXCLUDED."inputHash",
      "inputText" = EXCLUDED."inputText",
      "embedding" = EXCLUDED."embedding",
      "inputTokens" = EXCLUDED."inputTokens",
      "costUsd" = EXCLUDED."costUsd",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
  if (input.invalidateCandidateQualityGate) {
    await invalidateChangedCandidateQualityGate({
      client: input.client,
      indexVersionId: input.embedding.id,
    });
  }
  return result;
}

export async function recordEmbeddingIndexShadowFailure(input: {
  indexVersionId: string;
  phase: "generation" | "persistence";
  error: unknown;
}) {
  const errorName = input.error instanceof Error ? input.error.name : "UnknownError";
  await prisma.$executeRaw`
    UPDATE "EmbeddingIndexVersion"
    SET "lastError" = CAST(${JSON.stringify({
      phase: input.phase,
      errorName,
      recordedAt: new Date().toISOString(),
    })} AS jsonb),
        "status" = 'building',
        "qualityGatePassed" = false,
        "qualityValidatedAt" = NULL,
        "qualityReport" = NULL,
        "reconciledAt" = NULL,
        "validation" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.indexVersionId}
      AND "status" IN ('building', 'ready')
  `;
}

export async function persistVersionedEmbeddingBatch(input: {
  writeSet: EmbeddingWriteSet;
  kind: EmbeddingEntityKind;
  entityId: string;
  embeddings: GeneratedEmbedding[];
}) {
  const activeEmbedding = input.embeddings.find(
    (embedding) => embedding.id === input.writeSet.active.id,
  );
  const shadowEmbeddings = input.embeddings.filter(
    (embedding) => embedding.id !== input.writeSet.active.id,
  );
  const persistOne = (embedding: GeneratedEmbedding) => {
    const target = input.writeSet.targets.find(
      (version) => version.id === embedding.id,
    );
    return runFencedEmbeddingWrite({
      expectedWriteSetEpoch: input.writeSet.writeSetEpoch,
      write: (client) =>
        upsertVersionedEmbeddingRecord({
          client,
          kind: input.kind,
          entityId: input.entityId,
          embedding,
          invalidateCandidateQualityGate:
            target?.status !== "active" &&
            (
              target?.status === "ready" ||
              target?.qualityGatePassed === true
            ),
        }),
    });
  };

  // The active vector is availability-critical and is always committed first.
  // Shadow writes are independent; a candidate outage leaves a reconciliation
  // gap instead of rolling back the active index update.
  if (activeEmbedding) await persistOne(activeEmbedding);
  const shadowWrites = await Promise.allSettled(shadowEmbeddings.map(persistOne));
  for (let index = 0; index < shadowWrites.length; index += 1) {
    const result = shadowWrites[index];
    if (result.status === "fulfilled") continue;
    if (result.reason instanceof EmbeddingWriteFenceChangedError) {
      throw result.reason;
    }
    await Promise.allSettled([
      recordEmbeddingIndexShadowFailure({
        indexVersionId: shadowEmbeddings[index].id,
        phase: "persistence",
        error: result.reason,
      }),
    ]);
  }
}

export function persistBackfillEmbeddingRecord(input: {
  writeSet: EmbeddingWriteSet;
  target: EmbeddingIndexVersion;
  kind: EmbeddingEntityKind;
  entityId: string;
  embedding: GeneratedEmbedding;
}) {
  if (!input.writeSet.targets.some((target) => target.id === input.target.id)) {
    throw new Error(
      `Embedding index "${input.target.key}" is not in the fenced write set.`,
    );
  }
  const fencedTarget = input.writeSet.targets.find(
    (target) => target.id === input.target.id,
  )!;
  return runFencedEmbeddingWrite({
    expectedWriteSetEpoch: input.writeSet.writeSetEpoch,
    write: (client) =>
      upsertVersionedEmbeddingRecord({
        client,
        kind: input.kind,
        entityId: input.entityId,
        embedding: input.embedding,
        invalidateCandidateQualityGate:
          fencedTarget.status !== "active" &&
          (
            fencedTarget.status === "ready" ||
            fencedTarget.qualityGatePassed === true
          ),
      }),
  });
}

async function lockEmbeddingIndexAdministration(client: IndexQueryClient) {
  await client.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(hashtext('workbase-embedding-index-administration'))
  `;
}

export async function registerEmbeddingIndexCandidate(input: {
  key: string;
  provider: EmbeddingProvider;
  modelId: string;
  dimensions?: number;
}) {
  const requested = assertEmbeddingIndexIdentity({
    id: "candidate",
    key: input.key,
    provider: input.provider,
    modelId: input.modelId,
    dimensions: input.dimensions ?? WORKBASE_EMBEDDING_DIMENSIONS,
  });
  return prisma.$transaction(async (tx) => {
    await lockEmbeddingIndexAdministration(tx);
    const controls = await tx.$queryRaw<Array<{
      activationEpoch: number;
      writeSetEpoch: number;
    }>>`
      SELECT "activationEpoch", "writeSetEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR UPDATE
    `;
    const control = controls[0];
    if (!control) throw new Error("EmbeddingIndexControl is missing.");

    const existing = await tx.$queryRaw<IndexRow[]>`
      SELECT
        "id", "key", "provider", "modelId", "dimensions",
        "status"::text AS "status", "writeEnabled", "baseActivationEpoch",
        "qualityGatePassed", "reconciledAt"
      FROM "EmbeddingIndexVersion"
      WHERE "key" = ${requested.key}
      FOR UPDATE
    `;
    if (existing[0]) {
      const version = toIndexVersion(existing[0]);
      if (
        version.provider !== requested.provider ||
        version.modelId !== requested.modelId ||
        version.dimensions !== requested.dimensions
      ) {
        throw new Error(
          `Embedding index key "${requested.key}" is already assigned to a different model identity.`,
        );
      }
      return { version, registered: false };
    }

    const counts = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "EmbeddingIndexVersion"
      WHERE "writeEnabled" = true
        AND "status" IN ('active', 'building', 'ready')
    `;
    const configuredLimit = Number(process.env.WORKBASE_MAX_EMBEDDING_WRITE_TARGETS ?? 3);
    const writeTargetLimit = Number.isInteger(configuredLimit)
      ? Math.max(2, Math.min(configuredLimit, 5))
      : 3;
    if (Number(counts[0]?.count ?? 0) >= writeTargetLimit) {
      throw new Error(
        `Embedding write target limit (${writeTargetLimit}) reached. Disable a non-active index before registering another candidate.`,
      );
    }

    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "EmbeddingIndexVersion"
        ("id", "key", "provider", "modelId", "dimensions", "status", "writeEnabled", "baseActivationEpoch", "buildStartedAt", "createdAt", "updatedAt")
      VALUES
        (${id}, ${requested.key}, ${requested.provider}, ${requested.modelId}, ${requested.dimensions}, 'building', true, ${control.activationEpoch}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexControl"
      SET "writeSetEpoch" = "writeSetEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'
    `;

    return {
      version: {
        ...requested,
        id,
        status: "building" as const,
        writeEnabled: true,
        baseActivationEpoch: Number(control.activationEpoch),
        qualityGatePassed: false,
      },
      registered: true,
    };
  });
}

async function findIndexByKey(
  client: IndexQueryClient,
  key: string,
  lock = false,
) {
  const lockClause = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const rows = await client.$queryRaw<IndexRow[]>(Prisma.sql`
    SELECT
      "id", "key", "provider", "modelId", "dimensions",
      "status"::text AS "status", "writeEnabled", "baseActivationEpoch",
      "qualityGatePassed", "reconciledAt"
    FROM "EmbeddingIndexVersion"
    WHERE "key" = ${key}
    ${lockClause}
  `);
  if (!rows[0]) throw new Error(`Embedding index "${key}" does not exist.`);
  return toIndexVersion(rows[0]);
}

function serializeReconciliationTimestamp(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export function assertEmbeddingQualityValidationFence(
  value: unknown,
): EmbeddingQualityValidationFence {
  if (!value || typeof value !== "object") {
    throw new Error("Embedding quality report is missing its validation fence.");
  }
  const candidate = value as Partial<EmbeddingQualityValidationFence>;
  const validTimestamp =
    candidate.candidateReconciledAt === null ||
    (
      typeof candidate.candidateReconciledAt === "string" &&
      !Number.isNaN(Date.parse(candidate.candidateReconciledAt))
    );
  if (
    typeof candidate.activeVersionId !== "string" ||
    !candidate.activeVersionId ||
    typeof candidate.candidateVersionId !== "string" ||
    !candidate.candidateVersionId ||
    !Number.isInteger(candidate.activationEpoch) ||
    Number(candidate.activationEpoch) < 0 ||
    !Number.isInteger(candidate.writeSetEpoch) ||
    Number(candidate.writeSetEpoch) < 0 ||
    !validTimestamp
  ) {
    throw new Error("Embedding quality report has an invalid validation fence.");
  }
  return candidate as EmbeddingQualityValidationFence;
}

function embeddingQualityValidationFencesMatch(
  left: EmbeddingQualityValidationFence,
  right: EmbeddingQualityValidationFence,
) {
  return (
    left.activeVersionId === right.activeVersionId &&
    left.candidateVersionId === right.candidateVersionId &&
    left.activationEpoch === right.activationEpoch &&
    left.writeSetEpoch === right.writeSetEpoch &&
    left.candidateReconciledAt === right.candidateReconciledAt
  );
}

export async function resolveEmbeddingQualityValidationContext(key: string) {
  return prisma.$transaction(async (tx) => {
    const writeSet = await resolveEmbeddingWriteSet(tx);
    const candidate = await findIndexByKey(tx, key);
    return {
      active: writeSet.active,
      candidate,
      validationFence: {
        activeVersionId: writeSet.active.id,
        candidateVersionId: candidate.id,
        activationEpoch: writeSet.activationEpoch,
        writeSetEpoch: writeSet.writeSetEpoch,
        candidateReconciledAt: serializeReconciliationTimestamp(
          candidate.reconciledAt,
        ),
      } satisfies EmbeddingQualityValidationFence,
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

type BackfillRow = { entityId: string; inputText: string };

async function findBackfillRows(input: {
  kind: EmbeddingEntityKind;
  activeVersionId: string;
  targetVersionId: string;
  limit: number;
}) {
  if (input.kind === "highlight") {
    return prisma.$queryRaw<BackfillRow[]>`
      SELECT active."highlightId" AS "entityId", active."inputText"
      FROM "HighlightEmbedding" AS active
      LEFT JOIN "HighlightEmbedding" AS target
        ON target."highlightId" = active."highlightId"
        AND target."indexVersionId" = ${input.targetVersionId}
      WHERE active."indexVersionId" = ${input.activeVersionId}
        AND (target."id" IS NULL OR target."inputHash" <> active."inputHash")
      ORDER BY active."highlightId"
      LIMIT ${input.limit}
    `;
  }
  if (input.kind === "projectFact") {
    return prisma.$queryRaw<BackfillRow[]>`
      SELECT active."projectFactId" AS "entityId", active."inputText"
      FROM "ProjectFactEmbedding" AS active
      LEFT JOIN "ProjectFactEmbedding" AS target
        ON target."projectFactId" = active."projectFactId"
        AND target."indexVersionId" = ${input.targetVersionId}
      WHERE active."indexVersionId" = ${input.activeVersionId}
        AND (target."id" IS NULL OR target."inputHash" <> active."inputHash")
      ORDER BY active."projectFactId"
      LIMIT ${input.limit}
    `;
  }
  if (input.kind === "evidence") {
    return prisma.$queryRaw<BackfillRow[]>`
      SELECT active."evidenceItemId" AS "entityId", active."inputText"
      FROM "EvidenceEmbedding" AS active
      LEFT JOIN "EvidenceEmbedding" AS target
        ON target."evidenceItemId" = active."evidenceItemId"
        AND target."indexVersionId" = ${input.targetVersionId}
      WHERE active."indexVersionId" = ${input.activeVersionId}
        AND (target."id" IS NULL OR target."inputHash" <> active."inputHash")
      ORDER BY active."evidenceItemId"
      LIMIT ${input.limit}
    `;
  }
  return prisma.$queryRaw<BackfillRow[]>`
    SELECT active."artifactId" AS "entityId", active."inputText"
    FROM "ArtifactEmbedding" AS active
    LEFT JOIN "ArtifactEmbedding" AS target
      ON target."artifactId" = active."artifactId"
      AND target."indexVersionId" = ${input.targetVersionId}
    WHERE active."indexVersionId" = ${input.activeVersionId}
      AND (target."id" IS NULL OR target."inputHash" <> active."inputHash")
    ORDER BY active."artifactId"
    LIMIT ${input.limit}
  `;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
) {
  for (let offset = 0; offset < values.length; offset += concurrency) {
    await Promise.all(values.slice(offset, offset + concurrency).map(task));
  }
}

export async function backfillEmbeddingIndex(input: {
  key: string;
  batchSize?: number;
  concurrency?: number;
  onProgress?: (progress: {
    kind: EmbeddingEntityKind;
    processed: number;
    totalProcessed: number;
  }) => void;
}) {
  const target = await findIndexByKey(prisma, input.key);
  if (target.status === "active" || target.status === "retired" || target.status === "failed") {
    throw new Error(
      `Embedding index "${input.key}" cannot be backfilled while ${target.status}.`,
    );
  }
  const writeSet = await resolveEmbeddingWriteSet();
  const active = writeSet.active;
  if (active.id === target.id) throw new Error("The active embedding index does not need backfill.");
  if (!writeSet.targets.some((version) => version.id === target.id)) {
    throw new Error(
      `Embedding index "${input.key}" must be write-enabled before backfill.`,
    );
  }

  const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 500));
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, 12));
  const counts: Record<EmbeddingEntityKind, number> = {
    highlight: 0,
    projectFact: 0,
    evidence: 0,
    artifact: 0,
  };
  try {
    for (const kind of Object.keys(counts) as EmbeddingEntityKind[]) {
      while (true) {
        const rows = await findBackfillRows({
          kind,
          activeVersionId: active.id,
          targetVersionId: target.id,
          limit: batchSize,
        });
        if (!rows.length) break;
        await mapConcurrent(rows, concurrency, async (row) => {
          const embedding = await generateEmbeddingForIndex({
            identity: target,
            inputText: row.inputText,
          });
          await persistBackfillEmbeddingRecord({
            writeSet,
            target,
            kind,
            entityId: row.entityId,
            embedding,
          });
        });
        counts[kind] += rows.length;
        input.onProgress?.({
          kind,
          processed: rows.length,
          totalProcessed: Object.values(counts).reduce((sum, value) => sum + value, 0),
        });
      }
    }
    await prisma.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "buildCompletedAt" = CURRENT_TIMESTAMP,
          "lastError" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    return { target, active, counts };
  } catch (error) {
    await prisma.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "lastError" = CAST(${JSON.stringify({
        phase: "backfill",
        errorName: error instanceof Error ? error.name : "UnknownError",
        recordedAt: new Date().toISOString(),
      })} AS jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    throw error;
  }
}

export type EmbeddingReconciliationMetric = {
  activeRows: number;
  candidateRows: number;
  missingRows: number;
  hashMismatches: number;
};

export type EmbeddingReconciliationReport = {
  activeVersionId: string;
  candidateVersionId: string;
  activationEpoch: number;
  complete: boolean;
  metrics: Record<EmbeddingEntityKind, EmbeddingReconciliationMetric>;
  reconciledAt: string;
};

type RawReconciliationMetric = {
  activeRows: bigint;
  candidateRows: bigint;
  missingRows: bigint;
  hashMismatches: bigint;
};

function normalizeMetric(row: RawReconciliationMetric | undefined): EmbeddingReconciliationMetric {
  return {
    activeRows: Number(row?.activeRows ?? 0),
    candidateRows: Number(row?.candidateRows ?? 0),
    missingRows: Number(row?.missingRows ?? 0),
    hashMismatches: Number(row?.hashMismatches ?? 0),
  };
}

async function collectReconciliation(
  client: IndexQueryClient,
  input: {
    activeVersionId: string;
    candidateVersionId: string;
    activationEpoch: number;
  },
): Promise<EmbeddingReconciliationReport> {
  const [highlight, projectFact, evidence, artifact] = await Promise.all([
    client.$queryRaw<RawReconciliationMetric[]>`
      SELECT
        COUNT(active."id")::bigint AS "activeRows",
        COUNT(candidate."id")::bigint AS "candidateRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NULL)::bigint AS "missingRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NOT NULL AND active."inputHash" <> candidate."inputHash")::bigint AS "hashMismatches"
      FROM (
        SELECT "id", "highlightId", "inputHash"
        FROM "HighlightEmbedding"
        WHERE "indexVersionId" = ${input.activeVersionId}
      ) AS active
      FULL OUTER JOIN (
        SELECT "id", "highlightId", "inputHash"
        FROM "HighlightEmbedding"
        WHERE "indexVersionId" = ${input.candidateVersionId}
      ) AS candidate
        ON candidate."highlightId" = active."highlightId"
    `,
    client.$queryRaw<RawReconciliationMetric[]>`
      SELECT
        COUNT(active."id")::bigint AS "activeRows",
        COUNT(candidate."id")::bigint AS "candidateRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NULL)::bigint AS "missingRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NOT NULL AND active."inputHash" <> candidate."inputHash")::bigint AS "hashMismatches"
      FROM (
        SELECT "id", "projectFactId", "inputHash"
        FROM "ProjectFactEmbedding"
        WHERE "indexVersionId" = ${input.activeVersionId}
      ) AS active
      FULL OUTER JOIN (
        SELECT "id", "projectFactId", "inputHash"
        FROM "ProjectFactEmbedding"
        WHERE "indexVersionId" = ${input.candidateVersionId}
      ) AS candidate
        ON candidate."projectFactId" = active."projectFactId"
    `,
    client.$queryRaw<RawReconciliationMetric[]>`
      SELECT
        COUNT(active."id")::bigint AS "activeRows",
        COUNT(candidate."id")::bigint AS "candidateRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NULL)::bigint AS "missingRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NOT NULL AND active."inputHash" <> candidate."inputHash")::bigint AS "hashMismatches"
      FROM (
        SELECT "id", "evidenceItemId", "inputHash"
        FROM "EvidenceEmbedding"
        WHERE "indexVersionId" = ${input.activeVersionId}
      ) AS active
      FULL OUTER JOIN (
        SELECT "id", "evidenceItemId", "inputHash"
        FROM "EvidenceEmbedding"
        WHERE "indexVersionId" = ${input.candidateVersionId}
      ) AS candidate
        ON candidate."evidenceItemId" = active."evidenceItemId"
    `,
    client.$queryRaw<RawReconciliationMetric[]>`
      SELECT
        COUNT(active."id")::bigint AS "activeRows",
        COUNT(candidate."id")::bigint AS "candidateRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NULL)::bigint AS "missingRows",
        COUNT(*) FILTER (WHERE active."id" IS NOT NULL AND candidate."id" IS NOT NULL AND active."inputHash" <> candidate."inputHash")::bigint AS "hashMismatches"
      FROM (
        SELECT "id", "artifactId", "inputHash"
        FROM "ArtifactEmbedding"
        WHERE "indexVersionId" = ${input.activeVersionId}
      ) AS active
      FULL OUTER JOIN (
        SELECT "id", "artifactId", "inputHash"
        FROM "ArtifactEmbedding"
        WHERE "indexVersionId" = ${input.candidateVersionId}
      ) AS candidate
        ON candidate."artifactId" = active."artifactId"
    `,
  ]);
  const metrics = {
    highlight: normalizeMetric(highlight[0]),
    projectFact: normalizeMetric(projectFact[0]),
    evidence: normalizeMetric(evidence[0]),
    artifact: normalizeMetric(artifact[0]),
  };
  return {
    activeVersionId: input.activeVersionId,
    candidateVersionId: input.candidateVersionId,
    activationEpoch: input.activationEpoch,
    complete: Object.values(metrics).every(
      (metric) => metric.missingRows === 0 && metric.hashMismatches === 0,
    ),
    metrics,
    reconciledAt: new Date().toISOString(),
  };
}

export async function reconcileEmbeddingIndex(input: { key: string }) {
  return prisma.$transaction(async (tx) => {
    await lockEmbeddingIndexAdministration(tx);
    const controls = await tx.$queryRaw<Array<{
      activeVersionId: string;
      activationEpoch: number;
    }>>`
      SELECT "activeVersionId", "activationEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR UPDATE
    `;
    const control = controls[0];
    if (!control) throw new Error("EmbeddingIndexControl is missing.");
    const target = await findIndexByKey(tx, input.key, true);
    if (target.id === control.activeVersionId) {
      throw new Error("The active embedding index cannot be reconciled against itself.");
    }
    if (target.status === "failed" || target.status === "retired") {
      throw new Error(`Embedding index "${input.key}" is ${target.status}.`);
    }

    const report = await collectReconciliation(tx, {
      activeVersionId: control.activeVersionId,
      candidateVersionId: target.id,
      activationEpoch: Number(control.activationEpoch),
    });
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "status" = ${report.complete ? "ready" : "building"}::"EmbeddingIndexStatus",
          "baseActivationEpoch" = ${control.activationEpoch},
          "reconciledAt" = CURRENT_TIMESTAMP,
          "validation" = CAST(${JSON.stringify(report)} AS jsonb),
          "qualityGatePassed" = false,
          "qualityValidatedAt" = NULL,
          "qualityReport" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexControl"
      SET "writeSetEpoch" = "writeSetEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'
    `;
    return report;
  });
}

export async function recordEmbeddingQualityGate(input: {
  key: string;
  passed: boolean;
  report: unknown;
  expectedValidationFence: EmbeddingQualityValidationFence;
}) {
  JSON.stringify(input.report);
  const expectedFence = assertEmbeddingQualityValidationFence(
    input.expectedValidationFence,
  );
  if (!input.report || typeof input.report !== "object") {
    throw new Error("Embedding quality report must be an object.");
  }
  const report = input.report as {
    passed?: unknown;
    validationFence?: unknown;
  };
  if (report.passed !== input.passed) {
    throw new Error(
      "Embedding quality report result does not match the recorded result.",
    );
  }
  const reportFence = assertEmbeddingQualityValidationFence(
    report.validationFence,
  );
  if (!embeddingQualityValidationFencesMatch(reportFence, expectedFence)) {
    throw new Error(
      "Embedding quality report validation fence does not match the expected fence.",
    );
  }
  return prisma.$transaction(async (tx) => {
    await lockEmbeddingIndexAdministration(tx);
    const controls = await tx.$queryRaw<Array<{
      activeVersionId: string;
      activationEpoch: number;
      writeSetEpoch: number;
    }>>`
      SELECT "activeVersionId", "activationEpoch", "writeSetEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR UPDATE
    `;
    const control = controls[0];
    if (!control) throw new Error("EmbeddingIndexControl is missing.");
    const target = await findIndexByKey(tx, input.key, true);
    const currentFence: EmbeddingQualityValidationFence = {
      activeVersionId: control.activeVersionId,
      candidateVersionId: target.id,
      activationEpoch: Number(control.activationEpoch),
      writeSetEpoch: Number(control.writeSetEpoch),
      candidateReconciledAt: serializeReconciliationTimestamp(
        target.reconciledAt,
      ),
    };
    if (!embeddingQualityValidationFencesMatch(currentFence, expectedFence)) {
      throw new Error(
        `Embedding index "${input.key}" changed during quality validation; reconcile and re-run the quality gate.`,
      );
    }
    if (
      target.status !== "ready" ||
      currentFence.candidateReconciledAt === null ||
      target.baseActivationEpoch !== currentFence.activationEpoch
    ) {
      throw new Error(
        `Embedding index "${input.key}" must be ready and reconciled before recording its quality gate.`,
      );
    }
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "qualityGatePassed" = ${input.passed},
          "qualityValidatedAt" = CURRENT_TIMESTAMP,
          "qualityReport" = CAST(${JSON.stringify(input.report)} AS jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    return { ...target, qualityGatePassed: input.passed };
  });
}

export async function activateEmbeddingIndex(input: {
  key: string;
  expectedActivationEpoch: number;
}) {
  const result = await prisma.$transaction(async (tx) => {
    await lockEmbeddingIndexAdministration(tx);
    const controls = await tx.$queryRaw<Array<{
      activeVersionId: string;
      activationEpoch: number;
    }>>`
      SELECT "activeVersionId", "activationEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR UPDATE
    `;
    const control = controls[0];
    if (!control) throw new Error("EmbeddingIndexControl is missing.");
    if (Number(control.activationEpoch) !== input.expectedActivationEpoch) {
      throw new Error(
        `Embedding activation fence changed from ${input.expectedActivationEpoch} to ${control.activationEpoch}; reconcile again.`,
      );
    }
    const target = await findIndexByKey(tx, input.key, true);
    if (target.status !== "ready") {
      throw new Error(`Embedding index "${input.key}" must be ready before activation.`);
    }
    if (!target.qualityGatePassed) {
      throw new Error(`Embedding index "${input.key}" has not passed its retrieval quality gate.`);
    }
    if (target.baseActivationEpoch !== Number(control.activationEpoch)) {
      throw new Error(
        `Embedding index "${input.key}" was reconciled against an older active index; reconcile again.`,
      );
    }

    // Holding the control row FOR UPDATE excludes all application writes, which
    // take a FOR SHARE fence immediately before persisting their complete
    // active/building write set. Rechecking here closes the backfill/write race.
    const report = await collectReconciliation(tx, {
      activeVersionId: control.activeVersionId,
      candidateVersionId: target.id,
      activationEpoch: Number(control.activationEpoch),
    });
    if (!report.complete) {
      await tx.$executeRaw`
        UPDATE "EmbeddingIndexVersion"
        SET "status" = 'building',
            "qualityGatePassed" = false,
            "qualityValidatedAt" = NULL,
            "qualityReport" = NULL,
            "validation" = CAST(${JSON.stringify(report)} AS jsonb),
            "reconciledAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${target.id}
      `;
      return { activated: false as const };
    }

    await tx.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "status" = 'ready',
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${control.activeVersionId}
    `;
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "status" = 'active',
          "writeEnabled" = true,
          "activatedAt" = CURRENT_TIMESTAMP,
          "reconciledAt" = CURRENT_TIMESTAMP,
          "validation" = CAST(${JSON.stringify(report)} AS jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexControl"
      SET "activeVersionId" = ${target.id},
          "activationEpoch" = "activationEpoch" + 1,
          "writeSetEpoch" = "writeSetEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'
    `;
    return {
      activated: true as const,
      previousActiveVersionId: control.activeVersionId,
      activeVersionId: target.id,
      activationEpoch: Number(control.activationEpoch) + 1,
      report,
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
  if (!result.activated) {
    throw new Error(
      `Embedding index "${input.key}" changed after reconciliation; backfill, reconcile, and re-run the quality gate.`,
    );
  }
  return {
    previousActiveVersionId: result.previousActiveVersionId,
    activeVersionId: result.activeVersionId,
    activationEpoch: result.activationEpoch,
    report: result.report,
  };
}

export async function disableEmbeddingIndexWrites(input: { key: string }) {
  return prisma.$transaction(async (tx) => {
    await lockEmbeddingIndexAdministration(tx);
    const controls = await tx.$queryRaw<Array<{ activeVersionId: string }>>`
      SELECT "activeVersionId"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
      FOR UPDATE
    `;
    const target = await findIndexByKey(tx, input.key, true);
    if (target.id === controls[0]?.activeVersionId) {
      throw new Error("Cannot disable writes for the active embedding index.");
    }
    if (!target.writeEnabled) return { ...target, writeEnabled: false };

    await tx.$executeRaw`
      UPDATE "EmbeddingIndexVersion"
      SET "writeEnabled" = false,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${target.id}
    `;
    await tx.$executeRaw`
      UPDATE "EmbeddingIndexControl"
      SET "writeSetEpoch" = "writeSetEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'
    `;
    return { ...target, writeEnabled: false };
  });
}

export async function listEmbeddingIndexes() {
  const [versions, controls] = await Promise.all([
    prisma.$queryRaw<Array<IndexRow & {
      buildStartedAt: Date;
      buildCompletedAt: Date | null;
      reconciledAt: Date | null;
      activatedAt: Date | null;
      qualityValidatedAt: Date | null;
    }>>`
      SELECT
        "id", "key", "provider", "modelId", "dimensions",
        "status"::text AS "status", "writeEnabled", "baseActivationEpoch",
        "qualityGatePassed", "buildStartedAt", "buildCompletedAt",
        "reconciledAt", "activatedAt", "qualityValidatedAt"
      FROM "EmbeddingIndexVersion"
      ORDER BY "createdAt" ASC
    `,
    prisma.$queryRaw<Array<{
      activeVersionId: string;
      activationEpoch: number;
      writeSetEpoch: number;
    }>>`
      SELECT "activeVersionId", "activationEpoch", "writeSetEpoch"
      FROM "EmbeddingIndexControl"
      WHERE "id" = 'default'
    `,
  ]);
  return { control: controls[0] ?? null, versions };
}
