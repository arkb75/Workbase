ALTER TABLE "RepositoryFileSnapshot" ADD COLUMN "semanticRefreshRunId" TEXT;
CREATE INDEX "RepositoryFileSnapshot_semanticRefreshRunId_semanticStatus_idx"
  ON "RepositoryFileSnapshot"("semanticRefreshRunId", "semanticStatus");
