CREATE TYPE "KnowledgeLifecycleStatus" AS ENUM ('active', 'needs_validation', 'stale', 'superseded', 'retired', 'quarantined');
CREATE TYPE "KnowledgeReviewState" AS ENUM ('pending_review', 'reviewed', 'reverted');
CREATE TYPE "KnowledgeApprovalSource" AS ENUM ('automation', 'user', 'legacy');
CREATE TYPE "PublicSafetyStatus" AS ENUM ('not_eligible', 'pending', 'verified', 'failed');
CREATE TYPE "KnowledgeRefreshStatus" AS ENUM ('queued', 'inventorying', 'analyzing', 'reconciling', 'completed', 'failed', 'cancelled');
CREATE TYPE "KnowledgeRefreshTrigger" AS ENUM ('repository_attach', 'scheduled', 'manual', 'chat_freshness', 'backfill');
CREATE TYPE "RepositoryFileDisposition" AS ENUM ('eligible', 'analyzed', 'excluded', 'unreadable');
CREATE TYPE "RepositoryFileChangeType" AS ENUM ('unchanged', 'added', 'modified', 'renamed');
CREATE TYPE "KnowledgeChangeEntityKind" AS ENUM ('evidence', 'highlight', 'project_fact', 'artifact');
CREATE TYPE "KnowledgeChangeAction" AS ENUM ('created', 'updated', 'revalidated', 'retired', 'quarantined');
CREATE TYPE "KnowledgeChangeDecision" AS ENUM ('pending', 'kept', 'edited_and_kept', 'reverted', 'retired');

ALTER TABLE "AgentRun" ALTER COLUMN "harnessVersion" SET DEFAULT 'v4';

ALTER TABLE "Artifact"
  ADD COLUMN "approvalSource" "KnowledgeApprovalSource" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "autoAppliedAt" TIMESTAMP(3),
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleStatus" "KnowledgeLifecycleStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "publicSafetyStatus" "PublicSafetyStatus" NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN "reviewState" "KnowledgeReviewState" NOT NULL DEFAULT 'reviewed',
  ADD COLUMN "staleReason" TEXT,
  ADD COLUMN "supersedesArtifactId" TEXT,
  ADD COLUMN "validatedThroughSha" TEXT;

ALTER TABLE "Claim"
  ADD COLUMN "approvalSource" "KnowledgeApprovalSource" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "autoAppliedAt" TIMESTAMP(3),
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleStatus" "KnowledgeLifecycleStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "publicSafetyStatus" "PublicSafetyStatus" NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN "reviewState" "KnowledgeReviewState" NOT NULL DEFAULT 'reviewed',
  ADD COLUMN "supersedesHighlightId" TEXT,
  ADD COLUMN "validatedThroughSha" TEXT;

ALTER TABLE "EvidenceItem"
  ADD COLUMN "approvalSource" "KnowledgeApprovalSource" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "autoAppliedAt" TIMESTAMP(3),
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleStatus" "KnowledgeLifecycleStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "logicalKey" TEXT,
  ADD COLUMN "publicSafetyStatus" "PublicSafetyStatus" NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN "purgeEligibleAt" TIMESTAMP(3),
  ADD COLUMN "repositorySnapshotId" TEXT,
  ADD COLUMN "reviewState" "KnowledgeReviewState" NOT NULL DEFAULT 'reviewed',
  ADD COLUMN "supersedesEvidenceItemId" TEXT,
  ADD COLUMN "validatedThroughSha" TEXT;

ALTER TABLE "ProjectFact"
  ADD COLUMN "approvalSource" "KnowledgeApprovalSource" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "autoAppliedAt" TIMESTAMP(3),
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleStatus" "KnowledgeLifecycleStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "publicSafetyStatus" "PublicSafetyStatus" NOT NULL DEFAULT 'not_eligible',
  ADD COLUMN "reviewState" "KnowledgeReviewState" NOT NULL DEFAULT 'reviewed',
  ADD COLUMN "subsystemKey" TEXT,
  ADD COLUMN "validatedThroughSha" TEXT;

