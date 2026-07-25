-- Version vector spaces before changing providers. The existing Titan rows are
-- registered as the active legacy index, preserving retrieval throughout the
-- OpenRouter backfill.
DO $$
DECLARE
  identity_count INTEGER;
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO identity_count
  FROM (
    SELECT "modelId", "dimensions" FROM "HighlightEmbedding"
    UNION
    SELECT "modelId", "dimensions" FROM "ProjectFactEmbedding"
    UNION
    SELECT "modelId", "dimensions" FROM "EvidenceEmbedding"
    UNION
    SELECT "modelId", "dimensions" FROM "ArtifactEmbedding"
  ) AS identities;

  SELECT COUNT(*) INTO invalid_count
  FROM (
    SELECT "modelId", "dimensions" FROM "HighlightEmbedding"
    UNION ALL
    SELECT "modelId", "dimensions" FROM "ProjectFactEmbedding"
    UNION ALL
    SELECT "modelId", "dimensions" FROM "EvidenceEmbedding"
    UNION ALL
    SELECT "modelId", "dimensions" FROM "ArtifactEmbedding"
  ) AS embeddings
  WHERE "modelId" <> 'amazon.titan-embed-text-v2:0'
    OR "dimensions" <> 512;

  IF identity_count > 1 THEN
    RAISE EXCEPTION 'Cannot version legacy embeddings: multiple model/dimension identities are present.';
  END IF;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Cannot version legacy embeddings: expected only Amazon Titan v2 512-dimensional rows.';
  END IF;
END $$;

CREATE TYPE "EmbeddingIndexStatus" AS ENUM ('building', 'ready', 'active', 'failed', 'retired');

CREATE TABLE "EmbeddingIndexVersion" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "status" "EmbeddingIndexStatus" NOT NULL DEFAULT 'building',
  "writeEnabled" BOOLEAN NOT NULL DEFAULT true,
  "baseActivationEpoch" INTEGER NOT NULL,
  "buildStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "buildCompletedAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "validation" JSONB,
  "qualityGatePassed" BOOLEAN NOT NULL DEFAULT false,
  "qualityValidatedAt" TIMESTAMP(3),
  "qualityReport" JSONB,
  "lastError" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmbeddingIndexVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmbeddingIndexVersion_dimensions_check" CHECK ("dimensions" = 512)
);

CREATE TABLE "EmbeddingIndexControl" (
  "id" TEXT NOT NULL,
  "activeVersionId" TEXT NOT NULL,
  "activationEpoch" INTEGER NOT NULL DEFAULT 0,
  "writeSetEpoch" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmbeddingIndexControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmbeddingIndexControl_singleton_check" CHECK ("id" = 'default')
);

CREATE UNIQUE INDEX "EmbeddingIndexVersion_key_key" ON "EmbeddingIndexVersion"("key");
CREATE INDEX "EmbeddingIndexVersion_status_writeEnabled_idx" ON "EmbeddingIndexVersion"("status", "writeEnabled");
CREATE UNIQUE INDEX "EmbeddingIndexControl_activeVersionId_key" ON "EmbeddingIndexControl"("activeVersionId");

INSERT INTO "EmbeddingIndexVersion" (
  "id",
  "key",
  "provider",
  "modelId",
  "dimensions",
  "status",
  "writeEnabled",
  "baseActivationEpoch",
  "buildCompletedAt",
  "reconciledAt",
  "activatedAt",
  "qualityGatePassed",
  "qualityValidatedAt",
  "qualityReport"
)
VALUES (
  'legacy-bedrock-titan-v2-512',
  'legacy-bedrock-titan-v2-512',
  'bedrock',
  COALESCE(
    (SELECT "modelId" FROM "HighlightEmbedding" ORDER BY "updatedAt" DESC LIMIT 1),
    (SELECT "modelId" FROM "EvidenceEmbedding" ORDER BY "updatedAt" DESC LIMIT 1),
    (SELECT "modelId" FROM "ProjectFactEmbedding" ORDER BY "updatedAt" DESC LIMIT 1),
    (SELECT "modelId" FROM "ArtifactEmbedding" ORDER BY "updatedAt" DESC LIMIT 1),
    'amazon.titan-embed-text-v2:0'
  ),
  512,
  'active',
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  true,
  CURRENT_TIMESTAMP,
  '{"kind":"legacy_baseline","passed":true}'::jsonb
);

INSERT INTO "EmbeddingIndexControl" ("id", "activeVersionId", "activationEpoch", "writeSetEpoch")
VALUES ('default', 'legacy-bedrock-titan-v2-512', 0, 0);

