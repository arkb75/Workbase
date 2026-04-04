ALTER TYPE "VerificationStatus" ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE "Claim"
ADD COLUMN "rejectionReason" TEXT;

CREATE TYPE "GenerationKind" AS ENUM (
  'claim_research',
  'claim_verification',
  'artifact_generation'
);

CREATE TYPE "GenerationStatus" AS ENUM (
  'success',
  'provider_error',
  'parse_error',
  'validation_error'
);

CREATE TABLE "GenerationRun" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "kind" "GenerationKind" NOT NULL,
  "status" "GenerationStatus" NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "inputSummary" JSONB NOT NULL,
  "rawOutput" TEXT,
  "parsedOutput" JSONB,
  "validationErrors" JSONB,
  "resultRefs" JSONB,
  "tokenUsage" JSONB,
  "estimatedCostUsd" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GenerationRun_workItemId_kind_createdAt_idx"
ON "GenerationRun"("workItemId", "kind", "createdAt");

ALTER TABLE "GenerationRun"
ADD CONSTRAINT "GenerationRun_workItemId_fkey"
FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