UPDATE "EvidenceItem" SET "logicalKey" = "externalId";
UPDATE "Claim"
SET
  "lifecycleStatus" = CASE
    WHEN "verificationStatus" = 'approved' THEN 'active'::"KnowledgeLifecycleStatus"
    WHEN "verificationStatus" = 'rejected' THEN 'retired'::"KnowledgeLifecycleStatus"
    ELSE 'needs_validation'::"KnowledgeLifecycleStatus"
  END,
  "reviewState" = CASE
    WHEN "verificationStatus" IN ('draft', 'flagged') THEN 'pending_review'::"KnowledgeReviewState"
    ELSE 'reviewed'::"KnowledgeReviewState"
  END,
  "publicSafetyStatus" = CASE
    WHEN "verificationStatus" = 'approved' AND NOT "sensitivityFlag" THEN 'pending'::"PublicSafetyStatus"
    ELSE 'not_eligible'::"PublicSafetyStatus"
  END;
UPDATE "ProjectFact"
SET
  "lifecycleStatus" = CASE
    WHEN "status" = 'approved' THEN 'active'::"KnowledgeLifecycleStatus"
    WHEN "status" = 'superseded' THEN 'superseded'::"KnowledgeLifecycleStatus"
    WHEN "status" = 'rejected' THEN 'retired'::"KnowledgeLifecycleStatus"
    ELSE 'needs_validation'::"KnowledgeLifecycleStatus"
  END,
  "reviewState" = CASE
    WHEN "status" = 'draft' THEN 'pending_review'::"KnowledgeReviewState"
    ELSE 'reviewed'::"KnowledgeReviewState"
  END;

CREATE TABLE "KnowledgeRefreshRun" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "workflowId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "trigger" "KnowledgeRefreshTrigger" NOT NULL,
  "status" "KnowledgeRefreshStatus" NOT NULL DEFAULT 'queued',
  "targetHeads" JSONB NOT NULL,
  "completedHeads" JSONB,
  "coverage" JSONB,
  "progress" JSONB,
  "warnings" JSONB,
  "delta" JSONB,
  "error" JSONB,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeRefreshRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepositorySnapshot" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "refreshRunId" TEXT,
  "branch" TEXT NOT NULL,
  "commitSha" TEXT NOT NULL,
  "treeSha" TEXT NOT NULL,
  "committedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3) NOT NULL,
  "inventoryComplete" BOOLEAN NOT NULL DEFAULT false,
  "analysisComplete" BOOLEAN NOT NULL DEFAULT false,
  "coverageComplete" BOOLEAN NOT NULL DEFAULT false,
  "manifestHash" TEXT,
  "coverage" JSONB,
  "warnings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepositoryFileSnapshot" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "blobSha" TEXT,
  "sizeBytes" INTEGER,
  "language" TEXT,
  "disposition" "RepositoryFileDisposition" NOT NULL,
  "changeType" "RepositoryFileChangeType" NOT NULL DEFAULT 'added',
  "exclusionReason" TEXT,
  "contentHash" TEXT,
  "analyzerVersion" TEXT,
  "analysis" JSONB,
  "analyzedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RepositoryFileSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeChange" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "refreshRunId" TEXT,
  "entityKind" "KnowledgeChangeEntityKind" NOT NULL,
  "action" "KnowledgeChangeAction" NOT NULL,
  "decision" "KnowledgeChangeDecision" NOT NULL DEFAULT 'pending',
  "evidenceItemId" TEXT,
  "highlightId" TEXT,
  "projectFactId" TEXT,
  "artifactId" TEXT,
  "beforeSnapshot" JSONB,
  "afterSnapshot" JSONB,
  "reason" TEXT NOT NULL,
  "provenance" JSONB,
  "downstreamImpact" JSONB,
  "policyVersion" TEXT NOT NULL,
  "modelId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "reviewedByUserId" TEXT,
  "feedback" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeRefreshRun_workItemId_status_updatedAt_idx" ON "KnowledgeRefreshRun"("workItemId", "status", "updatedAt");
