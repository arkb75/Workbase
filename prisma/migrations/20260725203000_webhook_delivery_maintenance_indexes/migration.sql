CREATE INDEX "GitHubWebhookDelivery_status_processingStartedAt_idx"
  ON "GitHubWebhookDelivery"("status", "processingStartedAt");

CREATE INDEX "GitHubWebhookDelivery_status_processedAt_idx"
  ON "GitHubWebhookDelivery"("status", "processedAt");
