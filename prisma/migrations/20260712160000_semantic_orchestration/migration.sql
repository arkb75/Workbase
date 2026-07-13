ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'execution_routing';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'semantic_extraction';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'semantic_repair';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'capability_synthesis';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'coverage_audit';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'answer_completeness_audit';

ALTER TYPE "GenerationStatus" ADD VALUE IF NOT EXISTS 'queued';
ALTER TYPE "GenerationStatus" ADD VALUE IF NOT EXISTS 'running';

ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'repository_refresh';
ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'semantic_worker';
ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'coverage_audit';

ALTER TYPE "KnowledgeRefreshStatus" ADD VALUE IF NOT EXISTS 'routing';
ALTER TYPE "KnowledgeRefreshStatus" ADD VALUE IF NOT EXISTS 'semantic_analysis';
ALTER TYPE "KnowledgeRefreshStatus" ADD VALUE IF NOT EXISTS 'auditing';

CREATE TYPE "KnowledgeRefreshQuality" AS ENUM ('pending', 'verified', 'degraded', 'failed');
CREATE TYPE "RepositorySemanticStatus" AS ENUM ('not_selected', 'pending', 'succeeded', 'degraded', 'failed');
CREATE TYPE "CapabilityCoverageStatus" AS ENUM ('not_applicable', 'static_only', 'semantic_verified', 'partial', 'failed');

ALTER TABLE "KnowledgeRefreshRun"
  ADD COLUMN "qualityStatus" "KnowledgeRefreshQuality" NOT NULL DEFAULT 'pending',
  ADD COLUMN "orchestration" JSONB,
  ADD COLUMN "budgetUsage" JSONB;

UPDATE "KnowledgeRefreshRun"
SET "qualityStatus" = 'degraded'
WHERE "status" = 'completed';

ALTER TABLE "RepositoryFileSnapshot"
  ADD COLUMN "semanticStatus" "RepositorySemanticStatus" NOT NULL DEFAULT 'not_selected',
  ADD COLUMN "semanticAnalyzerVersion" TEXT,
  ADD COLUMN "semanticAnalysis" JSONB,
  ADD COLUMN "semanticDiagnostics" JSONB,
  ADD COLUMN "semanticAnalyzedAt" TIMESTAMP(3);

ALTER TABLE "Claim" ADD COLUMN "validationHeads" JSONB;
ALTER TABLE "ProjectFact" ADD COLUMN "validationHeads" JSONB;

ALTER TABLE "AgentRun" ADD COLUMN "knowledgeRefreshRunId" TEXT;
ALTER TABLE "GenerationRun" ADD COLUMN "idempotencyKey" TEXT;

CREATE TABLE "RepositoryCapabilityLedger" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "refreshRunId" TEXT,
  "capabilityKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" "CapabilityCoverageStatus" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "representativeFileIds" JSONB NOT NULL,
  "staticObservationCount" INTEGER NOT NULL DEFAULT 0,
  "semanticObservationCount" INTEGER NOT NULL DEFAULT 0,
  "producedEntityRefs" JSONB,
  "gaps" JSONB,
  "workerRunIds" JSONB,
  "analyzerVersion" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RepositoryCapabilityLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepositoryCapabilityLedger_snapshotId_capabilityKey_key"
  ON "RepositoryCapabilityLedger"("snapshotId", "capabilityKey");
CREATE INDEX "RepositoryCapabilityLedger_workItemId_status_priority_idx"
  ON "RepositoryCapabilityLedger"("workItemId", "status", "priority");
CREATE INDEX "RepositoryCapabilityLedger_refreshRunId_idx"
  ON "RepositoryCapabilityLedger"("refreshRunId");
CREATE INDEX "RepositoryFileSnapshot_snapshotId_semanticStatus_path_idx"
  ON "RepositoryFileSnapshot"("snapshotId", "semanticStatus", "path");
CREATE INDEX "AgentRun_knowledgeRefreshRunId_idx"
  ON "AgentRun"("knowledgeRefreshRunId");
CREATE UNIQUE INDEX "GenerationRun_workItemId_idempotencyKey_key"
  ON "GenerationRun"("workItemId", "idempotencyKey");

ALTER TABLE "RepositoryCapabilityLedger"
  ADD CONSTRAINT "RepositoryCapabilityLedger_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryCapabilityLedger"
  ADD CONSTRAINT "RepositoryCapabilityLedger_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "RepositorySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryCapabilityLedger"
  ADD CONSTRAINT "RepositoryCapabilityLedger_refreshRunId_fkey"
  FOREIGN KEY ("refreshRunId") REFERENCES "KnowledgeRefreshRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_knowledgeRefreshRunId_fkey"
  FOREIGN KEY ("knowledgeRefreshRunId") REFERENCES "KnowledgeRefreshRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
