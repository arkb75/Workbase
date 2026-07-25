ALTER TYPE "KnowledgeRefreshTrigger" ADD VALUE IF NOT EXISTS 'webhook_push';

CREATE TYPE "GitHubWebhookDeliveryStatus" AS ENUM (
  'received',
  'processing',
  'queued',
  'failed',
  'ignored'
);

CREATE TABLE "GitHubWebhookDelivery" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "refreshRunId" TEXT,
  "event" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "repositoryFullName" TEXT NOT NULL,
  "ref" TEXT,
  "afterSha" TEXT,
  "status" "GitHubWebhookDeliveryStatus" NOT NULL DEFAULT 'received',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "error" JSONB,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processingStartedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitHubWebhookDelivery_deliveryId_sourceId_key"
  ON "GitHubWebhookDelivery"("deliveryId", "sourceId");
CREATE INDEX "GitHubWebhookDelivery_workItemId_status_createdAt_idx"
  ON "GitHubWebhookDelivery"("workItemId", "status", "createdAt");
CREATE INDEX "GitHubWebhookDelivery_refreshRunId_idx"
  ON "GitHubWebhookDelivery"("refreshRunId");
CREATE INDEX "GitHubWebhookDelivery_repositoryId_receivedAt_idx"
  ON "GitHubWebhookDelivery"("repositoryId", "receivedAt");

ALTER TABLE "GitHubWebhookDelivery"
  ADD CONSTRAINT "GitHubWebhookDelivery_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitHubWebhookDelivery"
  ADD CONSTRAINT "GitHubWebhookDelivery_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitHubWebhookDelivery"
  ADD CONSTRAINT "GitHubWebhookDelivery_refreshRunId_fkey"
  FOREIGN KEY ("refreshRunId") REFERENCES "KnowledgeRefreshRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