CREATE UNIQUE INDEX "KnowledgeRefreshRun_workflowId_key" ON "KnowledgeRefreshRun"("workflowId");
CREATE UNIQUE INDEX "KnowledgeRefreshRun_workItemId_idempotencyKey_key" ON "KnowledgeRefreshRun"("workItemId", "idempotencyKey");
CREATE INDEX "RepositorySnapshot_workItemId_coverageComplete_resolvedAt_idx" ON "RepositorySnapshot"("workItemId", "coverageComplete", "resolvedAt");
CREATE INDEX "RepositorySnapshot_refreshRunId_idx" ON "RepositorySnapshot"("refreshRunId");
CREATE UNIQUE INDEX "RepositorySnapshot_sourceId_commitSha_key" ON "RepositorySnapshot"("sourceId", "commitSha");
CREATE INDEX "RepositoryFileSnapshot_snapshotId_disposition_path_idx" ON "RepositoryFileSnapshot"("snapshotId", "disposition", "path");
CREATE INDEX "RepositoryFileSnapshot_blobSha_analyzerVersion_idx" ON "RepositoryFileSnapshot"("blobSha", "analyzerVersion");
CREATE UNIQUE INDEX "RepositoryFileSnapshot_snapshotId_path_key" ON "RepositoryFileSnapshot"("snapshotId", "path");
CREATE INDEX "KnowledgeChange_workItemId_decision_createdAt_idx" ON "KnowledgeChange"("workItemId", "decision", "createdAt");
CREATE INDEX "KnowledgeChange_refreshRunId_action_idx" ON "KnowledgeChange"("refreshRunId", "action");
CREATE INDEX "KnowledgeChange_evidenceItemId_idx" ON "KnowledgeChange"("evidenceItemId");
CREATE INDEX "KnowledgeChange_highlightId_idx" ON "KnowledgeChange"("highlightId");
CREATE INDEX "KnowledgeChange_projectFactId_idx" ON "KnowledgeChange"("projectFactId");
CREATE INDEX "KnowledgeChange_artifactId_idx" ON "KnowledgeChange"("artifactId");
CREATE UNIQUE INDEX "KnowledgeChange_workItemId_idempotencyKey_key" ON "KnowledgeChange"("workItemId", "idempotencyKey");
CREATE INDEX "Artifact_workItemId_lifecycleStatus_reviewState_updatedAt_idx" ON "Artifact"("workItemId", "lifecycleStatus", "reviewState", "updatedAt");
CREATE INDEX "Artifact_supersedesArtifactId_idx" ON "Artifact"("supersedesArtifactId");
CREATE INDEX "Claim_workItemId_lifecycleStatus_reviewState_updatedAt_idx" ON "Claim"("workItemId", "lifecycleStatus", "reviewState", "updatedAt");
CREATE INDEX "Claim_supersedesHighlightId_idx" ON "Claim"("supersedesHighlightId");
CREATE INDEX "EvidenceItem_workItemId_lifecycleStatus_reviewState_updated_idx" ON "EvidenceItem"("workItemId", "lifecycleStatus", "reviewState", "updatedAt");
CREATE INDEX "EvidenceItem_sourceId_logicalKey_lifecycleStatus_idx" ON "EvidenceItem"("sourceId", "logicalKey", "lifecycleStatus");
CREATE INDEX "EvidenceItem_repositorySnapshotId_idx" ON "EvidenceItem"("repositorySnapshotId");
CREATE INDEX "EvidenceItem_supersedesEvidenceItemId_idx" ON "EvidenceItem"("supersedesEvidenceItemId");
CREATE INDEX "ProjectFact_workItemId_lifecycleStatus_reviewState_updatedA_idx" ON "ProjectFact"("workItemId", "lifecycleStatus", "reviewState", "updatedAt");
CREATE INDEX "ProjectFact_workItemId_subsystemKey_lifecycleStatus_idx" ON "ProjectFact"("workItemId", "subsystemKey", "lifecycleStatus");

ALTER TABLE "KnowledgeRefreshRun" ADD CONSTRAINT "KnowledgeRefreshRun_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_refreshRunId_fkey" FOREIGN KEY ("refreshRunId") REFERENCES "KnowledgeRefreshRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepositoryFileSnapshot" ADD CONSTRAINT "RepositoryFileSnapshot_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "RepositorySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_refreshRunId_fkey" FOREIGN KEY ("refreshRunId") REFERENCES "KnowledgeRefreshRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_projectFactId_fkey" FOREIGN KEY ("projectFactId") REFERENCES "ProjectFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_repositorySnapshotId_fkey" FOREIGN KEY ("repositorySnapshotId") REFERENCES "RepositorySnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_supersedesEvidenceItemId_fkey" FOREIGN KEY ("supersedesEvidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_supersedesHighlightId_fkey" FOREIGN KEY ("supersedesHighlightId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_supersedesArtifactId_fkey" FOREIGN KEY ("supersedesArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
