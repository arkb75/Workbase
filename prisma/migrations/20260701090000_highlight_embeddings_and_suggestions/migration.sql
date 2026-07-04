CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "HighlightSuggestionStatus" AS ENUM ('pending', 'accepted', 'dismissed');

CREATE TABLE "HighlightEmbedding" (
  "id" TEXT NOT NULL,
  "highlightId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "inputText" TEXT NOT NULL,
  "embedding" vector(512) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HighlightEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HighlightSuggestion" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "sourceHighlightId" TEXT NOT NULL,
  "status" "HighlightSuggestionStatus" NOT NULL DEFAULT 'pending',
  "suggestionType" TEXT NOT NULL,
  "currentSnapshot" JSONB NOT NULL,
  "suggestedDraft" JSONB NOT NULL,
  "matchReason" TEXT NOT NULL,
  "cosineDistance" DOUBLE PRECISION,
  "sourceEvidenceIds" JSONB NOT NULL,
  "generationRunIds" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HighlightSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HighlightEmbedding_highlightId_key" ON "HighlightEmbedding"("highlightId");
CREATE INDEX "HighlightEmbedding_highlightId_idx" ON "HighlightEmbedding"("highlightId");
CREATE INDEX "HighlightEmbedding_embedding_hnsw_idx" ON "HighlightEmbedding" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "HighlightSuggestion_workItemId_status_createdAt_idx" ON "HighlightSuggestion"("workItemId", "status", "createdAt");
CREATE INDEX "HighlightSuggestion_sourceHighlightId_status_idx" ON "HighlightSuggestion"("sourceHighlightId", "status");

ALTER TABLE "HighlightEmbedding"
  ADD CONSTRAINT "HighlightEmbedding_highlightId_fkey"
  FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HighlightSuggestion"
  ADD CONSTRAINT "HighlightSuggestion_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HighlightSuggestion"
  ADD CONSTRAINT "HighlightSuggestion_sourceHighlightId_fkey"
  FOREIGN KEY ("sourceHighlightId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