ALTER TABLE "HighlightEmbedding" ADD COLUMN "indexVersionId" TEXT;
ALTER TABLE "HighlightEmbedding" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "HighlightEmbedding" ADD COLUMN "costUsd" DECIMAL(18,10);
ALTER TABLE "ProjectFactEmbedding" ADD COLUMN "indexVersionId" TEXT;
ALTER TABLE "ProjectFactEmbedding" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "ProjectFactEmbedding" ADD COLUMN "costUsd" DECIMAL(18,10);
ALTER TABLE "EvidenceEmbedding" ADD COLUMN "indexVersionId" TEXT;
ALTER TABLE "EvidenceEmbedding" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "EvidenceEmbedding" ADD COLUMN "costUsd" DECIMAL(18,10);
ALTER TABLE "ArtifactEmbedding" ADD COLUMN "indexVersionId" TEXT;
ALTER TABLE "ArtifactEmbedding" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "ArtifactEmbedding" ADD COLUMN "costUsd" DECIMAL(18,10);

UPDATE "HighlightEmbedding" SET "indexVersionId" = 'legacy-bedrock-titan-v2-512';
UPDATE "ProjectFactEmbedding" SET "indexVersionId" = 'legacy-bedrock-titan-v2-512';
UPDATE "EvidenceEmbedding" SET "indexVersionId" = 'legacy-bedrock-titan-v2-512';
UPDATE "ArtifactEmbedding" SET "indexVersionId" = 'legacy-bedrock-titan-v2-512';

ALTER TABLE "HighlightEmbedding" ALTER COLUMN "indexVersionId" SET NOT NULL;
ALTER TABLE "ProjectFactEmbedding" ALTER COLUMN "indexVersionId" SET NOT NULL;
ALTER TABLE "EvidenceEmbedding" ALTER COLUMN "indexVersionId" SET NOT NULL;
ALTER TABLE "ArtifactEmbedding" ALTER COLUMN "indexVersionId" SET NOT NULL;

DROP INDEX "HighlightEmbedding_highlightId_key";
DROP INDEX "ProjectFactEmbedding_projectFactId_key";
DROP INDEX "EvidenceEmbedding_evidenceItemId_key";
DROP INDEX "ArtifactEmbedding_artifactId_key";

CREATE UNIQUE INDEX "HighlightEmbedding_highlightId_indexVersionId_key"
  ON "HighlightEmbedding"("highlightId", "indexVersionId");
CREATE UNIQUE INDEX "ProjectFactEmbedding_projectFactId_indexVersionId_key"
  ON "ProjectFactEmbedding"("projectFactId", "indexVersionId");
CREATE UNIQUE INDEX "EvidenceEmbedding_evidenceItemId_indexVersionId_key"
  ON "EvidenceEmbedding"("evidenceItemId", "indexVersionId");
CREATE UNIQUE INDEX "ArtifactEmbedding_artifactId_indexVersionId_key"
  ON "ArtifactEmbedding"("artifactId", "indexVersionId");

CREATE INDEX "HighlightEmbedding_indexVersionId_idx" ON "HighlightEmbedding"("indexVersionId");
CREATE INDEX "ProjectFactEmbedding_indexVersionId_idx" ON "ProjectFactEmbedding"("indexVersionId");
CREATE INDEX "EvidenceEmbedding_indexVersionId_idx" ON "EvidenceEmbedding"("indexVersionId");
CREATE INDEX "ArtifactEmbedding_indexVersionId_idx" ON "ArtifactEmbedding"("indexVersionId");

ALTER TABLE "EmbeddingIndexControl"
  ADD CONSTRAINT "EmbeddingIndexControl_activeVersionId_fkey"
  FOREIGN KEY ("activeVersionId") REFERENCES "EmbeddingIndexVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HighlightEmbedding"
  ADD CONSTRAINT "HighlightEmbedding_indexVersionId_fkey"
  FOREIGN KEY ("indexVersionId") REFERENCES "EmbeddingIndexVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectFactEmbedding"
  ADD CONSTRAINT "ProjectFactEmbedding_indexVersionId_fkey"
  FOREIGN KEY ("indexVersionId") REFERENCES "EmbeddingIndexVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceEmbedding"
  ADD CONSTRAINT "EvidenceEmbedding_indexVersionId_fkey"
  FOREIGN KEY ("indexVersionId") REFERENCES "EmbeddingIndexVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArtifactEmbedding"
  ADD CONSTRAINT "ArtifactEmbedding_indexVersionId_fkey"
  FOREIGN KEY ("indexVersionId") REFERENCES "EmbeddingIndexVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A global ANN graph would connect incomparable vector spaces and can discard
-- same-version neighbors before the SQL filter runs. Exact filtered scans are
-- correct for the current corpus. At larger scale, create one partial HNSW
-- index per immutable indexVersionId.
DROP INDEX IF EXISTS "HighlightEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ProjectFactEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "EvidenceEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ArtifactEmbedding_embedding_hnsw_idx";
